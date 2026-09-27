/**
 * The model-facing tool.
 *
 * The Web UI is still the upstream single-repository surface, so this tool is
 * what makes the multi-repository workflow usable end to end in the meantime:
 * it drives exactly the same operations the `/api` endpoints do.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createTask, finishTask, listTasks, suggestTaskRoot } from './operations.js'

/**
 * Model-facing description: what this is for, the order to drive it in, and the
 * decisions that are never the model's to make. The workflow itself lives in the
 * bundled skill's SKILL.md, which a session loads when it takes a task on; this
 * carries only what a caller needs before that.
 */
const DESCRIPTION = [
  'Create, list and finish a per-task Git worktree workspace that spans one or more repositories: one directory outside the source tree holding a worktree of every selected repository, all on one branch.',
  '',
  'Drive it in order: suggest-root, then create, then list, then done. Ask the user for the task name and the task space location before creating anything.',
  'Pass merge only when the user asked to merge, deleteBranch only after a merge, and force only when the user has decided to discard uncommitted work.',
  'A merge lands on the branch each source repository has checked out unless another is named; a branch that is checked out nowhere is merged in a temporary worktree, so no source checkout is ever switched.',
].join('\n')

/**
 * One repository row, with every property present so the declared output schema
 * holds for every action.
 * @param name - the repository directory name.
 * @returns a row with empty facts.
 */
function emptyRow(name) {
  return {
    name,
    path: '',
    branch: '',
    changedFiles: 0,
    merged: false,
    removed: false,
    branchDeleted: false,
    error: '',
  }
}

/**
 * Output shape shared by every action.
 *
 * The value schema DSL carries requiredness per property inside `properties`;
 * a `required` key on an object schema itself (the root, or an array's `items`)
 * is rejected, so absence is expressed by always filling every field instead.
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', required: true },
    summary: { type: 'string', required: true },
    task: { type: 'string', required: true },
    branch: { type: 'string', required: true },
    container: { type: 'string', required: true },
    tasksRoot: { type: 'string', required: true },
    suggested: { type: 'string', required: true },
    failed: { type: 'boolean', required: true },
    warnings: { type: 'array', required: true, items: { type: 'string' } },
    repositories: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          path: { type: 'string', required: true },
          branch: { type: 'string', required: true },
          changedFiles: { type: 'integer', required: true },
          merged: { type: 'boolean', required: true },
          removed: { type: 'boolean', required: true },
          branchDeleted: { type: 'boolean', required: true },
          error: { type: 'string', required: true },
        },
      },
    },
  },
}

/**
 * Base value every action starts from.
 * @param action - the action being reported.
 * @returns the shared, fully populated envelope.
 */
function envelope(action) {
  return {
    action,
    summary: '',
    task: '',
    branch: '',
    container: '',
    tasksRoot: '',
    suggested: '',
    failed: false,
    warnings: [],
    repositories: [],
  }
}

/**
 * Read a parameter the action cannot proceed without.
 * @param value - the raw parameter.
 * @param name - its model-facing name.
 * @returns the trimmed value.
 * @throws Error when it is missing.
 */
function required(value, name) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') throw new Error(`${name} is required for this action`)
  return text
}

/**
 * Resolve the task space root a list or done action should read: an explicit
 * root, else the recommendation for the given source root.
 * @param tasksRoot - the explicit task space root, if any.
 * @param sourceRoot - the source root, if any.
 * @returns the task space root to use.
 * @throws Error when neither is available.
 */
async function containerFor(tasksRoot, sourceRoot) {
  const explicit = typeof tasksRoot === 'string' ? tasksRoot.trim() : ''
  if (explicit !== '') return explicit
  const source = typeof sourceRoot === 'string' ? sourceRoot.trim() : ''
  if (source === '') throw new Error('tasksRoot is required (or sourceRoot, to use its recommended task space)')
  return (await suggestTaskRoot(source)).suggested
}

/**
 * Build the model-facing summary line for one action.
 * @param action - the action performed.
 * @param value - the action's normalized envelope.
 * @returns the summary sentence.
 */
function summarize(action, value) {
  if (action === 'suggest-root') {
    const names = value.repositories.map((row) => row.name).join(', ')
    return `Recommended task space for ${value.tasksRoot === '' ? 'the source root' : value.tasksRoot}: ${value.suggested}. ${value.repositories.length} source repositor${value.repositories.length === 1 ? 'y' : 'ies'}${names === '' ? '' : `: ${names}`}.`
  }
  if (action === 'create') {
    const names = value.repositories.map((row) => row.name).join(', ')
    return `Task '${value.task}' is ready at ${value.container} on branch '${value.branch}', with worktrees of: ${names}.${value.warnings.length === 0 ? '' : ` Warnings: ${value.warnings.join('; ')}.`}`
  }
  if (action === 'list') {
    if (value.repositories.length === 0 && value.container === '') return `No task space at ${value.tasksRoot}.`
    const perTask = value.repositories.filter((row) => row.name !== '').length
    return `${value.repositories.length} task${value.repositories.length === 1 ? '' : 's'} under ${value.tasksRoot} (${perTask} worktree${perTask === 1 ? '' : 's'}).`
  }
  const failed = value.failed ? ' Some repositories need attention:' : ''
  const attention = value.repositories.filter((row) => row.error !== '').map((row) => `${row.name}: ${row.error}`).join('; ')
  return `Task '${value.task}' finished. Task space ${value.container === '' ? 'removed' : `kept at ${value.container}`}.${failed}${attention}${value.warnings.length === 0 ? '' : ` Warnings: ${value.warnings.join('; ')}.`}`
}

/**
 * Register the `task_worktree_space` tool when the deployment serves tools.
 *
 * Both guards matter: a deployment without a tool runtime must keep its
 * endpoints, and a bare context double (as the host tests build) has no service
 * lookup at all, so probing it must not throw.
 * @param ctx - the host plugin context.
 * @returns the registration disposer, or undefined when tools are unavailable.
 */
export function registerTaskTool(ctx) {
  if (typeof ctx.get !== 'function') return undefined
  const tools = ctx.get('tools')
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return undefined

  return tools.register(defineTool({
    name: 'task_worktree_space',
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['suggest-root', 'create', 'list', 'done'],
        description: 'suggest-root, create, list, or done.',
      },
      task: { type: 'string', description: 'Name (create, done): the task space directory and branch suffix, with no separators or spaces.' },
      sourceRoot: { type: 'string', description: 'Directory of the repositories. Required for suggest-root and create.' },
      tasksRoot: { type: 'string', description: 'Container root, outside the source tree. Omit for the recommendation.' },
      repos: { type: 'array', items: { type: 'string' }, description: 'Repository names (create). Omit for all discovered.' },
      baseRef: { type: 'string', description: 'Start point (create). Omit for each repository HEAD.' },
      merge: { type: 'boolean', description: 'Merge before removing the worktrees (done). Only on request.' },
      target: { type: 'string', description: 'Branch to merge into (done), for every repository. Omit for the branch each source repository has checked out.' },
      deleteBranch: { type: 'boolean', description: 'Delete each branch after a merge (done). Needs merge.' },
      cleanStray: { type: 'boolean', description: 'Remove leftovers in the task space (done), except keep. Off by default.' },
      keep: { type: 'array', items: { type: 'string' }, description: 'Entries to keep with cleanStray (done).' },
      force: { type: 'boolean', description: 'Discard uncommitted changes, force-delete branches (done). Only on the user decision.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const action = args.action

      if (action === 'suggest-root') {
        const sourceRoot = required(args.sourceRoot, 'sourceRoot')
        const result = await suggestTaskRoot(sourceRoot, { tasksRoot: args.tasksRoot })
        const value = envelope(action)
        value.tasksRoot = result.sourceRoot
        value.suggested = result.suggested
        value.repositories = result.repositories.map((entry) => ({ ...emptyRow(entry.name), path: entry.path }))
        value.summary = summarize(action, value)
        return value
      }

      if (action === 'create') {
        const sourceRoot = required(args.sourceRoot, 'sourceRoot')
        const result = await createTask(ctx.subprocess, {
          sourceRoot,
          task: required(args.task, 'task'),
          tasksRoot: args.tasksRoot,
          repos: Array.isArray(args.repos) ? args.repos : undefined,
          baseRef: typeof args.baseRef === 'string' ? args.baseRef : undefined,
          push: false,
        })
        const value = envelope(action)
        value.task = result.task
        value.branch = result.branch
        value.container = result.path
        value.tasksRoot = result.tasksRoot
        value.warnings = result.warnings
        value.repositories = result.repositories.map((entry) => ({ ...emptyRow(entry.name), path: entry.path, branch: result.branch }))
        value.summary = summarize(action, value)
        return value
      }

      if (action === 'list') {
        const tasksRoot = await containerFor(args.tasksRoot, args.sourceRoot)
        const result = await listTasks(ctx.subprocess, { tasksRoot })
        const value = envelope(action)
        value.tasksRoot = result.tasksRoot
        for (const task of result.tasks) {
          if (task.repositories.length === 0) {
            value.repositories.push({ ...emptyRow(task.name), path: task.path })
            continue
          }
          for (const repository of task.repositories) {
            value.repositories.push({
              ...emptyRow(`${task.name}/${repository.name}`),
              path: repository.path,
              branch: repository.branch ?? '',
              changedFiles: repository.changedFiles,
            })
          }
        }
        value.summary = summarize(action, value)
        return value
      }

      if (action === 'done') {
        const task = required(args.task, 'task')
        const tasksRoot = await containerFor(args.tasksRoot, args.sourceRoot)
        const result = await finishTask(ctx.subprocess, {
          task,
          tasksRoot,
          merge: args.merge === true,
          target: typeof args.target === 'string' ? args.target : undefined,
          deleteBranch: args.deleteBranch === true,
          force: args.force === true,
          cleanStray: args.cleanStray === true,
          keep: Array.isArray(args.keep) ? args.keep : [],
        })
        const value = envelope(action)
        value.task = task
        value.container = result.containerRemoved ? '' : result.path
        value.tasksRoot = tasksRoot
        value.failed = result.failed
        value.warnings = result.warnings
        value.repositories = result.repositories.map((entry) => ({
          ...emptyRow(entry.name),
          path: entry.path,
          branch: entry.branch ?? '',
          merged: entry.merged === true,
          removed: entry.removed === true,
          branchDeleted: entry.branchDeleted === true,
          error: entry.error ?? '',
        }))
        value.summary = summarize(action, value)
        return value
      }

      throw new Error(`unknown action: ${action}`)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `task_worktree_space: ${args.action}`,
      kind: 'other',
      rawInput: args,
    }),
  }))
}

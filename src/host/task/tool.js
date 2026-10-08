/**
 * The model-facing tool.
 *
 * The Web UI is still the upstream single-repository surface, so this tool is
 * what makes the multi-repository workflow usable end to end in the meantime:
 * it drives exactly the same operations the `/api` endpoints do.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { projectNameFor } from './naming.js'
import { addTaskRepositories, createTask, finishTask, listTasks, suggestTaskRoot } from './operations.js'
import { coded } from './codes.js'

/**
 * Model-facing description: what this is for, the order to drive it in, and the
 * decisions that are never the model's to make. The workflow itself lives in the
 * bundled skill's SKILL.md, which a session loads when it takes a task on; this
 * carries only what a caller needs before that.
 */
const DESCRIPTION = [
  'Create, list and finish a per-task Git worktree workspace that spans one or more repositories: inside the task space container, one directory per project (the source root\'s own directory name) holding one directory per task, and under that a worktree of every selected repository, all on one branch.',
  '',
  'Drive it in order: suggest-root, then create, then list, then done. Ask the user for the task name and the Worktree Space container root before creating anything.',
  'Every repository shares one branch, `task/<task>` unless the user asks for another prefix and it is passed as branchPrefix.',
  'When a task that already exists turns out to need another repository, add it with action "add" rather than creating a second task: name the container (tasksRoot or sourceRoot), the project and the task, and pass each repository as an absolute path. A repository added this way may sit anywhere on disk, on another volume included — nothing later depends on where it is — but it joins the branch the task is already on and starts from its own HEAD unless baseRef says otherwise. Nothing is removed from a task this way.',
  'Pass merge only when the user asked to merge, and deleteBranch only after a merge: a branch that landed on its target is safe to remove, and that is the tidying-up this tool does on its own.',
  'This tool cannot do `force`, and asking for it is an error rather than a warning: discarding uncommitted work, and force-deleting a branch whose commits landed nowhere, are irreversible and have to be the user\'s own decision. Abandoning a task needs force too, so it is not available here either. When a task really has to be abandoned that way, say so and ask them to open the Worktree Space management page and finish it there, rather than retrying.',
  'Finishing commits nothing itself: a worktree still holding uncommitted work stops the finish and is named, and the commit is the caller\'s to make - an agent session opened in the task space writes a better message than a fixed one. force discards that work as the worktree goes.',
  'A repository answered with `mergeInProgress` holds an unresolved merge at `mergeSite`: resolve the files listed in `conflictedFiles` in that checkout, commit the merge there, then call done again with the same merge request to finish. Never resolve a conflict by picking a side the user has not picked.',
  'A merge lands on the branch each source repository has checked out unless another is named; a branch that is checked out nowhere is merged in a worktree of its own, so no source checkout is ever switched.',
  'The task\'s delivery policy - whether a merge waits for a passing deployment smoke, and for a human acceptance ack - is decided by the user and recorded in the task metadata at create time. It is not a tool argument, and done enforces it: a refused merge names what is missing, and the way past it is to deploy, smoke, and be accepted - not to retry.',
  'The task\'s note names the conflict mode too: a task whose policy is conflicts=agent-auto expects the caller to resolve a returned conflict itself - ask no one, fix the files listed in conflictedFiles in that checkout, commit the merge there, and call done again. Under any other mode a returned conflict is reported and waits for the user.',
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
    mainRepo: '',
    mergeInProgress: false,
    mergeSite: '',
    conflictedFiles: [],
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
    project: { type: 'string', required: true },
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
          mainRepo: { type: 'string', required: true },
          mergeInProgress: { type: 'boolean', required: true },
          mergeSite: { type: 'string', required: true },
          conflictedFiles: { type: 'array', required: true, items: { type: 'string' } },
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
    project: '',
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
  if (text === '') throw coded('E7006', `${name} is required for this action`)
  return text
}

/**
 * Resolve the container root a list or done action should read: an explicit root,
 * else whatever the configuration names, else the recommendation for the source root.
 *
 * The middle answer is here for the same reason it is in `create`: a list, an add
 * or a done that names only a source root has to read the container the creates
 * have been landing in, or it would report on, or write to, a directory nobody
 * uses.
 * @param subprocess - the profile's subprocess service.
 * @param tasksRoot - the explicit container root, if any.
 * @param sourceRoot - the source root, if any.
 * @param configuredRoot - the container root the configuration names, possibly empty.
 * @returns the container root to use.
 * @throws Error when neither is available.
 */
async function containerFor(subprocess, tasksRoot, sourceRoot, configuredRoot = '') {
  const explicit = typeof tasksRoot === 'string' ? tasksRoot.trim() : ''
  if (explicit !== '') return explicit
  const source = typeof sourceRoot === 'string' ? sourceRoot.trim() : ''
  if (source === '') throw coded('E7006', 'tasksRoot is required (or sourceRoot, to use its recommended task space)')
  return (await suggestTaskRoot(subprocess, source, { configuredRoot })).suggested
}

/**
 * Resolve the project layer a list or done action should read.
 *
 * The layout puts one directory layer between the container root and a task name,
 * and that layer is the source root's own directory name - the same rule
 * `createTask` derives it by. A caller that knows the source root does not have to
 * name it; one that does not has to say it, because the container root alone
 * cannot tell which project's task of that name was meant.
 * @param project - the explicit project name, if any.
 * @param sourceRoot - the source root, if any.
 * @returns the project name to use.
 * @throws Error when neither is available.
 */
function projectFor(project, sourceRoot) {
  const explicit = typeof project === 'string' ? project.trim() : ''
  if (explicit !== '') return explicit
  const source = typeof sourceRoot === 'string' ? sourceRoot.trim() : ''
  if (source === '') throw coded('E7006', 'project is required (or sourceRoot, whose directory name it is)')
  return projectNameFor(source)
}

/**
 * The Host's Workspace registry, when this deployment serves one.
 *
 * Making the directory and the worktrees is only half of a create: the other half
 * is telling DSH the result is a Workspace, and that half is a Host service rather
 * than a client-only capability. The dialog does it through `ctx.workspaces.create`
 * on the client, which is this registry over the wire; a tool call that skipped it
 * left a container on disk DSH did not know about, and one no second create could
 * take the name of - `createTask` reads a leftover of its own as E2002 and refuses.
 *
 * Probed rather than injected: it is a peer service a deployment need not serve,
 * and a plugin that demanded it would refuse to load instead of reporting a task
 * space the user can still register by hand.
 * @param ctx - the host plugin context.
 * @returns the registry, or undefined when there is none to register with.
 */
function workspaceRegistryOf(ctx) {
  if (typeof ctx.get !== 'function') return undefined
  const registry = ctx.get('workspaceRegistry')
  if (registry === null || registry === undefined || typeof registry.create !== 'function') return undefined
  return registry
}

/**
 * Register a task space that has just been made as a DSH Workspace.
 *
 * The title follows the dialog's own rule - `<source workspace title>/<task>` - so a
 * task space created from a session reads in the workspace list exactly like one
 * created from the panel, and two projects' tasks of one name cannot be read as one.
 * The registry keeps an existing record's title, so registering a directory that is
 * already a Workspace is the idempotent no-op it looks like.
 *
 * Nothing here throws: whether this succeeded is reported to the caller as a warning
 * by the action that asked for it, because the create it belongs to has already
 * happened on disk by then.
 * @param registry - the Host's Workspace registry.
 * @param taskPath - the task space the create made.
 * @param sourceRoot - the directory the task's repositories live in.
 * @param task - the task's name.
 * @returns an empty string on success, else why it could not be registered.
 */
async function registerTaskWorkspace(registry, taskPath, sourceRoot, task) {
  let title
  try {
    const source = typeof registry.resolveByPath === 'function' ? await registry.resolveByPath(sourceRoot) : undefined
    if (source !== null && source !== undefined && typeof source.title === 'string' && source.title !== '') {
      title = `${source.title}/${task}`
    }
  } catch {
    // The source root is not a registered Workspace, or its path no longer resolves.
    // The registry's own default - the task directory's name - is the right title
    // then, and neither is a reason to report the create as incomplete.
  }
  try {
    await registry.create(taskPath, title)
    return ''
  } catch (error) {
    return String(error?.message ?? error)
  }
}

/**
 * Refuse the one request a call cannot answer for itself.
 *
 * `force` is the whole of the irreversible surface here, and it is irreversible
 * twice over: it discards uncommitted work, and it swaps `git branch -d` for
 * `branch -D` (`archive.js`), which deletes a branch whose commits landed
 * nowhere. A model can be talked into either by anything it reads, so it is not
 * gated on a flag the model also holds - it is not expressible here at all, and
 * the way out is the management page, where the user ticks it.
 *
 * Everything else this tool can do to finish a task is recoverable or is git's
 * own decision. Merging lands the work; `deleteBranch` after a merge is
 * `git branch -d`, which refuses an unmerged branch on its own. `cleanStray`
 * reaches only the entries sitting directly in a task space that carries this
 * plugin's record and at least one linked worktree, and the user's own
 * documents are never among them: filing them away is `documentsDirectory` and
 * throwing them out is `discardDocuments`, and this tool passes neither.
 * Abandoning a task needs `deleteBranch` without a merge, which `archive.js`
 * already refuses without `force` - so refusing `force` closes that door too.
 * @param args - the tool's arguments.
 * @throws Error carrying E7007 when the call asks for `force`.
 */
function refuseIrreversible(args) {
  if (args.force !== true) return
  throw coded(
    'E7007',
    'force cannot be done from a tool call: discarding uncommitted work, and force-deleting a branch '
    + 'whose commits landed nowhere, are irreversible and have to be the user\'s own decision. '
    + 'Abandoning a task (deleteBranch without merge) needs force too, so it is not available here either. '
    + 'Ask them to open the Worktree Space management page and finish this task space there. '
    + 'Merging, and removing a branch once it has landed, are both still available here.',
  )
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
  if (action === 'add') {
    const names = value.repositories.map((row) => row.name).join(', ')
    return `Added to task '${value.task}' at ${value.container} on branch '${value.branch}': ${names}.${value.warnings.length === 0 ? '' : ` Warnings: ${value.warnings.join('; ')}.`}`
  }
  if (action === 'list') {
    if (value.repositories.length === 0 && value.container === '') return `No task space at ${value.tasksRoot}.`
    const perTask = value.repositories.filter((row) => row.name !== '').length
    return `${value.repositories.length} task${value.repositories.length === 1 ? '' : 's'} under ${value.tasksRoot} (${perTask} worktree${perTask === 1 ? '' : 's'}).`
  }
  const failed = value.failed ? ' Some repositories need attention:' : ''
  const attention = value.repositories.filter((row) => row.error !== '').map((row) => `${row.name}: ${row.error}`).join('; ')
  // A handed-on conflict is not a failure to report and move past: it is the step
  // that is left, so the summary says where it is rather than calling the task done.
  const handedOn = value.repositories.filter((row) => row.mergeInProgress)
  const headline = handedOn.length === 0
    ? `Task '${value.task}' finished. Task space ${value.container === '' ? 'removed' : `kept at ${value.container}`}.`
    : `Task '${value.task}' is unfinished: a merge is waiting to be resolved in ${handedOn.map((row) => row.mergeSite).join(', ')}.`
  const handoff = handedOn.length === 0
    ? ''
    : ` Resolve ${handedOn.map((row) => row.conflictedFiles.join(', ')).filter((list) => list !== '').join('; ') || 'the conflict'}, commit the merge there, then call done again.`
  return `${headline}${failed}${attention}${handoff}${value.warnings.length === 0 ? '' : ` Warnings: ${value.warnings.join('; ')}.`}`
}

/** How many repository rows a result card carries. */
const CARD_ROW_LIMIT = 20

/** How many warnings a result card carries. */
const CARD_WARNING_LIMIT = 3

/** How much text a result card carries, in characters. */
const CARD_TEXT_LIMIT = 4000

/**
 * The text of a completed call's card.
 *
 * Built from the durable projection when the Host passed one, and from the
 * model-facing content when it did not (a nested or otherwise projection-less
 * call), so a UI without the projection still gets something true. It is pure —
 * the same result gives the same text on the live path and on a session-log
 * replay — never longer than {@link CARD_TEXT_LIMIT}, and it says so when it cuts.
 * @param result - the completed call as the Host hands it to a presenter.
 * @returns the card's text.
 */
function cardText(result) {
  const meta = result !== null && typeof result === 'object'
    && result.meta !== null && typeof result.meta === 'object' && !Array.isArray(result.meta)
    ? result.meta
    : null
  const parts = []
  if (meta !== null) {
    if (typeof meta.summary === 'string' && meta.summary !== '') parts.push(meta.summary)
    const rows = Array.isArray(meta.repositories) ? meta.repositories : []
    const lines = rows.map((row) => {
      const name = typeof row?.name === 'string' ? row.name : '?'
      const state = row?.error ? `failed: ${String(row.error)}` : row?.merged === true ? 'merged' : 'not merged'
      return `${name}: ${state}${row?.removed === true ? ', worktree removed' : ''}`
    })
    const total = typeof meta.total === 'number' && Number.isFinite(meta.total) ? meta.total : rows.length
    if (total > rows.length) lines.push(`... and ${total - rows.length} more repositories`)
    if (lines.length > 0) parts.push(lines.join('\n'))
    const warnings = Array.isArray(meta.warnings) ? meta.warnings.filter((one) => typeof one === 'string') : []
    if (warnings.length > 0) parts.push(`warnings: ${warnings.join('; ')}`)
  } else if (Array.isArray(result?.content)) {
    const text = result.content
      .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .filter((one) => one !== '')
      .join('\n\n')
    if (text !== '') parts.push(text)
  }
  const text = parts.join('\n\n')
  return text.length > CARD_TEXT_LIMIT ? `${text.slice(0, CARD_TEXT_LIMIT)}\n... (truncated)` : text
}

/**
 * Register the `task_worktree_space` tool when the deployment serves tools.
 *
 * Both guards matter: a deployment without a tool runtime must keep its
 * endpoints, and a bare context double (as the host tests build) has no service
 * lookup at all, so probing it must not throw.
 * @param ctx - the host plugin context.
 * @param options - `configuredRoot` answers the container root the plugin's own
 * configuration names, read when an action needs one. A deployment that passes
 * nothing leaves every action on the recommendation.
 * @returns the registration disposer, or undefined when tools are unavailable.
 */
export function registerTaskTool(ctx, options = {}) {
  if (typeof ctx.get !== 'function') return undefined
  const tools = ctx.get('tools')
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return undefined
  // Read per call rather than captured once: the setting can change while a
  // session is running, and the next create should follow it.
  const configuredRoot = () => typeof options.configuredRoot === 'function' ? options.configuredRoot() : ''
  // The same rule for the per-project delivery defaults: the policy a create
  // records is the user's standing answer for that project, and a create the
  // model makes has to land on the same answer a dialog-made create would.
  const configuredDeliveryDefaults = () => typeof options.configuredDeliveryDefaults === 'function' ? options.configuredDeliveryDefaults() : {}
  // Where the strays policy files content away, when a done leaves the handling
  // to the policy: the same archive preference the finish dialog reads.
  const configuredArchive = () => typeof options.configuredArchive === 'function' ? options.configuredArchive() : undefined

  return tools.register(defineTool({
    name: 'task_worktree_space',
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['suggest-root', 'create', 'add', 'list', 'done'],
        description: 'suggest-root, create, add, list, or done.',
      },
      task: { type: 'string', description: 'Name (create, add, done): the task space directory and branch suffix, with no separators or spaces.' },
      project: { type: 'string', description: 'Project layer (add, list, done): the source root\'s own directory name. Omit when sourceRoot is given, since it is derived from it.' },
      sourceRoot: { type: 'string', description: 'Directory of the repositories. Required for suggest-root and create.' },
      tasksRoot: { type: 'string', description: 'Container for task spaces: beside the repositories\' directory, never inside it or a parent of it. Omit for the recommendation.' },
      repos: { type: 'array', items: { type: 'string' }, description: 'Repository paths, as reported by suggest-root (create, add). Omit for every discovered (create). A bare name is read as relative to sourceRoot, which only names a repository sitting directly in it.' },
      baseRef: { type: 'string', description: 'Start point (create, add). Omit for each repository HEAD.' },
      branchPrefix: { type: 'string', description: 'Branch prefix (create, suggest-root): the branch is this plus the task name. Omit for the default task/.' },
      merge: { type: 'boolean', description: 'Merge before removing the worktrees (done). Only on request.' },
      target: { type: 'string', description: 'Branch to merge into (done), for every repository. Omit for the branch each source repository has checked out.' },
      deleteBranch: { type: 'boolean', description: 'Delete each branch (done), after a merge. Needs merge; deleting a branch that never landed is refused here.' },
      cleanStray: { type: 'boolean', description: 'Remove leftovers in the task space (done), except keep. Never reaches the user\'s own documents here.' },
      keep: { type: 'array', items: { type: 'string' }, description: 'Entries to keep with cleanStray (done).' },
      force: { type: 'boolean', description: 'Discard uncommitted changes (done). Refused here, always - the user decides that themselves, on the management page.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.summary }],
      // The card's own projection, bounded here as well as at the card: a
      // hundred-repository task must neither bloat the session log nor a card.
      // `total` stays in place, so a capped list can never be read as the whole
      // answer.
      presentationMeta: (_args, value) => ({
        summary: value.summary,
        total: value.repositories.length,
        repositories: value.repositories.slice(0, CARD_ROW_LIMIT).map((row) => ({
          name: row.name,
          merged: row.merged,
          removed: row.removed,
          error: row.error,
        })),
        warnings: value.warnings.slice(0, CARD_WARNING_LIMIT),
      }),
    },
    async execute(args) {
      const action = args.action

      if (action === 'suggest-root') {
        const sourceRoot = required(args.sourceRoot, 'sourceRoot')
        const result = await suggestTaskRoot(ctx.subprocess, sourceRoot, {
          tasksRoot: args.tasksRoot,
          branchPrefix: typeof args.branchPrefix === 'string' ? args.branchPrefix : undefined,
          // The plugin's own setting outranks the recommendation: it is the user's
          // standing answer to where task spaces go, so the model proposes it too.
          configuredRoot: configuredRoot(),
        })
        const value = envelope(action)
        value.tasksRoot = result.sourceRoot
        value.suggested = result.suggested
        value.repositories = result.repositories.map((entry) => ({ ...emptyRow(entry.name), path: entry.path, branch: entry.branch ?? '' }))
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
          branchPrefix: typeof args.branchPrefix === 'string' ? args.branchPrefix : undefined,
          configuredRoot: configuredRoot(),
          // The policy is not a tool argument: the model never picks how a task is
          // delivered. It reads the same project defaults a dialog-made create
          // would, so a task started from a session lands on the same answers.
          deliveryDefaults: configuredDeliveryDefaults(),
        })
        const value = envelope(action)
        value.task = result.task
        value.project = result.project
        value.branch = result.branch
        value.container = result.path
        value.tasksRoot = result.tasksRoot
        // The other half of a create: the directory and the worktrees are on disk,
        // and DSH has to be told the result is a Workspace. Registering it here is
        // what keeps an agent-made task space from being a container the workspace
        // list never shows and no second create can take the name of.
        //
        // Reported as a warning and never thrown, because the create has already
        // succeeded: a caller told it failed would not know the worktrees are there,
        // and the same name would stay unusable either way.
        const registry = workspaceRegistryOf(ctx)
        const unregistered = registry === undefined
          ? 'this deployment serves no Workspace registry to register it with'
          : await registerTaskWorkspace(registry, result.path, sourceRoot, result.task)
        if (unregistered !== '') {
          value.warnings.push(
            `the task space is on disk but not registered as a DSH Workspace (${unregistered}); register it from the `
            + 'Worktree Space panel - "Create and open", or "Register again" after a create is refused - and open the '
            + 'task\'s session there; until it is registered, creating this task again is refused as E2002',
          )
        }
        value.repositories = result.repositories.map((entry) => ({ ...emptyRow(entry.name), path: entry.path, branch: result.branch }))
        value.summary = summarize(action, value)
        return value
      }

      if (action === 'add') {
        const task = required(args.task, 'task')
        const tasksRoot = await containerFor(ctx.subprocess, args.tasksRoot, args.sourceRoot, configuredRoot())
        const project = projectFor(args.project, args.sourceRoot)
        const result = await addTaskRepositories(ctx.subprocess, {
          task,
          project,
          tasksRoot,
          // Absolute paths, not names: a repository added to an existing task need
          // not sit under the source root that task began from, so there is no
          // directory to resolve a name against.
          repositories: Array.isArray(args.repos) ? args.repos : [],
          baseRef: typeof args.baseRef === 'string' && args.baseRef.trim() !== '' ? args.baseRef.trim() : undefined,
        })
        const value = envelope(action)
        value.task = result.task
        value.project = result.project
        value.branch = result.branch
        value.container = result.path
        value.tasksRoot = result.tasksRoot
        value.repositories = result.repositories.map((entry) => ({ ...emptyRow(entry.name), path: entry.path, branch: result.branch }))
        value.summary = summarize(action, value)
        return value
      }

      if (action === 'list') {
        const tasksRoot = await containerFor(ctx.subprocess, args.tasksRoot, args.sourceRoot, configuredRoot())
        const result = await listTasks(ctx.subprocess, { tasksRoot })
        const value = envelope(action)
        value.tasksRoot = result.tasksRoot
        for (const task of result.tasks) {
          // Named the way the layout reads - project, task, repository - so two
          // projects' tasks of the same name cannot be read as one.
          const label = `${task.project}/${task.name}`
          if (task.repositories.length === 0) {
            value.repositories.push({ ...emptyRow(label), path: task.path })
            continue
          }
          for (const repository of task.repositories) {
            value.repositories.push({
              ...emptyRow(`${label}/${repository.name}`),
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
        refuseIrreversible(args)
        const tasksRoot = await containerFor(ctx.subprocess, args.tasksRoot, args.sourceRoot, configuredRoot())
        const project = projectFor(args.project, args.sourceRoot)
        const result = await finishTask(ctx.subprocess, {
          task,
          project,
          tasksRoot,
          merge: args.merge === true,
          target: typeof args.target === 'string' ? args.target : undefined,
          deleteBranch: args.deleteBranch === true,
          force: args.force === true,
          cleanStray: args.cleanStray === true,
          keep: Array.isArray(args.keep) ? args.keep : [],
          deliveryArchive: configuredArchive(),
        })
        const value = envelope(action)
        value.task = task
        value.project = project
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
          mainRepo: entry.mainRepo ?? '',
          mergeInProgress: entry.mergeInProgress === true,
          mergeSite: entry.mergeSite ?? '',
          conflictedFiles: Array.isArray(entry.conflictedFiles) ? entry.conflictedFiles : [],
          error: entry.error ?? '',
        }))
        value.summary = summarize(action, value)
        return value
      }

      throw coded('E7005', `unknown action: ${action}`)
    },
    // Both presenters are pure: the same arguments and the same result give the
    // same view on the live path and on a session-log replay. Neither reads a
    // session, the clock, the environment or anything else outside its inputs.
    presentCall: (args) => ({
      card: 'generic',
      title: `task_worktree_space: ${args.action}`,
      kind: 'other',
      // The task name is the one input a reader wants while the call runs; the
      // whole args object (paths, flags, an archive directory) is not.
      rawInput: typeof args?.task === 'string' && args.task !== '' ? args.task : undefined,
    }),
    presentResult: (args, result) => ({
      card: 'generic',
      title: `task_worktree_space: ${args?.action ?? 'call'}`,
      content: [{ type: 'text', text: cardText(result) }],
    }),
  }))
}

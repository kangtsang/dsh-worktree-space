/**
 * Task layout
 *
 * What more than one of those needs: the layout a task container follows, and the worktrees it holds.
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tryRunGit } from './git.js'
import { coerceDeliveryPolicy } from './delivery.js'
import { deploymentEnvIdFor, validateProjectName, validateTaskName } from './naming.js'
import { assertTaskSpaceShape } from './paths.js'
import { recommendTasksRoot } from './paths.js'

/** File a task container carries so a session finds the task's own rules. */

export const BREADCRUMB = 'README.en.md'

/**
 * The task's metadata, as data.
 *
 * The container used to carry only {@link BREADCRUMB}, a Markdown note written
 * for a session to read. It is read back with a regular expression and, of the
 * five facts it records, only three were ever parsed again — the base and the
 * creation time were written and then lost. The JSON file is the record now:
 * every field below is either the task's identity or a fact captured once, at
 * create time, that cannot be recomputed later. Live state (the branch a
 * worktree is on now, its dirty files, the commits it has not merged) is
 * deliberately absent: it is a git question, and a copy here would rot.
 */
export const TASK_METADATA = 'worktree-space.json'

/**
 * The same metadata rendered for a reader.
 *
 * Generated from {@link TASK_METADATA} every time the JSON is written, so the
 * two cannot disagree; this is the file a session finds when it opens the task
 * space, replacing the note the old extension used to hold.
 *
 * Named after the record it renders rather than `README.md`. A task space is a
 * directory the user opens and puts their own files in, and `README.md` is the
 * first name anyone reaches for: a space that once carried the plugin's note
 * could not also hold the user's own without one overwriting the other. The
 * shared prefix makes the pair self-evident — the `.json` is the record, this
 * is the same record for a reader — and leaves every conventional name to the
 * user.
 */
export const TASK_README = 'worktree-space.md'

/**
 * Files this plugin writes into a container and therefore owns.
 *
 * {@link BREADCRUMB} is here as a legacy name: versions before the JSON wrote
 * that note instead, and a space created then is still this plugin's to clear.
 * `README.md` is deliberately absent even though such a space may hold one the
 * plugin itself wrote — by the time a space is archived, a file with that name
 * is as likely to be the user's own, and deleting the user's notes is worse
 * than leaving one stale file behind.
 */
export const TASK_OWNED_FILES = [TASK_METADATA, TASK_README, BREADCRUMB]


/**
 * Whether a directory is a linked worktree, that is, its `.git` is a file
 * pointing back at a source repository. A source repository's `.git` is a
 * directory, so this is what keeps a source root from being mistaken for a task
 * or the reverse.
 * @param directory - the candidate directory.
 * @returns whether the directory is a linked worktree.
 */

export async function isLinkedWorktree(directory) {
  try {
    return (await stat(join(directory, '.git'))).isFile()
  } catch {
    return false
  }
}


/**
 * Resolve the container root to use, preferring an explicit request.
 *
 * Three answers, in the order they win: what the caller named, what the
 * configuration names, and the recommendation derived from the source root. The
 * configured directory sits in the middle because it is a default rather than a
 * rule - a task that names its own container root still goes where it was told -
 * and because it is the user's standing answer to "where do task spaces go",
 * which is what both the create dialog and the tool's own `suggest-root` report.
 * @param sourceRoot - the directory holding the source repositories.
 * @param requestedRoot - a caller-supplied container root, possibly empty.
 * @param configuredRoot - the container root the configuration names, possibly empty.
 * @returns the container root, in native separators.
 */

export function resolveTasksRoot(sourceRoot, requestedRoot, configuredRoot) {
  const requested = typeof requestedRoot === 'string' ? requestedRoot.trim() : ''
  if (requested !== '') return requested
  const configured = typeof configuredRoot === 'string' ? configuredRoot.trim() : ''
  return configured === '' ? recommendTasksRoot(sourceRoot) : configured
}


/**
 * The task space directory: the one place the host spells out the layout.
 *
 * `<container root>/<project>/<task>`, with each segment validated as the name it
 * is - the task by the rule a branch suffix also obeys, the project by the
 * weaker rule a directory name obeys. Both are validated here rather than at the
 * call sites so that a path this plugin writes and a path it later reads back
 * can never disagree, and so the two relative names a caller could send cannot
 * walk out of the container root.
 * @param tasksRoot - the container root.
 * @param project - the project layer's name.
 * @param task - the task name.
 * @returns the task space directory.
 */
export function taskSpacePath(tasksRoot, project, task) {
  const root = String(tasksRoot ?? '').trim()
  const path = join(root, validateProjectName(project), validateTaskName(task))
  assertTaskSpaceShape(root, path)
  return path
}


/**
 * Read the linked worktrees inside a task directory with their branch and dirty
 * state.
 * @param subprocess - the profile's subprocess service.
 * @param taskPath - the task directory.
 * @returns one row per worktree, in directory order.
 */

export async function listTaskWorktrees(subprocess, taskPath) {
  let entries
  try {
    entries = await readdir(taskPath, { withFileTypes: true })
  } catch {
    return []
  }

  const repositories = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const worktreePath = join(taskPath, entry.name)
    if (!(await isLinkedWorktree(worktreePath))) continue
    const branch = await tryRunGit(subprocess, worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const status = await tryRunGit(subprocess, worktreePath, ['status', '--porcelain'])
    repositories.push({
      name: entry.name,
      path: worktreePath,
      branch: branch === '' ? undefined : branch,
      changedFiles: status === '' ? 0 : status.split(/\r?\n/).filter(Boolean).length,
    })
  }
  return repositories
}


/**
 * Build the metadata a container records for itself.
 *
 * `startCommit` is read once per repository, before the branch is created, so
 * the answer belongs to the source checkout rather than to the worktree that
 * was just made from it.
 * @param details - `task`, `tasksRoot`, `sourceRoot`, the shared `branch`, the
 * optional `baseRef`, and the created repositories with their source paths,
 * source branches and starting commits.
 * @returns the document to write as JSON. Alongside the captured facts it
 * carries the `deploymentEnvId` derived from the project and task names — a
 * deployment is not a fact this plugin captures, but the id every deploy
 * command and cleanup later must spell identically, so it is written down
 * rather than recomputed at each end — and the `delivery` policy the task was
 * created under, completed to the defaults where the caller said less, so the
 * note, the gate and the panel read one record instead of three opinions.
 */
export function taskMetadata(details) {
  const { task, project, tasksRoot, sourceRoot, branch, baseRef, repositories = [], delivery } = details
  return {
    version: 1,
    task,
    project,
    tasksRoot,
    sourceRoot,
    branch,
    baseRef: baseRef === undefined || `${baseRef}`.trim() === '' ? null : `${baseRef}`,
    deploymentEnvId: deploymentEnvIdFor(project, task),
    delivery: coerceDeliveryPolicy(delivery),
    createdAt: new Date().toISOString(),
    repositories: repositories.map((entry) => ({
      name: entry.name,
      sourcePath: entry.sourcePath,
      ...(entry.sourceBranch === undefined ? {} : { sourceBranch: entry.sourceBranch }),
      ...(entry.startCommit === undefined ? {} : { startCommit: entry.startCommit }),
      branch: entry.branch ?? branch,
    })),
  }
}

/**
 * Read a container's metadata, from JSON when it has one.
 *
 * Containers made before this file existed hold only the Markdown note, so the
 * note is still parsed and its three facts are returned as the identity. The
 * richer fields are then simply absent, which every reader treats as "unknown"
 * rather than as failure — a space is never demoted for being old.
 * @param taskPath - the container directory.
 * @returns the metadata, or undefined when the directory is not one of ours.
 */
export async function readTaskMetadata(taskPath) {
  const text = await readFile(join(taskPath, TASK_METADATA), 'utf8').catch(() => '')
  if (text.trim() !== '') {
    try {
      const parsed = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.task === 'string' && parsed.task !== '') {
        return parsed
      }
    } catch {
      // A half-written or hand-edited file falls through to the note below
      // rather than turning a task into a stranger.
    }
  }
  const legacy = await parseLegacyBreadcrumb(taskPath)
  return legacy === undefined ? undefined : { version: 0, ...legacy }
}

/**
 * Read the legacy Markdown note, when the container has one.
 * @param taskPath - the container directory.
 * @returns its three facts, or undefined.
 */
async function parseLegacyBreadcrumb(taskPath) {
  const text = await readFile(join(taskPath, BREADCRUMB), 'utf8').catch(() => '')
  if (text.trim() === '') return undefined
  const task = /^#\s*Task:\s*(.+)$/m.exec(text)?.[1]?.trim()
  if (task === undefined || task === '') return undefined
  const branch = /^-\s*Branch:\s*`([^`]+)`/m.exec(text)?.[1]?.trim()
  const sourceRoot = /^-\s*Source root:\s*`([^`]+)`/m.exec(text)?.[1]?.trim()
  return {
    task,
    ...(branch === undefined || branch === '' ? {} : { branch }),
    ...(sourceRoot === undefined || sourceRoot === '' ? {} : { sourceRoot }),
  }
}

/**
 * Render the metadata as the note a session reads.
 *
 * The Deployment section is here, and not only in the bundled skill, because it
 * is the one line a session must copy exactly — the environment id — and a note
 * generated from the same record the cleanup later reads is what keeps the two
 * from drifting. A container old enough to predate the field renders without the
 * section: guidance that names no id would invite a session to guess one.
 * @param metadata - the document {@link taskMetadata} built.
 * @returns the Markdown contents.
 */
export function renderTaskMetadata(metadata) {
  const { task, project, branch, baseRef, createdAt, sourceRoot, repositories = [], deploymentEnvId, delivery } = metadata
  const lines = [
    `# Task: ${task}`,
    '',
    ...(typeof project === 'string' && project !== '' ? [`- Project: \`${project}\``] : []),
    `- Branch: \`${branch}\` (one branch per repository below)`,
    `- Base: ${baseRef === undefined || baseRef === null || `${baseRef}`.trim() === '' ? "each repository's current HEAD" : `\`${baseRef}\``}`,
    ...(typeof createdAt === 'string' && createdAt !== '' ? [`- Created: ${createdAt}`] : []),
    `- Source root: \`${sourceRoot}\``,
    '- This folder is the agent session working directory.',
    '- The facts above are stored in `worktree-space.json`; this file is generated from it.',
    '',
    '## Repositories',
    ...repositories.map((entry) => `- \`${entry.name}\``),
    '',
    '## Conventions',
    '- Commit in each repository separately (the same branch name everywhere).',
    '- Source repositories are read-only: never edit or commit there.',
    '- Merging back to the main branch is the user\'s action, not the agent\'s.',
    '',
    ...(typeof deploymentEnvId === 'string' && deploymentEnvId !== '' ? [
      '## Deployment',
      '- If this space holds deployable services — a repository with its own `deploy/deploy.sh`, or a `deploy/` orchestration root beside the worktrees — deploy them to an isolated Docker environment rather than starting them on the host.',
      `- Environment id for this task: \`DSH_ENV_ID=${deploymentEnvId}\`. Pass it to every deploy command: it is what keeps this task's containers, images and acceptance URL apart from every other task's.`,
      '- `./deploy.sh up` builds and starts the environment and prints the acceptance URL; run `./deploy.sh smoke` and let it pass before handing the URL to the user.',
      '- `./deploy.sh status --json` is the machine-readable view; `./deploy.sh destroy` tears the environment down when acceptance is over.',
      '',
    ] : []),
    ...(delivery === undefined ? [] : [
      '## Delivery policy',
      `- Deploy: target \`${delivery.deploy.target}\` (${delivery.deploy.mode}).`,
      `- Verification: \`${delivery.verification}\`.`,
      `- Merge: \`${delivery.merge.mode}\` into ${delivery.merge.target === null ? 'the branch each source repository has checked out' : `\`${delivery.merge.target}\``}, then ${delivery.merge.deleteBranch ? 'delete' : 'keep'} the task branch.`,
      `- Conflicts: \`${delivery.conflicts}\`. Strays: \`${delivery.strays}\`.`,
      '- `done` enforces this policy: a merge is refused while the deployment state has no passing smoke and, under agent-then-human, while the human acceptance ack is missing.',
      '',
    ]),
  ]
  return lines.join('\n')
}

/**
 * Write a container's metadata: the JSON record and the note rendered from it.
 * @param taskPath - the container directory.
 * @param metadata - the document {@link taskMetadata} built.
 */
export async function writeTaskMetadata(taskPath, metadata) {
  await writeFile(join(taskPath, TASK_METADATA), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
  await writeFile(join(taskPath, TASK_README), renderTaskMetadata(metadata), 'utf8')
}

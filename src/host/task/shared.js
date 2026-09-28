/**
 * Task layout
 *
 * What more than one of those needs: the layout a task container follows, and the worktrees it holds.
 */

import { createTask } from './create.js'
import { DOCUMENT_EXTENSIONS, finishTask } from './archive.js'

import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rmdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { discoverSourceRepos, isSourceRepository, resolveSourceRepos } from './discover.js'
import { gitSucceeded, parseWorktrees, runGit, tryRunGit } from './git.js'
import { branchNameFor, DEFAULT_BRANCH_PREFIX, validateTaskName } from './naming.js'
import { assertIsolated, recommendTasksRoot } from './paths.js'

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
 * @param sourceRoot - the directory holding the source repositories.
 * @param requestedRoot - a caller-supplied container root, possibly empty.
 * @returns the container root, in native separators.
 */

export function resolveTasksRoot(sourceRoot, requestedRoot) {
  const requested = typeof requestedRoot === 'string' ? requestedRoot.trim() : ''
  return requested === '' ? recommendTasksRoot(sourceRoot) : requested
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
 * Classify a directory as a task source root.
 *
 * A source root is a repository that is not a linked worktree, or a directory
 * whose top-level children are repositories. The answer is filesystem-only —
 * `.git` as a directory is what marks a repository — so it costs no git calls
 * and cannot disagree with what {@link createTask} would discover.
 * @param sourceRoot - the candidate directory.
 * @returns the classification plus the repositories a task would span.
 */

/**
 * Describe where a task container should live and which repositories the task
 * would span, without creating anything.
 * @param subprocess - the profile's subprocess service, used to read the branch
 * each repository's HEAD is on.
 * @param sourceRoot - the directory holding the source repositories.
 * @param options - `tasksRoot` overrides the recommendation; `branchPrefix`
 * overrides the branch prefix a create would use.
 * @returns the recommendation, the discovered repositories with their current
 * branch, the branch prefix, and whether the container root came from the caller.
 * @throws IsolationError when the container layout would nest with the source.
 */

/**
 * Read the identity `createTask` writes into a container's breadcrumb.
 * @param text - the breadcrumb file's contents.
 * @returns the fields it names, or undefined when this is not one of ours.
 */

/**
 * Describe a directory as a task container, when it is one.
 *
 * Filesystem only: a container holds one linked worktree per repository (each
 * child's `.git` is a file rather than a directory) and, when this plugin made
 * it, the breadcrumb above. That is what lets the Web UI label a Workspace as a
 * task — and offer to archive it — without walking a container root or starting
 * git for every row.
 * @param taskPath - the candidate container directory.
 * @returns what the container is, with `isTask: false` when it is not one.
 */

/**
 * Render the task container's breadcrumb, the file that hands a session the
 * task's branch, base and conventions.
 * @param details - the task facts to record.
 * @returns the file contents.
 */

/**
 * Build the metadata a container records for itself.
 *
 * `startCommit` is read once per repository, before the branch is created, so
 * the answer belongs to the source checkout rather than to the worktree that
 * was just made from it.
 * @param details - `task`, `tasksRoot`, `sourceRoot`, the shared `branch`, the
 * optional `baseRef`, and the created repositories with their source paths,
 * source branches and starting commits.
 * @returns the document to write as JSON.
 */
export function taskMetadata(details) {
  const { task, tasksRoot, sourceRoot, branch, baseRef, repositories = [] } = details
  return {
    version: 1,
    task,
    tasksRoot,
    sourceRoot,
    branch,
    baseRef: baseRef === undefined || `${baseRef}`.trim() === '' ? null : `${baseRef}`,
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
 * @param metadata - the document {@link taskMetadata} built.
 * @returns the Markdown contents.
 */
export function renderTaskMetadata(metadata) {
  const { task, branch, baseRef, createdAt, sourceRoot, repositories = [] } = metadata
  const lines = [
    `# Task: ${task}`,
    '',
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

/**
 * Create a task space: one container beside the repositories' directory holding a
 * worktree of every selected repository on a shared branch.
 * @param subprocess - the profile's subprocess service.
 * @param options - `sourceRoot`, `task`, and the optional `tasksRoot`, `repos`
 * (repository names; omit for every discovered repository), `baseRef`,
 * `branchPrefix` and `push`.
 * @returns the created task's branch, container path and repositories.
 * @throws Error, after rolling the partial create back, when any step fails.
 */

/**
 * List the task spaces under a container root with the state of their
 * worktrees.
 * @param subprocess - the profile's subprocess service.
 * @param options - `tasksRoot`.
 * @returns the container root and one row per task.
 * @throws Error when no container root is given.
 */

/** Extensions whose files are the user's own writing rather than build output. */

/** Directories a build writes, which nobody misses when they go. */

/** Directories an editor writes, which nobody misses either. */

/** File names an editor or the shell writes. */

/** File suffixes that are build output, editor backups, or merge leftovers. */

/**
 * Classify a container entry: build output, editor state, or content.
 *
 * Only the last kind is worth warning about — it is the user's own material,
 * and cleaning the container deletes it — so the distinction has to be made
 * here rather than left to the dialog's prose.
 * @param name - the entry's name.
 * @param directory - whether it is a directory.
 * @returns `"build"`, `"editor"` or `"content"`.
 */

/**
 * Whether a file name looks like a document.
 * @param name - the entry's name.
 * @returns whether its extension is one of {@link DOCUMENT_EXTENSIONS}.
 */

/**
 * Count the documents inside a stray directory.
 *
 * Bounded on purpose: this runs while a dialog opens, and the count only has to
 * be good enough to warn that there is writing in there before it is deleted.
 * @param directory - the directory to walk.
 * @param options - `maxEntries`, the number of entries to look at before stopping.
 * @returns how many documents were seen.
 */

/**
 * Finish a task space: optionally merge each repository's branch, remove
 * the worktrees, optionally delete the branches, then clear the container.
 *
 * Every repository is attempted even when one fails; the outcome reports what
 * happened per repository so a conflict or a dirty worktree never hides the
 * repositories that did complete.
 * @param subprocess - the profile's subprocess service.
 * @param options - `task` and `tasksRoot`, plus the optional `merge`, `target`
 * (one branch for every repository), `targets` (a branch per repository),
 * `deleteBranch`, `force`, `cleanStray`, `keep`, `documentsDirectory` and
 * `discardDocuments`. A merge lands on the branch each source repository has
 * checked out unless another is named, and a named one that is checked out nowhere
 * is merged in a temporary worktree, so no source checkout is ever switched. The
 * container's own content is filed into
 * `documentsDirectory` when one is named, discarded when `discardDocuments` is
 * set, and otherwise left where it is.
 * @returns the per-repository outcome and whether the container was removed.
 * @throws Error when the task directory or its worktrees cannot be found.
 */


/**
 * Task layout
 *
 * What more than one of those needs: the layout a task container follows, and the worktrees it holds.
 */

import { breadcrumb, createTask } from './create.js'
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


/** Merge targets, in the order they are tried when none is named. */

export const MERGE_TARGET_CANDIDATES = ['main', 'master']


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
 * Undo a partial create: remove the worktrees this call added and the container
 * it made. Only what this call created is touched, so a failure never removes
 * anything the caller already had.
 * @param subprocess - the profile's subprocess service.
 * @param taskPath - the task directory being rolled back.
 * @param created - the repositories whose worktrees were created.
 * @returns the names that could not be rolled back.
 */

/**
 * Create a task space: one container outside the source tree holding a
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

/**
 * Pick the branch a finished task merges into: an explicit target, else the
 * remote's default, else the first conventional name that exists locally.
 * @param subprocess - the profile's subprocess service.
 * @param mainRepo - the source repository.
 * @param requested - an explicitly requested target, possibly empty.
 * @returns the local branch name to merge into.
 * @throws Error when no target can be determined.
 */

/**
 * Report what archiving a task would do, without doing any of it.
 *
 * Each repository reports the branch its worktree is on, the branch that branch
 * would merge into, how many commits that merge would bring, and how many files
 * are uncommitted — which is what the archive dialog shows before the user
 * chooses. The merge target is resolved the same way {@link finishTask} resolves
 * it, so the promise and the outcome cannot disagree.
 * @param subprocess - the profile's subprocess service.
 * @param options - `task` and `tasksRoot`.
 * @returns the per-repository plan and its totals.
 * @throws Error when the task directory or its worktrees cannot be found.
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
 * @param options - `task` and `tasksRoot`, plus the optional `merge`, `target`,
 * `deleteBranch`, `force`, `cleanStray`, `keep`, `documentsDirectory` and
 * `discardDocuments`. The container's own content is filed into
 * `documentsDirectory` when one is named, discarded when `discardDocuments` is
 * set, and otherwise left where it is.
 * @returns the per-repository outcome and whether the container was removed.
 * @throws Error when the task directory or its worktrees cannot be found.
 */


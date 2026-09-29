/**
 * Path identity and layout rules for task spaces.
 *
 * Ported from the source skill's `lib.sh`. Two rules carry over unchanged:
 * work and source must never nest inside one another, and the recommended task
 * container sits beside the repositories' directory. Where it sits is decided by
 * {@link recommendTasksRoot}: in the source root's first directory below its
 * volume root, so the two share that directory as a common ancestor. What it is
 * called is decided by {@link containerIn}: `worktree-space` in every scenario,
 * with `dsh-worktree-space` for the one layout whose own name would land on the
 * source root.
 */
import { dirname, join, parse, resolve } from 'node:path'

/** Windows compares paths case-insensitively; POSIX does not. */
const CASE_INSENSITIVE = process.platform === 'win32'

/**
 * Reduce a path to a comparison key.
 *
 * Git reports forward-slash paths on Windows while the filesystem hands out
 * backslash paths, so identity checks must never compare raw strings. The key
 * unifies separators, drops trailing separators, and folds case on Windows.
 * @param value - a path in any of the forms this plugin exchanges.
 * @returns the comparison key.
 */
export function canonicalPath(value) {
  const unified = String(value ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  if (unified === '') return '/'
  return CASE_INSENSITIVE ? unified.toLowerCase() : unified
}

/**
 * Whether two paths name the same location.
 * @param left - first path.
 * @param right - second path.
 * @returns whether both paths resolve to one location.
 */
export function samePathLocation(left, right) {
  return canonicalPath(left) === canonicalPath(right)
}

/**
 * Whether `child` is a strict descendant of `parent`.
 * @param parent - the containing path.
 * @param child - the candidate descendant.
 * @returns whether `child` sits below `parent`.
 */
export function isInside(parent, child) {
  const outer = canonicalPath(parent)
  const inner = canonicalPath(child)
  if (outer === inner) return false
  return inner.startsWith(outer.endsWith('/') ? outer : `${outer}/`)
}

/** Raised when a task container would nest with its source root. */
export class IsolationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'IsolationError'
  }
}

/**
 * Reject a task container that is the repositories' directory, sits inside it, or
 * contains it: work and source must stay isolated.
 * @param sourceRoot - the directory holding the source repositories.
 * @param tasksRoot - the proposed task container root.
 * @throws IsolationError when the two layouts nest.
 */
export function assertIsolated(sourceRoot, tasksRoot) {
  if (samePathLocation(sourceRoot, tasksRoot)) {
    throw new IsolationError(`the tasks root must not be the repositories' directory itself: ${sourceRoot}`)
  }
  if (isInside(sourceRoot, tasksRoot)) {
    throw new IsolationError(
      `the tasks root ${tasksRoot} is inside the repositories' directory ${sourceRoot}\n  work and source must be isolated; put the container beside that directory`,
    )
  }
  if (isInside(tasksRoot, sourceRoot)) {
    throw new IsolationError(
      `the tasks root ${tasksRoot} contains the repositories' directory ${sourceRoot}\n  work and source must be isolated; put the container beside that directory`,
    )
  }
}

/** The container's own directory name, used in every scenario. */
const CONTAINER_NAME = 'worktree-space'

/** The name the container takes where its own would land on the source root. */
const CONTAINER_BACKUP_NAME = 'dsh-worktree-space'

/**
 * The task container inside one directory.
 *
 * `worktree-space` is the name in every scenario, so the container is recognisable
 * wherever it is recommended and two tasks never scatter across two names. The one
 * layout that cannot use it is a source root the container would equal or contain -
 * a source root that is itself `<parent>/worktree-space` - and there it takes
 * `dsh-worktree-space` rather than be recommended onto its own source.
 * @param parent - the directory the container lives in.
 * @param sourceRoot - the source root the container must not swallow.
 * @returns the recommended container root, in native separators.
 */
export function containerIn(parent, sourceRoot) {
  const preferred = join(parent, CONTAINER_NAME)
  const swallows = isInside(preferred, sourceRoot) || samePathLocation(preferred, sourceRoot)
  return swallows ? join(parent, CONTAINER_BACKUP_NAME) : preferred
}

/**
 * The first directory a path sits in below its volume root.
 *
 * The source root and the task container have to end up under one common
 * ancestor: that is the directory a session opened for a linked worktree needs
 * as its working directory, because a commit writes into the source
 * repository's git directory as well as the worktree. Sharing the first
 * directory below the volume root gives them one, and it gives every project
 * filed under that directory the same one - `E:\workspace` for both
 * `E:\workspace\project1` and `E:\workspace\deep\project2`, so both containers
 * land in `E:\workspace\worktree-space` however deep their own project sits -
 * while staying off the volume root, which a session may not be opened on.
 * @param absolute - an absolute path.
 * @param root - that path's volume root (`E:\`, `/`).
 * @returns the first directory below the volume root, or undefined when the path
 * is itself that first directory — there is no room beside it then.
 */
function firstDirectoryBelowRoot(absolute, root) {
  const parts = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean)
  return parts.length > 1 ? join(root, parts[0]) : undefined
}

/**
 * Which directory the task container is placed in, for an absolute source root.
 *
 * The parent is the source root's own first directory below its volume root -
 * `E:\workspace` for `E:\workspace\public\repo` - because the container then
 * shares a real prefix with the source tree without either of them being widened
 * to the volume root, which a session may not be opened on. One such directory is
 * the whole point: every project filed anywhere under the same root workspace
 * reaches the same `worktree-space`, so the container does not follow each
 * project's own depth and does not scatter a second copy of itself beside a
 * project that sits deeper than its neighbours.
 *
 * A source root that is itself that first directory (`E:\repo`) has nothing
 * beside it that is still below the volume root, so the volume root answers; a
 * path without a drive has no meaningful first directory at all, and its own
 * parent answers.
 *
 * The path and its volume root are arguments rather than something resolved here,
 * so the drive-letter rule can be checked from any platform: resolving is the one
 * step of it that belongs to the platform the caller runs on.
 * @param absolute - an absolute source root.
 * @param root - that path's volume root (`E:\`, `/`); parsed when omitted.
 * @returns the directory to place the container in, in native separators.
 */
export function containerParentFor(absolute, root = parse(absolute).root) {
  const driveRoot = /^[A-Za-z]:[\\/]$/.test(root) ? root : undefined
  const first = driveRoot === undefined ? undefined : firstDirectoryBelowRoot(absolute, root)
  if (first !== undefined) return first
  return driveRoot === undefined ? dirname(absolute) : driveRoot
}

/**
 * Recommend where the task container should live for a source root.
 *
 * {@link containerParentFor} decides where it goes and says why; this resolves the
 * path first, which is the only part of the rule that depends on the platform, and
 * {@link containerIn} names the container under the directory that won.
 * @param sourceRoot - the directory holding the source repositories.
 * @returns the recommended container root, in native separators.
 */
export function recommendTasksRoot(sourceRoot) {
  const absolute = resolve(sourceRoot)
  return containerIn(containerParentFor(absolute), absolute)
}

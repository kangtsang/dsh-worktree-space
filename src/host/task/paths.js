/**
 * Path identity and layout rules for task spaces.
 *
 * Ported from the source skill's `lib.sh`. Two rules carry over unchanged:
 * work and source must never nest inside one another, and the recommended task
 * container sits outside the source tree. Where it sits is decided by
 * {@link recommendTasksRoot}: in the source root's first directory below its
 * volume root, which keeps the two under one common ancestor without widening
 * the recommendation to the volume root itself.
 */
import { existsSync } from 'node:fs'
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
 * Reject a task container that is the source root, sits inside it, or contains
 * it: work and source must stay isolated.
 * @param sourceRoot - the directory holding the source repositories.
 * @param tasksRoot - the proposed task container root.
 * @throws IsolationError when the two layouts nest.
 */
export function assertIsolated(sourceRoot, tasksRoot) {
  if (samePathLocation(sourceRoot, tasksRoot)) {
    throw new IsolationError(`tasks root must not be the source root itself: ${sourceRoot}`)
  }
  if (isInside(sourceRoot, tasksRoot)) {
    throw new IsolationError(
      `tasks root is inside the source root: ${tasksRoot}\n  work and source must be isolated; pick a location outside the source tree`,
    )
  }
  if (isInside(tasksRoot, sourceRoot)) {
    throw new IsolationError(
      `source root is inside the tasks root: ${tasksRoot}\n  work and source must be isolated; pick a location outside the source tree`,
    )
  }
}

/**
 * Pure layout decision behind {@link recommendTasksRoot}.
 *
 * A drive root prefers `<drive>:\workspace`, and reuses `<drive>:\worktree-space`
 * once that name is taken; a path without a drive falls back to a sibling of
 * the source root.
 * @param driveRoot - the source root's drive root (`E:\`), or undefined when it has none.
 * @param fallbackParent - parent used when there is no drive root.
 * @param exists - filesystem probe for the candidate `<drive>:\workspace`.
 * @returns the recommended container root.
 */
export function chooseTasksRoot(driveRoot, fallbackParent, exists) {
  if (driveRoot === undefined) return join(fallbackParent, 'worktree-space')
  const workspace = join(driveRoot, 'workspace')
  return exists(workspace) ? join(driveRoot, 'worktree-space') : workspace
}

/**
 * The first directory a path sits in below its volume root.
 *
 * The source root and the task container have to end up under one common
 * ancestor: that is the directory a session opened for a linked worktree needs
 * as its working directory, because a commit writes into the source
 * repository's git directory as well as the worktree. Sharing the first
 * directory below the volume root gives them one - `E:\workspace` for both
 * `E:\workspace\public\repo` and `E:\workspace\worktree-space\<task>\repo` -
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
 * Recommend where the task container should live for a source root.
 *
 * `<first directory>\worktree-space` is the recommendation whenever the source
 * root has such a directory, since the container is then a sibling of the
 * source root's own branch of the tree and can never nest with it. A source
 * root that is itself the first directory (`E:\repo`) has nothing beside it
 * that is still below the volume root, and a path without a drive has no
 * meaningful first directory at all: both fall back to the older candidates,
 * which are checked against the source root and replaced by a sibling when they
 * would contain it — as `<drive>:\workspace` does for a source root that
 * already lives under `<drive>:\workspace`.
 * @param sourceRoot - the directory holding the source repositories.
 * @param options - `exists` overrides the filesystem probe (tests).
 * @returns the recommended container root, in native separators.
 */
export function recommendTasksRoot(sourceRoot, { exists = existsSync } = {}) {
  const absolute = resolve(sourceRoot)
  const { root } = parse(absolute)
  const driveRoot = /^[A-Za-z]:[\\/]$/.test(root) ? root : undefined
  const first = driveRoot === undefined ? undefined : firstDirectoryBelowRoot(absolute, root)
  if (first !== undefined) return join(first, 'worktree-space')
  const candidate = chooseTasksRoot(driveRoot, dirname(absolute), exists)
  if (isInside(candidate, absolute) || samePathLocation(candidate, absolute)) {
    return join(dirname(absolute), 'worktree-space')
  }
  return candidate
}

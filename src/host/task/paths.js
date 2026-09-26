/**
 * Path identity and layout rules for task spaces.
 *
 * Ported from the source skill's `lib.sh`. Two rules carry over unchanged:
 * work and source must never nest inside one another, and the recommended task
 * container sits beside the source root's drive rather than inside the source
 * tree.
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
 * Recommend where the task container should live for a source root.
 *
 * The drive-root candidate is checked against the source root itself: a source
 * root that already lives under `<drive>:\workspace` would otherwise be handed
 * a container that contains it, which {@link assertIsolated} rejects. The
 * sibling fallback can never nest with the source root, so it is the answer
 * whenever the preferred candidate would.
 * @param sourceRoot - the directory holding the source repositories.
 * @param options - `exists` overrides the filesystem probe (tests).
 * @returns the recommended container root, in native separators.
 */
export function recommendTasksRoot(sourceRoot, { exists = existsSync } = {}) {
  const absolute = resolve(sourceRoot)
  const { root } = parse(absolute)
  const driveRoot = /^[A-Za-z]:[\\/]$/.test(root) ? root : undefined
  const candidate = chooseTasksRoot(driveRoot, dirname(absolute), exists)
  if (isInside(candidate, absolute) || samePathLocation(candidate, absolute)) {
    return join(dirname(absolute), 'worktree-space')
  }
  return candidate
}

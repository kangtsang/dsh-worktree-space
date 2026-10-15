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
import { lstatSync, realpathSync } from 'node:fs'

/** Windows compares paths case-insensitively; POSIX does not. */
const CASE_INSENSITIVE = process.platform === 'win32'

/**
 * Fold `.` and `..` segments out of a separator-normalised path, lexically.
 *
 * Deliberately not `resolve()`: that also makes the path absolute and collapses
 * it against the process's working directory, which is the opposite of what this
 * is for. Two spellings of one directory only have to compare equal to each
 * other - `<root>/<project>/task` and `<root>/<project>/x/../task` name the same
 * place - and neither of them has to exist for that to be true.
 *
 * A `..` with nothing left to pop is **kept, and nothing after it is folded**.
 * Both halves of that matter. Keeping it means a path that really does climb out
 * of its own root is still spelled with the `..` that says so, rather than being
 * silently rewritten into a path that looks contained. Stopping there means the
 * fold never *invents* a containment: `a/../../b` is not `b` - the first `..`
 * escapes `a` against a directory this text does not know, and once the path has
 * left the frame, no later segment can be folded back into it against the real
 * root. Folding past that point is what would turn a spelling that escapes the
 * container into one that reads as inside it.
 * @param path - a path whose separators are already `/`.
 * @returns the same path with the `..` segments that can be folded, folded.
 */
function foldDotSegments(path) {
  const absolute = path.startsWith('/')
  const segments = []
  let escaped = false
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (!escaped && segments.length > 0 && segments[segments.length - 1] !== '..') {
        segments.pop()
        continue
      }
      // Above the frame this text can account for: kept verbatim, and every
      // segment after it is kept verbatim too.
      escaped = true
      segments.push(segment)
      continue
    }
    segments.push(segment)
  }
  const body = segments.join('/')
  if (absolute) return `/${body}`
  return body
}

/**
 * Reduce a path to a comparison key.
 *
 * Git reports forward-slash paths on Windows while the filesystem hands out
 * backslash paths, so identity checks must never compare raw strings. The key
 * unifies separators, drops trailing separators, and folds case on Windows.
 *
 * Deliberately *lexical and unreduced*: `.` and `..` are left exactly as they
 * were written. Folding them here would look like a tidy-up and is the wrong
 * place for it - this key is the base of `isInside`, `samePathLocation` and
 * `assertIsolated`, whose whole design is two layers: a fast textual comparison,
 * with resolution happening at the boundary that receives an outside path. A
 * fold here would move that job up into the comparison and quietly change what
 * four callers mean by "the same path", including the one that deliberately
 * asserts a `..` is *not* caught lexically so that the resolving boundary can be
 * shown to be what catches it.
 *
 * Callers that need dot-segment equivalence ask for it by name, through
 * {@link reducedPath}.
 * @param value - a path in any of the forms this plugin exchanges.
 * @returns the comparison key.
 */
export function canonicalPath(value) {
  const unified = String(value ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  if (unified === '') return '/'
  return CASE_INSENSITIVE ? unified.toLowerCase() : unified
}

/**
 * The comparison key for a path whose `.` and `..` segments are to be folded.
 *
 * The same key {@link canonicalPath} builds, with the dot segments reduced
 * first - for the callers whose question is about a *location* rather than about
 * the text they were handed. The delete fence is the one that needs it: it is
 * asked about a path assembled from a caller-supplied root and two
 * caller-supplied names, and `<root>/<project>/x/../task` names a task space that
 * a purely textual comparison calls something else - so a delete of it is
 * refused although it is legitimate, which is the failure mode this exists to
 * prevent.
 *
 * The fold is pure text and never touches the filesystem or the working
 * directory. It stops at the first `..` that has nothing left to pop, keeping
 * that segment and every segment after it verbatim: `a/../../b` really does
 * climb out of the frame this text can account for, and folding past that point
 * would turn a spelling that escapes its root into one that reads as inside it.
 * @param value - a path in any of the forms this plugin exchanges.
 * @returns the reduced comparison key.
 */
export function reducedPath(value) {
  const unified = String(value ?? '').replace(/[\\/]+/g, '/')
  const folded = foldDotSegments(unified)
  if (folded === '' || folded === '/') return '/'
  return CASE_INSENSITIVE ? folded.toLowerCase() : folded
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
 * A set of paths reduced to one comparison key.
 *
 * For the callers that identify a *collection* of Workspaces rather than one
 * path: the scan cache files an answer under the set of paths it covered, and
 * the set has to become one string. Deduplicated and sorted, so neither the
 * order a caller happens to list its Workspaces in nor one of them arriving
 * twice can produce a second key for one set.
 * @param values - the paths.
 * @returns the key; empty when nothing usable was given.
 */
export function canonicalPathSet(values) {
  const unique = new Set()
  for (const value of values ?? []) {
    const key = reducedPath(value)
    if (key !== '' && key !== '/') unique.add(key)
  }
  return [...unique].sort().join('\n')
}

/**
 * An externally supplied path, as the absolute path it names.
 *
 * The comparisons in this file are deliberately lexical - each is checked immediately
 * before the operation it guards, against the path this plugin is holding at that
 * moment - and that is exactly why a path from outside has to be resolved before it
 * reaches one. `E:/a/x/../b/c/wt` is not lexically inside `E:/a/b/c`, and yet it
 * resolves to `E:\a\b\c\wt`, which really is: a container root like that passes
 * {@link assertIsolated} while every worktree it holds lands inside the source tree,
 * so the plugin's own "work and source are isolated" invariant reports itself
 * satisfied about the one layout it exists to refuse.
 *
 * So this is the boundary's job and not the comparison's: every caller-supplied or
 * configuration-supplied path goes through here on its way in, and nothing below it
 * has to remember to resolve anything. An empty value stays empty rather than becoming
 * the process's working directory, because "no path was given" is a case the callers
 * already answer in their own words (E1004, E4005) and resolving it would silently
 * turn a missing argument into a real one.
 * @param value - a path as a caller or the configuration spelled it.
 * @returns that path resolved to an absolute one, or an empty string.
 */
export function absolutePath(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text === '' ? '' : resolve(text)
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

/**
 * Raised when a task container would nest with its source root.
 *
 * The code is per-case rather than one for the class: E1001, E1002 and E1003 are
 * three layouts that read alike and are fixed differently - beside that
 * directory, outside it, or not inside it at all - so a reader who has the code
 * knows which one they are looking at without re-reading the message.
 */
export class IsolationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'IsolationError'
    this.code = code
  }
}

/**
 * Reject a task container that is the repositories' directory, sits inside it, or
 * contains it: work and source must stay isolated.
 * @param sourceRoot - the directory holding the source repositories.
 * @param tasksRoot - the proposed task container root.
 * @throws IsolationError when the two layouts nest, carrying E1001, E1002 or E1003.
 */
export function assertIsolated(sourceRoot, tasksRoot) {
  if (samePathLocation(sourceRoot, tasksRoot)) {
    throw new IsolationError('E1001', `the tasks root must not be the repositories' directory itself: ${sourceRoot}`)
  }
  if (isInside(sourceRoot, tasksRoot)) {
    throw new IsolationError(
      'E1002',
      `the tasks root ${tasksRoot} is inside the repositories' directory ${sourceRoot}\n  work and source must be isolated; put the container beside that directory`,
    )
  }
  if (isInside(tasksRoot, sourceRoot)) {
    throw new IsolationError(
      'E1003',
      `the tasks root ${tasksRoot} contains the repositories' directory ${sourceRoot}\n  work and source must be isolated; put the container beside that directory`,
    )
  }
}

/**
 * Raised when a delete would reach outside the container root.
 *
 * A separate class from {@link IsolationError} because it is not a layout the
 * caller can fix by naming a different container: by the time it is raised the
 * container is known and the delete is about to happen. One code, E1005, for the
 * class - every case here is the same thing from a caller's point of view: this
 * delete is refused, nothing was removed.
 */
export class FenceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'FenceError'
    this.code = code
  }
}

/**
 * The real location a path names, for a path that may not exist.
 *
 * `realpathSync` answers only for something on disk, and a delete target is
 * frequently already gone: the fence runs immediately before a removal, and the
 * entry may have been removed by the operation that led here. So the nearest
 * ancestor that does exist is resolved - which is where a junction on the parent
 * chain shows up, and that is the case this exists for - and the segments below
 * it are appended as they were written. Those segments cannot be links, because
 * they are not there.
 *
 * A failure to resolve is *not* answered with the untouched path. Returning it
 * would be fail-open in the one place where being wrong deletes the wrong
 * directory: an unresolvable ancestor is a `realpath` error, not a statement
 * that the path is inside the container.
 * @param value - the path to resolve.
 * @returns its real location, or undefined when it cannot be determined.
 */
function realLocation(value) {
  const text = String(value ?? '')
  if (text === '') return undefined
  const rest = []
  let current = resolve(text)
  for (;;) {
    try {
      const real = realpathSync(current)
      return rest.length === 0 ? real : join(real, ...rest.reverse())
    } catch {
      const parent = dirname(current)
      // The volume root has no parent: nothing above it can answer either.
      if (parent === current) return undefined
      rest.push(current.slice(parent.length).replace(/^[\\/]+/, ''))
      current = parent
    }
  }
}

/**
 * Whether a resolved path is below a resolved root.
 *
 * A separate comparison from {@link isInside} because it is answered on real
 * locations rather than on the strings held: the fence cannot use the lexical
 * one alone without a parent-chain junction defeating it.
 * @param root - the real container root.
 * @param target - the real delete target.
 * @returns whether the target is strictly below the root.
 */
function isInsideReal(root, target) {
  const outer = reducedPath(root)
  const inner = reducedPath(target)
  if (outer === '/' || inner === '/') return false
  return inner !== outer && inner.startsWith(`${outer}/`)
}

/**
 * Refuse a delete whose target is not strictly inside the container root.
 *
 * The container root is the fence every removal in this plugin is held to, and
 * this is where that is enforced rather than assumed. Callers build paths from a
 * caller-supplied root and two caller-supplied names, and a name is a string
 * until it is checked; `../..` in any of the three places a path is assembled is
 * enough to put a recursive delete somewhere else entirely. Rather than trust
 * each call site to have got the arithmetic right, every removal states where it
 * is about to remove from and is refused unless the answer is a strict descendant
 * of the root.
 *
 * Two comparisons, and both have to pass. The lexical one is the historical
 * check and catches every `..` a caller can write. The real one exists because a
 * junction or symbolic link on the *parent chain* defeats it: `<container>/link`
 * where `link` points outside reads as a descendant lexically, and a recursive
 * delete through it reaches the target. Only the real location knows.
 *
 * Failing to resolve either side is a refusal rather than a pass. The fence may
 * distrust an agent but never blocks the user, and this is not that distinction:
 * a path whose real location cannot be determined is a path this cannot promise
 * is inside the container, and there is no correct deletion to protect by
 * guessing.
 * @param tasksRoot - the container root.
 * @param target - the path about to be deleted.
 * @param what - the thing being deleted, named in the refusal.
 * @throws FenceError carrying E1005 when `target` is the root itself or sits outside it.
 */
export function assertInsideContainer(tasksRoot, target, what = 'this path') {
  // Both halves of the fence are asked of the *reduced* key rather than of
  // `canonicalPath`: a path assembled from a root and two names is routinely
  // spelled with segments that a textual comparison cannot see through, and the
  // question here is where the path points, not how it is written.
  const root = reducedPath(tasksRoot)
  const inner = reducedPath(target)
  const inside = inner.startsWith(root.endsWith('/') ? root : `${root}/`)
  if (!inside) {
    throw new FenceError('E1005', `${what} is outside the container root and will not be deleted: ${target}\n  the container root is ${tasksRoot}`)
  }
  const realRoot = realLocation(tasksRoot)
  const realTarget = realLocation(target)
  if (realRoot === undefined || realTarget === undefined) {
    throw new FenceError('E1005', `${what} could not be resolved to a real location, so whether it is inside the container root cannot be shown, and it will not be deleted: ${target}\n  the container root is ${tasksRoot}`)
  }
  if (!isInsideReal(realRoot, realTarget)) {
    throw new FenceError('E1005', `${what} resolves to ${realTarget}, which is outside the container root and will not be deleted: ${target}\n  the container root is ${tasksRoot}`)
  }
}

/**
 * Refuse a task space that is not exactly two levels below the container root.
 *
 * The layout is `<container root>/<project>/<task>`, and finishing a task deletes
 * what it finds under that path - so a path that resolved to one level, or to
 * zero, is not a task space at all but the container or the project layer, and
 * deleting what is under it would take every other task with it. The name
 * validators already refuse the input that could produce such a path; this is
 * the invariant asserted on the result rather than on the inputs, so relaxing a
 * validator later cannot quietly widen what a delete reaches.
 * @param tasksRoot - the container root.
 * @param taskPath - the joined task space path.
 * @throws FenceError carrying E1005 when the path is not two levels below the root.
 */
export function assertTaskSpaceShape(tasksRoot, taskPath) {
  const rest = canonicalPath(taskPath).slice(canonicalPath(tasksRoot).replace(/\/+$/, '').length)
  const segments = rest.split('/').filter((segment) => segment !== '')
  if (segments.length !== 2 || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new FenceError('E1005', `a task space must be <container root>/<project>/<task>; this path is not one and will not be deleted: ${taskPath}`)
  }
}

/**
 * Ask whether a deletion is allowed, and answer with the refusal if it is not.
 *
 * The same two checks {@link assertInsideContainer} and {@link assertRealDirectory}
 * make, shaped for the call sites that must not abort: finishing a task removes one
 * directory at a time, and a refusal is one directory's problem, not the end of the
 * run. An empty string means the delete may go ahead.
 * @param tasksRoot - the container root.
 * @param target - the path about to be deleted.
 * @param what - the thing being deleted, named in the refusal.
 * @returns the reason the delete is refused, or an empty string when it may proceed.
 */
export function refuseDelete(tasksRoot, target, what = 'this path') {
  try {
    // The link test first, and it is not a stylistic order. A junction sitting in the
    // container is *both* "a link" and, once followed, "a path outside the root" - the
    // second is a consequence of the first. Asking the containment question first
    // therefore answers with the symptom and hides the cause, and the cause is the one
    // a reader can act on: a link is a name this plugin will not walk through, and it is
    // the same refusal wherever the link happens to point - into the container or out of
    // it. `assertRealDirectory` is also the cheaper question, answered by one `lstat`.
    assertRealDirectory(target, what)
    assertInsideContainer(tasksRoot, target, what)
    return ''
  } catch (error) {
    return error instanceof FenceError ? error.message : `refusing to delete ${what}: ${target}`
  }
}

/**
 * Refuse to delete a directory that is really a link somewhere else.
 *
 * A junction or symbolic link inside the container is a name, not a location:
 * reading through one reaches the target, and a delete that walked through it
 * would remove files the fence never covered. Node's own recursive removal
 * unlinks such an entry rather than descending it, so this guards the removals
 * git performs, which are its own and answer to none of this plugin's checks.
 * @param path - the directory about to be deleted.
 * @param what - the thing being deleted, named in the refusal.
 * @throws FenceError carrying E1005 when the path is a reparse point.
 */
export function assertRealDirectory(path, what = 'this directory') {
  let stats
  try {
    // `lstat`, not `stat`: `stat` follows the link and answers for the target, so
    // the one question being asked here - is this name a link - comes back false
    // for exactly the entries it exists to catch.
    stats = lstatSync(path)
  } catch {
    // Gone already: there is nothing to delete and nothing to walk into.
    return
  }
  if (stats.isSymbolicLink()) {
    throw new FenceError('E1005', `${what} is a link, not a directory, and will not be deleted: ${path}`)
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

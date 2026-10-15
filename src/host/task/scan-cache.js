/**
 * What the Host remembers of the scan the panel last read.
 *
 * A scan walks the disk and then asks git about every repository and worktree it
 * finds, so a panel that has just been reopened would sit on its skeleton until
 * that finished — even though the answer it showed a moment ago is still a
 * perfectly usable picture. The Host therefore keeps its last answers in process
 * memory, and only there: nothing is written to disk, so a restarted DSH instance
 * starts with an empty cache, exactly as if no panel had ever been opened.
 *
 * A remembered answer is never authoritative. The panel asks for one to paint
 * immediately and scans again in the same breath, so any staleness lasts exactly
 * as long as that scan — which is the whole reason the memory is safe to keep.
 */

import { absolutePath, canonicalPath, canonicalPathSet } from './paths.js'

/** How many Workspace path sets keep the repositories their last scan found. */
export const SCAN_CACHE_LIMIT = 4
/** How many worktree statuses are kept, across every remembered scan. */
export const STATUS_CACHE_LIMIT = 500

/**
 * The key a worktree status is filed and looked up under.
 *
 * A status is stored from the path a request named and read back against the path
 * git printed in the scan that lists that worktree, so the two sides have to be put
 * through the same normalisation or the memory stops matching itself and every
 * status quietly disappears. Resolving is the half that matters: the request
 * boundary resolves the path it is handed (`worktree.status`), which is the same
 * rule every other externally supplied path in this plugin follows, and a lookup
 * that kept the raw spelling would miss the entry the store had just made. A path
 * git already reported is absolute, so this is a no-op for it; a path that is not
 * yet absolute can only be resolved against the process's own directory, which is
 * where it was going to be read from anyway.
 *
 * The `canonicalPath` fold on top is the other half, and it is what makes the
 * three spellings a Windows session really produces one key: the panel's own
 * `E:\Workspace\Proj`, a `resolve()`d `E:\Workspace\Proj\`, and git's forward-slash
 * `E:/Workspace/Proj` are one directory. Folding case and separators is exactly what
 * `canonicalPath` is for, and *not* doing it here was a second, quieter definition
 * of path identity - one that did not fold case while every comparison beside it
 * did.
 * @param value - a worktree path, from a request or from a scan.
 * @returns the key the status map uses.
 */
const statusKey = (value) => canonicalPath(absolutePath(value))

const scans = new Map()
const statuses = new Map()

/**
 * Store one entry, dropping the least recently written one past the limit.
 *
 * A Map iterates in insertion order, and re-inserting an existing key moves it to
 * the end, so the first key is always the one that has gone longest without being
 * refreshed by a scan the panel actually asked for.
 */
const remember = (map, key, value, limit) => {
  map.delete(key)
  map.set(key, value)
  while (map.size > limit) map.delete(map.keys().next().value)
}

/**
 * The identity of a scan: the Workspace paths it covered, and the bounds it ran under.
 *
 * Deduplicated and sorted, so neither the order the panel happens to list its
 * Workspaces in nor one of them arriving twice can miss an entry already held.
 *
 * The bounds are part of the identity, and leaving them out was a real defect
 * rather than an omission: a scan answers "the repositories under these paths",
 * and that answer is a function of how deep the walk went and which directory
 * names it stepped over. Keyed on the paths alone, the shallow answer a panel
 * painted at depth 2 was handed back as the first frame of a depth-3 request -
 * so raising the configured depth appeared to change nothing, and the extra
 * repositories only appeared once the walk behind it finished and overwrote the
 * entry. The bounds travel as data rather than folded into the path key so the
 * two halves of the identity stay readable in a debugger.
 * @param paths - the Workspace paths a request carries.
 * @param bounds - the depth and ignored set the walk ran under, when known.
 * @returns the key; empty when the request named no path.
 */
export function scanKey(paths, bounds = {}) {
  const pathsKey = canonicalPathSet(paths)
  if (pathsKey === '') return ''
  const depth = Number.isFinite(bounds.depth) ? String(bounds.depth) : ''
  // Sorted, because the set a scan was configured with is a set: two configurations
  // that ignore the same names in a different order are one configuration, and
  // keying them apart would halve the cache without making it more correct.
  const ignored = [...(bounds.ignored ?? [])].map((name) => String(name).toLowerCase()).sort().join(',')
  return `${pathsKey}\u0000${depth}\u0000${ignored}`
}

/**
 * Remember the repositories a scan found.
 * @param paths - the Workspace paths the scan covered.
 * @param repositories - the scan's own answer.
 * @param bounds - the depth and ignored set the walk ran under, when known.
 */
export function rememberScan(paths, repositories, bounds = {}) {
  const key = scanKey(paths, bounds)
  if (key === '') return
  remember(scans, key, repositories, SCAN_CACHE_LIMIT)
}

/**
 * Remember one worktree's status.
 *
 * Statuses are keyed by worktree rather than by scan, because the same worktree
 * is the same worktree whichever Workspace set it was scanned through.
 * @param path - the worktree the status describes.
 * @param status - the answer of `worktree.status`.
 */
export function rememberStatus(path, status) {
  const key = statusKey(path)
  if (key === '') return
  remember(statuses, key, status, STATUS_CACHE_LIMIT)
}

/**
 * The remembered answer for a set of Workspace paths.
 *
 * The statuses that come back are only the ones the Host happens to hold: a
 * worktree it has never been asked about is left out rather than guessed at, and
 * the caller — which is scanning again at that very moment — shows it as still
 * being checked, which is true.
 * @param paths - the Workspace paths to answer for.
 * @param bounds - the depth and ignored set the caller is about to scan under; the
 *   remembered answer has to be the one for these bounds, not for any other.
 * @returns the remembered repositories with the statuses they can be given, or
 *   undefined when this Host remembers nothing about these paths at these bounds.
 */
export function recallScan(paths, bounds = {}) {
  const key = scanKey(paths, bounds)
  const repositories = key === '' ? undefined : scans.get(key)
  if (repositories === undefined) return undefined
  const remembered = {}
  for (const repository of repositories) {
    for (const worktree of repository.worktrees ?? []) {
      const status = statuses.get(statusKey(worktree.path))
      if (status !== undefined) remembered[worktree.path] = status
    }
  }
  return { repositories, statuses: remembered }
}

/**
 * Forget every remembered scan and status.
 *
 * The cache's real lifetime is the process, so nothing in production has to call
 * this: it exists for tests, which share one module instance, and as the seam a
 * deployment would use to drop the panel's memory without a restart.
 */
export function clearScanCache() {
  scans.clear()
  statuses.clear()
}

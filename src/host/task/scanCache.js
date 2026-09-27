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

/** How many Workspace path sets keep the repositories their last scan found. */
export const SCAN_CACHE_LIMIT = 4
/** How many worktree statuses are kept, across every remembered scan. */
export const STATUS_CACHE_LIMIT = 500

// A trailing separator is noise for path identity. The entry module's cleanPath
// would say the same, but importing it here would close a cycle back from the
// module that owns this one.
const cleanPath = (value) => {
  const text = String(value ?? '')
  return text.length > 1 ? text.replace(/[\\/]+$/, '') : text
}

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
 * The identity of a scan: the Workspace paths it covered.
 *
 * Deduplicated and sorted, so neither the order the panel happens to list its
 * Workspaces in nor one of them arriving twice can miss an entry already held.
 * @param paths - the Workspace paths a request carries.
 * @returns the key; empty when the request named no path.
 */
export function scanKey(paths) {
  const unique = new Set()
  for (const path of paths ?? []) {
    const cleaned = cleanPath(path)
    if (cleaned !== '') unique.add(cleaned)
  }
  return [...unique].sort().join('\n')
}

/**
 * Remember the repositories a scan found.
 * @param paths - the Workspace paths the scan covered.
 * @param repositories - the scan's own answer.
 */
export function rememberScan(paths, repositories) {
  const key = scanKey(paths)
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
  const key = cleanPath(path)
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
 * @returns the remembered repositories with the statuses they can be given, or
 *   undefined when this Host remembers nothing about these paths.
 */
export function recallScan(paths) {
  const key = scanKey(paths)
  const repositories = key === '' ? undefined : scans.get(key)
  if (repositories === undefined) return undefined
  const remembered = {}
  for (const repository of repositories) {
    for (const worktree of repository.worktrees ?? []) {
      const status = statuses.get(cleanPath(worktree.path))
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

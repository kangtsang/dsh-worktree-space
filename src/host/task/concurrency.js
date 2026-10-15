/**
 * Running several of a panel's questions at once, a few at a time.
 *
 * A scan asks git about every repository it finds, and a panel asks git about
 * every worktree. Those questions are independent, and asking them one at a time
 * is what made a refresh slow: every other stage of the same refresh already
 * runs in parallel, so the serial one was the whole wait.
 *
 * Unbounded `Promise.all` is not the opposite mistake, it is the same one with
 * the sign flipped. Each question here spawns a `git` process, and a hundred of
 * those at once spend their time in process creation competing for each other -
 * which is why the batch in `discoverGitRoots` reads eight directories at a time
 * rather than all of them. The limit is the point: it is a ceiling on how much
 * work is in flight, not a scheduler.
 */

/**
 * How many of those questions may be in flight at once.
 *
 * Here rather than in the entry module, because the entry module is not the only
 * caller that has to obey it and is not a module the others may import: `index.js`
 * imports the task side, so a constant it owned would come back the wrong way
 * round. This file is a leaf - it imports nothing - which is what makes it the one
 * place both sides can read the number from. The entry re-exports it, so its public
 * surface is unchanged.
 */
export const SCAN_CONCURRENCY = 6

/**
 * Apply `worker` to every item with at most `limit` of them in flight, and keep
 * the results in the order the items came in.
 *
 * Order is the input's rather than the completion's: a scan that finished
 * faster for a later repository would otherwise paint its rows in a different
 * order on every refresh, which reads as the list shuffling itself.
 *
 * Nothing here catches. A worker that can fail should decide what that means -
 * a repository that vanished mid-scan is not the scan's failure, and the caller
 * is the only one that knows the difference between that and a real error.
 * @template T, R
 * @param {readonly T[]} items - the work, in the order it should come back.
 * @param {number} limit - how many may be in flight at once; below one is one.
 * @param {(item: T, index: number) => Promise<R>} worker - what to do with each.
 * @returns {Promise<R[]>} every result, in the order of `items`.
 */
export async function mapWithLimit(items, limit, worker) {
  const list = [...items]
  const results = new Array(list.length)
  const width = Math.max(1, Math.trunc(limit) || 1)
  let next = 0
  // `next` is the only thing the runners share and the only thing they race on,
  // and every increment reads it before writing it, so no two take the same slot.
  const run = async () => {
    for (;;) {
      const index = next++
      if (index >= list.length) return
      results[index] = await worker(list[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, list.length) }, run))
  return results
}

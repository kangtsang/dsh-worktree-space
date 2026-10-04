/**
 * Running the panel's per-worktree questions a few at a time.
 *
 * A panel refresh asks the Host for one status per linked worktree, and each of
 * those is a `git` process on the other side. Asking for all of them at once
 * looks like the fast option and is not: they spend their time competing for the
 * same disk and the same process slots. A ceiling in flight costs nothing in
 * correctness and keeps the load flat as the task list grows.
 */

/**
 * Apply `worker` to every item with at most `limit` of them in flight, and keep
 * the results in the order the items came in.
 *
 * Order is the input's rather than the completion's, so the rows stay where the
 * caller put them however the answers race.
 *
 * Nothing here catches: a worker that answers a failure as data should do that
 * itself, and one that throws propagates rather than half-filling the array.
 * @param items - the work, in the order it should come back.
 * @param limit - how many may be in flight at once; below one is one.
 * @param worker - what to do with each item.
 * @returns every result, in the order of `items`.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const list = [...items]
  const results = new Array<R>(list.length)
  const width = Math.max(1, Math.trunc(limit) || 1)
  let next = 0
  // `next` is the only thing the runners share and the only thing they race on,
  // and every increment reads it before writing it, so no two take the same slot.
  const run = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= list.length) return
      results[index] = await worker(list[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, list.length) }, run))
  return results
}

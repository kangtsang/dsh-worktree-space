/**
 * One finish at a time, per task space.
 *
 * Finishing a task is a read-decide-delete sequence with nothing atomic in it: it
 * reads the directory, merges each branch, removes each worktree, files the
 * strays and finally removes the container. Two of those running at once for one
 * task space each read the same directory, each merge, each delete, and the
 * outcome is whichever interleaving the scheduler happened to produce - a panel
 * double-press is enough to ask for exactly that.
 *
 * So finishes of one task space are serialised here, in process. A second caller
 * waits for the first and then runs; by then the space is usually gone, which is
 * the correct outcome and needs no special case - the second run finds no task
 * space and says so, exactly as it would have if it had been asked a moment later.
 *
 * Deliberately not a lock file, and that is a decision rather than an omission. A
 * lock file is held by a process, and a process that is killed leaves it behind:
 * the next finish would find a lock nobody holds and either refuse work that is
 * nobody's fault or have to decide, on a timer, that the owner is dead - which is
 * a guess. In-process state has no such residue, because the process dying takes
 * the lock with it. The realistic double-finish is inside one host process anyway
 * (the panel's own press, or the panel and the tool at once), and that is the case
 * this covers; a second host process finishing the same task space is not a case
 * this plugin creates, and pretending to cover it would buy a stale-lock failure
 * mode instead.
 */

import { canonicalPath } from './paths.js'

/**
 * The chains in flight, keyed by the task space they belong to.
 *
 * The key is the canonical path rather than the string the caller sent, so two
 * spellings of one task space - a trailing separator, the other kind of slash -
 * serialise against each other. `canonicalPath` is the same key every other
 * comparison in this plugin uses, and the value is the tail of the chain: a
 * promise that settles when the last queued call has.
 */
const chains = new Map()

/**
 * Run one operation with exclusive use of a task space.
 *
 * The body runs alone with respect to every other call for the same key, and
 * calls for different keys never wait on each other: two tasks finishing at once
 * is the parallel case this plugin exists for. The lock is released when the body
 * settles, whether it returned or threw, so a failed finish cannot wedge the task
 * space - the next call runs rather than waiting on a rejection that already
 * happened.
 *
 * The returned promise rejects with whatever the body threw, so a caller sees the
 * operation's own failure and not a wrapper around it.
 * @template T
 * @param {string} key - the task space being finished; compared canonically.
 * @param {() => Promise<T>} body - the work to run under the lock.
 * @returns {Promise<T>} the body's own result, or its own rejection.
 */
export function withTaskLock(key, body) {
  const entry = canonicalPath(key)
  // The tail of the chain, and the link this call adds to it. The next caller waits
  // on `mine`, which settles only after this body has, so the queue is a plain
  // promise chain rather than a list to keep in step.
  const previous = chains.get(entry) ?? Promise.resolve()
  let release
  const mine = new Promise((resolve) => { release = resolve })
  chains.set(entry, mine)
  // `previous` is a settled-or-pending link that never rejects: every link in the
  // chain is `mine`-shaped, resolved by `release` rather than by the body's own
  // outcome, so one failure cannot poison the queue for the calls behind it.
  return previous
    .then(() => body())
    .finally(() => {
      release()
      // Only the last link clears the key: a call that finished while another is
      // queued must leave the queued one's chain in place, or the next arrival would
      // start a second chain alongside it and the two would not be serialised.
      if (chains.get(entry) === mine) chains.delete(entry)
    })
}

/**
 * Forget every chain.
 *
 * The lock's real lifetime is the process, so nothing in production calls this:
 * it exists for tests, which share one module instance across files, and as the
 * seam a deployment would use to drop the queue without a restart.
 */
export function clearTaskLocks() {
  chains.clear()
}

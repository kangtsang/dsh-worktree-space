/**
 * One conversation turn at a time, per session.
 *
 * Two of the session tools read and write the same thing: `send` appends a message that the
 * session will answer, and `wait` watches the log for the next reply. Neither is atomic -
 * `send` appends and returns, `wait` polls - so a `wait` that started before a `send` lands
 * sees the reply to **that** message and reports it as the answer to whatever the waiter
 * asked. The waiter gets a plausible, well-formed reply that belongs to somebody else's
 * message, which is worse than an error: nothing about the answer says it is not the one
 * that was waited for.
 *
 * The realistic shape is one agent dispatching a long task and waiting on it while the user,
 * or another agent, sends the session an instruction. Both are ordinary uses of these tools,
 * and nothing in either one is wrong - they simply must not interleave.
 *
 * So the two take turns per session. A second caller waits for the first and then runs,
 * against the state the first left behind, which is what a caller that had arrived a moment
 * later would have seen anyway.
 *
 * ## Why the mechanism is shared with the task lock
 *
 * `withTaskLock` already implements exactly this - a promise chain per key, where a failure
 * does not poison the queue and the key is dropped by the last link - and it lives in
 * `task/task-lock.js` because the task space was the first thing that needed it. Two
 * implementations of "serialise by key" would be the drift this repository keeps finding, so
 * this module is a thin, correctly-named front over the same function rather than a second
 * one: the mechanism is identical and the name says what *this* caller is protecting.
 *
 * The key is namespaced (`session:`), so a session id that happens to equal a task space
 * path cannot make the two wait on each other. They are unrelated resources and there is no
 * reason for a lock on one to block the other.
 */

import { withTaskLock } from './task/task-lock.js'

/**
 * Run one session operation with exclusive use of that session.
 *
 * The body runs alone with respect to every other `send`/`wait` for the same session, and
 * calls for different sessions never wait on each other: waiting on one task while another
 * runs is the parallel case these tools exist for.
 *
 * The returned promise rejects with whatever the body threw, so a caller sees the
 * operation's own failure and not a wrapper around it.
 * @template T
 * @param {string} sessionId - the session being used.
 * @param {() => Promise<T>} body - the work to run under the lock.
 * @returns {Promise<T>} the body's own result, or its own rejection.
 */
export function withSessionTurn(sessionId, body) {
  return withTaskLock(`session:${String(sessionId ?? '')}`, body)
}

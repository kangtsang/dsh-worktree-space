/**
 * Whether a session is still working in a task space, and the refusal that follows.
 *
 * A finish removes the worktrees and the task space itself, so a session whose working
 * directory is inside it loses the ground under it mid-turn: it keeps running, its next
 * write lands in a directory that is gone or on a path that no longer resolves, and the
 * work it was doing is quietly unrecoverable. The operating system blocks the directory
 * removal while a process holds it as its cwd - which is why a finish under a running
 * session leaves an empty task space behind rather than nothing - but that is a lock on
 * Windows, not a decision this plugin made, and it is no protection at all for the
 * worktrees that were already removed.
 *
 * This lives in its own module rather than beside the tool that first needed it, because
 * two callers now ask the same question from two different layers: the tool and the
 * `task.done` endpoint refuse early, and `finishTask` asks again inside its own lock -
 * where the answer is the real one, because nothing can start working between the ask and
 * the removal. The tool imports the operations, so a guard living in the tool could not be
 * called from an operation without a cycle; the question belongs to neither of them.
 */
import { canonicalPath, isInside } from './paths.js'
import { coded } from './codes.js'

/**
 * The sessions still working in one task space, when this deployment can tell.
 *
 * A session counts as working when the registry says it is running, or when its log still
 * holds an open turn, or when its inbox has something queued: the first misses a turn that
 * has ended but whose work is queued, and the last misses a turn that is running but whose
 * inbox is empty. Each is cheap and together they cover the three ways a session can be
 * mid-work.
 *
 * Best effort by construction. A deployment that serves no agent registry cannot be asked,
 * and an unreadable session contributes nothing - the answer is then "nothing found", which
 * is what a finish with no evidence should do rather than block on a question it cannot ask.
 *
 * Exported so the panel can show the answer without computing it a second way: `task.plan`
 * carries these to the dialog, and the dialog's own pre-check reads them rather than asking
 * the session list a narrower question. Two implementations of "is a session working" is
 * exactly how the panel and the endpoint came to disagree once already.
 * @param ctx - the host plugin context.
 * @param taskPath - the task space being finished.
 * @returns the sessions still working in it, most likely first.
 */
export function sessionsWorkingIn(ctx, taskPath) {
  if (typeof ctx?.get !== 'function') return []
  let agents
  try {
    agents = ctx.get('agents')
  } catch {
    return []
  }
  if (agents === undefined || agents === null || typeof agents.list !== 'function') return []
  let listed
  try {
    listed = agents.list()
  } catch {
    return []
  }
  const found = []
  for (const agent of Array.isArray(listed) ? listed : []) {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') continue
    // A session in the task space itself, or in one of the worktrees under it - both lose their
    // ground to the same finish, and the worktree case is the one that is already being removed.
    if (canonicalPath(cwd) !== canonicalPath(taskPath) && !isInside(taskPath, cwd)) continue
    const running = agent.status === 'running'
    const openTurn = turnIsOpen(agent.session)
    const inbox = agent.inbox
    const queued = inbox?.hasPending === true
      || (inbox?.nextTurn?.length ?? 0) + (inbox?.nextStep?.length ?? 0) > 0
    if (!running && !openTurn && !queued) continue
    found.push({ sessionId: String(agent.id), running, openTurn, queued })
  }
  return found
}

/**
 * Whether a session's log still holds a turn that has started and not ended.
 * @param session - the session to read.
 * @returns whether a turn is open.
 */
function turnIsOpen(session) {
  if (session === undefined || session === null || typeof session.snapshotEvents !== 'function') return false
  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return false
  }
  let open = false
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'turn/start') open = true
    if (event?.type === 'turn/end') open = false
  }
  return open
}

/**
 * Refuse a finish while a session is still working in the task space.
 *
 * Refused rather than reported as a warning, because everything a finish does is destructive and
 * most of it is not reversible: the worktrees go, the task space goes, and the session that was
 * mid-write has no way to notice. The caller has two honest ways forward and the message names
 * both - stop the sessions and finish, or leave the space standing.
 *
 * The caller itself is excluded, and that exclusion is what makes the session-finishes-its-own-work
 * flow real. A session that calls `done` is by definition running, with a turn open, in the task
 * space it is asking to remove - so counting it would refuse every self-finish with the caller as
 * its own blocker, and the only escape (cancel yourself first) ends the turn and the reporting with
 * it. It is the caller's own work being torn down, and the caller is the one party that knows
 * whether it is done writing; every *other* session in there is still refused, which is what the
 * guard is for.
 *
 * Exported because the panel's own finish reaches `finishTask` through a different door
 * (`task.done`), and the two must not disagree: a guard on the tool alone would mean the model
 * is refused where the panel is not, which is exactly backwards for the path a person drives.
 * @param ctx - the host plugin context.
 * @param taskPath - the task space being finished.
 * @param callerSessionId - the session asking to finish, left out of the answer when given.
 * @throws Error carrying E5012 when another session is still working there.
 */
export function refuseWhileSessionsWork(ctx, taskPath, callerSessionId = '') {
  const caller = typeof callerSessionId === 'string' ? callerSessionId : ''
  const working = sessionsWorkingIn(ctx, taskPath).filter((entry) => caller === '' || entry.sessionId !== caller)
  if (working.length === 0) return
  const described = working.map((entry) => {
    const why = [
      entry.running ? 'running' : '',
      entry.openTurn ? 'mid-turn' : '',
      entry.queued ? 'with work queued' : '',
    ].filter(Boolean).join(', ')
    return `${entry.sessionId}${why === '' ? '' : ` (${why})`}`
  }).join('; ')
  throw coded(
    'E5012',
    `a session is still working in this task space: ${described}. Finishing removes the worktrees and the `
      + 'task space, so a session that is mid-turn would lose the directory it is writing into and the work '
      + 'it has not committed. Stop those sessions first - `wts_session_tool cancel` stops one, and '
      + '`wts_session_tool status` says what each is doing - then call done again. If the work is not meant to '
      + 'stop, leave the task space standing: it is still there, and nothing has been removed.',
    // Structured as well as spoken, so the panel can say it in the reader's language the way it
    // already does for E5011. The English above is the model's and the log's copy.
    { sessions: working },
  )
}

// The dispatched-session watcher: which turn ends it reports, and that it never breaks the
// session it is watching.
//
// The listener runs inside the harness's append path, so the failure modes that matter are
// (a) reporting a turn that ended fine, (b) missing one that did not, and (c) throwing out of
// the listener. Each is pinned here.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ABNORMAL_TURN_ENDS, MISSING_REPORT_TURN_ENDS, SessionWatch, interruptionNotice, missingReportNotice } from '../src/host/session-watch.js'

/** A session-shaped object, as the event feed hands one over. */
const sessionOf = (id) => ({ id })

/** One `turn/end` event carrying a reason kind. */
const turnEnd = (turn, kind, extra = {}) => ({
  type: 'turn/end',
  seq: turn * 10,
  time: turn * 10,
  data: { turn, reason: { kind, ...extra } },
})

/** The session a fixture dispatches to, and the task it works in. */
const CHILD = 'child-1'
const TASK = 'report'

/** Temporary roots this file made, removed after each test. */
const made = []

afterEach(async () => {
  while (made.length > 0) await rm(made.pop(), { recursive: true, force: true })
})

/** A fresh temporary root, remembered for cleanup. */
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'wts-watch-'))
  made.push(root)
  return root
}

/** The record's session entry, with the one field under test left out by default. */
const sessionEntry = (reportedAt) => ({
  sessionId: CHILD,
  at: '2026-01-01 00:00:00',
  role: 'task',
  ...(reportedAt === undefined ? {} : { reportedAt }),
})

/** The task's own record, as a `done` would leave it just before removing the space. */
const recordOf = (sourceRoot, reportedAt) => ({
  version: 1,
  task: TASK,
  project: 'public',
  branch: 'task/report',
  sourceRoot,
  repositories: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  sessions: [sessionEntry(reportedAt)],
})

/**
 * A task space on disk whose record names the watched session.
 *
 * The live half of the read: `watch()` is handed this path and the watcher reads the record
 * from it. `taskPath` is `<root>/<project>/<task>` on purpose, because the archive lookup
 * derives the project and task names from exactly those two segments.
 * @param reportedAt - the stamp to write, or undefined for a session that never reported.
 * @returns the source root the task was cut from, and the task space path.
 */
async function liveSpace(reportedAt) {
  const root = await tempRoot()
  const sourceRoot = join(root, 'src')
  const taskPath = join(root, 'spaces', 'public', TASK)
  await mkdir(join(taskPath, '.worktree-space'), { recursive: true })
  await writeFile(
    join(taskPath, '.worktree-space', 'worktree-space.json'),
    JSON.stringify(recordOf(sourceRoot, reportedAt)),
    'utf8',
  )
  return { sourceRoot, taskPath }
}

/**
 * Only what a `done` leaves behind: the archived index under the source root, and no task space.
 *
 * The archived half of the read, and the one that matters most: a finished task's directory is
 * removed, so this file is the only place its `sessions[]` survives - which makes it the only
 * thing that can stop the watcher reporting a report that happened.
 * @param reportedAt - the stamp to write, or undefined for a session that never reported.
 * @returns the source root, and the task space path that no longer exists.
 */
async function archivedOnly(reportedAt) {
  const root = await tempRoot()
  const sourceRoot = join(root, 'src')
  const taskPath = join(root, 'spaces', 'public', TASK)
  const archive = join(sourceRoot, '.worktree-space', 'tasks-archive', 'public')
  await mkdir(archive, { recursive: true })
  await writeFile(
    join(archive, '2026-01-02-03-04-05-report.json'),
    JSON.stringify({
      ...recordOf(sourceRoot, reportedAt),
      taskPath,
      createdAt: '2026-01-01 00:00:00',
      updatedAt: '2026-01-02 03:04:05',
      finishedAt: '2026-01-02 03:04:05',
    }),
    'utf8',
  )
  return { sourceRoot, taskPath }
}

/**
 * A watch over a fake host: one ctx that records listeners, one live sender agent.
 * @returns the watcher, the recorded listeners, the sender agent, and the log lines.
 */
function harness({ sender = 'caller-1', live = true } = {}) {
  // Listeners are held with a removed flag rather than spliced, so a stale snapshot cannot
  // deliver to something that has been unsubscribed - which is the behaviour the host has
  // and the one the disposer test depends on.
  const listeners = []
  const logged = []
  const steered = []
  const caller = {
    id: sender,
    steer: (message) => steered.push(message),
  }
  const ctx = {
    on: (name, listener) => {
      const entry = { name, listener, removed: false }
      listeners.push(entry)
      return () => { entry.removed = true }
    },
    get: (name) => name === 'agents'
      ? { get: (id) => (live && id === sender ? caller : undefined) }
      : undefined,
    logger: { warn: (line) => logged.push(line) },
  }
  const watch = new SessionWatch({ ctx, log: (line) => logged.push(line) })
  return { watch, listeners, caller, steered, logged }
}

/**
 * Deliver one event to every registered listener, as the harness does.
 *
 * Awaited by the caller: a `completed` judgement reads a record before it decides, so
 * the listener hands back a promise for that case. Awaiting an abnormal one costs nothing - its
 * notice is already sent by the time the promise is made.
 * @param listeners - the recorded listeners.
 * @param session - the session the event belongs to.
 * @param event - the appended event.
 */
async function feed(listeners, session, event) {
  for (const entry of listeners) {
    if (entry.removed === true) continue
    await entry.listener(session, event)
  }
}

describe('the dispatched-session watcher', () => {
  it('reports each of the four abnormal turn ends, naming the session', () => {
    for (const kind of ['error', 'interrupted', 'blocked', 'max-tokens']) {
      const { watch, listeners, steered } = harness()
      watch.install()
      watch.watch('child-1', 'login', 'caller-1')

      feed(listeners, sessionOf('child-1'), turnEnd(1, kind))

      expect(steered, kind).toHaveLength(1)
      expect(steered[0].content[0].text, kind).toContain('child-1')
      expect(steered[0].content[0].text, kind).toContain('login')
      // The notice has to say the work is unfinished, or a dispatcher may close the task.
      expect(steered[0].content[0].text, kind).toMatch(/NOT finished/)
    }
  })

  // The gap this feature exists for: a member that stops without reporting. `completed` is not a
  // failure, so nothing used to be sent, and a dispatcher that follows its own brief - no long
  // blocking wait - never learned that no report was coming.
  it('reports a completed turn whose session never reported', async () => {
    const { sourceRoot, taskPath } = await liveSpace(undefined)
    const { watch, listeners, steered } = harness()
    watch.install()
    watch.watch(CHILD, TASK, 'caller-1', taskPath, sourceRoot)

    await feed(listeners, sessionOf(CHILD), turnEnd(1, 'completed'))

    expect(steered).toHaveLength(1)
    const text = steered[0].content[0].text
    expect(text).toContain(CHILD)
    expect(text).toContain(TASK)
    // The wording is the feature: the turn did not fail, the report is what is missing.
    expect(text).toMatch(/ended its last turn normally/)
    expect(text).toMatch(/never sent a final report/)
    expect(text).not.toMatch(/NOT finished/)
  })

  it('stays silent for a completed turn whose session reported', async () => {
    // The negative control. Without it, a watcher that reported every completed turn would pass
    // the test above while making the notice worthless.
    const { sourceRoot, taskPath } = await liveSpace('2026-01-02 03:04:05')
    const { watch, listeners, steered } = harness()
    watch.install()
    watch.watch(CHILD, TASK, 'caller-1', taskPath, sourceRoot)

    await feed(listeners, sessionOf(CHILD), turnEnd(1, 'completed'))

    expect(steered).toHaveLength(0)
  })

  // The two cases a `done` creates, and the reason the archive is read at all: the task space is
  // gone by the time the turn ends, so the source root's archive is the only place the answer
  // survives. "Reported, then finished" must not be reported; "finished, never reported" must be
  // - and the two differ only in that one field of that one file.
  it('reads the report out of the source root archive after the task space is gone', async () => {
    const { sourceRoot, taskPath } = await archivedOnly('2026-01-02 03:04:05')
    const { watch, listeners, steered } = harness()
    watch.install()
    watch.watch(CHILD, TASK, 'caller-1', taskPath, sourceRoot)

    await feed(listeners, sessionOf(CHILD), turnEnd(1, 'completed'))

    expect(steered).toHaveLength(0)
  })

  it('reports a finished task whose archived record carries no report', async () => {
    // The same path with one field removed. The pair is the point: the archive read has to be
    // able to answer both ways, or the silence above proves nothing.
    const { sourceRoot, taskPath } = await archivedOnly(undefined)
    const { watch, listeners, steered } = harness()
    watch.install()
    watch.watch(CHILD, TASK, 'caller-1', taskPath, sourceRoot)

    await feed(listeners, sessionOf(CHILD), turnEnd(1, 'completed'))

    expect(steered).toHaveLength(1)
    expect(steered[0].content[0].text).toMatch(/never sent a final report/)
  })

  it('treats a completed turn as unreported when there is no record to read', async () => {
    // A watcher armed without a task path, or a record removed by hand. The answer is "no
    // report" rather than silence: a notice the dispatcher did not need is one sentence, a
    // silent session is the gap this exists to close.
    const { watch, listeners, steered } = harness()
    watch.install()
    watch.watch(CHILD, TASK, 'caller-1')

    await feed(listeners, sessionOf(CHILD), turnEnd(1, 'completed'))

    expect(steered).toHaveLength(1)
  })

  it('reports the same completed turn once, however often the log replays it', async () => {
    const { sourceRoot, taskPath } = await liveSpace(undefined)
    const { watch, listeners, steered } = harness()
    watch.install()
    watch.watch(CHILD, TASK, 'caller-1', taskPath, sourceRoot)

    await feed(listeners, sessionOf(CHILD), turnEnd(1, 'completed'))
    await feed(listeners, sessionOf(CHILD), turnEnd(1, 'completed'))
    expect(steered).toHaveLength(1)

    // A genuinely later turn is a second stopping point, and is reported again.
    await feed(listeners, sessionOf(CHILD), turnEnd(2, 'completed'))
    expect(steered).toHaveLength(2)
  })

  // `aborted` is not the gap. It is a turn something stopped on purpose - the user from the
  // interface, or a dispatcher through `wts_session_tool cancel` - so a session that says nothing
  // after one was not left unfinished, it was stopped. Reporting it would invite the dispatcher
  // to wake a session the user has just decided to stop. There is also nothing to distinguish the
  // two cancellers with: the host's reason is `{ kind: 'aborted', reason: TurnEndCancelCause }`
  // and `TurnEndCancelCause = AgentCancelCause | { kind: 'legacy' }` with `AgentCancelCause` =
  // user | parent | hook{reason} | disposed - no session id anywhere, and the plugin's own
  // `wts_session_tool cancel` passes no caller either. Since neither cancellation is reported,
  // nothing needs distinguishing, and the test is one case rather than three.
  it('stays silent for an aborted turn, whoever stopped it', async () => {
    for (const extra of [{ reason: { kind: 'user' } }, { reason: { kind: 'hook', reason: 'stop' } }, { reason: { kind: 'legacy' } }, {}]) {
      const { sourceRoot, taskPath } = await liveSpace(undefined)
      const { watch, listeners, steered } = harness()
      watch.install()
      watch.watch(CHILD, TASK, 'caller-1', taskPath, sourceRoot)

      await feed(listeners, sessionOf(CHILD), turnEnd(1, 'aborted', extra))

      expect(steered, JSON.stringify(extra)).toHaveLength(0)
    }
  })

  it('stays silent for the kinds that are neither a failure nor a stopping point', async () => {
    // `forked` and anything else the host may add: nothing here says a session stopped without
    // reporting, and inventing a notice for it would be a false alarm.
    for (const kind of ['forked', 'something-new']) {
      const { watch, listeners, steered } = harness()
      watch.install()
      watch.watch(CHILD, TASK, 'caller-1')

      await feed(listeners, sessionOf(CHILD), turnEnd(1, kind))

      expect(steered, kind).toHaveLength(0)
    }
  })

  it('ignores every session it was not asked to watch', () => {
    const { watch, listeners, steered } = harness()
    watch.install()
    watch.watch('child-1', 'login', 'caller-1')

    feed(listeners, sessionOf('somebody-else'), turnEnd(1, 'error'))

    expect(steered).toHaveLength(0)
  })

  it('ignores every event that is not a turn end', () => {
    const { watch, listeners, steered } = harness()
    watch.install()
    watch.watch('child-1', 'login', 'caller-1')

    for (const type of ['user/message', 'assistant/message', 'turn/start', 'step/end', 'session/title']) {
      feed(listeners, sessionOf('child-1'), { type, seq: 1, time: 1, data: {} })
    }

    expect(steered).toHaveLength(0)
  })

  it('reports once per turn, not once per replay of the same turn end', () => {
    // A resumed or replayed log can carry the same `turn/end` again. A second notice would
    // read as a second failure that never happened.
    const { watch, listeners, steered } = harness()
    watch.install()
    watch.watch('child-1', 'login', 'caller-1')

    feed(listeners, sessionOf('child-1'), turnEnd(1, 'error'))
    feed(listeners, sessionOf('child-1'), turnEnd(1, 'error'))
    expect(steered).toHaveLength(1)

    // A genuinely later turn is still reported.
    feed(listeners, sessionOf('child-1'), turnEnd(2, 'error'))
    expect(steered).toHaveLength(2)
  })

  // Two abnormal turns with no `data.turn` in either. Deduplicating on a `-1` sentinel for
  // a missing turn made the second one look like a replay of the first and dropped it -
  // silently, in the direction that matters, because the thing being dropped is the report
  // that a dispatched session died.
  it('reports every abnormal turn that carries no turn number, not just the first', () => {
    const { watch, listeners, steered } = harness()
    watch.install()
    watch.watch('child-1', 'login', 'caller-1')

    const withoutTurn = (seq, kind) => ({ type: 'turn/end', seq, time: seq, data: { reason: { kind } } })
    feed(listeners, sessionOf('child-1'), withoutTurn(10, 'error'))
    feed(listeners, sessionOf('child-1'), withoutTurn(20, 'max-tokens'))
    // Both, and they are different turns: two notices, naming the two kinds.
    expect(steered).toHaveLength(2)
    expect(steered[0].content[0].text).toContain('failed')
    expect(steered[1].content[0].text).toContain('ran out of output room')

    // The negative control for the same rule: the SAME event delivered twice is still one
    // notice, so this is a deduplication and not "report everything twice".
    feed(listeners, sessionOf('child-1'), withoutTurn(20, 'max-tokens'))
    expect(steered).toHaveLength(2)
  })

  it('attributes the notice to the watched session, so it renders as an agent report', () => {    const { watch, listeners, steered } = harness()
    watch.install()
    watch.watch('child-1', 'login', 'caller-1')

    feed(listeners, sessionOf('child-1'), turnEnd(1, 'error'))

    // The same source the subagent channel and wts_session_tool send use, so the receiving
    // interface presents it as an agent's report rather than as the user typing.
    expect(steered[0].source).toEqual({
      kind: 'agent-message',
      form: 'relay',
      senderSessionId: 'child-1',
    })
  })

  it('carries the failure code and message when the turn failed', () => {
    const { watch, listeners, steered } = harness()
    watch.install()
    watch.watch('child-1', 'login', 'caller-1')

    feed(listeners, sessionOf('child-1'), turnEnd(1, 'error', {
      error: { code: 'PI_AI_ERROR', message: 'upstream refused' },
    }))

    expect(steered[0].content[0].text).toContain('PI_AI_ERROR')
    expect(steered[0].content[0].text).toContain('upstream refused')
  })

  it('stops watching a session once told to', () => {
    const { watch, listeners, steered } = harness()
    watch.install()
    watch.watch('child-1', 'login', 'caller-1')
    watch.unwatch('child-1')

    feed(listeners, sessionOf('child-1'), turnEnd(1, 'error'))

    expect(steered).toHaveLength(0)
    expect(watch.watchedIds()).toEqual([])
  })

  it('keeps working when the dispatcher is gone, and says so', () => {
    // The dispatcher may have been closed between dispatch and failure. The notice cannot be
    // delivered, and that has to be recorded rather than thrown.
    const { watch, listeners, steered, logged } = harness({ live: false })
    watch.install()
    watch.watch('child-1', 'login', 'caller-1')

    feed(listeners, sessionOf('child-1'), turnEnd(1, 'error'))

    expect(steered).toHaveLength(0)
    expect(logged.join('\n')).toMatch(/not live/)
  })

  it('never throws out of the event feed, whatever the host hands it', async () => {
    // A throw here would be this plugin breaking a session it was only asked to watch. Since a
    // `completed` judgement awaits a record read, "does not throw" now has two halves: the
    // listener must neither throw synchronously nor hand back a rejected promise, and awaiting
    // the feed is what checks both.
    const { watch, listeners } = harness()
    watch.install()
    watch.watch('child-1', 'login', 'caller-1')

    const rubbish = [
      undefined, null, {}, { type: 'turn/end' },
      { type: 'turn/end', data: {} },
      { type: 'turn/end', data: { turn: 1, reason: {} } },
      { type: 'turn/end', data: { turn: 'x', reason: { kind: 'error' } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: 'not an object' } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 1, message: 2 } } } },
      // The quiet kinds with the shapes they can arrive in: a canceller's id that is not a
      // string, and a record that cannot be read.
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { sessionId: 7 } } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed', reason: null } } },
    ]
    for (const event of rubbish) {
      await expect(feed(listeners, sessionOf('child-1'), event)).resolves.toBeUndefined()
    }
    await expect(feed(listeners, undefined, turnEnd(1, 'error'))).resolves.toBeUndefined()
    await expect(feed(listeners, {}, turnEnd(1, 'error'))).resolves.toBeUndefined()
  })

  it('says a session is watched by id, and re-watching keeps the newest task name', () => {
    const { watch, listeners, steered } = harness()
    watch.install()
    watch.watch('child-1', 'first', 'caller-1')
    watch.watch('child-1', 'second', 'caller-1')

    expect(watch.watchedIds()).toEqual(['child-1'])
    feed(listeners, sessionOf('child-1'), turnEnd(1, 'error'))

    // One notice, naming the newer dispatch rather than both.
    expect(steered).toHaveLength(1)
    expect(steered[0].content[0].text).toContain('second')
  })

  it('reports that it cannot watch at all when the host serves no event feed', () => {
    const logged = []
    const watch = new SessionWatch({ ctx: { logger: { warn: (line) => logged.push(line) } }, log: (line) => logged.push(line) })
    expect(watch.install()).toBe(false)
    expect(logged.join('\n')).toMatch(/no session event feed/)
  })

  // `dispose()` cleared the watch table and set `installed` false without removing the
  // listener, so an `install()` after it attached a second one and every event was judged
  // twice - two notices for one turn. The disposer the host returns is what makes
  // `installed` mean what it says.
  it('unsubscribes on dispose, so a later install does not double-handle every event', () => {
    const { watch, listeners, steered } = harness()
    watch.install()
    expect(listeners).toHaveLength(1)

    watch.dispose()
    expect(listeners[0].removed, 'dispose must remove the listener it installed').toBe(true)

    // Re-armed afterwards, which has to be possible or the unsubscription is a one-way door.
    expect(watch.install()).toBe(true)
    expect(listeners).toHaveLength(2)
    watch.watch('child-1', 'login', 'caller-1')
    feed(listeners, sessionOf('child-1'), turnEnd(1, 'error'))

    // One notice for one turn: the first listener is gone, so it cannot deliver a second.
    expect(steered).toHaveLength(1)
  })

  it('installs once, so a second call on a live watcher adds no listener', () => {
    // The other half: `install()` is idempotent while it is installed, which is what keeps
    // a caller that re-arms defensively from doubling the feed itself.
    const { watch, listeners } = harness()
    expect(watch.install()).toBe(true)
    expect(watch.install()).toBe(true)
    expect(listeners).toHaveLength(1)
  })
})

describe('the interruption notice', () => {
  it('names the task, the session and the next steps, and says the work is unfinished', () => {
    const text = interruptionNotice('login', 'child-1', 'error', 'PI_AI_ERROR: boom')
    expect(text).toContain('login')
    expect(text).toContain('child-1')
    expect(text).toContain('PI_AI_ERROR: boom')
    expect(text).toMatch(/NOT finished/)
    expect(text).toContain('wts_session_tool status')
    expect(text).toContain('wts_session_tool send')
  })

  it('reads sensibly with no task name and no failure detail', () => {
    const text = interruptionNotice('', 'child-1', 'max-tokens', '')
    expect(text).toContain('child-1')
    expect(text).not.toContain('It reported:')
    expect(text).toMatch(/ran out of output room/)
  })

  it('covers exactly the four kinds that mean the work did not get done', () => {
    expect([...ABNORMAL_TURN_ENDS].sort()).toEqual(['blocked', 'error', 'interrupted', 'max-tokens'])
  })
})

describe('the missing-report notice', () => {
  it('says the turn ended normally and only the report is missing', () => {
    const text = missingReportNotice('login', 'child-1')
    expect(text).toContain('login')
    expect(text).toContain('child-1')
    expect(text).toMatch(/ended its last turn normally/)
    expect(text).toMatch(/never sent a final report/)
    expect(text).toMatch(/not a failure of the turn/)
    expect(text).toContain('finalReport: true')
    // The failure notice's warning belongs to a different situation: reusing it here would send
    // a dispatcher hunting for a crash that never happened, and would point it at the tools that
    // put a session back to work.
    expect(text).not.toMatch(/NOT finished/)
    expect(text).not.toContain('was interrupted')
  })

  it('points at the session\'s own output and warns against waking it', () => {
    // The one instruction this notice must not give is "resume it". A session that stopped may
    // have been stopped on purpose, so the notice sends the dispatcher to what the session
    // already produced and says in as many words that this is not a reason to wake it.
    const text = missingReportNotice('login', 'child-1')
    expect(text).toContain('wts_session_tool read')
    expect(text).toContain('wts_session_tool status')
    expect(text).toMatch(/not\*\* as a reason to resume or wake the session/)
  })

  it('reads sensibly with no task name', () => {
    const text = missingReportNotice('', 'child-1')
    expect(text).toContain('child-1')
    expect(text).toMatch(/The dispatched session ended its last turn normally/)
    expect(text).not.toContain('""')
  })

  it('covers exactly the one kind where a missing report is the question', () => {
    // `completed` alone. `aborted` is a turn stopped on purpose, and reporting it would be the
    // plugin inviting a resume of a session the user had just stopped.
    expect([...MISSING_REPORT_TURN_ENDS]).toEqual(['completed'])
  })
})

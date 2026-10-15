// The dispatched-session watcher: which turn ends it reports, and that it never breaks the
// session it is watching.
//
// The listener runs inside the harness's append path, so the failure modes that matter are
// (a) reporting a turn that ended fine, (b) missing one that did not, and (c) throwing out of
// the listener. Each is pinned here.
import { describe, expect, it } from 'vitest'
import { ABNORMAL_TURN_ENDS, SessionWatch, interruptionNotice } from '../src/host/session-watch.js'

/** A session-shaped object, as the event feed hands one over. */
const sessionOf = (id) => ({ id })

/** One `turn/end` event carrying a reason kind. */
const turnEnd = (turn, kind, extra = {}) => ({
  type: 'turn/end',
  seq: turn * 10,
  time: turn * 10,
  data: { turn, reason: { kind, ...extra } },
})

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

/** Deliver one event to every registered listener, as the harness does. */
function feed(listeners, session, event) {
  for (const entry of listeners) {
    if (entry.removed === true) continue
    entry.listener(session, event)
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

  it('says nothing for a turn that completed, or one the user cancelled', () => {
    // `completed` is the work finishing; `aborted` is the user stopping it. Reporting either
    // would be a false alarm on a session that behaved exactly as asked.
    for (const kind of ['completed', 'aborted', 'forked']) {
      const { watch, listeners, steered } = harness()
      watch.install()
      watch.watch('child-1', 'login', 'caller-1')

      feed(listeners, sessionOf('child-1'), turnEnd(1, kind))

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

    // The same source the subagent channel and wts_session_tool_send use, so the receiving
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

  it('never throws out of the event feed, whatever the host hands it', () => {
    // A throw here would be this plugin breaking a session it was only asked to watch.
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
    ]
    for (const event of rubbish) {
      expect(() => feed(listeners, sessionOf('child-1'), event)).not.toThrow()
    }
    expect(() => feed(listeners, undefined, turnEnd(1, 'error'))).not.toThrow()
    expect(() => feed(listeners, {}, turnEnd(1, 'error'))).not.toThrow()
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
    expect(text).toContain('wts_session_tool_status')
    expect(text).toContain('wts_session_tool_send')
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

/**
 * Watching a dispatched session for the turns that end badly, and telling the
 * dispatching agent about them.
 *
 * A task space hands its work to a session of its own. That session can stop without
 * finishing - the model call fails, the output ceiling is hit, a pre-step hook refuses the
 * work, or a crash leaves the turn orphaned and the log is closed after the fact. Nothing
 * tells the dispatcher: it asked once, was answered "started", and from then on the only
 * way to learn that the work died is to poll a session it has no reason to suspect.
 *
 * ## What this watches, and why it is not `agent/turn-stopping`
 *
 * `agent/turn-stopping` fires *before* the turn closes and exists so a listener can keep it
 * alive (that is the hook `dsh-mission-guard` builds its session guard on). This wants the
 * opposite: the turn has already ended, and the question is how. So it watches
 * `session/event`, which the harness documents as a post-commit, fire-and-forget append
 * feed - the listener snapshot resolves before the log push and the callbacks run after it,
 * so the `turn/end` event is readable and committed by the time this sees it.
 *
 * The event is the whole judgement. `turn/end` carries `reason.kind`, and the four kinds
 * that mean "the work did not get done" are the same four `dsh-mission-guard` calls
 * recoverable, for the same reasons:
 *
 * | kind | what happened |
 * | --- | --- |
 * | `error` | the model call or the loop failed permanently |
 * | `interrupted` | a crash orphaned the turn; the log was closed after the fact |
 * | `blocked` | `agent/pre-step` refused it, so not one step ran |
 * | `max-tokens` | at least one step hit its output ceiling |
 *
 * `completed` is the work finishing and `aborted` is the user cancelling it; neither is a
 * failure to report. A report is sent for **every** abnormal turn rather than only the last
 * one, because a session can be given more work after a bad turn and the dispatcher wants to
 * know about the bad one whether or not it turned out to be fatal.
 *
 * ## Why nothing here may throw
 *
 * A `session/event` listener runs inside the append path. The harness contains a throw
 * (it logs and carries on, so a committed append never fails), but a throw here would still
 * be this plugin breaking a session it was only asked to watch - and the dispatcher would
 * learn nothing. Every entry point is wrapped, and a failure is logged instead.
 * @module dsh-worktree-space/session-watch
 */

import { randomUUID } from 'node:crypto'

/** The `turn/end.reason.kind` values that mean the work did not get done. */
export const ABNORMAL_TURN_ENDS = new Set(['error', 'interrupted', 'blocked', 'max-tokens'])

/** How the kind reads in a sentence, for a reader who has not memorised the table. */
const KIND_PHRASES = {
  error: 'failed',
  interrupted: 'was interrupted (the process stopped mid-turn)',
  blocked: 'was refused before it could start',
  'max-tokens': 'ran out of output room before it finished',
}

/**
 * What a watching dispatcher is told, in the words of the event that triggered it.
 * @param kind - the `turn/end.reason.kind`.
 * @returns the clause that follows the session id.
 */
function phraseFor(kind) {
  return KIND_PHRASES[kind] ?? `ended abnormally (${kind})`
}

/**
 * The failure detail a `turn/end` reason carries, when it carries one.
 *
 * Only `error` has a structured failure. It is read defensively: the field is part of the
 * harness's contract but a plugin that read it unguarded would throw out of an event
 * listener the moment the shape changed.
 * @param reason - the turn-end reason.
 * @returns a one-line detail, or '' when there is none.
 */
function failureDetail(reason) {
  const failure = reason?.error
  if (failure === null || typeof failure !== 'object') return ''
  const code = typeof failure.code === 'string' && failure.code !== '' ? failure.code : ''
  const message = typeof failure.message === 'string' && failure.message !== '' ? failure.message : ''
  if (code !== '' && message !== '') return `${code}: ${message}`
  return code !== '' ? code : message
}

/**
 * The message a dispatcher receives about one abnormal turn.
 * @param task - the task name, for a reader who dispatched more than one.
 * @param sessionId - the dispatched session's id.
 * @param kind - the `turn/end.reason.kind`.
 * @param detail - the failure detail, when there is one.
 * @returns the message text.
 */
export function interruptionNotice(task, sessionId, kind, detail) {
  const subject = task === '' ? 'The dispatched session' : `The dispatched session for "${task}"`
  const detailLine = detail === '' ? '' : `\nIt reported: ${detail}`
  return `${subject} ${phraseFor(kind)}.`
    + `\n\nSession id: ${sessionId}`
    + `${detailLine}`
    + '\n\nIt is still there — `wts_session_tool_status` says what it is doing now, `wts_session_tool_read` shows the'
    + ' last messages, and `wts_session_tool_send` can put it back to work. The work was NOT finished, so do not treat'
    + ' this task as done.'
}

/**
 * The session a dispatched task's work runs in, and how to reach the agent that dispatched it.
 *
 * Held per watched session. `sender` is the session id of the dispatching agent - the one the
 * notice is addressed to - and is read when the watch is armed, because by the time a turn
 * ends the caller of the dispatching tool is long gone.
 */
export class SessionWatch {
  /**
   * @param deps - the plugin context and a log sink.
   */
  constructor(deps) {
    this.deps = deps
    /** watched session id -> { task, sender, lastTurn }. */
    this.watched = new Map()
    this.installed = false
    /** The `ctx.on` disposer, when the host returned one. */
    this.unsubscribe = undefined
  }

  /**
   * Start listening. Idempotent, and safe on a host that serves no session service.
   *
   * The disposer `ctx.on` returns is kept rather than dropped, and that is the difference
   * between a listener this instance owns and one it can only stop by being garbage
   * collected. Without it `dispose()` cleared the watch table and set `installed` back to
   * false - so a `dispose()` followed by an `install()` put a **second** listener on the
   * feed, and every event was then handled twice. The host's own disposal of the plugin
   * fibre removes the first one, so this is not about reloads: it is about this object's
   * own lifecycle staying honest, which is what `installed` claims to describe.
   * @returns whether the feed was subscribed to.
   */
  install() {
    if (this.installed) return true
    const ctx = this.deps.ctx
    if (ctx === null || ctx === undefined || typeof ctx.on !== 'function') {
      this.emit('this deployment serves no session event feed, so an interrupted dispatched session cannot be reported')
      return false
    }
    try {
      // A root-context listener sees every session's appends. The handler contains its own
      // failures, because this runs inside another session's append path.
      const off = ctx.on('session/event', (session, event) => {
        try {
          this.onSessionEvent(session, event)
        } catch (error) {
          this.emit(`watching a session event failed: ${String(error?.message ?? error)}`)
        }
      })
      // A host that returns no disposer is one this cannot unregister from, and saying so
      // is better than storing a value that is not callable and failing at disposal time.
      this.unsubscribe = typeof off === 'function' ? off : undefined
      this.installed = true
      return true
    } catch (error) {
      this.emit(`the session event feed could not be subscribed to: ${String(error?.message ?? error)}`)
      return false
    }
  }

  /**
   * Watch one dispatched session.
   *
   * Called right after the work is handed over. Watching is by session id, so a session that
   * was already watched (a second dispatch into the same space) keeps the newest task name and
   * sender rather than accumulating two notices per turn.
   * @param sessionId - the dispatched session.
   * @param task - the task name, for the notice.
   * @param senderSessionId - the dispatching agent's session id, or '' when it has none.
   */
  watch(sessionId, task, senderSessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    this.watched.set(sessionId, {
      task: typeof task === 'string' ? task : '',
      sender: typeof senderSessionId === 'string' ? senderSessionId : '',
      lastKey: undefined,
    })
  }

  /**
   * Stop watching one session.
   *
   * Deliberately has no caller in this plugin, and the review lists that as a finding. It is
   * a design decision rather than an oversight, and the reason is what an entry holds: a
   * session id, the task name to say in a notice, and the id to address it to. None of those
   * expires. `notify` resolves the sending agent afresh each time, so an entry for a session
   * that has gone is inert until a later dispatch into that same session replaces it - and
   * that replacement keeps the newest task and sender rather than accumulating a second.
   *
   * Dropping entries at some event would be worse than keeping them. The obvious candidate
   * is a finish, and that is the moment a dispatched session may still be running - a report
   * about its death is exactly what the dispatcher is waiting for when it goes to look - so
   * a watch cancelled there would suppress the one notice this module exists to deliver.
   * Cancelling on the session's own end would need a signal this module does not receive.
   *
   * The table is therefore bounded by the number of sessions this plugin has dispatched into,
   * which is small and does not grow on its own. It is kept as a method rather than deleted
   * because it is the correct way to stop watching one session, and a deployment that learns
   * a reliable end-of-session signal should call it there rather than reach into the map.
   */
  unwatch(sessionId) {
    this.watched.delete(sessionId)
  }

  /** The session ids currently watched. */
  watchedIds() {
    return [...this.watched.keys()]
  }

  /**
   * Stop everything: the watches, and the subscription itself.
   *
   * Unsubscribing is what makes `installed` mean what it says. Clearing the table and
   * setting the flag false, without removing the listener, describes an instance that is
   * no longer watching while it is still receiving every event - and an `install()` after
   * that would add a second listener, so each event would be judged twice and every notice
   * sent twice. A host that returned no disposer is the one case this cannot undo, and it
   * is reported rather than hidden.
   */
  dispose() {
    this.watched.clear()
    if (this.installed && this.unsubscribe === undefined) {
      this.emit('the session event feed gave no way to unsubscribe, so this listener stays attached until the plugin is unloaded')
    }
    const off = this.unsubscribe
    this.unsubscribe = undefined
    if (typeof off === 'function') {
      try {
        off()
      } catch (error) {
        this.emit(`the session event feed could not be unsubscribed from: ${String(error?.message ?? error)}`)
      }
    }
    this.installed = false
  }

  /**
   * Judge one appended event.
   *
   * Only `turn/end` matters, and only for a session being watched. Everything else returns
   * immediately - this runs for every event of every session in the deployment.
   * @param session - the session whose log grew.
   * @param event - the appended event.
   */
  onSessionEvent(session, event) {
    if (event?.type !== 'turn/end') return
    const sessionId = typeof session?.id === 'string' ? session.id : ''
    if (sessionId === '') return
    const entry = this.watched.get(sessionId)
    if (entry === undefined) return
    const kind = event.data?.reason?.kind
    if (typeof kind !== 'string' || !ABNORMAL_TURN_ENDS.has(kind)) return
    // Reported once per turn: the same turn cannot end twice, but a replayed or resumed log
    // can carry the same `turn/end` again, and a duplicate notice would read as a second
    // failure that never happened.
    //
    // Deduplicated by the event's own identity, and NOT by a sentinel for a missing turn.
    // This used to fall back to `-1` when `data.turn` was absent, which made "this event has
    // no turn number" indistinguishable from "this is turn -1" - so the first such notice
    // was sent, `lastTurn` became `-1`, and **every later abnormal turn without a turn
    // number was silently dropped**. The failure direction was the bad one: a missing field
    // suppressed the report of a session that had died, which is the one thing this module
    // exists to prevent. The log's `seq` is the event's own identity, present whenever the
    // event is real, so it is what the dedup key uses.
    //
    // A missing `seq` is treated as **not a duplicate** rather than as one: reporting a
    // turn twice is a repeated sentence, while missing one is a session nobody hears about.
    const key = typeof event.seq === 'number' ? `seq:${event.seq}` : typeof event.data?.turn === 'number' ? `turn:${event.data.turn}` : ''
    if (key !== '' && entry.lastKey === key) return
    if (key !== '') entry.lastKey = key
    this.notify(entry, sessionId, kind, failureDetail(event.data?.reason))
  }

  /**
   * Deliver one notice to the dispatching session.
   *
   * The report is sent as the watching session's own agent, so the receiving interface
   * attributes it and presents it as an agent's report rather than as the user typing - the
   * same channel `wts_session_tool_send` uses.
   * @param entry - the watch record.
   * @param sessionId - the dispatched session's id.
   * @param kind - the turn-end kind.
   * @param detail - the failure detail, when there is one.
   */
  notify(entry, sessionId, kind, detail) {
    const text = interruptionNotice(entry.task, sessionId, kind, detail)
    const sender = entry.sender
    if (sender === '') {
      // Nobody to address. The watch stays armed - a later dispatch into the same session
      // may name a sender - but there is nothing to deliver to now.
      this.emit(`session ${sessionId} ${phraseFor(kind)}, but the dispatching session is unknown, so nothing was sent`)
      return
    }
    const target = this.agentFor(sender)
    if (target === undefined) {
      this.emit(`session ${sessionId} ${phraseFor(kind)}, but the dispatching session ${sender} is not live, so nothing was sent`)
      return
    }
    try {
      // `steer` rather than `followup`: the dispatcher is usually mid-turn (it is an agent),
      // and a queued notice would sit unread until a boundary a long turn may never reach.
      target.steer({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: sessionId },
      })
      this.emit(`reported to ${sender}: session ${sessionId} ${phraseFor(kind)}`)
    } catch (error) {
      this.emit(`session ${sessionId} ${phraseFor(kind)}, but telling ${sender} failed: ${String(error?.message ?? error)}`)
    }
  }

  /**
   * The live agent for one session id, or undefined.
   * @param sessionId - the session to resolve.
   * @returns the agent, when the registry serves one.
   */
  agentFor(sessionId) {
    const ctx = this.deps.ctx
    if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return undefined
    let agents
    try {
      agents = ctx.get('agents')
    } catch {
      return undefined
    }
    if (agents === undefined || agents === null || typeof agents.get !== 'function') return undefined
    try {
      const agent = agents.get(sessionId)
      return agent === null ? undefined : agent
    } catch {
      return undefined
    }
  }

  /**
   * The log sink. Never throws: it is called from inside another session's append path and
   * from this module's own error handling.
   * @param message - the line to record.
   */
  emit(message) {
    try {
      this.deps.log(message)
    } catch { /* a log that fails must not become the failure */ }
  }
}

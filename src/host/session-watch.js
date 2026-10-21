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
 * `completed` is the work finishing and `aborted` is a turn being cancelled; neither is a
 * failure to report as such. A report is sent for **every** abnormal turn rather than only the last
 * one, because a session can be given more work after a bad turn and the dispatcher wants to
 * know about the bad one whether or not it turned out to be fatal.
 *
 * ## The other gap: a session that stops without reporting
 *
 * A dispatched session is asked to report back when it stops, and a dispatcher that follows
 * its own brief does not sit in a long blocking wait for that report. So a member that finishes
 * its work, ends its turn normally and says nothing leaves the dispatcher waiting for a message
 * that is never coming - and the four abnormal kinds above do not cover it, because nothing
 * went wrong with the session.
 *
 * That is what `reportedAt` answers. `wts_session_tool send` stamps it on the sending session's
 * own entry when the call passes `finalReport: true`, and this module reads it when a watched
 * session's turn ends as `completed`:
 *
 *   - **stamped** - the report arrived; nothing to say;
 *   - **absent, or unreadable** - the session stopped without reporting, and the dispatcher is
 *     told. The read order is the live record first, then the source root's archive, because a
 *     `done` removes the task space and files the index that holds the field into
 *     `<source root>/.worktree-space/tasks-archive/<project>/`. When neither can be read the
 *     answer is "unreported": an unnecessary notice is a sentence read once, where a missing one
 *     is a session nobody hears about.
 *
 * `aborted` is deliberately **not** one of them. It is a turn something stopped on purpose - the
 * user from the interface, or a dispatcher through `wts_session_tool cancel` - so the session did
 * not "finish without reporting", it was made to stop. Telling the dispatcher that a session it
 * cancelled never reported would be worse than noise: it invites exactly the wrong next step, to
 * wake a session the user has just decided to stop. There is also nothing to distinguish the two
 * cancellers with - the event carries a cause kind and no session id at all - and since neither
 * cancellation is reported, nothing needs distinguishing.
 *
 * The notice says the turn ended *normally*, in as many words, and says what not to do with it.
 * It is not the interruption notice and must not read like one: a session that did exactly what it
 * was asked and then stayed quiet is a missing report, not a failure, and the notice therefore
 * points at the session's own last output rather than inviting a resume.
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
import { basename, dirname } from 'node:path'
import { readTaskMetadata, taskSessionsOf } from './task/shared.js'
import { readArchivedTaskSession } from './task/source-index.js'

/** The `turn/end.reason.kind` values that mean the work did not get done. */
export const ABNORMAL_TURN_ENDS = new Set(['error', 'interrupted', 'blocked', 'max-tokens'])

/**
 * The `turn/end.reason.kind` values where a missing report is the thing to notice.
 *
 * One kind, and the number is the point. `completed` is the only turn end that means "the session
 * stopped by itself, and whether it reported is a separate question". `aborted` is a turn
 * something stopped on purpose, so a session that does not report after one was not left
 * unfinished - it was stopped, and the dispatcher is not told. See the module comment.
 */
export const MISSING_REPORT_TURN_ENDS = new Set(['completed'])

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
 * How a completed-but-unreported turn reads in a log line.
 *
 * Deliberately not one of {@link phraseFor}'s clauses: those describe a failure, and a reader
 * skimming the log has to be able to tell this line from them.
 */
const UNREPORTED_PHRASE = 'ended its turn normally without sending a final report'

/**
 * Whether a session entry says a final report was delivered.
 *
 * The test is presence, not content: this module only asks whether the session reported, and
 * the four things a report is supposed to state (the commits, the commands, the evidence, what
 * was not verified) are for the dispatcher to judge, not for a guard to second-guess.
 * @param entry - a normalized session entry, from the record or from an archived index.
 * @returns whether it carries a `reportedAt`.
 */
function hasReport(entry) {
  return typeof entry?.reportedAt === 'string' && entry.reportedAt.trim() !== ''
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
    + '\n\nIt is still there — `wts_session_tool status` says what it is doing now, `wts_session_tool read` shows the'
    + ' last messages, and `wts_session_tool send` can put it back to work. The work was NOT finished, so do not treat'
    + ' this task as done.'
}

/**
 * The message a dispatcher receives when a watched session stops without reporting.
 *
 * The opposite of {@link interruptionNotice} in tone and in what it asks for. That one says the
 * work was not finished, warns against treating the task as done, and offers the tools that put
 * the session back to work. This one says the turn ended normally and only the report is missing
 * - and then deliberately points at what the session already produced rather than at anything
 * that would wake it. A session that stopped may have been stopped on purpose, so a notice that
 * invited a resume would be this plugin undoing a decision that was not its own; the dispatcher
 * reads the session's last output and decides from there.
 * @param task - the task name, for a reader who dispatched more than one.
 * @param sessionId - the dispatched session's id.
 * @returns the message text.
 */
export function missingReportNotice(task, sessionId) {
  const subject = task === '' ? 'The dispatched session' : `The dispatched session for "${task}"`
  return `${subject} ended its last turn normally, but it never sent a final report.`
    + '\n\nThis is not a failure of the turn: nothing here says the work stopped wrongly. What is missing is the report —'
    + ' the session has not called `wts_session_tool send` with `finalReport: true`, so nothing tells you whether the work'
    + ' finished, what it did, or what it left unverified.'
    + `\n\nSession id: ${sessionId}`
    + '\n\nRead what it did before deciding anything: `wts_session_tool read` shows its last messages and'
    + ' `wts_session_tool status` says where it stopped. Treat this notice as a report that is missing, **not** as a reason'
    + ' to resume or wake the session — a session that has stopped may have been stopped on purpose, and its own last'
    + ' output is the first thing to read.'
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
    /** watched session id -> { task, sender, taskPath, sourceRoot, lastKey }. */
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
      // failures, because this runs inside another session's append path - and it can hand
      // back a promise, because deciding whether a `completed` turn was reported means reading
      // a record. A rejection there must not surface as an unhandled one in the append path,
      // so it is caught here; the promise is still returned, so a caller that wants to know
      // when the judgement finished can wait for it.
      const off = ctx.on('session/event', (session, event) => {
        let outcome
        try {
          outcome = this.onSessionEvent(session, event)
        } catch (error) {
          this.emit(`watching a session event failed: ${String(error?.message ?? error)}`)
          return undefined
        }
        if (outcome !== null && typeof outcome === 'object' && typeof outcome.then === 'function') {
          outcome.catch((error) => this.emit(`watching a session event failed: ${String(error?.message ?? error)}`))
        }
        return outcome
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
   *
   * `taskPath` and `sourceRoot` are where a later "did it report?" is answered from, and they
   * are captured here because by the time a turn ends they may be gone: `done` removes the task
   * space and files its index under the source root. `taskPath` locates the live record, and
   * the source root locates the archive once the record is not there. Both are optional - a
   * caller with neither cannot be asked the question, and the answer given then is "no report".
   * @param sessionId - the dispatched session.
   * @param task - the task name, for the notice.
   * @param senderSessionId - the dispatching agent's session id, or '' when it has none.
   * @param taskPath - the task space directory, or '' when the caller has none.
   * @param sourceRoot - the workspace root the task was cut from, or ''.
   */
  watch(sessionId, task, senderSessionId, taskPath = '', sourceRoot = '') {
    if (typeof sessionId !== 'string' || sessionId === '') return
    this.watched.set(sessionId, {
      task: typeof task === 'string' ? task : '',
      sender: typeof senderSessionId === 'string' ? senderSessionId : '',
      taskPath: typeof taskPath === 'string' ? taskPath : '',
      sourceRoot: typeof sourceRoot === 'string' ? sourceRoot : '',
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
   *
   * An abnormal kind notifies straight away and returns. A `completed` turn notifies only once
   * the session's own record has been asked whether a final report was delivered, which is why
   * this is `async`: the answer comes from a file, and after a `done` that file is the archived
   * index under the source root. It never rejects; the listener that calls it catches anyway.
   *
   * `aborted` is neither: it is a turn something stopped on purpose, so it is not reported at
   * all. The module comment says why.
   * @param session - the session whose log grew.
   * @param event - the appended event.
   * @returns nothing, or a promise that settles when a completed turn has been judged.
   */
  async onSessionEvent(session, event) {
    if (event?.type !== 'turn/end') return
    const sessionId = typeof session?.id === 'string' ? session.id : ''
    if (sessionId === '') return
    const entry = this.watched.get(sessionId)
    if (entry === undefined) return
    const reason = event.data?.reason
    const kind = reason?.kind
    if (typeof kind !== 'string') return
    const abnormal = ABNORMAL_TURN_ENDS.has(kind)
    if (!abnormal && !MISSING_REPORT_TURN_ENDS.has(kind)) return
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
    if (abnormal) {
      this.notify(entry, sessionId, kind, failureDetail(reason))
      return
    }
    // The turn was not a failure and was not a cancellation - the session stopped by itself. So
    // the only question left is whether it handed its report over before it did.
    if (await this.reported(entry, sessionId)) return
    this.notifyMissingReport(entry, sessionId)
  }

  /**
   * Whether this session delivered its final report, as far as anything on disk can say.
   *
   * Two places are asked, in the order that matters. The live record is the authority while the
   * task space exists. Once it does not - a `done` removes the space and files the index under
   * the source root - the archived index is the only copy left, and it is read from the
   * project and task the watched `taskPath` was built from, which is why `watch` keeps that path
   * rather than only the task name.
   *
   * An unreadable answer is "no report". Both reads are best-effort by nature (the file may be
   * gone, unreadable, or hand-edited), and the direction of the mistake is chosen deliberately:
   * a notice the dispatcher did not need is one sentence, where a silent session is the gap this
   * module exists to close.
   * @param entry - the watch record, carrying the task path and the source root.
   * @param sessionId - the session that just ended a turn.
   * @returns whether a report is on record.
   */
  async reported(entry, sessionId) {
    const taskPath = entry.taskPath
    if (taskPath !== '') {
      const metadata = await readTaskMetadata(taskPath).catch(() => undefined)
      if (metadata !== undefined && metadata !== null) {
        const found = taskSessionsOf(metadata).find((one) => one.sessionId === sessionId)
        // The live record is the authority: once it exists and names the session, its answer is
        // the answer, and consulting an archive behind it could only resurrect a stale one.
        if (found !== undefined) return hasReport(found)
      }
    }
    if (entry.sourceRoot !== '') {
      const task = taskPath === '' ? entry.task : basename(taskPath)
      const project = taskPath === '' ? '' : basename(dirname(taskPath))
      if (project !== '' && task !== '') {
        const archived = await readArchivedTaskSession(entry.sourceRoot, project, task, sessionId).catch(() => undefined)
        if (archived !== undefined) return hasReport(archived)
      }
    }
    return false
  }

  /**
   * Deliver one notice to the dispatching session.
   *
   * The report is sent as the watching session's own agent, so the receiving interface
   * attributes it and presents it as an agent's report rather than as the user typing - the
   * same channel `wts_session_tool send` uses.
   * @param entry - the watch record.
   * @param sessionId - the dispatched session's id.
   * @param kind - the turn-end kind.
   * @param detail - the failure detail, when there is one.
   */
  notify(entry, sessionId, kind, detail) {
    this.deliver(entry, sessionId, phraseFor(kind), interruptionNotice(entry.task, sessionId, kind, detail))
  }

  /**
   * The same delivery, for a session that ended without reporting.
   *
   * A separate entry point rather than a flag because the two notices are different documents:
   * one says the work was not finished, the other says the turn ended normally and only the
   * report is missing. What they share is the channel and the addressee, which is what
   * {@link deliver} holds.
   * @param entry - the watch record.
   * @param sessionId - the dispatched session's id.
   */
  notifyMissingReport(entry, sessionId) {
    this.deliver(entry, sessionId, UNREPORTED_PHRASE, missingReportNotice(entry.task, sessionId))
  }

  /**
   * Send one notice to the dispatching session, or say why it could not be sent.
   * @param entry - the watch record.
   * @param sessionId - the dispatched session's id.
   * @param phrase - how the turn end reads in a log line.
   * @param text - the message body.
   */
  deliver(entry, sessionId, phrase, text) {
    const sender = entry.sender
    if (sender === '') {
      // Nobody to address. The watch stays armed - a later dispatch into the same session
      // may name a sender - but there is nothing to deliver to now.
      this.emit(`session ${sessionId} ${phrase}, but the dispatching session is unknown, so nothing was sent`)
      return
    }
    const target = this.agentFor(sender)
    if (target === undefined) {
      this.emit(`session ${sessionId} ${phrase}, but the dispatching session ${sender} is not live, so nothing was sent`)
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
      this.emit(`reported to ${sender}: session ${sessionId} ${phrase}`)
    } catch (error) {
      this.emit(`session ${sessionId} ${phrase}, but telling ${sender} failed: ${String(error?.message ?? error)}`)
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

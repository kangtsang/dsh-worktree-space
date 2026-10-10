/**
 * The session-control tools: watching, correcting and recovering the sessions a
 * task space is worked in.
 *
 * A task space hands its work to a session of its own — its own context, its own
 * approval gate, its own working directory — and the session that dispatched it is
 * **not** its parent, so the ordinary parent/child channel refuses to reach it
 * (`send_message` answers `belongs to another parent session`). These eight tools
 * are the only way the dispatching session can ask whether that work is still
 * moving, what it is doing, and to say something to it.
 *
 * The set is deliberately smaller than the session-bridge plugin it mirrors
 * (`dsh-session-bridge`, `mission_guard_*`): no watchdog and no automatic
 * steer/cancel, no archive/unarchive, no chain-of-thought rules, no config tool.
 * Those were left out because the dispatching session is already the decision
 * maker — a second one that steers or kills on its own is worse at it — and
 * because they are not about a task space at all.
 *
 * Two rules run through the whole file:
 *
 *  1. **Every capability is probed, never assumed.** A deployment may serve no
 *     session registry, no persistence, no workspace registry, no title service.
 *     A tool whose service is missing answers that this deployment does not offer
 *     it — it never throws a `TypeError` out of a service lookup, because a model
 *     reading a stack trace learns nothing it can act on.
 *  2. **A value that goes back to the model is lossless JSON.** The Host rejects a
 *     tool result containing `undefined` outright (`value is not lossless JSON`),
 *     which turns one absent optional field into a tool that is completely
 *     unusable. Every return goes through {@link toLosslessJson}, which drops an
 *     absent key rather than carrying `undefined`.
 */
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** How long a wait may block, and how long it blocks by default. */
const MAX_WAIT_MS = 3_600_000
const DEFAULT_WAIT_MS = 180_000

/** How many messages a read returns by default, and at most. */
const DEFAULT_READ_LIMIT = 20
const MAX_READ_LIMIT = 100

/** How many sessions a find returns by default, and at most. */
const DEFAULT_FIND_LIMIT = 10
const MAX_FIND_LIMIT = 50

/** How many recent rows a status carries by default, and at most. */
const DEFAULT_RECENT = 8
const MAX_RECENT = 20

/** Characters of a reasoning tail a status keeps before it truncates. */
const REASONING_TAIL_LIMIT = 4000

/** How many offline sessions a find resolves a title for, at most. */
const OFFLINE_TITLE_BUDGET = 30

/** How many recent messages a result card carries. */
const CARD_ROW_LIMIT = 8

/**
 * Read a service from the host context, tolerantly.
 *
 * `ctx.get` may be absent entirely (a bare context double), may throw, and answers
 * `undefined` for a service this deployment does not serve — all three mean the
 * same thing here: there is nothing to call.
 * @param ctx - the host plugin context.
 * @param name - the service name.
 * @returns the service, or undefined.
 */
function service(ctx, name) {
  if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return undefined
  let value
  try {
    value = ctx.get(name)
  } catch {
    return undefined
  }
  return value === null ? undefined : value
}

/**
 * The live-agent registry, when this deployment serves one.
 *
 * Probed per call rather than captured at registration: the tool half mounts
 * whether or not the session half exists, and the answer to "is it there" can
 * change with the deployment, not with the tool.
 * @param ctx - the host plugin context.
 * @returns the registry, or undefined.
 */
function agentsOf(ctx) {
  const agents = service(ctx, 'agents')
  return agents !== undefined && typeof agents.get === 'function' ? agents : undefined
}

/** The sentence a tool answers with when the live-agent registry is not served. */
const NO_AGENTS = 'this deployment does not offer the session registry (the `agents` service), '
  + 'so no live session can be inspected, messaged, waited on or stopped'

/** The sentence a tool answers with when nothing can enumerate sessions at all. */
const NO_SESSION_LISTING = 'this deployment does not offer the session registry or session persistence, '
  + 'so no session can be located'

/** The sentence a tool answers with when a session cannot be resumed. */
const NO_RESUME = 'this deployment does not offer the live-agent registry (the `agents` service) or session '
  + 'persistence, so a session cannot be brought back online'

/** The sentence a tool answers with when no session can be opened. */
const NO_CREATE = 'this deployment does not offer the session service (`sessionController`) or the live-agent '
  + 'registry (`agents`), so no session can be opened'

/**
 * The answer a tool gives when the capability it needs is not served at all.
 *
 * `offered: false` is reserved for exactly this, so a caller can tell "this
 * deployment cannot do that" (choose another route) from "that session is not
 * usable" (resume it, or name another one) — see {@link unavailable}. Returned
 * rather than thrown: the missing service is a fact about the deployment, not a
 * mistake the caller made, and a caller told "not offered" can choose another
 * route where a caller holding a stack trace cannot.
 * @param reason - which capability is missing, in one sentence.
 * @returns the canonical value of a refused call.
 */
function refusal(reason) {
  return { offered: false, sessionId: '', summary: reason, reason }
}

/**
 * The answer a tool gives when the deployment can do this, but not to that session.
 *
 * A session that is offline, or one this deployment has never heard of, is a
 * different answer from a missing service: the route to it is to resume it, or to
 * locate the one that is there. Saying `offered: false` for both would make the
 * flag useless for the decision it exists to inform.
 * @param sessionId - the session that could not be used.
 * @param reason - why not, in one sentence.
 * @returns the canonical value of an unusable-target answer.
 */
function unavailable(sessionId, reason) {
  return { offered: true, sessionId, summary: reason, reason }
}

/** Fold a possibly-throwing accessor into undefined. */
function safely(read) {
  try {
    return read()
  } catch {
    return undefined
  }
}

/** Losslessly drop `undefined` from a tool result; see the module comment. */
function toLosslessJson(value, seen = new Set()) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'bigint') return value.toString()
  if (type === 'undefined' || type === 'function' || type === 'symbol') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (Array.isArray(value)) {
    if (seen.has(value)) return null
    seen.add(value)
    const out = value.map((item) => {
      const kind = typeof item
      if (item === undefined || kind === 'function' || kind === 'symbol') return null
      return toLosslessJson(item, seen)
    })
    seen.delete(value)
    return out
  }
  if (type === 'object') {
    if (seen.has(value)) return null
    seen.add(value)
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      const kind = typeof item
      if (kind === 'function' || kind === 'symbol') continue
      out[key] = toLosslessJson(item, seen)
    }
    seen.delete(value)
    return out
  }
  return null
}

/** {@link toLosslessJson}, for a value that is an object. */
function asJson(value) {
  return toLosslessJson(value)
}

/**
 * The event log of a session, across the two shapes dsh-session has had.
 *
 * Older versions expose `events` as a getter; newer ones replaced it with
 * `snapshotEvents()`, where reading `.events` gives `undefined` and iterating it
 * throws. Neither shape being readable is an empty log, never an error.
 * @param session - a live session.
 * @returns the events, possibly empty.
 */
function sessionEvents(session) {
  if (session === null || session === undefined) return []
  if (Array.isArray(session.events)) return session.events
  if (typeof session.snapshotEvents === 'function') {
    const events = safely(() => session.snapshotEvents())
    return Array.isArray(events) ? events : []
  }
  return []
}

/** The text blocks of a message's content, joined; undefined when there are none. */
function blockText(content) {
  if (!Array.isArray(content)) return undefined
  const parts = []
  for (const raw of content) {
    if (raw !== null && typeof raw === 'object' && raw.type === 'text' && typeof raw.text === 'string' && raw.text !== '') {
      parts.push(raw.text)
    }
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/** The text of one content-block type (e.g. `reasoning`); undefined when absent. */
function blockTextByType(content, wanted) {
  if (!Array.isArray(content)) return undefined
  const parts = []
  for (const raw of content) {
    if (raw !== null && typeof raw === 'object' && raw.type === wanted && typeof raw.text === 'string' && raw.text !== '') {
      parts.push(raw.text)
    }
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/** How many image blocks a message carries. */
function countImages(content) {
  if (!Array.isArray(content)) return 0
  return content.filter((raw) => raw !== null && typeof raw === 'object' && raw.type === 'image').length
}

/** The distinct tool names a message called. */
function toolNamesOf(toolCalls) {
  if (!Array.isArray(toolCalls)) return []
  const names = []
  for (const raw of toolCalls) {
    if (raw !== null && typeof raw === 'object' && typeof raw.name === 'string' && !names.includes(raw.name)) names.push(raw.name)
  }
  return names
}

/**
 * Fold an event log into the readable rows a reader pages through.
 * @param events - the session's events.
 * @returns one row per user or assistant message, in event order.
 */
function foldMessages(events) {
  const rows = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (source !== undefined && source.kind !== 'user') continue
      const text = blockText(event.data?.content)
      if (text === undefined) continue
      rows.push({ seq: event.seq, time: event.time, role: 'user', text, images: countImages(event.data?.content) })
    } else if (event.type === 'assistant/message') {
      const message = event.data?.message ?? null
      const text = message === null ? undefined : blockText(message.content)
      // Reasoning has lived in two places: a `reasoning` content block (current)
      // and a `message.reasoning` field (older). Both are read, block first.
      const reasoning = message === null
        ? undefined
        : (blockTextByType(message.content, 'reasoning') ?? blockText(message.reasoning))
      const toolCalls = message === null ? [] : toolNamesOf(message.toolCalls)
      if (text === undefined && reasoning === undefined && toolCalls.length === 0) continue
      const row = { seq: event.seq, time: event.time, role: 'assistant', images: message === null ? 0 : countImages(message.content) }
      if (text !== undefined) row.text = text
      if (reasoning !== undefined) row.reasoning = reasoning
      if (toolCalls.length > 0) row.toolCalls = toolCalls
      rows.push(row)
    }
  }
  return rows
}

/**
 * A session's title: the last `session/title` event, else the first user message.
 * @param events - the session's events.
 * @returns the title, or undefined when the log carries neither.
 */
function titleOf(events) {
  let title
  for (const event of Array.isArray(events) ? events : []) {
    if (event.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title !== '') {
      title = event.data.title
    }
  }
  if (title !== undefined) return title
  for (const event of Array.isArray(events) ? events : []) {
    if (event.type !== 'user/message') continue
    const source = event.data?.source
    if (source !== undefined && source.kind !== 'user') continue
    const text = blockText(event.data?.content)
    if (text === undefined) continue
    const trimmed = text.replace(/\s+/g, ' ').trim()
    return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed
  }
  return undefined
}

/** The largest event seq in a log; -1 when it is empty. */
function maxSeq(events) {
  let largest = -1
  for (const event of Array.isArray(events) ? events : []) {
    if (typeof event.seq === 'number' && event.seq > largest) largest = event.seq
  }
  return largest
}

/**
 * The in-flight reasoning and text deltas of a live session.
 *
 * The stream is carried two ways across dsh versions: in the `stream` records of
 * the newest `assistant/message` / `assistant/attempt` event (current), or as
 * standalone `assistant/chunk` events before the last finalized message (older).
 * Both are read; a session with neither returns null.
 * @param events - the session's events.
 * @returns the accumulated slice, or null when nothing is streaming.
 */
function liveReasoningSnapshot(events) {
  let lastFinalizedSeq = -1
  let reasoning = ''
  let text = ''
  let found = false
  for (const event of Array.isArray(events) ? events : []) {
    const type = event.type
    if (type === 'assistant/message' || type === 'assistant/attempt') {
      const data = event.data ?? {}
      if (Array.isArray(data.stream)) {
        let streamedReasoning = ''
        let streamedText = ''
        for (const raw of data.stream) {
          if (raw === null || typeof raw !== 'object') continue
          if (raw.type === 'reasoning-chunks' && Array.isArray(raw.texts)) {
            for (const piece of raw.texts) if (typeof piece === 'string') streamedReasoning += piece
          } else if (raw.type === 'text-chunks' && Array.isArray(raw.texts)) {
            for (const piece of raw.texts) if (typeof piece === 'string') streamedText += piece
          } else if (raw.type === 'chunk' && raw.chunk !== null && typeof raw.chunk === 'object') {
            if (raw.chunk.type === 'reasoning-delta' && typeof raw.chunk.text === 'string') streamedReasoning += raw.chunk.text
            else if (raw.chunk.type === 'text-delta' && typeof raw.chunk.text === 'string') streamedText += raw.chunk.text
          }
        }
        if (streamedReasoning !== '' || streamedText !== '') {
          reasoning = streamedReasoning
          text = streamedText
          found = true
        }
      }
      if (type === 'assistant/message') lastFinalizedSeq = event.seq
      continue
    }
    if (type !== 'assistant/chunk' || event.seq <= lastFinalizedSeq) continue
    const chunk = event.data?.chunk
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') { reasoning += chunk.text; found = true }
    else if (chunk.type === 'text-delta' && typeof chunk.text === 'string') { text += chunk.text; found = true }
  }
  return found ? { reasoning, text } : null
}

/**
 * A bounded reasoning tail: the in-flight text first, else the last finalized one.
 * @param liveReasoning - the in-flight reasoning, if any.
 * @param lastReasoning - the last finalized reasoning, if any.
 * @returns the tail, or undefined when there is none.
 */
function reasoningTailOf(liveReasoning, lastReasoning) {
  const source = liveReasoning ?? lastReasoning
  if (source === undefined || source === '') return undefined
  return source.length <= REASONING_TAIL_LIMIT ? source : `${source.slice(0, REASONING_TAIL_LIMIT)}…`
}

/**
 * The most recent `turn/end`, with the retries that turn already burned.
 *
 * This is the one signal that separates "the task finished" from "an error killed
 * the turn and the session went quiet": both look like idle with no pending work.
 * @param events - the session's events.
 * @returns the turn's ending, or undefined when no turn has ended.
 */
function lastTurnEndOf(events) {
  const retriesByTurn = new Map()
  let last
  for (const event of Array.isArray(events) ? events : []) {
    const type = event.type
    if (type === 'llm/retry') {
      const turn = event.data?.turn
      if (typeof turn === 'number') retriesByTurn.set(turn, (retriesByTurn.get(turn) ?? 0) + 1)
      continue
    }
    if (type !== 'turn/end') continue
    const data = event.data ?? {}
    const turn = typeof data.turn === 'number' ? data.turn : 0
    const reason = data.reason ?? {}
    const kind = typeof reason.kind === 'string' ? reason.kind : 'unknown'
    const entry = { turn, seq: event.seq, time: event.time, kind, retriesScheduled: retriesByTurn.get(turn) ?? 0 }
    if (kind === 'error' && reason.error !== null && typeof reason.error === 'object' && typeof reason.error.code === 'string') {
      entry.failure = {
        message: typeof reason.error.message === 'string' ? reason.error.message : '',
        code: reason.error.code,
        ...(typeof reason.error.status === 'number' ? { status: reason.error.status } : {}),
      }
    }
    if (kind === 'aborted' && typeof reason.reason?.kind === 'string') entry.cancelCause = reason.reason.kind
    last = entry
  }
  return last
}

/**
 * A snapshot of one live session: what a watcher decides on.
 *
 * `lastActivityAt` is the time of the newest event and `stalledMs` is how long ago
 * that was. They are the only reliable answer to "stuck or busy": during a long
 * build, a file's mtime, a log's tail and a worktree's state all sit still, while
 * the session's own log keeps its own clock.
 * @param ctx - the host plugin context.
 * @param agent - the live agent.
 * @param liveActivityAt - the arrival time of an in-flight chunk, when the caller knows one.
 * @returns the snapshot, without any `undefined` value.
 */
function statusSnapshot(ctx, agent, liveActivityAt) {
  const events = sessionEvents(agent.session)
  const rows = foldMessages(events)
  let lastActivityAt = null
  let lastTurn = 0
  let openTurn = false
  let stepStartAt = null
  let lastStepDurationMs = null
  for (const event of events) {
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      const turn = event.data?.turn
      if (typeof turn === 'number' && turn > 0) lastTurn = turn
    }
    if (event.type === 'turn/start') openTurn = true
    if (event.type === 'turn/end') openTurn = false
    const closesStep = event.type === 'assistant/message' || event.type === 'assistant/attempt' || String(event.type).startsWith('tool/')
    if (closesStep && stepStartAt !== null) {
      lastStepDurationMs = Math.max(0, event.time - stepStartAt)
      stepStartAt = null
    }
    if (event.type === 'turn/start' || event.type === 'user/message' || closesStep) stepStartAt = event.time
    if (typeof event.time === 'number' && event.time > (lastActivityAt ?? 0)) lastActivityAt = event.time
  }
  let lastReply
  let lastReasoning
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row.role !== 'assistant') continue
    if (lastReply === undefined && row.text !== undefined) lastReply = row.text
    if (lastReasoning === undefined && row.reasoning !== undefined) lastReasoning = row.reasoning
    if (lastReply !== undefined && lastReasoning !== undefined) break
  }
  const live = liveReasoningSnapshot(events)
  const liveReasoning = live !== null && live.reasoning !== '' ? live.reasoning : undefined
  const liveText = live !== null && live.text !== '' ? live.text : undefined
  const reasoningTail = reasoningTailOf(liveReasoning, lastReasoning)
  const lastTurnEnd = lastTurnEndOf(events)
  const inbox = agent.inbox
  const cwd = agent.session?.header?.cwd
  const rawIdle = lastActivityAt === null ? null : Date.now() - lastActivityAt
  // The in-flight stream is the other half of "how long since anything happened":
  // dsh appends nothing to the log while a message streams, so a long answer would
  // otherwise age into looking stuck.
  const stalledMs = rawIdle === null || liveActivityAt === undefined || liveActivityAt <= 0
    ? rawIdle
    : Math.min(rawIdle, Math.max(0, Date.now() - liveActivityAt))
  return {
    sessionId: agent.id,
    live: true,
    status: agent.status,
    running: agent.status === 'running',
    ...(titleOf(events) === undefined ? {} : { title: titleOf(events) }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(workspaceByPath(ctx, cwd) === undefined ? {} : { workspaceId: workspaceByPath(ctx, cwd) }),
    openTurn,
    lastTurn,
    lastActivityAt,
    ...(rawIdle === null ? {} : { rawStalledMs: rawIdle }),
    stalledMs,
    ...(lastStepDurationMs === null ? {} : { lastStepDurationMs }),
    // Two inbox shapes: a `hasPending` getter (older dsh) and the two pending
    // arrays (current). Reading only one of them reports "nothing queued" on the
    // other, which is exactly the fact a caller is here to learn.
    pendingWork: inbox?.hasPending === true || (inbox?.nextTurn?.length ?? 0) + (inbox?.nextStep?.length ?? 0) > 0,
    nextTurnCount: inbox?.nextTurn?.length ?? 0,
    nextStepCount: inbox?.nextStep?.length ?? 0,
    ...(lastReply === undefined ? {} : { lastReply }),
    ...(lastReasoning === undefined ? {} : { lastReasoning }),
    ...(liveReasoning === undefined ? {} : { liveReasoning }),
    ...(liveText === undefined ? {} : { liveText }),
    ...(reasoningTail === undefined ? {} : { reasoningTail }),
    messageCount: rows.length,
    recent: rows.slice(-DEFAULT_RECENT),
    ...(lastTurnEnd === undefined ? {} : { lastTurnEnd }),
  }
}

/**
 * What a session that is not live can still be asked: its last activity, whether a
 * turn was left open, and its last reply.
 *
 * A parent told "it is not live" cannot tell a finished task from one that went
 * offline mid-turn, and the difference decides whether the work is resumed or
 * redone. The persisted log answers it, so the answer is read rather than guessed.
 * @param ctx - the host plugin context.
 * @param sessionId - the session to read.
 * @returns the offline snapshot, or undefined when nothing can be read.
 */
async function offlineSnapshot(ctx, sessionId) {
  const events = await persistedEvents(ctx, sessionId)
  if (events === undefined) return undefined
  const rows = foldMessages(events)
  let openTurn = false
  let lastActivityAt = null
  for (const event of events) {
    if (event.type === 'turn/start') openTurn = true
    if (event.type === 'turn/end') openTurn = false
    if (typeof event.time === 'number' && event.time > (lastActivityAt ?? 0)) lastActivityAt = event.time
  }
  let lastReply
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].role === 'assistant' && rows[index].text !== undefined) { lastReply = rows[index].text; break }
  }
  const reasoningTail = reasoningTailOf(undefined, rows.filter((row) => row.reasoning !== undefined).pop()?.reasoning)
  return {
    live: false,
    openTurn,
    lastActivityAt,
    ...(lastActivityAt === null ? {} : { lastActivityAgoMs: Date.now() - lastActivityAt }),
    ...(lastReply === undefined ? {} : { lastReply }),
    ...(reasoningTail === undefined ? {} : { reasoningTail }),
    messageCount: rows.length,
    recent: rows.slice(-DEFAULT_RECENT),
  }
}

/**
 * The events of a persisted session, across the two persistence APIs.
 *
 * `inspect(id)` was the older shape; it was replaced by `open(id, 'read')` +
 * `read()` + `close()`, where the read handle takes no write ownership and must be
 * closed. A session that does not exist throws in both, which the caller treats as
 * "nothing to read".
 * @param ctx - the host plugin context.
 * @param sessionId - the session to read.
 * @returns the events, or undefined when they cannot be read.
 */
async function persistedEvents(ctx, sessionId) {
  const persistence = service(ctx, 'sessionPersistence')
  if (persistence === undefined) return undefined
  if (typeof persistence.inspect === 'function') {
    const inspected = await safelyAsync(() => persistence.inspect(sessionId))
    return inspected === undefined ? undefined : (Array.isArray(inspected.events) ? inspected.events : [])
  }
  if (typeof persistence.open !== 'function') return undefined
  const handle = await safelyAsync(() => persistence.open(sessionId, 'read'))
  if (handle === undefined || handle === null) return undefined
  try {
    const read = await safelyAsync(() => handle.read())
    return read !== undefined && Array.isArray(read.events) ? read.events : []
  } finally {
    await safelyAsync(() => handle.close())
  }
}

/** {@link safely}, for a promise-returning read: a rejection is an absent answer. */
async function safelyAsync(read) {
  try {
    return await read()
  } catch {
    return undefined
  }
}

/**
 * The sessions this deployment knows about, live ones first.
 *
 * Live agents are always current; the durable store answers for the offline ones.
 * A deployment serving neither is reported as such by the caller, not here.
 * @param ctx - the host plugin context.
 * @returns one row per session, with the fields find filters and reports on.
 */
async function knownSessions(ctx) {
  const agents = agentsOf(ctx)
  const persistence = service(ctx, 'sessionPersistence')
  if (agents === undefined && persistence === undefined) return undefined
  const workspaceIds = workspaceBySession(ctx)
  const items = []
  const seen = new Set()
  if (agents !== undefined && typeof agents.list === 'function') {
    const listed = safely(() => agents.list())
    for (const agent of Array.isArray(listed) ? listed : []) {
      const header = agent?.session?.header
      const cwd = header?.cwd
      const workspaceId = workspaceIds.get(agent.id) ?? workspaceByPath(ctx, cwd)
      const title = titleOf(sessionEvents(agent.session))
      seen.add(agent.id)
      items.push({
        sessionId: agent.id,
        live: true,
        running: agent.status === 'running',
        ...(title === undefined ? {} : { title }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(typeof header?.createdAt === 'number' ? { createdAt: header.createdAt } : {}),
        ...(header?.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
      })
    }
  }
  if (persistence !== undefined && typeof persistence.list === 'function') {
    const snapshots = await safelyAsync(() => persistence.list())
    for (const record of Array.isArray(snapshots) ? snapshots : []) {
      // Current persistence answers `{ header, revision, … }`; older versions
      // answered the header's fields flat, so both are read.
      const header = record?.header ?? record
      if (header === null || typeof header !== 'object' || typeof header.id !== 'string') continue
      if (seen.has(header.id)) continue
      seen.add(header.id)
      const workspaceId = workspaceIds.get(header.id)
      items.push({
        sessionId: header.id,
        live: false,
        ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(typeof header.createdAt === 'number' ? { createdAt: header.createdAt } : {}),
        ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
      })
    }
  }
  return items
}

/** Session id → workspace id, over the whole registry (empty when it is not served). */
function workspaceBySession(ctx) {
  const map = new Map()
  const registry = service(ctx, 'workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') return map
  const workspaces = safely(() => registry.list())
  for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
    for (const sessionId of workspace?.sessionIds ?? []) map.set(sessionId, String(workspace.id))
  }
  return map
}

/** The workspace a directory belongs to, by path (undefined when it is not served). */
function workspaceByPath(ctx, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return undefined
  const registry = service(ctx, 'workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') return undefined
  const workspaces = safely(() => registry.list())
  for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
    if (workspace?.path === cwd) return workspace.id
  }
  return undefined
}

/**
 * Count a session into the Workspace its directory belongs to.
 *
 * A session opened through the session controller is attached only when the call
 * names a Workspace; one opened by directory would otherwise sit in "Ungrouped".
 * Best effort: a deployment with no registry, and a directory no Workspace claims,
 * are both normal, and neither is a reason to refuse the session that was opened.
 * @param ctx - the host plugin context.
 * @param sessionId - the session to count in.
 * @param cwd - its working directory.
 * @returns the workspace id it landed in, or undefined.
 */
async function attachToWorkspace(ctx, sessionId, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return undefined
  const registry = service(ctx, 'workspaceRegistry')
  if (registry === undefined || typeof registry.resolveByPath !== 'function') return undefined
  const workspace = await safelyAsync(() => registry.resolveByPath(cwd))
  if (workspace === undefined || workspace === null || typeof workspace.attachSession !== 'function') return undefined
  const attached = await safelyAsync(() => workspace.attachSession(sessionId))
  return attached === undefined ? undefined : String(workspace.id)
}

/** A user message value, as `followup` / `steer` accept one. */
function userMessage(text) {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/**
 * Rename a live session so the interface shows the title.
 *
 * Written through the `sessionTitle` service, which appends the same user-sourced
 * `session/title` event the interface's own rename does — that event is what pins
 * the title and stops automatic generation from overwriting it. Probed, because a
 * minimal profile may serve no title service at all.
 * @param ctx - the host plugin context.
 * @param session - the live session object.
 * @param title - the title to apply.
 * @returns whether it was applied.
 */
function renameSession(ctx, session, title) {
  const titles = service(ctx, 'sessionTitle')
  if (titles === undefined || typeof titles.rename !== 'function') return false
  const applied = safely(() => titles.rename(session, title))
  return applied !== undefined
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait for a session's next assistant output.
 *
 * The wait ends when a new text reply is readable — not when the turn ends, which
 * a `followup`-driven turn does not always produce. When nothing new arrives
 * within the budget, the newest output that already existed is returned with
 * `stale: true` rather than an empty answer: a caller that timed out needs to know
 * what the session last said, not that the wait expired.
 * @param options - the session, the baseline seq, the budget and the caller's signal.
 * @returns the observed output, the baseline, and how the wait ended.
 */
async function waitForReply(options) {
  const started = Date.now()
  const deadline = started + options.timeoutMs
  let latest = null
  let textReply = null
  let turnEnded = false
  for (;;) {
    if (options.signal !== undefined && options.signal.aborted) break
    const events = sessionEvents(options.session)
    for (const row of foldMessages(events)) {
      if (row.seq <= options.baselineSeq || row.role !== 'assistant') continue
      if (latest === null || row.seq > latest.seq) latest = row
      if (row.text !== undefined && (textReply === null || row.seq > textReply.seq)) textReply = row
    }
    if (options.requireTurnEnd === true && latest !== null) {
      for (const event of events) {
        if (event.seq > latest.seq && event.type === 'turn/end') { turnEnded = true; break }
      }
    }
    const done = options.requireTurnEnd === true ? latest !== null && turnEnded : textReply !== null
    if (done) break
    if (Date.now() >= deadline) break
    await sleep(100)
  }
  const observedNew = textReply !== null
  let stale = false
  if (textReply === null) {
    const rows = foldMessages(sessionEvents(options.session))
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]
      if (row.role === 'assistant' && row.text !== undefined && row.seq <= options.baselineSeq) { textReply = row; stale = true; break }
    }
  }
  return {
    message: textReply,
    seq: textReply === null ? options.baselineSeq : textReply.seq,
    turnEnded,
    timedOut: options.requireTurnEnd === true ? !(latest !== null && turnEnded) : !observedNew,
    stale,
    aborted: options.signal !== undefined && options.signal.aborted,
    waitedMs: Date.now() - started,
  }
}

/** Clamp a wait budget, refusing a value that is not a positive number. */
function clampTimeout(value) {
  if (value === undefined) return DEFAULT_WAIT_MS
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid timeoutMs: expected a positive number of milliseconds, got ${JSON.stringify(value)}`)
  }
  return Math.min(value, MAX_WAIT_MS)
}

/** Clamp a count, refusing a value that is not a positive integer. */
function clampLimit(value, fallback, max) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`invalid limit: expected a positive integer, got ${JSON.stringify(value)}`)
  }
  return Math.min(value, max)
}

/** Read a required string argument. */
function requiredString(value, name, hint) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') throw new Error(`${name} is required${hint === undefined ? '' : `: ${hint}`}`)
  return text
}

/** The line a wait's ending adds to a rendered result. */
function waitNotes(reply) {
  const notes = []
  if (reply.timedOut === true) notes.push('[timed out]')
  if (reply.stale === true) notes.push('[stale] this is the output that already existed; nothing new arrived')
  if (reply.aborted === true) notes.push('[aborted]')
  return notes
}

/** Render a wait result as the row the model reads. */
function renderWait(wait) {
  const row = wait.message
  return {
    message: row === null ? null : {
      seq: row.seq,
      role: row.role,
      ...(row.text === undefined ? {} : { text: row.text }),
      ...(row.reasoning === undefined ? {} : { reasoning: row.reasoning }),
      images: row.images,
      toolCalls: row.toolCalls ?? [],
    },
    seq: wait.seq,
    turnEnded: wait.turnEnded,
    timedOut: wait.timedOut,
    ...(wait.stale === true ? { stale: true } : {}),
    aborted: wait.aborted,
    waitedMs: wait.waitedMs,
  }
}

/**
 * The output shape every session tool shares.
 *
 * Open on purpose: each tool answers with its own fields beside the four that are
 * always there, and a closed schema would have to be widened for each one — which
 * is the shape `additionalProperties: true` already is. The four core fields are
 * always filled, so a refusal and a success are read the same way.
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    offered: { type: 'boolean', required: true },
    sessionId: { type: 'string', required: true },
    summary: { type: 'string', required: true },
    reason: { type: 'string', required: true },
  },
}

/** The card projection shared by every session tool. */
function cardMeta(value) {
  const rows = Array.isArray(value.messages)
    ? value.messages.slice(-CARD_ROW_LIMIT).map((row) => ({ role: row.role, seq: row.seq, text: typeof row.text === 'string' ? row.text.slice(0, 400) : '' }))
    : Array.isArray(value.items)
      ? value.items.slice(0, CARD_ROW_LIMIT).map((item) => ({ sessionId: item.sessionId, title: item.title ?? '', live: item.live === true }))
      : []
  return { summary: value.summary, reason: value.reason, rows }
}

/**
 * `wts_session_tool_find` — locate a session by directory, title or id.
 *
 * The one a parent needs when it did not write the id down: a task space's record
 * carries its sessions (see `recordTaskSession`), so this is the fallback, not the
 * first route.
 * @param ctx - the host plugin context.
 * @returns the registration disposer.
 */
function registerFind(tools, ctx) {
  return tools.register(defineTool({
    name: 'wts_session_tool_find',
    description: 'Find sessions by directory, title or id, across every workspace. Live sessions are always current; '
      + 'offline ones come from the durable session store. A plain query matches the session id, its title and its '
      + 'working directory as a case-insensitive substring. Returns the session id, whether it is live and running, '
      + 'its working directory and its title — ready to pass to wts_session_tool_status / _read / _send / _resume. '
      + 'A task space\'s own record already carries the session ids it opened (see worktree-space.json and the '
      + 'task_worktree_space list action), so search only when that id is not to hand.',
    parameters: {
      query: { type: 'string', description: 'Substring matched against the session id, title and working directory (case-insensitive).' },
      sessionId: { type: 'string', description: 'Only sessions whose id contains this substring.' },
      title: { type: 'string', description: 'Only sessions whose title contains this substring.' },
      cwd: { type: 'string', description: 'Only sessions whose working directory contains this substring (path or directory name).' },
      liveOnly: { type: 'boolean', description: 'When true, only live sessions are returned (default false).' },
      limit: { type: 'number', description: `Maximum items (default ${DEFAULT_FIND_LIMIT}, max ${MAX_FIND_LIMIT}).` },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        if (value.offered !== true || value.reason !== '') return [{ type: 'text', text: value.reason }]
        const items = Array.isArray(value.items) ? value.items : []
        if (items.length === 0) return [{ type: 'text', text: 'no sessions found' }]
        return [{ type: 'text', text: items.map((item) => {
          const state = item.live === true ? (item.running === true ? 'running' : 'idle') : 'offline'
          const cwd = typeof item.cwd === 'string' ? ` @ ${item.cwd}` : ''
          return `${state} ${item.sessionId} (${item.title ?? '(untitled)'})${cwd}`
        }).join('\n') }]
      },
      presentationMeta: (_args, value) => cardMeta(value),
    },
    async execute(args) {
      const limit = clampLimit(args.limit, DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT)
      const items = await knownSessions(ctx)
      if (items === undefined) return refusal(NO_SESSION_LISTING)
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      const idFilter = typeof args.sessionId === 'string' ? args.sessionId.trim().toLowerCase() : ''
      const titleFilter = typeof args.title === 'string' ? args.title.trim().toLowerCase() : ''
      const cwdFilter = typeof args.cwd === 'string' ? args.cwd.trim().toLowerCase() : ''
      // An offline session's title lives only in its log, so it is read for the
      // sessions the filter actually asks about — and only up to a bounded number,
      // because that read is a file per session.
      if (titleFilter !== '' || query !== '') {
        let inspected = 0
        for (const item of items) {
          if (inspected >= OFFLINE_TITLE_BUDGET) break
          if (item.live || item.title !== undefined) continue
          const events = await persistedEvents(ctx, item.sessionId)
          inspected += 1
          if (events !== undefined && titleOf(events) !== undefined) item.title = titleOf(events)
        }
      }
      const filtered = items.filter((item) => {
        if (args.liveOnly === true && !item.live) return false
        if (idFilter !== '' && !item.sessionId.toLowerCase().includes(idFilter)) return false
        if (titleFilter !== '' && !(item.title ?? '').toLowerCase().includes(titleFilter)) return false
        if (cwdFilter !== '' && !(item.cwd ?? '').toLowerCase().includes(cwdFilter)) return false
        if (query !== '') {
          const haystack = `${item.sessionId} ${item.title ?? ''} ${item.cwd ?? ''}`.toLowerCase()
          if (!haystack.includes(query)) return false
        }
        return true
      })
      filtered.sort((left, right) => {
        if (left.live !== right.live) return left.live ? -1 : 1
        return (right.createdAt ?? 0) - (left.createdAt ?? 0)
      })
      const page = filtered.slice(0, limit)
      return asJson({
        offered: true,
        sessionId: '',
        reason: '',
        items: page,
        total: filtered.length,
        truncated: filtered.length > limit,
        summary: `${filtered.length} session${filtered.length === 1 ? '' : 's'} match${filtered.length === 1 ? 'es' : ''}${filtered.length > page.length ? `, showing ${page.length}` : ''}.`,
      })
    },
  }))
}

/**
 * `wts_session_tool_status` — is it moving, and what does it think it is doing?
 *
 * Answers for an offline session too, from its persisted log: "it is not live" is
 * itself the answer a recovering parent is after, and it is not the same as
 * "nothing to report".
 * @param ctx - the host plugin context.
 * @returns the registration disposer.
 */
function registerStatus(tools, ctx) {
  return tools.register(defineTool({
    name: 'wts_session_tool_status',
    description: 'Inspect a session\'s progress: running, whether a turn is open, when it last did anything, whether '
      + 'work is queued, its last text reply, and its reasoning tail. lastActivity is the reliable answer to "stuck or '
      + 'busy": a build leaves files, mtimes and logs still for minutes while the session keeps working, so only the '
      + 'session\'s own clock tells the two apart — pass stalledMsThreshold to have a RUNNING session marked stalled '
      + 'once it has been quiet for longer than that (an idle session is never marked). lastTurnEnd names a turn that '
      + 'did not end `completed` (error / interrupted / blocked / max-tokens), which is the one way to tell a task '
      + 'that finished from one an error killed into silence. A session that is not live is answered from its '
      + 'persisted log with live: false.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to inspect.' },
      stalledMsThreshold: { type: 'number', description: 'Mark a RUNNING session stalled once it has been quiet for more than this many milliseconds (default 60000).' },
      recent: { type: 'number', description: `How many recent messages to include (default ${DEFAULT_RECENT}, max ${MAX_RECENT}).` },
      reasoning: { type: 'string', enum: ['none', 'last', 'live', 'tail'], description: 'Which chain-of-thought fields to include: tail (default) keeps all three, last keeps only the finalized reasoning, live only the in-flight one, none drops them.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        if (value.offered !== true || value.reason !== '') return [{ type: 'text', text: value.reason }]
        const named = typeof value.title === 'string' && value.title !== '' ? ` ("${value.title}")` : ''
        const lines = [`${value.running === true ? 'running' : (value.live === true ? 'idle' : 'offline')} ${value.sessionId}${named}`]
        if (value.live !== true) lines.push(`lastActivity: ${value.lastActivityAgoMs === null ? 'unknown' : `now-${value.lastActivityAgoMs}ms`}`)
        else {
          lines.push(`openTurn: ${value.openTurn === true ? `yes (turn #${value.lastTurn})` : `no (last turn #${value.lastTurn})`}`)
          lines.push(`lastActivity: ${value.lastActivityAgoMs === null ? 'never' : `now-${value.lastActivityAgoMs}ms`}${value.stalled === true ? ' [STALLED]' : ''}`)
        }
        if (value.pendingWork === true) lines.push(`pendingWork: ${value.nextTurnCount} turn + ${value.nextStepCount} step`)
        if (value.lastTurnEnd !== undefined && value.lastTurnEnd.kind !== 'completed') {
          lines.push(`lastTurnEnd: ${value.lastTurnEnd.kind} (turn #${value.lastTurnEnd.turn})${value.lastTurnEnd.failure === undefined ? '' : ` — ${value.lastTurnEnd.failure.code}: ${value.lastTurnEnd.failure.message}`}`)
        }
        if (typeof value.lastReply === 'string' && value.lastReply !== '') lines.push(`lastReply: ${value.lastReply}`)
        if (typeof value.reasoningTail === 'string' && value.reasoningTail !== '') lines.push(`reasoning: ${value.reasoningTail.length > 160 ? `${value.reasoningTail.slice(0, 160)}…` : value.reasoningTail}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta: (_args, value) => cardMeta(value),
    },
    async execute(args) {
      const sessionId = requiredString(args.sessionId, 'sessionId', 'the id wts_session_tool_find answered with')
      const threshold = typeof args.stalledMsThreshold === 'number' && Number.isFinite(args.stalledMsThreshold) && args.stalledMsThreshold >= 0
        ? args.stalledMsThreshold
        : 60_000
      const reasoningMode = ['none', 'last', 'live', 'tail'].includes(args.reasoning) ? args.reasoning : 'tail'
      const agents = agentsOf(ctx)
      const agent = agents === undefined ? undefined : safely(() => agents.get(sessionId))
      if (agent !== undefined && agent !== null) {
        const snapshot = statusSnapshot(ctx, agent)
        const shown = typeof args.recent === 'number' && Number.isInteger(args.recent) && args.recent >= 0
          ? Math.min(args.recent, MAX_RECENT)
          : DEFAULT_RECENT
        const recent = snapshot.recent.slice(-shown)
        const lastActivityAgoMs = snapshot.stalledMs
        const value = {
          offered: true,
          sessionId,
          reason: '',
          live: true,
          running: snapshot.running,
          openTurn: snapshot.openTurn,
          lastTurn: snapshot.lastTurn,
          lastActivity: snapshot.lastActivityAt,
          lastActivityAgoMs,
          stalledMsThreshold: threshold,
          stalled: snapshot.running === true && lastActivityAgoMs !== null && lastActivityAgoMs > threshold,
          pendingWork: snapshot.pendingWork,
          nextTurnCount: snapshot.nextTurnCount,
          nextStepCount: snapshot.nextStepCount,
          lastReply: snapshot.lastReply ?? '',
          reasoningTail: reasoningMode === 'none' ? '' : (snapshot.reasoningTail ?? ''),
          ...(reasoningMode === 'none' || reasoningMode === 'live' ? {} : { lastReasoning: snapshot.lastReasoning ?? '' }),
          ...(reasoningMode === 'none' || reasoningMode === 'last' ? {} : { liveReasoning: snapshot.liveReasoning ?? '' }),
          ...(snapshot.title === undefined ? {} : { title: snapshot.title }),
          ...(snapshot.cwd === undefined ? {} : { cwd: snapshot.cwd }),
          ...(snapshot.lastTurnEnd === undefined ? {} : { lastTurnEnd: snapshot.lastTurnEnd }),
          messageCount: snapshot.messageCount,
          recent,
        }
        value.summary = `${snapshot.running ? 'running' : 'idle'}${snapshot.openTurn ? ', turn open' : ''}`
          + `${snapshot.pendingWork ? ', work queued' : ''}`
          + `${value.stalled ? `, stalled (no activity for ${lastActivityAgoMs}ms)` : ''}.`
        return asJson(value)
      }
      const offline = await offlineSnapshot(ctx, sessionId)
      if (offline === undefined) {
        if (agents === undefined && service(ctx, 'sessionPersistence') === undefined) return refusal(NO_AGENTS)
        // Two absences with the same shape and different remedies: the session does
        // not exist, or it does and this deployment serves no persistence to read it
        // from. The sentence says which, because only one of them is worth retrying.
        const reason = service(ctx, 'sessionPersistence') === undefined
          ? `session ${JSON.stringify(sessionId)} is not live, and this deployment serves no session persistence, so `
            + 'its log cannot be read — call wts_session_tool_resume if it should come back online'
          : `session ${JSON.stringify(sessionId)} is not live and has no persisted log to read — `
            + 'use wts_session_tool_find to locate the session that is still there'
        return asJson({
          offered: true,
          sessionId,
          reason,
          title: '',
          live: false,
          running: false,
          openTurn: false,
          lastActivity: null,
          lastActivityAgoMs: null,
          stalledMsThreshold: threshold,
          stalled: false,
          pendingWork: false,
          nextTurnCount: 0,
          nextStepCount: 0,
          lastReply: '',
          reasoningTail: '',
          summary: `session ${sessionId} is unknown here.`,
        })
      }
      const value = {
        offered: true,
        sessionId,
        reason: '',
        title: '',
        ...offline,
        running: false,
        lastActivity: offline.lastActivityAt,
        lastActivityAgoMs: offline.lastActivityAt === null ? null : Date.now() - offline.lastActivityAt,
        stalledMsThreshold: threshold,
        stalled: false,
        pendingWork: false,
        nextTurnCount: 0,
        nextStepCount: 0,
        lastReply: offline.lastReply ?? '',
        reasoningTail: reasoningMode === 'none' ? '' : (offline.reasoningTail ?? ''),
      }
      value.summary = `offline (last activity ${value.lastActivityAgoMs === null ? 'unknown' : `${value.lastActivityAgoMs}ms ago`}); `
        + 'call wts_session_tool_resume to bring it back online.'
      return asJson(value)
    },
  }))
}

/**
 * `wts_session_tool_read` — what was actually said, so "did not do it" can be told
 * from "never arrived".
 *
 * This is the tool that answers the one failure a sender cannot see: a `queue`
 * message is read at a turn boundary, and a dispatched task is often one long
 * turn, so the message sits unread in the inbox while the session looks like it is
 * ignoring it.
 * @param ctx - the host plugin context.
 * @returns the registration disposer.
 */
function registerRead(tools, ctx) {
  return tools.register(defineTool({
    name: 'wts_session_tool_read',
    description: 'Read messages from any session — live or persisted (offline) — folding its event log into user and '
      + 'assistant rows. Returns the most recent 20 by default; pass limit for more (max 100) and sinceSeq to page '
      + 'forward from an event seq. role filters the rows, includeReasoning false drops reasoning blocks. Use it to '
      + 'check whether an instruction was actually delivered: a queue message is read at a turn boundary, so on a '
      + 'long-running task it can sit unread in the inbox and look exactly like a session ignoring it.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to read (live or offline).' },
      sinceSeq: { type: 'integer', description: 'Only return messages with a seq greater than this (paging cursor).' },
      limit: { type: 'number', description: `How many of the most recent messages to return (default ${DEFAULT_READ_LIMIT}, max ${MAX_READ_LIMIT}).` },
      role: { type: 'string', enum: ['user', 'assistant', 'both'], description: 'Which rows to return (default both).' },
      includeReasoning: { type: 'boolean', description: 'Include assistant reasoning blocks (default true).' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        if (value.offered !== true || value.reason !== '') return [{ type: 'text', text: value.reason }]
        const messages = Array.isArray(value.messages) ? value.messages : []
        if (messages.length === 0) return [{ type: 'text', text: `no messages in ${value.sessionId}` }]
        return [{ type: 'text', text: messages.map((row) => `${row.role} #${row.seq}: ${typeof row.text === 'string' ? row.text : '(no text)'}`).join('\n') }]
      },
      presentationMeta: (_args, value) => cardMeta(value),
    },
    async execute(args) {
      const sessionId = requiredString(args.sessionId, 'sessionId', 'the id wts_session_tool_find answered with')
      const agents = agentsOf(ctx)
      const agent = agents === undefined ? undefined : safely(() => agents.get(sessionId))
      let events
      let live = false
      let cwd
      let title
      if (agent !== undefined && agent !== null) {
        events = sessionEvents(agent.session)
        live = true
        cwd = agent.session?.header?.cwd
        title = titleOf(events)
      } else {
        events = await persistedEvents(ctx, sessionId)
        if (events === undefined) {
          if (agents === undefined && service(ctx, 'sessionPersistence') === undefined) return refusal(NO_AGENTS)
          // A live session is the only one this deployment can read without
          // persistence, so the two absences are named apart: one is a session that
          // does not exist, the other a log this deployment cannot open at all.
          return unavailable(sessionId, service(ctx, 'sessionPersistence') === undefined
            ? `session ${JSON.stringify(sessionId)} is not live, and this deployment serves no session persistence, so `
              + 'its log cannot be read — call wts_session_tool_resume if it should come back online'
            : `session ${JSON.stringify(sessionId)} is not live and has no persisted log to read — `
              + 'use wts_session_tool_find to locate the session that is still there')
        }
      }
      let rows = foldMessages(events)
      if (args.role === 'user') rows = rows.filter((row) => row.role === 'user')
      if (args.role === 'assistant') rows = rows.filter((row) => row.role === 'assistant')
      if (args.includeReasoning === false) rows = rows.map((row) => ({ ...row, reasoning: undefined }))
      const sinceSeq = typeof args.sinceSeq === 'number' && Number.isInteger(args.sinceSeq) && args.sinceSeq >= 0 ? args.sinceSeq : undefined
      if (sinceSeq !== undefined) rows = rows.filter((row) => row.seq > sinceSeq)
      const limit = clampLimit(args.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT)
      const page = rows.slice(-limit)
      return asJson({
        offered: true,
        sessionId,
        reason: '',
        live,
        ...(cwd === undefined ? {} : { cwd }),
        ...(title === undefined ? {} : { title }),
        messages: page.map((row) => ({
          seq: row.seq,
          time: row.time,
          role: row.role,
          ...(row.text === undefined ? {} : { text: row.text }),
          ...(row.reasoning === undefined ? {} : { reasoning: row.reasoning }),
          images: row.images,
          ...(row.toolCalls === undefined ? {} : { toolCalls: row.toolCalls }),
        })),
        total: rows.length,
        truncated: rows.length > page.length,
        nextSeq: maxSeq(events),
        summary: `${page.length} of ${rows.length} message${rows.length === 1 ? '' : 's'} from ${sessionId} (${live ? 'live' : 'offline'}).`,
      })
    },
  }))
}

/**
 * `wts_session_tool_send` — say something to a session after the task was handed
 * over.
 *
 * `mode` is the whole point: `queue` is read at the session's next turn boundary,
 * which a long-running task may never reach, while `steer` is injected into the
 * turn that is running now. Anything time-sensitive — "stop, there are
 * uncommitted files" — has to be a steer.
 * @param ctx - the host plugin context.
 * @returns the registration disposer.
 */
function registerSend(tools, ctx) {
  return tools.register(defineTool({
    name: 'wts_session_tool_send',
    description: 'Send a message to a session and let it start working. mode=queue (the default) appends a normal turn '
      + 'and is only read at a turn boundary; mode=steer injects the message into the running turn and is caught at its '
      + 'next step. Anything time-sensitive must be a steer: a dispatched task is often one long turn, so a queued '
      + 'correction can sit unread until the work is over. The session must be live — call wts_session_tool_resume '
      + 'first otherwise. With waitForReply=true the call blocks until that session produces its next assistant reply. '
      + 'Without it the answer carries sinceSeq, the anchor to pass to wts_session_tool_wait.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Target session id.' },
      message: { type: 'string', required: true, description: 'Message text, sent as a user turn.' },
      mode: { type: 'string', enum: ['queue', 'steer'], description: 'queue (default) appends a turn; steer interrupts the running turn at its next step.' },
      waitForReply: { type: 'boolean', description: 'When true, wait for the next assistant reply before answering (default false).' },
      timeoutMs: { type: 'number', description: `Wait budget in milliseconds (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS}).` },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        if (value.offered !== true || value.reason !== '') return [{ type: 'text', text: value.reason }]
        const lines = [`sent to ${value.sessionId} (${value.mode})`]
        if (typeof value.sinceSeq === 'number') lines.push(`sinceSeq: ${value.sinceSeq} (pass to wts_session_tool_wait)`)
        if (value.reply !== undefined) {
          lines.push(`reply: ${value.reply.message === null ? '(no text)' : (value.reply.message.text ?? '(no text)')}`)
          lines.push(...waitNotes(value.reply))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta: (_args, value) => cardMeta(value),
    },
    async execute(args, exec) {
      const sessionId = requiredString(args.sessionId, 'sessionId', 'the id wts_session_tool_find answered with')
      const message = requiredString(args.message, 'message', 'the text to send')
      const agents = agentsOf(ctx)
      if (agents === undefined) return refusal(NO_AGENTS)
      const agent = safely(() => agents.get(sessionId))
      if (agent === undefined || agent === null) {
        return unavailable(sessionId, `session ${JSON.stringify(sessionId)} is not live — call wts_session_tool_resume to bring it `
          + 'online first, or wts_session_tool_find to locate the session that is still there')
      }
      const mode = args.mode === 'steer' ? 'steer' : 'queue'
      const baseline = maxSeq(sessionEvents(agent.session))
      if (mode === 'steer') agent.steer(userMessage(message))
      else agent.followup(userMessage(message))
      let reply
      if (args.waitForReply === true) {
        const waited = await waitForReply({
          session: agent.session,
          baselineSeq: baseline,
          timeoutMs: clampTimeout(args.timeoutMs),
          signal: exec?.signal,
        })
        reply = renderWait(waited)
      }
      const cwd = agent.session?.header?.cwd
      await attachToWorkspace(ctx, sessionId, cwd)
      return asJson({
        offered: true,
        sessionId,
        reason: '',
        accepted: true,
        mode,
        sinceSeq: baseline,
        ...(reply === undefined ? {} : { reply }),
        summary: `sent to ${sessionId} with mode=${mode}.`,
      })
    },
  }))
}

/**
 * `wts_session_tool_create` — open a session in a directory, which is how a lost
 * task is picked back up.
 *
 * The session service is preferred over the agent registry because it is what
 * attaches the session to a Workspace, which is what makes it read under the task
 * in the workspace list rather than in "Ungrouped".
 * @param ctx - the host plugin context.
 * @returns the registration disposer.
 */
function registerCreate(tools, ctx) {
  return tools.register(defineTool({
    name: 'wts_session_tool_create',
    description: 'Open a NEW top-level session and optionally hand it one job. Pass cwd as the ABSOLUTE path the '
      + 'session must work in — a task space, so the new session can see the task record, the deploy root and the '
      + 'worktrees — or a workspaceId. This is the recovery route when a task\'s session was lost and the work has to '
      + 'carry on in the same task space; the prompt must stand alone, because the new session does not share this '
      + 'conversation. The session is attached to the Workspace its directory belongs to. Answers with the new '
      + 'session id and, when a prompt was handed over, the delivery result.',
    parameters: {
      cwd: { type: 'string', description: 'Absolute working directory for the new session — the task space. One of cwd or workspaceId is required.' },
      workspaceId: { type: 'string', description: 'Workspace to open the session in; takes precedence over cwd.' },
      title: { type: 'string', description: 'Optional title, applied to the session itself so the interface shows it and automatic title generation stops overwriting it.' },
      prompt: { type: 'string', description: 'Optional first job, handed to the session as its first turn. It must be self-contained.' },
      agentPreset: { type: 'string', description: 'Optional agent preset id to compose the new session from.' },
      waitForReply: { type: 'boolean', description: 'When true and a prompt was given, wait for the first assistant reply (default false).' },
      timeoutMs: { type: 'number', description: `Wait budget in milliseconds (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS}).` },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        if (value.offered !== true || value.reason !== '') return [{ type: 'text', text: value.reason }]
        const lines = [`created session ${value.sessionId}${value.cwd === '' ? '' : ` in ${value.cwd}`}`]
        if (value.titleNote !== undefined) lines.push(value.titleNote)
        if (typeof value.sinceSeq === 'number') lines.push(`sinceSeq: ${value.sinceSeq} (pass to wts_session_tool_wait)`)
        if (value.reply !== undefined) {
          lines.push(`reply: ${value.reply.message === null ? '(no text)' : (value.reply.message.text ?? '(no text)')}`)
          lines.push(...waitNotes(value.reply))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta: (_args, value) => cardMeta(value),
    },
    async execute(args, exec) {
      const requestedCwd = typeof args.cwd === 'string' ? args.cwd.trim() : ''
      const workspaceId = typeof args.workspaceId === 'string' ? args.workspaceId.trim() : ''
      if (requestedCwd === '' && workspaceId === '') {
        throw new Error('cwd is required (an absolute path — the task space the session must work in), or workspaceId')
      }
      const controller = service(ctx, 'sessionController')
      const agents = agentsOf(ctx)
      const canUseController = controller !== undefined && typeof controller.create === 'function'
      const canUseAgents = agents !== undefined && typeof agents.create === 'function'
      if (!canUseController && !canUseAgents) return refusal(NO_CREATE)

      const preset = typeof args.agentPreset === 'string' && args.agentPreset.trim() !== '' ? args.agentPreset.trim() : undefined
      let sessionId = ''
      let cwd = requestedCwd
      let viaController = false
      if (canUseController) {
        // The controller's own request carries the preset, which is where it belongs:
        // it composes the session as it creates it.
        const place = {
          ...(workspaceId !== '' ? { workspaceId } : { cwd: requestedCwd }),
          ...(preset === undefined ? {} : { agentPreset: preset }),
        }
        const created = await safelyAsync(() => controller.create(place))
        sessionId = typeof created?.sessionId === 'string' ? created.sessionId : ''
        viaController = true
      } else {
        // No controller, so the agent registry creates it directly. An explicit
        // preset has to be MOUNTED, not merely named: falling through would leave
        // the id on the header while the agent ran on whatever composition the
        // deployment defaults to, and its tools would be somebody else's.
        const presets = preset === undefined ? undefined : service(ctx, 'agentPresets')
        sessionId = `wts-${randomUUID()}`
        const handle = await safelyAsync(() => agents.create({
          sessionId,
          meta: { cwd: requestedCwd, ...(preset === undefined ? {} : { agentPreset: preset }) },
          ...(preset === undefined || presets === undefined || typeof presets.mount !== 'function'
            ? {}
            : { setup: async (agentCtx) => { await presets.mount(agentCtx, preset) } }),
        }))
        if (handle === undefined || handle.agent === undefined) {
          // The capability is served — this attempt failed. `offered` stays true so
          // the caller reads it as a failure to retry, not as a deployment that
          // cannot open sessions at all.
          return unavailable('', `the session could not be opened in ${JSON.stringify(requestedCwd)}`)
        }
        cwd = handle.agent.session?.header?.cwd ?? requestedCwd
      }
      if (sessionId === '') {
        return unavailable('', 'the session service answered without a session id, so no session was opened')
      }
      // The directory a controller-opened session landed in is read back from the
      // live session: `cwd` was a request, and this is what it became.
      const liveAgent = agents === undefined ? undefined : safely(() => agents.get(sessionId))
      if (liveAgent !== undefined && liveAgent !== null && typeof liveAgent.session?.header?.cwd === 'string') {
        cwd = liveAgent.session.header.cwd
      }
      const attached = await attachToWorkspace(ctx, sessionId, cwd)
      const wantedTitle = typeof args.title === 'string' && args.title.trim() !== '' ? args.title.trim() : ''
      let titleApplied = false
      if (wantedTitle !== '' && liveAgent !== undefined && liveAgent !== null) {
        titleApplied = renameSession(ctx, liveAgent.session, wantedTitle)
      }

      let reply
      let baseline
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt !== '') {
        if (liveAgent !== undefined && liveAgent !== null) {
          baseline = maxSeq(sessionEvents(liveAgent.session))
          liveAgent.followup(userMessage(prompt))
          if (args.waitForReply === true) {
            const waited = await waitForReply({
              session: liveAgent.session,
              baselineSeq: baseline,
              timeoutMs: clampTimeout(args.timeoutMs),
              signal: exec?.signal,
            })
            reply = renderWait(waited)
          }
        } else if (viaController && typeof controller.prompt === 'function') {
          // The Host's prompt request is a typed shape with required fields, and its
          // own client (`Session.prompt` in the session controller) is the reference
          // for one: a minted requestId, the delivery mode, the content, and the
          // caller's zone. The second argument is the signal the contract declares —
          // a handoff is not a cancellable read, so it never aborts.
          const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
          const handed = await safelyAsync(() => controller.prompt({
            requestId: randomUUID(),
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: prompt }],
            ...(typeof timeZone === 'string' && timeZone !== '' ? { clientTimeZone: timeZone } : {}),
          }, new AbortController().signal))
          if (handed === undefined) {
            return asJson({
              offered: true,
              sessionId,
              reason: `the session was opened but the job could not be handed to it; open it and say what to do`,
              cwd,
              accepted: true,
              delivered: false,
              summary: `session ${sessionId} opened in ${cwd}, but the prompt did not reach it.`,
            })
          }
        } else {
          return asJson({
            offered: true,
            sessionId,
            reason: 'the session was opened but this deployment offers no way to hand it a prompt; open it and say what to do',
            cwd,
            accepted: true,
            delivered: false,
            summary: `session ${sessionId} opened in ${cwd}, but the prompt did not reach it.`,
          })
        }
      }
      return asJson({
        offered: true,
        sessionId,
        reason: '',
        cwd,
        accepted: true,
        // Only said when there was a job to hand over: a session opened with no
        // prompt has nothing that could have been delivered, and a `false` there
        // would read as a handoff that failed.
        ...(prompt === '' ? {} : { delivered: true }),
        ...(attached === undefined ? {} : { workspaceId: attached }),
        ...(wantedTitle === '' ? {} : { title: wantedTitle }),
        ...(wantedTitle !== '' && !titleApplied
          ? { titleNote: 'the title could not be applied: this deployment serves no sessionTitle service, or the session was not live' }
          : {}),
        ...(reply === undefined && baseline !== undefined ? { sinceSeq: baseline } : {}),
        ...(reply === undefined ? {} : { reply }),
        summary: `session ${sessionId} opened in ${cwd}${prompt === '' ? '' : ' and handed the job'}.`,
      })
    },
  }))
}

/**
 * `wts_session_tool_resume` — bring an offline session back online.
 *
 * A host restart puts every session offline, and a task that was mid-turn is then
 * neither reachable nor readable through the live registry. Resuming keeps the
 * task's own continuity — the same session id, the same context — which is the
 * difference between picking the work back up and starting it over.
 * @param ctx - the host plugin context.
 * @returns the registration disposer.
 */
function registerResume(tools, ctx) {
  return tools.register(defineTool({
    name: 'wts_session_tool_resume',
    description: 'Bring a persisted (offline) session back online so wts_session_tool_send / _wait / _read can work on '
      + 'it. A host restart puts every session offline, so this is how a task keeps its continuity instead of being '
      + 'dispatched again from scratch. Resuming keeps the session id and its context; if it is already live this is a '
      + 'no-op that says so. Read the session\'s last state with wts_session_tool_status before deciding what to send.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to resume (its persisted log must exist).' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        if (value.offered !== true || value.reason !== '') return [{ type: 'text', text: value.reason }]
        if (value.alreadyLive === true) return [{ type: 'text', text: `session ${value.sessionId} is already live` }]
        return [{ type: 'text', text: `resumed session ${value.sessionId}${value.cwd === '' ? '' : ` (cwd: ${value.cwd})`}` }]
      },
      presentationMeta: (_args, value) => cardMeta(value),
    },
    async execute(args) {
      const sessionId = requiredString(args.sessionId, 'sessionId', 'the id wts_session_tool_find answered with')
      const agents = agentsOf(ctx)
      const existing = agents === undefined ? undefined : safely(() => agents.get(sessionId))
      if (existing !== undefined && existing !== null) {
        return asJson({
          offered: true,
          sessionId,
          reason: '',
          alreadyLive: true,
          resumed: false,
          running: existing.status === 'running',
          cwd: existing.session?.header?.cwd ?? '',
          summary: `session ${sessionId} is already live.`,
        })
      }
      if (agents === undefined || typeof agents.resume !== 'function') return refusal(NO_RESUME)
      const persistence = service(ctx, 'sessionPersistence')
      if (persistence === undefined || typeof persistence.list !== 'function') return refusal(NO_RESUME)
      const snapshots = await safelyAsync(() => persistence.list())
      const record = (Array.isArray(snapshots) ? snapshots : [])
        .map((entry) => entry?.header ?? entry)
        .find((header) => header !== null && typeof header === 'object' && header.id === sessionId)
      if (record === undefined) {
        return unavailable(sessionId, `session ${JSON.stringify(sessionId)} is unknown here (no live agent and no persisted log) — `
          + 'use wts_session_tool_find to locate the sessions that do exist')
      }
      const handle = await safelyAsync(() => agents.resume({ resumeSessionId: sessionId }))
      if (handle === undefined || handle.agent === undefined) {
        return unavailable(sessionId, `session ${JSON.stringify(sessionId)} could not be resumed`)
      }
      const cwd = handle.agent.session?.header?.cwd ?? record.cwd ?? ''
      await attachToWorkspace(ctx, sessionId, cwd)
      return asJson({
        offered: true,
        sessionId,
        reason: '',
        resumed: true,
        alreadyLive: false,
        cwd,
        summary: `session ${sessionId} is online again.`,
      })
    },
  }))
}

/**
 * `wts_session_tool_wait` — wait for the output a send or a create produced.
 *
 * The orchestration primitive: send, then wait for that one message to be
 * answered. A timeout is not an empty answer — the newest output that already
 * existed comes back marked `stale`, because a caller whose wait expired still
 * needs to know what the session last said.
 * @param ctx - the host plugin context.
 * @returns the registration disposer.
 */
function registerWait(tools, ctx) {
  return tools.register(defineTool({
    name: 'wts_session_tool_wait',
    description: 'Wait for a session\'s next assistant output. By default the wait starts from the newest event at '
      + 'call time, so pass the sinceSeq anchor that wts_session_tool_send / _create returned to wait for THAT message '
      + 'specifically (-1 counts every event, which is what a brand-new session needs). It returns as soon as a new '
      + 'assistant text reply is readable, without waiting for the whole turn, and with requireTurnEnd it waits for the '
      + 'turn to settle first. A wait that runs out of budget is not an empty answer: the newest output that already '
      + 'existed is returned with stale=true. The session must be live — resume it first otherwise.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to wait on (must be live).' },
      sinceSeq: { type: 'integer', description: 'Only output after this event seq counts (default: the newest seq at call time; -1 counts every event).' },
      timeoutMs: { type: 'number', description: `Wait budget in milliseconds (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS}).` },
      requireTurnEnd: { type: 'boolean', description: 'When true, wait for the turn to settle before returning (default false: return as soon as the reply text is readable).' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        if (value.offered !== true || value.reason !== '') return [{ type: 'text', text: value.reason }]
        const reply = value.reply
        if (reply === undefined || reply.message === null) {
          return [{ type: 'text', text: `no assistant text in ${value.sessionId} within ${reply === undefined ? '?' : reply.waitedMs}ms` }]
        }
        return [{ type: 'text', text: [`reply seq ${reply.seq}: ${reply.message.text ?? '(no text)'}`, ...waitNotes(reply)].join('\n') }]
      },
      presentationMeta: (_args, value) => cardMeta(value),
    },
    async execute(args, exec) {
      const sessionId = requiredString(args.sessionId, 'sessionId', 'the id wts_session_tool_find answered with')
      const agents = agentsOf(ctx)
      if (agents === undefined) return refusal(NO_AGENTS)
      const agent = safely(() => agents.get(sessionId))
      if (agent === undefined || agent === null) {
        return unavailable(sessionId, `session ${JSON.stringify(sessionId)} is not live — call wts_session_tool_resume first, because `
          + 'waiting needs a live session')
      }
      const baseline = typeof args.sinceSeq === 'number' && Number.isInteger(args.sinceSeq) && args.sinceSeq >= -1
        ? args.sinceSeq
        : maxSeq(sessionEvents(agent.session))
      const waited = await waitForReply({
        session: agent.session,
        baselineSeq: baseline,
        timeoutMs: clampTimeout(args.timeoutMs),
        signal: exec?.signal,
        requireTurnEnd: args.requireTurnEnd === true,
      })
      const reply = renderWait(waited)
      return asJson({
        offered: true,
        sessionId,
        reason: '',
        sinceSeq: baseline,
        running: agent.status === 'running',
        reply,
        summary: reply.timedOut === true
          ? `timed out after ${reply.waitedMs}ms; ${reply.stale === true ? 'returning the output that already existed' : 'no output at all yet'}`
          : `reply seq ${reply.seq} after ${reply.waitedMs}ms.`,
      })
    },
  }))
}

/**
 * `wts_session_tool_cancel` — the brake.
 *
 * For a session that has run away, is plainly off track, or has to be stopped
 * before its task space is archived. Cancellation is asynchronous: the state in
 * the answer is sampled right after the request, so a `running: true` here can be
 * a turn still winding down — poll `wts_session_tool_status` for `openTurn: false`
 * to see it settle.
 * @param ctx - the host plugin context.
 * @returns the registration disposer.
 */
function registerCancel(tools, ctx) {
  return tools.register(defineTool({
    name: 'wts_session_tool_cancel',
    description: 'Stop a session: abort the active turn, and unless keepInbox is true also clear the queued and '
      + 'steering work. Use it when a task has run away, is plainly off track, or has to be stopped before its task '
      + 'space is archived. Cancellation is asynchronous — the state in the answer is sampled immediately after the '
      + 'request, so running: true can be a turn still winding down; poll wts_session_tool_status until openTurn is '
      + 'false to confirm. The session must be live.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id to stop (must be live).' },
      keepInbox: { type: 'boolean', description: 'Preserve queued and steering input instead of clearing it (default false, i.e. clear the pending work).' },
      cause: { type: 'string', description: 'Optional stable reason recorded with the cancellation.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        if (value.offered !== true || value.reason !== '') return [{ type: 'text', text: value.reason }]
        return [{ type: 'text', text: `cancelled ${value.sessionId} (${value.keepInbox === true ? 'queued work kept' : 'queued work cleared'}), still running: ${value.running}` }]
      },
      presentationMeta: (_args, value) => cardMeta(value),
    },
    async execute(args) {
      const sessionId = requiredString(args.sessionId, 'sessionId', 'the id wts_session_tool_find answered with')
      const agents = agentsOf(ctx)
      if (agents === undefined) return refusal(NO_AGENTS)
      const agent = safely(() => agents.get(sessionId))
      if (agent === undefined || agent === null) {
        return unavailable(sessionId, `session ${JSON.stringify(sessionId)} is not live — call wts_session_tool_resume first, because `
          + 'stopping needs a live session')
      }
      const keepInbox = args.keepInbox === true
      const cause = typeof args.cause === 'string' && args.cause.trim() !== ''
        ? { kind: 'hook', reason: args.cause.trim() }
        : { kind: 'user' }
      agent.cancel(cause, { keepInbox })
      const snapshot = statusSnapshot(ctx, agent)
      return asJson({
        offered: true,
        sessionId,
        reason: '',
        cancelled: true,
        running: agent.status === 'running',
        keepInbox,
        openTurn: snapshot.openTurn,
        lastActivity: snapshot.lastActivityAt,
        summary: `cancelled ${sessionId} (${keepInbox ? 'queued work kept' : 'queued work cleared'}).`,
      })
    },
  }))
}

/**
 * Register the eight session-control tools.
 *
 * Only `tools` is required to mount them; every session service is probed per
 * call instead. That is deliberate and it is the difference between two failures:
 * demanding the services here would leave a deployment without them with **no
 * tools at all** — silent, and indistinguishable from the plugin not being
 * installed — where probing answers "this deployment does not offer X", which is
 * something a caller can act on.
 * @param ctx - the host plugin context.
 * @returns the registration disposers, or undefined when tools are not served.
 */
export function registerSessionTools(ctx) {
  if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return undefined
  const tools = ctx.get('tools')
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return undefined
  const registered = [
    registerFind(tools, ctx),
    registerStatus(tools, ctx),
    registerRead(tools, ctx),
    registerSend(tools, ctx),
    registerCreate(tools, ctx),
    registerResume(tools, ctx),
    registerWait(tools, ctx),
    registerCancel(tools, ctx),
  ]
  return () => {
    for (const dispose of registered) {
      if (typeof dispose === 'function') dispose()
    }
  }
}

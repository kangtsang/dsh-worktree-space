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
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isUsableBranchName, isUsableTaskName } from './task/naming.js'
import { canonicalPath, isInside } from './task/paths.js'
import { isSourceRepository } from './task/discover.js'
import { isLinkedWorktree, readTaskMetadata, taskSessionsOf } from './task/shared.js'
import { withSessionTurn } from './session-turn.js'

/** How long a wait may block, and how long it blocks by default. */
const MAX_WAIT_MS = 3_600_000
const DEFAULT_WAIT_MS = 180_000

/**
 * How often a wait looks again, and how far that interval is allowed to grow.
 *
 * Doubling from 100ms to a second: the first passes stay fast enough that a reply which
 * arrives immediately is seen immediately, and a wait measured in minutes stops waking
 * ten times a second to find that nothing has changed. The old fixed 100ms made an
 * hour-long budget 36000 passes, each one a call into another service.
 */
const WAIT_POLL_MIN_MS = 100
const WAIT_POLL_MAX_MS = 1000

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

/**
 * Whether the three tools below may act on a session.
 *
 * They reach a session by id alone, and that is a bigger reach than the reason they
 * exist. A dispatched task session is not the leader's child, so the leader needs a
 * way to talk to it - that is why these tools are here. But the same reach can abort
 * the session the user is talking to right now (cancel defaults to clearing the
 * queued work), steer arbitrary text into any running turn, or read any session's
 * messages and reasoning outright, and `wts_session_tool_find` is exactly the global
 * lookup that hands out any id.
 *
 * So the reach is bounded to the sessions this plugin's own work puts on the other
 * end. A target is reachable when **any** of these holds:
 *
 *   1. its own working directory is at or under a task space this plugin made - found
 *      by reading `.worktree-space/worktree-space.json` from that directory upward,
 *      which is the directory a dispatch opens the session on;
 *   2. its id is named in the **caller's own** task record (`sessions`, or the older
 *      `sessionId` spelling), read from the caller's directory upward;
 *   3. its working directory **is** one of the source checkouts the caller's own task
 *      record names (`repositories[].sourcePath`).
 *
 * Arm 1 is about the target alone, so it needs no caller at all, and it is what lets
 * a leader steer or stop a dispatched member even though the leader's own directory -
 * a source checkout - is in no task space. Arms 2 and 3 read the caller's task space,
 * which is the only record this plugin can find without scanning the filesystem.
 *
 * Arm 3 is what keeps the report-back working, and why it is needed is worth stating:
 * the leader works in the source checkout, outside every task space, so no arm that
 * looks only for a task space around a directory can reach it. On a record written
 * before the `leader` role existed the dispatcher is named nowhere, which is why the
 * arm reads the member's own record for the checkout its task was made from; on a new
 * record the pair is verifiable from both sides, because arm 2 names the leader too.
 * Nothing here works out "which session is the leader" beyond what these arms allow,
 * and a guess beyond them would refuse the very call this arm exists to allow. The
 * host's own subagent delegation is the host's contract - it has its own channel and
 * its own parent/child notion, which the host does expose on the session header - and
 * what is bounded here is this plugin's dispatch chain, where the session opened for a
 * task is not the caller's child.
 *
 * What is out is a session in none of the three - one the user opened by hand,
 * anywhere else on the machine. It is refused with this file's existing `unavailable`
 * shape ("the deployment can do this, not to that session") rather than a new error
 * code, because the caller's fix is to name a different session.
 *
 * On the user's own conversation: the brief asked for a check that refuses to cancel
 * the session the user is talking to. It is not here, because there is nothing to
 * check against - the host exposes no foreground or "current" session to a plugin.
 * The only session set it offers is the sessions working in a task space
 * (`sessionsWorkingIn`), which is a different question, and "what the interface has on
 * screen" is not readable from a plugin at all. Every available substitute would be a
 * guess - "a session in a source checkout is the user's", say - and that guess is
 * wrong in the case that matters most: the dispatcher is usually in a source checkout
 * itself, so the guess would refuse the leader its own tool call. What is left is the
 * arms above, which hold these tools to the sessions this plugin's work created, plus
 * the self-cancel refusal in `registerCancel`.
 * @param ctx - the host plugin context.
 * @param sessionId - the id the caller asked for.
 * @param agent - the live session, when the registry has one.
 * @param exec - the tool run, for the calling session's own directory.
 * @returns whether the tools may act on this session.
 */
async function sessionInScope(ctx, sessionId, agent, exec) {
  // The target's directory: the live header when there is one, and the persisted
  // header when the session is offline. `read` reaches an offline log, so a test that
  // only looked at live sessions would leave exactly that path ungated.
  const liveCwd = typeof agent?.session?.header?.cwd === 'string' ? agent.session.header.cwd : ''
  const targetCwd = liveCwd !== '' ? liveCwd : await persistedDirectory(ctx, sessionId)
  if (targetCwd !== '' && (await taskSpaceAbove(targetCwd)) !== undefined) return true
  const callerSpace = await taskSpaceAbove(exec?.agent?.session?.header?.cwd)
  if (callerSpace === undefined) return false
  if (taskSessionsOf(callerSpace.metadata).some((entry) => entry.sessionId === sessionId)) return true
  return isSourceCheckoutOf(callerSpace.metadata, targetCwd)
}

/**
 * How far up from a session's directory a task space is looked for.
 *
 * The plugin's own layout is `<container root>/<project>/<task>`, and a session is
 * opened either on the task space itself or on a worktree one level inside it, so the
 * record is a level or two up. The walk stops at the drive root anyway; this bound
 * only keeps a pathologically deep directory from turning one tool call into a long
 * chain of reads that cannot succeed.
 */
const TASK_SPACE_WALK_LIMIT = 8

/**
 * The task space a directory sits in, and the record it holds.
 *
 * Walked upward rather than read at one exact level, because a session may be opened
 * on a worktree rather than on the task space, and the record sits at the task space's
 * own level. `dirname` rather than a split-and-rejoin: rejoining loses a Windows drive
 * prefix, so `C:\space\proj\task` would come back as a relative path that names
 * nothing, and `dirname` also stops cleanly at the root.
 * @param directory - a session's working directory, possibly absent.
 * @returns the task space's directory and its record, or undefined.
 */
async function taskSpaceAbove(directory) {
  if (typeof directory !== 'string' || directory === '') return undefined
  let current = directory
  for (let level = 0; level < TASK_SPACE_WALK_LIMIT; level += 1) {
    const metadata = await safelyAsync(() => readTaskMetadata(current))
    if (metadata !== undefined && metadata !== null && typeof metadata === 'object') {
      return { path: current, metadata }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/**
 * Whether a directory is a source checkout the caller's task was made from.
 *
 * The record keeps one `sourcePath` per repository, and the session that dispatched a
 * task works in that checkout - which is outside every task space, so this is the only
 * arm that reaches it. `isInside` is a strict-descendant test, so equality is checked
 * too: the dispatcher works *at* the source root, not below it.
 * @param metadata - the caller's task record.
 * @param directory - the target session's working directory.
 * @returns whether the target works in one of them.
 */
function isSourceCheckoutOf(metadata, directory) {
  if (typeof directory !== 'string' || directory === '') return false
  const repositories = Array.isArray(metadata?.repositories) ? metadata.repositories : []
  for (const entry of repositories) {
    const source = typeof entry?.sourcePath === 'string' ? entry.sourcePath.trim() : ''
    if (source === '') continue
    if (canonicalPath(source) === canonicalPath(directory)) return true
    if (isInside(source, directory)) return true
  }
  return false
}

/**
 * A persisted session's working directory, best effort.
 *
 * `inspect` answers the newer shape and carries the directory under `meta`; `list` is
 * the fallback, and it is where `find` reads the directory from. Either may be absent,
 * and an absent answer means "unknown" - which {@link sessionInScope} treats as "not
 * provably this plugin's work", exactly as it treats a directory outside every task
 * space. That is the conservative direction on purpose: the two arms that could still
 * let the target through do not need its directory.
 * @param ctx - the host plugin context.
 * @param sessionId - the offline session.
 * @returns its directory, or an empty string.
 */
async function persistedDirectory(ctx, sessionId) {
  const persistence = service(ctx, 'sessionPersistence')
  if (persistence === undefined) return ''
  if (typeof persistence.inspect === 'function') {
    const inspected = await safelyAsync(() => persistence.inspect(sessionId))
    const cwd = inspected?.meta?.cwd
    if (typeof cwd === 'string' && cwd !== '') return cwd
  }
  if (typeof persistence.list === 'function') {
    const rows = await safelyAsync(() => persistence.list())
    for (const row of Array.isArray(rows) ? rows : []) {
      const header = row?.header ?? row
      if (header?.id === sessionId && typeof header.cwd === 'string' && header.cwd !== '') return header.cwd
    }
  }
  return ''
}

/**
 * Why a session the tools will not act on was refused.
 *
 * One sentence for all three tools, so the boundary is one rule rather than three
 * wordings that drift. It says what would put the session in scope, because the
 * caller's fix is to name a different session, not to retry.
 * @param sessionId - the id that was refused.
 * @returns the reason, for {@link unavailable}.
 */
function outOfScopeReason(sessionId) {
  return `session ${JSON.stringify(sessionId)} is not one this plugin is responsible for: these tools reach the `
    + 'sessions a task space this plugin made runs in, the ones a caller\'s own task record names, and the sessions '
    + 'working in that task\'s source checkouts. A session elsewhere - one the user opened by hand - is out of reach '
    + 'on purpose: cancelling it would abort the conversation they are having, and reading it would hand over messages '
    + 'nobody asked this plugin to hold. Use wts_session_tool_find with a cwd inside a task space to list the ones '
    + 'that are in scope.'
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
      // A message another agent sent is conversation, not injected context: a reader paging
      // this session has to see it, or a report this plugin itself delivered would vanish
      // from the very read tool that exists to show what happened here.
      if (source !== undefined && !CONVERSATIONAL_SOURCES.has(source.kind)) continue
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
    // Same rule as the read fold: an agent's message is a candidate title, an injected
    // instruction or checkpoint is not.
    if (source !== undefined && !CONVERSATIONAL_SOURCES.has(source.kind)) continue
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
    // The rows a caller may ask for, which is `MAX_RECENT` and not `DEFAULT_RECENT`. This
    // used to slice to the default, and `status` then sliced again to whatever was asked
    // for - so `recent: 20` returned eight rows, the documented maximum was unreachable,
    // and the tool's own description promised a number it could not deliver.
    //
    // Cutting here is right and the caller's slice is not redundant: the ceiling belongs
    // beside the fold it bounds, and the caller still asks for fewer. What cannot work is
    // a ceiling here lower than the one the schema advertises, which is what this was.
    recent: rows.slice(-MAX_RECENT),
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
    // Same ceiling as the live snapshot above, for the same reason: an offline session
    // asked for more rows must be answerable, and the caller is the one that decides how
    // many of the available rows it actually wanted.
    recent: rows.slice(-MAX_RECENT),
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

/**
 * The session id an agent is addressed by, or undefined when there is none.
 *
 * A tool run's `exec.agent` is the caller the harness set, and `agent.id` is its session id -
 * the same id `wts_session_tool_find` answers with and the same one a reader names to reach it.
 * Probed rather than assumed: a run with no agent (an anonymous caller, a scheduled job) must
 * leave the message unattributed rather than throw out of a property read.
 * @param agent - the tool run's caller agent, when it has one.
 * @returns the session id, or undefined.
 */
function sessionIdOf(agent) {
  const id = agent === undefined || agent === null ? undefined : agent.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * The source kinds that carry a conversational message a reader pages through.
 *
 * `user` is a person; `agent-message` and `team-message` are another agent speaking. Everything
 * else a session's log can hold under `user/message` is injected context rather than a turn's
 * content - instructions, a compaction checkpoint, a skill catalog - and a reader paging the
 * conversation should not be shown those as if somebody had said them.
 */
const CONVERSATIONAL_SOURCES = new Set(['user', 'agent-message', 'team-message'])

/**
 * A user message value, as `followup` / `steer` accept one.
 * @param text - the message body.
 * @param senderSessionId - the session sending it, when one is known.
 * @returns the message, attributed to `senderSessionId` when there is one.
 */
function userMessage(text, senderSessionId) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: sourceFor(senderSessionId),
  }
}

/**
 * Attribute a message to the agent that sent it, in the harness's own vocabulary.
 *
 * A report from one session to another is the same act the subagent channel performs when a
 * child reports to its parent, so it carries the same source: `agent-message` in the `relay`
 * form, naming the sender. That is what lets the interface present it as an agent's report -
 * its own row, "from session X", the agent icon - instead of as the user typing. The harness
 * is explicit that this map is merge-extensible and that every render decision keys on the
 * durable source, so a producer only has to write the source its audience already understands.
 *
 * With no sender to name, the message stays `user`: claiming an agent attribution this side
 * cannot substantiate would put words in a session's mouth that nothing recorded.
 * @param senderSessionId - the sending session's id, or undefined when there is none.
 * @returns the durable source for the message.
 */
function sourceFor(senderSessionId) {
  return typeof senderSessionId === 'string' && senderSessionId !== ''
    ? { kind: 'agent-message', form: 'relay', senderSessionId }
    : { kind: 'user' }
}

/**
 * The framing the receiving model reads, naming who sent the message.
 *
 * The interface shows the sender from the source alone, but the model only sees content blocks,
 * so the name has to be in the text as well. This mirrors the harness's own wording for an
 * agent-to-agent message rather than inventing a second phrasing for the same act.
 *
 * It is the fallback, not the rule: when {@link reportHeader} has already stated the session in
 * the header, repeating it as a sentence in front of the body says the same thing twice.
 * @param text - the message body.
 * @param senderSessionId - the sending session's id, or undefined when there is none.
 * @returns the text the receiving model reads.
 */
function framedForModel(text, senderSessionId) {
  return typeof senderSessionId === 'string' && senderSessionId !== ''
    ? `Agent ${senderSessionId} sent a message: ${text}`
    : text
}

/**
 * The facts a report carries above its body, so a reader knows where it came from.
 *
 * The interface names the sender as an opaque session id - `relaySender` in ui-chat reads
 * `senderSessionId` and says outright that it cannot resolve one to a title - so a report that
 * carried only that would be a uuid and a wall of prose. These are the readable facts the
 * sending side already knows, put where the reader (and the receiving model) can see them.
 *
 * Every field is optional and simply omitted when unknown: a report from a session that is not
 * in a task space is still a report, and a header with blanks in it would be worse than none.
 *
 * The task name is deliberately not one of them: it is already in the heading, and a line
 * repeating it would be the one field a reader never has to look for.
 *
 * `Role` breaks the "optional" rule above, and on purpose: it is the one field this file
 * states as a contract rather than as a nicety. A report must always carry who is speaking
 * and which session that is, and a line a caller could leave out is a line a caller could
 * hide. Its use is identification rather than permission: it is how a session reads back
 * which end of the dispatch it is on after its own turn has been interrupted, compacted or
 * resumed - see {@link senderRole} - and it is descriptive metadata a model reads, never a
 * policy input code uses: no gate, refusal, warning, audit entry or panel display reads
 * it, and later features must not either. The value comes from the sender's working
 * directory, which the host writes, never from anything the sender asserts, and where
 * nothing on disk supports an answer it says `unknown` rather than dropping the line.
 */
const REPORT_FIELDS = [
  ['workspace', 'Workspace'],
  ['path', 'Task space'],
  ['branch', 'Branch'],
  ['directory', 'Working directory'],
  // The role qualifies the session id that follows it, so the two are read together.
  ['role', 'Role'],
  ['sender', 'Session'],
]

/**
 * Which end of a dispatch a sending session stands on, from where it works.
 *
 * **What the line is for.** A session's identity in a dispatch is otherwise something it
 * only knows from the conversation that produced it - and a turn can be interrupted, its
 * context compacted or resumed, and that memory is gone. The role line is how the session
 * reads its own position back off disk after that happens, rather than re-deriving it or
 * guessing it: `leader:` says it is the end that dispatched the work and takes the
 * reports, `member:` says it is the session executing the task in a task space.
 *
 * This is the fallback, and it is worth saying when it is not used: both ends normally
 * know their own position from the exchange itself - the session that dispatched made the
 * call, and is the leader by that act - so nothing here runs in the ordinary case. The
 * question below is what a session asks itself after a resume, when the conversation no
 * longer answers it.
 *
 * **A label, not a gate.** This traffic is not really this plugin's contract; the tools
 * borrow the host's message channel to deliver a report. The role is descriptive metadata
 * for a model to read and never a policy input for code to use: it takes no part in
 * letting a call through or refusing one, in a self-cancel refusal, in the audit log, or
 * in what the panel shows - and no later feature may put it to such use either. What may
 * be reached is settled by {@link sessionInScope} alone, which does not read this value,
 * and a report whose role reads `unknown` is delivered exactly like any other.
 *
 * The question is narrow on purpose: **am I a member** - a session working in a task space
 * this plugin made. Two tests, the record first:
 *
 *  1. the directory holds the task-space record, or sits under one that does. This is the
 *     plainest positive evidence there is, and the walk upward is what covers a session
 *     opened on `<task space>/<repo>` as well as one opened on the space itself.
 *  2. no record answers, but a linked worktree is what the directory is - or what sits
 *     directly inside it, which is the worktree of the space one level up. This is the arm
 *     a finish leaves room for: taking a task apart removes the record while the worktree
 *     is still mounted, and a session working in it is still a member.
 *
 * A repository is asked about its children only when it is not one itself. `git worktree
 * add` registers its worktrees inside a repository's own `.git/`, so a checkout routinely
 * holds worktree-shaped directories - and the session working at a checkout is the end that
 * dispatched the work, so reading it as a member because of what sits below it would be
 * exactly the inference from a directory this rule refuses to make.
 *
 * Anything else answers `unknown`, and that is the whole of it: this side does **not**
 * infer leadership from a directory. A source checkout, a workspace holding repositories,
 * a container root, an unrelated folder - none of them state "I dispatched this work",
 * because that is a fact about a conversation, not about a path. The value range keeps
 * `leader` for the ends that know it, and a reader can tell the far end is a member from
 * the line beside it. Both ends of one exchange reading `unknown` is not a case worth
 * designing for: with no task space left standing there is nothing here to report about,
 * and the session answers from the conversation it is in.
 *
 * The position is read from the filesystem, never asserted by the caller, and never
 * derived from a session id - the id travels on its own `Session:` line, as the contract's
 * other half, not as evidence for this one. It also does not consult the record's `leader`
 * entry: that one is an audit fact about who dispatched, written at dispatch, and a task
 * space whose record predates it still answers from position here.
 * @param cwd - the sending session's working directory, when it has one.
 * @returns 'member', or 'unknown' when the directory does not say a member works in it.
 */
async function senderRole(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return 'unknown'
  // 1. The record, at the directory or above it: the direct answer, and the only one that
  // needs nothing from git. `taskSpaceAbove` is the same walk the scope gate uses.
  if ((await taskSpaceAbove(cwd)) !== undefined) return 'member'
  // 2. No record answers, so ask whether this is a worktree. The directory itself, or its
  // children one level down - because a session is opened either on the task space, whose
  // worktrees sit below it, or on one of those worktrees.
  if (await isLinkedWorktree(cwd)) return 'member'
  // A repository is asked about its children only when it is not one itself. `git worktree
  // add` registers its worktrees *inside* the repository's own `.git/`, so a checkout
  // routinely holds worktree-shaped directories - but the session working at a checkout is
  // the end that dispatched the work, and calling it a member because of what sits below it
  // would be exactly the inference from a directory this rule refuses to make.
  if (await isSourceRepository(cwd)) return 'unknown'
  const entries = await readdir(cwd, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    // A symlink is not followed: this asks what the workspace is, not what points into it
    // from somewhere else on the machine.
    if (!entry.isDirectory()) continue
    if (await isLinkedWorktree(join(cwd, entry.name))) return 'member'
  }
  return 'unknown'
}

/**
 * The longest a header field may be, and the one place that number is written.
 *
 * A field is a name, a path or a uuid, so this is generous for all three; what it is
 * not is unbounded. The task name and the branch come out of the task space's own
 * record, which the session that works there can write (the space is its working
 * directory), and the header is read by another model - so a value that runs to
 * megabytes is a value this side chose to forward. Truncated rather than refused:
 * a report with an over-long task name is still a report about that task.
 */
const REPORT_FIELD_LIMIT = 200

/**
 * Fold a value into the one line a header field occupies, or nothing.
 *
 * Every character that could make a value stop being one field is removed rather
 * than escaped, because the header is plain text a model reads and an escape would
 * be one more thing for it to decode. Newlines and carriage returns go first: they
 * are what let a record field forge a second header line, and a forged
 * `Workspace: trusted` above the real body is the whole reason this exists.
 *
 * Control characters go with them. A record field is a file's contents, so it can
 * hold anything a text file can, and none of it is a name, a path or an id.
 * @param value - the field as the record stated it.
 * @returns one line, or '' when nothing usable is left.
 */
function reportFieldLine(value) {
  const folded = String(value ?? '')
    // Whitespace first, so a newline becomes a space rather than joining two words.
    .replace(/\s+/g, ' ')
    // Then anything else that is not a printable character. `\u007f` is DEL, which
    // is invisible and therefore worse than a character that shows.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim()
  if (folded === '') return ''
  return folded.length > REPORT_FIELD_LIMIT ? `${folded.slice(0, REPORT_FIELD_LIMIT)}…` : folded
}

/**
 * The boundary that separates the plugin's header from the reported body.
 *
 * A line of ordinary text cannot be this. The whole point is that the two sides are
 * told apart by something a record field cannot contain, and a field can contain any
 * text - which is exactly how a forged `报告正文：` inside a task name produced two
 * boundaries. So the boundary carries the one thing a field cannot: a run of
 * characters drawn here, at send time, from a random source. A field cannot guess it,
 * and even a field that carried a *previous* report's marker verbatim would not match
 * this one.
 *
 * It stays readable rather than being a bare uuid: a person reading the transcript
 * sees where the plugin's own words stop and the agent's begin.
 * @returns the marker line, unique to this report.
 */
function reportBoundary() {
  return `----- 报告正文 ${randomUUID()} -----`
}

/**
 * Assemble the header block a report opens with.
 *
 * Every value that reaches this is folded to one bounded line first
 * ({@link reportFieldLine}), and the body is introduced by a boundary this function
 * generates rather than by a fixed string ({@link reportBoundary}). Both halves are
 * needed: the first stops a record field becoming a second header line, the second
 * stops it forging the marker that says where the body starts.
 *
 * The task name is folded through the same rule as the fields even though it sits in
 * the heading: it comes from the same record, so it is the same untrusted value.
 * @param facts - the task name, workspace title, task-space path, branch, sender role
 * and sender id.
 * @returns the header lines and the body's opening boundary, or '' when nothing is known.
 */
function reportHeader(facts) {
  const lines = []
  for (const [key, label] of REPORT_FIELDS) {
    const value = reportFieldLine(facts[key])
    if (value !== '') lines.push(`${label}: ${value}`)
  }
  if (lines.length === 0) return ''
  // The title names the report; the facts follow it. `任务【login】执行报告` reads as a heading
  // over the fields rather than as one more field, which is what makes it scannable. Without a
  // task it is an agent's report rather than a task's, and saying "任务" there would name a task
  // this side never found.
  const task = reportFieldLine(facts.task)
  const heading = task !== '' ? `任务【${task}】执行报告` : 'Agent 执行报告'
  return `${heading}\n\n${lines.join('\n')}\n\n${reportBoundary()}\n`
}

/**
 * Read the facts a sending session can state about itself.
 *
 * Best effort by construction: this runs on the send path, where a missing registry or an
 * unreadable record must cost a line of the header rather than the report itself. The task-space
 * facts come from the session's own directory - the metadata file a task space carries - so a
 * session that is not in one simply contributes no task fields.
 * @param ctx - the host plugin context.
 * @param senderSessionId - the sending session's id.
 * @param cwd - the sending session's working directory, when it has one.
 * @returns the header facts, each present only when known.
 */
async function reportFacts(ctx, senderSessionId, cwd) {
  const facts = {}
  if (typeof senderSessionId === 'string' && senderSessionId !== '') {
    facts.sender = senderSessionId
    // The role qualifies the session, so it is read exactly when there is a session to
    // qualify. A run with no caller agent has no sender to name, and its working
    // directory comes from that same agent - so such a run states no facts at all and
    // stays the unattributed message it always was. A role beside no session id would
    // be a line about a sender this side cannot name, which is the one thing the
    // contract does not ask for.
    facts.role = await senderRole(cwd)
  }
  // The task's own record, read from the directory the session works in. It carries the task
  // name and the branch, and it is also what makes the directory a TASK SPACE rather than an
  // ordinary working directory - so the path is only labelled as one once this has answered.
  // Labelling every cwd a task space would be a claim the record does not support, and a report
  // from a session that is not on a task would name a task space that does not exist.
  const metadata = typeof cwd === 'string' && cwd !== ''
    ? await safelyAsync(() => readTaskMetadata(cwd))
    : undefined
  const onTask = metadata !== null && metadata !== undefined && typeof metadata === 'object'
  if (typeof cwd === 'string' && cwd !== '') {
    if (onTask) facts.path = cwd
    else facts.directory = cwd
  }
  if (onTask) {
    // Validated at the level the write side uses, not merely folded: the record is
    // inside the task space, so the session working there can write any string into
    // these two fields. A value this plugin could never have written - a task name
    // with a separator or whitespace, a branch that is not a legal ref - is not one
    // to repeat back as a fact about where the report came from, and dropping it is
    // what says so. The fields that follow fold and cap whatever survives.
    if (isUsableTaskName(metadata.task)) facts.task = metadata.task
    if (isUsableBranchName(metadata.branch)) facts.branch = metadata.branch
  }
  // The Workspace title the sidebar shows, which is what a reader recognises the space by.
  const title = workspaceTitleByPath(ctx, cwd)
  if (title !== undefined) facts.workspace = title
  return facts
}

/**
 * The title of the Workspace a directory is registered as.
 * @param ctx - the host plugin context.
 * @param path - the directory.
 * @returns the title, or undefined when no Workspace claims that directory.
 */
function workspaceTitleByPath(ctx, path) {
  if (typeof path !== 'string' || path === '') return undefined
  const registry = service(ctx, 'workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') return undefined
  const workspaces = safely(() => registry.list())
  for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
    if (workspace?.path === path) {
      const title = workspace.title
      if (typeof title === 'string' && title.trim() !== '') return title.trim()
    }
  }
  return undefined
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
 * @param options.liveCheck - asked between passes whether the session can still answer, when
 *   the caller has a way to know. See below for what a `false` means to the caller.
 * @returns the observed output, the baseline, and how the wait ended.
 *
 * ## A session that cannot answer ends the wait early
 *
 * This is a behaviour change, not a cost one, and it is the second half of the review's
 * item 12. A wait whose session went offline or was cancelled used to keep polling until
 * the budget ran out - up to an hour, on the documented maximum - because nothing in the
 * loop knew the session could no longer produce a reply. The tool's own `execute` holds
 * the live agent, so it can answer that question between passes, and a `false` from
 * `liveCheck` breaks the wait.
 *
 * What the caller sees, exactly: `timedOut` stays true (nothing arrived), `stale` is true
 * when an older reply exists to fall back on and false when there is none, `aborted` stays
 * false because the caller's own signal did not fire, and `waitedMs` is small rather than
 * the budget. A caller that wants to tell this apart from an exhausted budget reads
 * `waitedMs` against the `timeoutMs` it sent. That is the whole of the change; no field was
 * added and none was removed, so a caller that ignores `waitedMs` sees exactly what it saw
 * before, only sooner.
 *
 * Exported for the test that has to observe the reading being incremental. That cannot be
 * done through the tool: the saving is invisible in every field it returns - a frozen
 * cursor answers identically - so the test drives this function with `reportFolded` and
 * asserts on the count. Everything else about it is internal.
 */
export async function waitForReply(options) {
  const started = Date.now()
  const deadline = started + options.timeoutMs
  // The highest event seq already folded. The log is append-only, so a pass only has to
  // look at what was appended since the last one - see the note above for what is
  // deliberately still read in full.
  let cursor = options.baselineSeq
  // The highest seq any folded event has carried. Written as a maximum, not as "the last
  // event's seq": the guard above already skips anything at or below the cursor, so within
  // one pass the two spellings are equivalent - which is exactly why the maximum is the
  // one to write. It stays correct if the guard is ever relaxed, it states the invariant
  // the pass depends on, and it cannot be read as depending on an order that
  // `sessionEvents` does not promise: it hands back the host's array unsorted, and the
  // whole-log fold this replaced was order-independent (`row.seq > latest.seq`).
  const advance = (seq) => { if (seq > cursor) cursor = seq }
  // The highest `turn/end` seq seen so far, tracked across passes rather than compared
  // against `events` each time: a turn end that arrived in an earlier pass still answers
  // the question, because the question is "did one land after the newest assistant row".
  let turnEndedAfter = -1
  let latest = null
  let textReply = null
  let turnEnded = false
  let interval = WAIT_POLL_MIN_MS
  // How much the wait folded, reported to a caller that asks for it.
  //
  // This exists because the saving is invisible in the answer: a wait whose cursor never
  // moves returns exactly the same fields as one whose cursor works, which is what makes
  // this the single part of the change an equivalence test cannot reach. The count is the
  // only thing that can hold it. No tool passes this, so no tool output changes.
  let folded = 0
  for (;;) {
    if (options.signal !== undefined && options.signal.aborted) break
    const events = sessionEvents(options.session)
    for (const event of events) {
      if (typeof event.seq !== 'number' || event.seq <= cursor) continue
      folded += 1
      // Folded one event at a time, so `latest` means "the newest assistant row past the
      // baseline" whether this pass saw it or an earlier one did. Folding the window in
      // one call would keep only the newest row *within the window*, which is the same
      // answer only while the window is the whole log - the thing being changed.
      //
      // Changing this line to `foldMessages(events)` looks equivalent and is not: it folds
      // the whole log once per event, which is O(n^2) rather than O(n) a pass. No test
      // catches it - the answers are identical and the `folded` count measures events
      // admitted rather than arguments passed - so this comment is the only warning there
      // is. Holding it would take a second counter in production code for a
      // constant-factor regression, which is not worth the seam.
      for (const row of foldMessages([event])) {
        if (row.role !== 'assistant') continue
        if (latest === null || row.seq > latest.seq) latest = row
        if (row.text !== undefined && (textReply === null || row.seq > textReply.seq)) textReply = row
      }
      if (event.type === 'turn/end' && event.seq > turnEndedAfter) turnEndedAfter = event.seq
      advance(event.seq)
    }
    if (options.requireTurnEnd === true && latest !== null && turnEndedAfter > latest.seq) turnEnded = true
    const done = options.requireTurnEnd === true ? latest !== null && turnEnded : textReply !== null
    if (done) break
    // Asked after a full pass, so a session that answered and then stopped is still
    // answered for: the reply is already in hand by the time this can break anything.
    if (typeof options.liveCheck === 'function' && options.liveCheck() === false) break
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    // Clamped to what is left, so a wait never overshoots its own budget by an interval:
    // with the interval growing to a second, an unclamped sleep could return up to that
    // much after the deadline, and a caller timing the call would see it.
    await sleep(Math.min(interval, remaining))
    interval = Math.min(interval * 2, WAIT_POLL_MAX_MS)
  }
  let observedNew = textReply !== null
  let stale = false
  if (textReply === null) {
    // The whole log, and it should be: this runs at most once, only when nothing new
    // arrived, and it is looking for the newest reply at or *before* the baseline - the
    // one question a cursor pointing forward cannot answer.
    const rows = foldMessages(sessionEvents(options.session))
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]
      if (row.role === 'assistant' && row.text !== undefined && row.seq <= options.baselineSeq) { textReply = row; stale = true; break }
    }
  }
  return {
    message: textReply,
    seq: textReply === null ? options.baselineSeq : textReply.seq,
    // Carried through so `renderWait` can decide whether `turnEnded` means anything for
    // this wait: in the default mode the field is never examined, and reporting it as
    // `false` would be an answer to a question nobody asked.
    requireTurnEnd: options.requireTurnEnd === true,
    turnEnded,
    timedOut: options.requireTurnEnd === true ? !(latest !== null && turnEnded) : !observedNew,
    stale,
    aborted: options.signal !== undefined && options.signal.aborted,
    waitedMs: Date.now() - started,
    // Reported only to a caller that asked for it. `renderWait` does not copy it, so the
    // tool's answer is unchanged; it exists for the test that has to observe the reading
    // being incremental, which no returned field can show.
    ...(options.reportFolded === true ? { folded } : {}),
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
    // Present only when the caller asked for it. `turnEnded` used to be returned as
    // `false` in the default mode, where the wait does not look at turn ends at all -
    // so a `false` there read as "the turn has not ended", which is a claim this side
    // never checked and, for a `followup`-driven session, a claim that can be false
    // while the reply is right there. An absent field says "not asked", and the tool's
    // description already tells a caller to pass `requireTurnEnd` for that answer.
    ...(wait.requireTurnEnd === true ? { turnEnded: wait.turnEnded } : {}),
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
      + 'A task space\'s own record already carries the session ids it opened (see `.worktree-space/worktree-space.json` and the '
      + 'wts_worktree_space list action), so search only when that id is not to hand.',
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
    async execute(args, exec) {
      const sessionId = requiredString(args.sessionId, 'sessionId', 'the id wts_session_tool_find answered with')
      const agents = agentsOf(ctx)
      const agent = agents === undefined ? undefined : safely(() => agents.get(sessionId))
      let events
      let live = false
      let cwd
      let title
      if (agent !== undefined && agent !== null) {
        // Scope, asked before a live session's log is handed back. `read` reaches
        // further than the other two in one way that matters: it returns a whole
        // message list and the reasoning behind it.
        if (!(await sessionInScope(ctx, sessionId, agent, exec))) {
          return unavailable(sessionId, outOfScopeReason(sessionId))
        }
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
        // Existence had to be settled first, because the two refusals above are the
        // more useful answer when the deployment, not the session, is the problem.
        // Nothing is returned before this point: the events were read to identify
        // the session, and an out-of-scope answer discards them unread.
        if (!(await sessionInScope(ctx, sessionId, agent, exec))) {
          return unavailable(sessionId, outOfScopeReason(sessionId))
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
      // Scope, asked before anything is sent. These tools exist so a leader can reach the
      // session it dispatched, which is not its child - but the same reach would steer text
      // into any session on the machine. See {@link sessionInScope} for what is in.
      if (!(await sessionInScope(ctx, sessionId, agent, exec))) return unavailable(sessionId, outOfScopeReason(sessionId))
      const mode = args.mode === 'steer' ? 'steer' : 'queue'
      // Who is speaking: the session that called this tool. `exec.agent` is the caller the
      // harness sets on every tool run, so the report is attributed to the agent that wrote
      // it rather than to nobody.
      const senderSessionId = sessionIdOf(exec?.agent)
      // Everything from here to the end of the reply happens inside this session's turn, and
      // that includes `reportFacts`. It awaits the task record, and an await *before* the
      // lock lets a concurrent wait run to completion first - the lock then serialises two
      // bodies while doing nothing about the work that already happened outside it. A
      // serialisation covering part of an operation is the shape this item is about, so the
      // header is built inside too rather than before.
      const { baseline, reply } = await withSessionTurn(sessionId, async () => {
        // The readable facts above the body. The interface can name the sender only as a
        // session id, so the report states where it came from in its own text.
        const facts = await reportFacts(ctx, senderSessionId, exec?.agent?.session?.header?.cwd)
        const header = reportHeader(facts)
        // The header names the session itself, so the harness-style sentence would say it
        // twice. It stays the fallback for a report with no header at all - one sent from a
        // session that is not in a task space - where naming the sender is the only
        // attribution there is.
        const framed = header === '' ? framedForModel(message, senderSessionId) : message
        const outbound = userMessage(header + framed, senderSessionId)
        // The baseline is read here rather than outside for the same reason: a value read
        // before the turn began would describe a log a `wait` behind it had already moved.
        const at = maxSeq(sessionEvents(agent.session))
        if (mode === 'steer') agent.steer(outbound)
        else agent.followup(outbound)
        if (args.waitForReply !== true) return { baseline: at, reply: undefined }
        const waited = await waitForReply({
          session: agent.session,
          baselineSeq: at,
          timeoutMs: clampTimeout(args.timeoutMs),
          signal: exec?.signal,
        })
        return { baseline: at, reply: renderWait(waited) }
      })
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
      // The baseline, the whole wait, and the reply it settles on are held under this
      // session's turn, so a `send` to the same session cannot land while this is watching.
      // Without that, the reply to somebody else's message arrives past this baseline and is
      // returned as the answer to this call - a well-formed answer to a question nobody
      // asked, which is worse than a refusal, because nothing in it says it is not the one
      // that was waited for.
      //
      // The baseline is read inside the lock for the same reason the `send` side reads its
      // own inside one: a value read before the turn began would describe a log the send
      // behind it had already changed.
      const { waited, baseline } = await withSessionTurn(sessionId, async () => {
        const at = typeof args.sinceSeq === 'number' && Number.isInteger(args.sinceSeq) && args.sinceSeq >= -1
          ? args.sinceSeq
          : maxSeq(sessionEvents(agent.session))
        const result = await waitForReply({
          session: agent.session,
          baselineSeq: at,
          timeoutMs: clampTimeout(args.timeoutMs),
          signal: exec?.signal,
          requireTurnEnd: args.requireTurnEnd === true,
          // The session this call is holding can stop being live while it waits, and the
          // registry is where that shows: a cancelled or disposed session is no longer a
          // running agent, and nothing it does afterwards can produce the reply being waited
          // for. Asked between passes so the wait ends then rather than at the budget's end,
          // which on the documented maximum is an hour.
          //
          // Asked of the registry rather than of the `agent` captured above, because that is
          // a snapshot: reading it again would answer about the moment the call started, and
          // would never change. A registry that cannot be asked is not an answer either way,
          // so it leaves the wait alone - the check only ever shortens a wait it can prove is
          // pointless.
          liveCheck: () => {
            const current = safely(() => agents.get(sessionId))
            return current !== undefined && current !== null
          },
        })
        return { waited: result, baseline: at }
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
    async execute(args, exec) {
      const sessionId = requiredString(args.sessionId, 'sessionId', 'the id wts_session_tool_find answered with')
      const agents = agentsOf(ctx)
      if (agents === undefined) return refusal(NO_AGENTS)
      const agent = safely(() => agents.get(sessionId))
      if (agent === undefined || agent === null) {
        return unavailable(sessionId, `session ${JSON.stringify(sessionId)} is not live — call wts_session_tool_resume first, because `
          + 'stopping needs a live session')
      }
      // Cancelling is the one of these that destroys work: it aborts the turn that is
      // running and, by default, throws away everything queued behind it. So it is held
      // to the scope test like the other two, and to two more of its own.
      if (!(await sessionInScope(ctx, sessionId, agent, exec))) return unavailable(sessionId, outOfScopeReason(sessionId))
      const callerSessionId = sessionIdOf(exec?.agent)
      // Not itself. A session that cancels itself ends the turn it is in, and the report
      // it was going to send with it - so the answer to "stop me" is not available from
      // inside the thing being stopped.
      if (callerSessionId !== '' && callerSessionId === sessionId) {
        return unavailable(sessionId, `this is the session making the call, and cancelling it would end this turn — and the report `
          + 'it would send — before the answer existed. Stop it from another session, or from the interface.')
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

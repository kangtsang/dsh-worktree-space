/**
 * The session-control tools: the eight `wts_session_tool_*` registrations.
 *
 * What a unit test can honestly check here is the contract, not the sessions:
 * the arguments each tool refuses, the shape it answers with, the filters it
 * applies, and — the point of the whole file — that a deployment serving **no**
 * session service still registers every tool and answers "not offered" instead
 * of throwing out of a service lookup. Whether a real session is created,
 * resumed or steered is the maintainer's end-to-end check against an installed
 * package, and nothing here pretends to cover it.
 */
import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerSessionTools } from "../src/host/session-tools.js"
import { registerTaskTool } from "../src/host/task/tool.js"
import { readTaskMetadata, renderTaskMetadata, taskMetadata, taskSessionsOf } from "../src/host/task/shared.js"

/** The eight tools, by name, as the plugin registers them. */
const TOOL_NAMES = [
  "wts_session_tool_find",
  "wts_session_tool_status",
  "wts_session_tool_read",
  "wts_session_tool_send",
  "wts_session_tool_create",
  "wts_session_tool_resume",
  "wts_session_tool_wait",
  "wts_session_tool_cancel",
]

/**
 * A context whose tool runtime captures what the plugin registers, and whose
 * service lookup answers whatever `services` holds.
 *
 * `services` is read per lookup rather than copied, so a test can hand in a
 * partial deployment — a tool runtime and nothing else — which is exactly the
 * degradation path under test.
 * @param services - the services this context serves, by name.
 * @returns the context and the captured definitions, by name.
 */
function toolContext(services = {}) {
  const captured = []
  const ctx = {
    get: (name) => (name === "tools"
      ? { register: (definition) => { captured.push(definition); return () => {} } }
      : services[name]),
  }
  return { ctx, captured, byName: () => Object.fromEntries(captured.map((entry) => [entry.name, entry])) }
}

/** A user message event, as a session log carries one. */
const userEvent = (seq, text, time = seq * 10) => ({
  type: "user/message",
  seq,
  time,
  data: { source: { kind: "user" }, content: [{ type: "text", text }] },
})

/** An assistant message event, with optional reasoning and tool calls. */
const assistantEvent = (seq, text, { reasoning, toolCalls, time = seq * 10 } = {}) => ({
  type: "assistant/message",
  seq,
  time,
  data: {
    turn: 1,
    step: 1,
    message: {
      content: [
        ...(reasoning === undefined ? [] : [{ type: "reasoning", text: reasoning }]),
        ...(text === undefined ? [] : [{ type: "text", text }]),
      ],
      ...(toolCalls === undefined ? {} : { toolCalls: toolCalls.map((name) => ({ name })) }),
    },
  },
})

/**
 * A fake live agent over a fixed event log.
 *
 * It records what was called on it rather than doing anything: what these tools
 * must get right is which of `followup` / `steer` / `cancel` they reach for, with
 * which arguments, and that is what `calls` is for.
 * @param options - the session id, the log, the status and the pending inbox.
 * @returns the agent and the list of calls made on it.
 */
function fakeAgent({ id = "s-1", events = [], status = "idle", cwd = "/task/space", inbox = {} } = {}) {
  const calls = []
  const agent = {
    id,
    status,
    session: { header: { id, cwd, createdAt: 1 }, snapshotEvents: () => events },
    inbox,
    followup: (message) => calls.push({ kind: "followup", message }),
    steer: (message) => calls.push({ kind: "steer", message }),
    cancel: (cause, options) => calls.push({ kind: "cancel", cause, options }),
    calls,
  }
  return agent
}

/**
 * A deployment that serves the session services, over a fixed set of sessions.
 * @param agents - the live agents, keyed by session id.
 * @param options - the persisted sessions and the workspaces.
 * @returns the services map and the recorded side effects.
 */
function sessionServices(agents = {}, { persisted = [], workspaces = [], resume } = {}) {
  const created = []
  const prompted = []
  const resumed = []
  const services = {
    agents: {
      get: (id) => agents[id],
      list: () => Object.values(agents),
      create: async (options) => {
        created.push(options)
        const agent = fakeAgent({ id: options.sessionId, cwd: options.meta?.cwd })
        agents[options.sessionId] = agent
        // The real registry awaits setup before publishing, so a test that checks
        // what setup composed has to see it run here too.
        if (typeof options.setup === "function") await options.setup({})
        return { agent }
      },
      resume: async (options) => {
        resumed.push(options)
        if (resume !== undefined) return resume(options)
        const agent = fakeAgent({ id: options.resumeSessionId })
        agents[options.resumeSessionId] = agent
        return { agent }
      },
    },
    sessionPersistence: {
      list: async () => persisted.map((header) => ({ header })),
      inspect: async (id) => {
        const record = persisted.find((header) => header.id === id)
        if (record === undefined) throw new Error(`unknown session ${id}`)
        return { events: record.events ?? [], meta: { cwd: record.cwd } }
      },
    },
    workspaceRegistry: {
      list: () => workspaces,
      resolveByPath: async (path) => workspaces.find((workspace) => workspace.path === path),
    },
    sessionTitle: { rename: () => ({ title: "renamed" }) },
    sessions: { get: () => ({ append: () => {} }) },
  }
  return { services, created, prompted, resumed }
}

describe("registerSessionTools", () => {
  it("registers exactly the eight session tools, and returns one disposer for them", () => {
    const { ctx, captured } = toolContext()
    const dispose = registerSessionTools(ctx)
    expect(captured.map((entry) => entry.name)).toEqual(TOOL_NAMES)
    expect(typeof dispose).toBe("function")
  })

  it("stays out of the way when the deployment serves no tool runtime", () => {
    expect(registerSessionTools({ get: () => undefined })).toBeUndefined()
  })

  it("survives a bare context double with no service lookup", () => {
    expect(() => registerSessionTools({})).not.toThrow()
    expect(registerSessionTools({})).toBeUndefined()
  })

  it("still registers every tool when the deployment serves no session service", () => {
    // The point of probing rather than injecting: a profile without these services
    // gets the tools, and each one answers what it cannot do. Injecting them would
    // register nothing at all here, which is silent and indistinguishable from the
    // plugin not being installed.
    const { ctx, captured } = toolContext()
    registerSessionTools(ctx)
    expect(captured.map((entry) => entry.name)).toEqual(TOOL_NAMES)
    for (const tool of captured) {
      expect(typeof tool.execute).toBe("function")
      expect(typeof tool.output.render).toBe("function")
    }
  })

  it("answers 'not offered by this deployment' instead of throwing, one tool at a time", async () => {
    const { ctx, byName } = toolContext()
    registerSessionTools(ctx)
    const tools = byName()
    const calls = [
      ["wts_session_tool_find", {}],
      ["wts_session_tool_status", { sessionId: "s-1" }],
      ["wts_session_tool_read", { sessionId: "s-1" }],
      ["wts_session_tool_send", { sessionId: "s-1", message: "hello" }],
      ["wts_session_tool_create", { cwd: "/task/space" }],
      ["wts_session_tool_resume", { sessionId: "s-1" }],
      ["wts_session_tool_wait", { sessionId: "s-1" }],
      ["wts_session_tool_cancel", { sessionId: "s-1" }],
    ]
    for (const [name, args] of calls) {
      const value = await tools[name].execute(args, {})
      expect(value.offered, name).toBe(false)
      expect(value.reason, name).toMatch(/does not offer/)
      expect(value.summary, name).toBe(value.reason)
      // A refusal is still a rendered result, not an exception the model reads as a
      // stack trace.
      const rendered = tools[name].output.render(args, value)
      expect(rendered[0].text, name).toMatch(/does not offer/)
    }
  })

  it("requires the arguments a tool cannot proceed without", async () => {
    const { ctx, byName } = toolContext()
    registerSessionTools(ctx)
    const tools = byName()
    // A missing argument is refused by the declared schema, before the body runs;
    // an empty one passes the schema and is refused by the tool itself. Both are
    // clear about which argument is meant, which is the requirement.
    for (const name of ["wts_session_tool_status", "wts_session_tool_read", "wts_session_tool_wait", "wts_session_tool_cancel", "wts_session_tool_resume"]) {
      await expect(tools[name].execute({}, {}), name).rejects.toThrow(/missing required property "sessionId"/)
      await expect(tools[name].execute({ sessionId: "   " }, {}), name).rejects.toThrow(/sessionId is required/)
    }
    await expect(tools.wts_session_tool_send.execute({}, {})).rejects.toThrow(/missing required property "sessionId"/)
    await expect(tools.wts_session_tool_send.execute({ sessionId: "s-1" }, {})).rejects.toThrow(/missing required property "message"/)
    await expect(tools.wts_session_tool_send.execute({ sessionId: "s-1", message: "  " }, {})).rejects.toThrow(/message is required/)
    // A create has no session to read a directory from: one of cwd or workspaceId
    // has to be named, and the refusal says which.
    await expect(tools.wts_session_tool_create.execute({}, {})).rejects.toThrow(/cwd is required/)
  })

  it("refuses an unknown send mode through the declared enum, before the tool runs", async () => {
    const { ctx, byName } = toolContext()
    registerSessionTools(ctx)
    // `defineTool` validates against the declared schema first, so a mode outside
    // queue/steer never reaches the body - which is what keeps the mode from
    // silently defaulting to queue.
    await expect(byName().wts_session_tool_send.execute({ sessionId: "s-1", message: "hi", mode: "interrupt" }, {}))
      .rejects.toThrow(/must be one of/)
    expect(byName().wts_session_tool_send.parameters.properties.mode.enum).toEqual(["queue", "steer"])
  })
})

describe("wts_session_tool_find", () => {
  it("filters by cwd, title and id, and reports live state", async () => {
    const live = fakeAgent({ id: "s-live", status: "running", cwd: "/ws/login", events: [userEvent(0, "fix the build")] })
    const { services } = sessionServices({ "s-live": live }, {
      persisted: [
        { id: "s-offline", cwd: "/ws/other", createdAt: 2, events: [userEvent(0, "another task")] },
        { id: "s-third", cwd: "/ws/login", createdAt: 3, events: [userEvent(0, "same directory")] },
      ],
      workspaces: [{ id: "ws-1", path: "/ws/login", sessionIds: ["s-live"] }],
    })
    const { ctx, byName } = toolContext(services)
    registerSessionTools(ctx)
    const find = byName().wts_session_tool_find

    const all = await find.execute({}, {})
    expect(all.offered).toBe(true)
    expect(all.total).toBe(3)
    // Live first: a live session is always the more current answer.
    expect(all.items[0]).toMatchObject({ sessionId: "s-live", live: true, running: true, workspaceId: "ws-1" })

    const byCwd = await find.execute({ cwd: "login" }, {})
    expect(byCwd.items.map((item) => item.sessionId).sort()).toEqual(["s-live", "s-third"])

    const byTitle = await find.execute({ title: "fix the build" }, {})
    expect(byTitle.items.map((item) => item.sessionId)).toEqual(["s-live"])

    const byId = await find.execute({ sessionId: "offline" }, {})
    expect(byId.items.map((item) => item.sessionId)).toEqual(["s-offline"])

    const liveOnly = await find.execute({ liveOnly: true }, {})
    expect(liveOnly.items.map((item) => item.sessionId)).toEqual(["s-live"])

    const limited = await find.execute({ limit: 1 }, {})
    expect(limited.items).toHaveLength(1)
    expect(limited.truncated).toBe(true)
  })
})

describe("wts_session_tool_status", () => {
  it("returns the documented fields from a live session", async () => {
    // Times are recent, so the session is busy rather than stalled: `lastActivity`
    // is an epoch timestamp and the age beside it is what a reader compares.
    const now = Date.now()
    const events = [
      userEvent(0, "build it", now - 30),
      { type: "turn/start", seq: 1, time: now - 20, data: { turn: 1 } },
      assistantEvent(2, "working on it", { reasoning: "checking the config", time: now - 10 }),
    ]
    const agent = fakeAgent({ id: "s-1", status: "running", events, inbox: { nextTurn: [{}], nextStep: [{}] } })
    const { services } = sessionServices({ "s-1": agent })
    const { ctx, byName } = toolContext(services)
    registerSessionTools(ctx)
    const value = await byName().wts_session_tool_status.execute({ sessionId: "s-1" }, {})

    expect(value.offered).toBe(true)
    expect(value.live).toBe(true)
    expect(value.running).toBe(true)
    expect(value.openTurn).toBe(true)
    expect(value.lastTurn).toBe(1)
    expect(value.lastActivity).toBe(now - 10)
    expect(value.lastActivityAgoMs).toBeGreaterThanOrEqual(0)
    expect(value.pendingWork).toBe(true)
    expect(value.nextTurnCount).toBe(1)
    expect(value.nextStepCount).toBe(1)
    expect(value.lastReply).toBe("working on it")
    expect(value.reasoningTail).toBe("checking the config")
    expect(value.stalled).toBe(false)
  })

  it("marks a running session stalled past the threshold, and never an idle one", async () => {
    const events = [assistantEvent(2, "done", { time: 1 })]
    const running = fakeAgent({ id: "s-run", status: "running", events })
    const idle = fakeAgent({ id: "s-idle", status: "idle", events })
    const { services } = sessionServices({ "s-run": running, "s-idle": idle })
    const { ctx, byName } = toolContext(services)
    registerSessionTools(ctx)
    const status = byName().wts_session_tool_status

    const stalled = await status.execute({ sessionId: "s-run", stalledMsThreshold: 1 }, {})
    expect(stalled.stalled).toBe(true)
    // An idle session that has been quiet for a long time is finished, not stuck.
    const quiet = await status.execute({ sessionId: "s-idle", stalledMsThreshold: 1 }, {})
    expect(quiet.running).toBe(false)
    expect(quiet.stalled).toBe(false)
  })

  it("names a turn that did not end completed, which is how an error is told from a finish", async () => {
    const events = [
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
      assistantEvent(1, "trying"),
      { type: "turn/end", seq: 2, time: 3, data: { turn: 1, reason: { kind: "error", error: { code: "RATE_LIMIT", message: "slow down" } } } },
    ]
    const { services } = sessionServices({ "s-1": fakeAgent({ id: "s-1", events }) })
    const { ctx, byName } = toolContext(services)
    registerSessionTools(ctx)
    const value = await byName().wts_session_tool_status.execute({ sessionId: "s-1" }, {})
    expect(value.lastTurnEnd).toMatchObject({ kind: "error", turn: 1, failure: { code: "RATE_LIMIT" } })
  })

  it("answers for an offline session from its persisted log rather than failing", async () => {
    const { services } = sessionServices({}, {
      persisted: [{ id: "s-old", cwd: "/ws/old", events: [userEvent(0, "old work"), assistantEvent(1, "still here")] }],
    })
    const { ctx, byName } = toolContext(services)
    registerSessionTools(ctx)
    const value = await byName().wts_session_tool_status.execute({ sessionId: "s-old" }, {})
    expect(value.offered).toBe(true)
    expect(value.live).toBe(false)
    expect(value.running).toBe(false)
    expect(value.lastReply).toBe("still here")
    expect(value.summary).toMatch(/resume/)
  })

  it("says a session is unknown instead of inventing one", async () => {
    const { services } = sessionServices({})
    const { ctx, byName } = toolContext(services)
    registerSessionTools(ctx)
    const value = await byName().wts_session_tool_status.execute({ sessionId: "nobody" }, {})
    expect(value.offered).toBe(true)
    expect(value.live).toBe(false)
    expect(value.reason).toMatch(/no persisted log/)
    expect(value.summary).toMatch(/unknown/)
  })

  it("names the missing persistence when that, not the session, is why nothing can be read", async () => {
    // A deployment serving the agent registry but no persistence: the session may
    // well exist, and the refusal has to say the log cannot be opened rather than
    // that the session is unknown. Only one of those is worth acting on.
    const agent = fakeAgent({ id: "s-1" })
    const { ctx, byName } = toolContext({ agents: { get: (id) => (id === "s-1" ? agent : undefined), list: () => [agent] } })
    registerSessionTools(ctx)
    const status = await byName().wts_session_tool_status.execute({ sessionId: "other" }, {})
    expect(status.offered).toBe(true)
    expect(status.reason).toMatch(/serves no session persistence/)
    const read = await byName().wts_session_tool_read.execute({ sessionId: "other" }, {})
    expect(read.offered).toBe(true)
    expect(read.reason).toMatch(/serves no session persistence/)
  })
})

describe("wts_session_tool_read", () => {
  it("applies the role filter and pages with sinceSeq", async () => {
    const events = [
      userEvent(0, "first question"),
      assistantEvent(1, "first answer"),
      userEvent(2, "second question"),
      assistantEvent(3, "second answer"),
    ]
    const { services } = sessionServices({ "s-1": fakeAgent({ id: "s-1", events }) })
    const { ctx, byName } = toolContext(services)
    registerSessionTools(ctx)
    const read = byName().wts_session_tool_read

    const both = await read.execute({ sessionId: "s-1" }, {})
    expect(both.messages.map((row) => `${row.role}:${row.seq}`)).toEqual(["user:0", "assistant:1", "user:2", "assistant:3"])

    const users = await read.execute({ sessionId: "s-1", role: "user" }, {})
    expect(users.messages.map((row) => row.text)).toEqual(["first question", "second question"])

    const assistants = await read.execute({ sessionId: "s-1", role: "assistant" }, {})
    expect(assistants.messages.map((row) => row.text)).toEqual(["first answer", "second answer"])

    // sinceSeq is strictly greater-than, which is what makes it a paging cursor:
    // the next page starts where the last one ended.
    const page = await read.execute({ sessionId: "s-1", sinceSeq: 1 }, {})
    expect(page.messages.map((row) => row.seq)).toEqual([2, 3])
    expect(page.nextSeq).toBe(3)

    const limited = await read.execute({ sessionId: "s-1", limit: 1 }, {})
    expect(limited.messages.map((row) => row.seq)).toEqual([3])
    expect(limited.truncated).toBe(true)
  })

  it("drops reasoning when asked, and reads an offline session's log", async () => {
    const events = [userEvent(0, "go"), assistantEvent(1, "answer", { reasoning: "because" })]
    const { services } = sessionServices({}, { persisted: [{ id: "s-old", cwd: "/ws", events }] })
    const { ctx, byName } = toolContext(services)
    registerSessionTools(ctx)
    const read = byName().wts_session_tool_read

    const withReasoning = await read.execute({ sessionId: "s-old" }, {})
    expect(withReasoning.live).toBe(false)
    expect(withReasoning.messages[1].reasoning).toBe("because")

    const without = await read.execute({ sessionId: "s-old", includeReasoning: false }, {})
    expect(without.messages[1]).not.toHaveProperty("reasoning")
  })
})

describe("wts_session_tool_send", () => {
  it("passes the mode through, and queues by default", async () => {
    const agent = fakeAgent({ id: "s-1" })
    const { services } = sessionServices({ "s-1": agent })
    const { ctx, byName } = toolContext(services)
    registerSessionTools(ctx)
    const send = byName().wts_session_tool_send

    const queued = await send.execute({ sessionId: "s-1", message: "carry on" }, {})
    expect(queued.accepted).toBe(true)
    expect(queued.mode).toBe("queue")
    // The anchor a caller passes to wait for THIS message specifically, rather than
    // for whatever happens to arrive next.
    expect(queued.sinceSeq).toBe(-1)
    expect(agent.calls.map((call) => call.kind)).toEqual(["followup"])
    expect(agent.calls[0].message.content).toEqual([{ type: "text", text: "carry on" }])

    const steered = await send.execute({ sessionId: "s-1", message: "stop now", mode: "steer" }, {})
    expect(steered.mode).toBe("steer")
    expect(agent.calls.map((call) => call.kind)).toEqual(["followup", "steer"])
  })

  it("says a session is not live rather than silently dropping the message", async () => {
    const { services } = sessionServices({})
    const { ctx, byName } = toolContext(services)
    registerSessionTools(ctx)
    const value = await byName().wts_session_tool_send.execute({ sessionId: "gone", message: "hello" }, {})
    // The deployment CAN send; this session is the problem. `offered` stays true, so
    // a caller can tell "choose another route" from "resume this one" — which is the
    // decision the flag exists for.
    expect(value.offered).toBe(true)
    expect(value.sessionId).toBe("gone")
    expect(value.reason).toMatch(/is not live/)
    expect(value.reason).toMatch(/wts_session_tool_resume/)
    expect(byName().wts_session_tool_send.output.render({}, value)[0].text).toMatch(/is not live/)
  })
})

describe("wts_session_tool_wait", () => {
  it("returns the existing output when the wait times out, not an empty answer", async () => {
    // The whole point of the stale fallback: a caller whose wait ran out still has
    // to learn what the session last said. An empty answer here would be
    // indistinguishable from a session that has never spoken.
    const events = [userEvent(0, "go"), assistantEvent(1, "the only answer")]
    const agent = fakeAgent({ id: "s-1", events })
    const { services } = sessionServices({ "s-1": agent })
    const { ctx, byName } = toolContext(services)
    registerSessionTools(ctx)
    const value = await byName().wts_session_tool_wait.execute({ sessionId: "s-1", timeoutMs: 20 }, {})
    expect(value.offered).toBe(true)
    expect(value.reply.timedOut).toBe(true)
    expect(value.reply.stale).toBe(true)
    expect(value.reply.message.text).toBe("the only answer")
    expect(value.reply.seq).toBe(1)
    expect(value.summary).toMatch(/timed out/)
  })

  it("returns a new reply that arrives within the budget, without waiting for the turn to end", async () => {
    const events = [userEvent(0, "go")]
    const agent = fakeAgent({ id: "s-1", events })
    const { services } = sessionServices({ "s-1": agent })
    const { ctx, byName } = toolContext(services)
    registerSessionTools(ctx)
    // The reply lands while the wait is running: the tool polls the live log, so a
    // session that answers mid-wait is seen without any turn/end.
    setTimeout(() => { events.push(assistantEvent(1, "here it is")) }, 30)
    const value = await byName().wts_session_tool_wait.execute({ sessionId: "s-1", sinceSeq: 0, timeoutMs: 2000 }, {})
    expect(value.reply.timedOut).toBe(false)
    expect(value.reply.stale).toBeUndefined()
    expect(value.reply.message.text).toBe("here it is")
    expect(value.sinceSeq).toBe(0)
  })

  it("refuses to wait on a session that is not live", async () => {
    const { services } = sessionServices({})
    const { ctx, byName } = toolContext(services)
    registerSessionTools(ctx)
    const value = await byName().wts_session_tool_wait.execute({ sessionId: "gone" }, {})
    expect(value.offered).toBe(true)
    expect(value.reason).toMatch(/is not live/)
  })
})

describe("wts_session_tool_cancel", () => {
  it("passes keepInbox through, and clears the inbox by default", async () => {
    const agent = fakeAgent({ id: "s-1", status: "running" })
    const { services } = sessionServices({ "s-1": agent })
    const { ctx, byName } = toolContext(services)
    registerSessionTools(ctx)
    const cancel = byName().wts_session_tool_cancel

    const cleared = await cancel.execute({ sessionId: "s-1" }, {})
    expect(cleared.cancelled).toBe(true)
    expect(cleared.keepInbox).toBe(false)
    expect(agent.calls[0]).toMatchObject({ kind: "cancel", options: { keepInbox: false } })
    expect(agent.calls[0].cause).toEqual({ kind: "user" })

    const kept = await cancel.execute({ sessionId: "s-1", keepInbox: true, cause: "runaway" }, {})
    expect(kept.keepInbox).toBe(true)
    expect(agent.calls[1]).toMatchObject({ kind: "cancel", options: { keepInbox: true } })
    expect(agent.calls[1].cause).toEqual({ kind: "hook", reason: "runaway" })
  })

  it("refuses to stop a session that is not live", async () => {
    const { services } = sessionServices({})
    const { ctx, byName } = toolContext(services)
    registerSessionTools(ctx)
    const value = await byName().wts_session_tool_cancel.execute({ sessionId: "gone" }, {})
    expect(value.offered).toBe(true)
    expect(value.reason).toMatch(/is not live/)
  })
})

describe("wts_session_tool_create and wts_session_tool_resume", () => {
  it("opens a session in the named directory and hands it the prompt", async () => {
    const { services, created, prompted } = sessionServices({}, {
      workspaces: [{ id: "ws-login", path: "/ws/login", sessionIds: [], attachSession: async () => {} }],
    })
    services.sessionController = {
      create: async (place) => { created.push(place); return { sessionId: "s-new" } },
      prompt: async (request, signal) => { prompted.push({ request, signal }); return { accepted: true } },
    }
    const { ctx, byName } = toolContext(services)
    registerSessionTools(ctx)
    const value = await byName().wts_session_tool_create.execute({ cwd: "/ws/login", prompt: "build it" }, {})

    expect(value.offered).toBe(true)
    expect(value.sessionId).toBe("s-new")
    expect(created).toEqual([{ cwd: "/ws/login" }])
    // The typed prompt request the Host's own client sends: a minted requestId, the
    // queue mode, the content, the caller's zone, and the signal the contract
    // declares. Sending the id and the content alone is what the Host reports as
    // `prompt rejected`.
    expect(prompted).toHaveLength(1)
    expect(typeof prompted[0].request.requestId).toBe("string")
    expect(prompted[0].request).toMatchObject({ sessionId: "s-new", mode: "queue", content: [{ type: "text", text: "build it" }] })
    expect(typeof prompted[0].signal?.throwIfAborted).toBe("function")
  })

  it("opens nothing but the session when no prompt was given", async () => {
    const { services, created, prompted } = sessionServices({})
    services.sessionController = {
      create: async (place) => { created.push(place); return { sessionId: "s-new" } },
      prompt: async () => { prompted.push({}); return {} },
    }
    const { ctx, byName } = toolContext(services)
    registerSessionTools(ctx)
    const value = await byName().wts_session_tool_create.execute({ cwd: "/ws/login" }, {})
    expect(value.sessionId).toBe("s-new")
    expect(prompted).toEqual([])
    // Nothing was handed over, so nothing is claimed to have been: `delivered` is
    // about the job, not about the session.
    expect(value).not.toHaveProperty("delivered")
    expect(value.summary).toContain("opened")
  })

  it("mounts an explicit preset when it has to create the session through the registry", async () => {
    // An explicit preset has to be MOUNTED, not merely named: naming it leaves the
    // id on the header while the agent runs on whatever composition the deployment
    // defaults to, and its tools would be somebody else's.
    const mounted = []
    const { services, created } = sessionServices({})
    services.agentPresets = { mount: async (agentCtx, id) => { mounted.push(id) } }
    const { ctx, byName } = toolContext(services)
    registerSessionTools(ctx)
    const value = await byName().wts_session_tool_create.execute({ cwd: "/ws/login", agentPreset: "task-runner" }, {})
    expect(value.sessionId).toMatch(/^wts-/)
    expect(mounted).toEqual(["task-runner"])
    // The preset reaches the header too, so the resumed session is composed the same.
    expect(created[0].meta.agentPreset).toBe("task-runner")
  })

  it("is a no-op that says so when the session is already live", async () => {
    const agent = fakeAgent({ id: "s-1", status: "running" })
    const { services, resumed } = sessionServices({ "s-1": agent })
    const { ctx, byName } = toolContext(services)
    registerSessionTools(ctx)
    const value = await byName().wts_session_tool_resume.execute({ sessionId: "s-1" }, {})
    expect(value.alreadyLive).toBe(true)
    expect(value.running).toBe(true)
    expect(resumed).toEqual([])
  })

  it("brings an offline session back online", async () => {
    const { services, resumed } = sessionServices({}, { persisted: [{ id: "s-old", cwd: "/ws/old" }] })
    const { ctx, byName } = toolContext(services)
    registerSessionTools(ctx)
    const value = await byName().wts_session_tool_resume.execute({ sessionId: "s-old" }, {})
    expect(value.resumed).toBe(true)
    expect(value.alreadyLive).toBe(false)
    expect(resumed).toEqual([{ resumeSessionId: "s-old" }])
  })

  it("refuses to resume a session with no persisted log", async () => {
    const { services } = sessionServices({})
    const { ctx, byName } = toolContext(services)
    registerSessionTools(ctx)
    const value = await byName().wts_session_tool_resume.execute({ sessionId: "nobody" }, {})
    expect(value.offered).toBe(true)
    expect(value.reason).toMatch(/is unknown here/)
  })
})

/**
 * A task space on disk holding one worktree and the record a create leaves.
 * @param options - the record's extra fields, and the deploy state to write.
 * @returns the container root, the task space and a cleanup.
 */
async function taskSpaceFixture({ record = {}, deployState } = {}) {
  const container = await mkdtemp(join(tmpdir(), "wts-session-tools-"))
  const taskPath = join(container, "kratos-admin", "login")
  await mkdir(join(taskPath, "alpha"), { recursive: true })
  await writeFile(join(taskPath, "alpha", ".git"), "gitdir: /elsewhere\n")
  const metadata = { ...taskMetadata({
    task: "login",
    project: "kratos-admin",
    tasksRoot: container,
    sourceRoot: "/source",
    branch: "task/login",
    repositories: [{ name: "alpha", sourcePath: "/source/alpha" }],
  }), ...record }
  await writeFile(join(taskPath, "worktree-space.json"), `${JSON.stringify(metadata, null, 2)}\n`)
  await writeFile(join(taskPath, "worktree-space.md"), renderTaskMetadata(metadata))
  if (deployState !== undefined) {
    await mkdir(join(taskPath, "deploy"), { recursive: true })
    await writeFile(join(taskPath, "deploy", ".state.json"), `${JSON.stringify(deployState)}\n`)
  }
  return { container, taskPath, cleanup: () => rm(container, { recursive: true, force: true }) }
}

/** A subprocess double whose git calls all succeed and print nothing. */
const quietSubprocess = {
  spawn: () => ({
    done: Promise.resolve({ exitCode: 0, signal: null }),
    collected: {
      stdout: { readFrom: () => ({ text: "" }) },
      stderr: { readFrom: () => ({ text: "" }) },
    },
  }),
}

/**
 * A context serving the tools plus whatever else the action under test looks up.
 * @param services - the services beyond `tools`.
 * @returns the context and the captured tool definitions.
 */
function taskToolContext(services = {}) {
  const captured = []
  const ctx = {
    subprocess: quietSubprocess,
    get: (name) => (name === "tools"
      ? { register: (definition) => { captured.push(definition); return () => {} } }
      : services[name]),
  }
  return { ctx, captured }
}

/** The `dispatch` services: a controller that opens `sessionId`, and no registry. */
function dispatchServices(sessionId = "s-dispatched") {
  const created = []
  const prompts = []
  return {
    created,
    prompts,
    services: {
      sessionController: {
        create: async (place) => { created.push(place); return { sessionId } },
        prompt: async (request, signal) => { prompts.push({ request, signal }); return { accepted: true } },
      },
      sessions: { get: () => ({ append: () => {} }) },
    },
  }
}

describe("§4.3 — a dispatched session is recorded in the task's own record", () => {
  it("writes the session id a create opened, and reports it in list", async () => {
    const fixture = await taskSpaceFixture()
    const { created, services } = dispatchServices("s-created")
    const { ctx, captured } = taskToolContext(services)
    try {
      registerTaskTool(ctx)
      const dispatched = await captured[0].execute(
        { action: "dispatch", task: "login", project: "kratos-admin", tasksRoot: fixture.container, prompt: "go" },
        {},
      )
      expect(dispatched.sessionId).toBe("s-created")
      expect(created).toEqual([{ cwd: fixture.taskPath }])

      // The record now names the session, so nothing has to search for it by
      // directory — which is the whole point of §4.3.
      const record = JSON.parse(await readFile(join(fixture.taskPath, "worktree-space.json"), "utf8"))
      expect(record.sessions).toHaveLength(1)
      expect(record.sessions[0]).toMatchObject({ sessionId: "s-created", role: "task" })
      expect(typeof record.sessions[0].at).toBe("string")

      // And the note a session reads in the task space carries it too.
      const note = await readFile(join(fixture.taskPath, "worktree-space.md"), "utf8")
      expect(note).toContain("`s-created`")

      const listed = await captured[0].execute({ action: "list", tasksRoot: fixture.container }, {})
      expect(listed.sessions).toEqual([{ sessionId: "s-created", role: "task", at: record.sessions[0].at }])
      expect(listed.summary).toContain("s-created")
    } finally {
      await fixture.cleanup()
    }
  })

  it("records the session a create-with-a-prompt opened, in the task space it just made", async () => {
    const container = await mkdtemp(join(tmpdir(), "wts-session-tools-create-"))
    const source = await mkdtemp(join(tmpdir(), "wts-session-tools-source-"))
    await mkdir(join(source, "alpha", ".git"), { recursive: true })
    const { services } = dispatchServices("s-inline")
    const { ctx, captured } = taskToolContext(services)
    // The branch is free: `show-ref` is git's way of saying it does not exist.
    ctx.subprocess = {
      spawn: ({ argv }) => ({
        done: Promise.resolve({ exitCode: argv.slice(3).join(" ").startsWith("show-ref") ? 1 : 0, signal: null }),
        collected: { stdout: { readFrom: () => ({ text: "" }) }, stderr: { readFrom: () => ({ text: "" }) } },
      }),
    }
    try {
      registerTaskTool(ctx)
      const value = await captured[0].execute(
        { action: "create", sourceRoot: source, task: "login", tasksRoot: container, prompt: "go" },
        {},
      )
      expect(value.sessionId).toBe("s-inline")
      const record = JSON.parse(await readFile(join(value.container, "worktree-space.json"), "utf8"))
      expect(record.sessions).toEqual([{ sessionId: "s-inline", at: record.sessions[0].at, role: "task" }])
    } finally {
      await rm(container, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
    }
  })

  it("reads a record that has no sessions field exactly as before", async () => {
    const fixture = await taskSpaceFixture()
    const { ctx, captured } = taskToolContext()
    try {
      const record = await readTaskMetadata(fixture.taskPath)
      // A record written before this field existed: it answers an empty list, and
      // that is not a claim that the task has no session — only that nobody wrote
      // one down.
      expect(record).not.toHaveProperty("sessions")
      expect(taskSessionsOf(record)).toEqual([])
      expect(taskSessionsOf(undefined)).toEqual([])
      expect(renderTaskMetadata(record)).not.toContain("## Sessions")

      registerTaskTool(ctx)
      const listed = await captured[0].execute({ action: "list", tasksRoot: fixture.container }, {})
      expect(listed.sessions).toEqual([])
      expect(listed.summary).not.toContain("Sessions:")
    } finally {
      await fixture.cleanup()
    }
  })

  it("reads the shorter sessionId spelling as one entry, and drops a malformed one", async () => {
    expect(taskSessionsOf({ sessionId: "s-short" })).toEqual([{ sessionId: "s-short", role: "task" }])
    expect(taskSessionsOf({ sessions: [{ sessionId: "a" }, "b", { sessionId: "" }, null, 7] })).toEqual([
      { sessionId: "a", role: "task" },
      { sessionId: "b", role: "task" },
    ])
    expect(taskSessionsOf({ sessions: [{ sessionId: "c", role: "handoff", at: "2026-01-01T00:00:00.000Z" }] }))
      .toEqual([{ sessionId: "c", role: "handoff", at: "2026-01-01T00:00:00.000Z" }])
  })
})

describe("§4.3 — list echoes what a deploy recorded", () => {
  it("reports the acceptance URL and the last smoke", async () => {
    const fixture = await taskSpaceFixture({
      deployState: { url: "http://localhost:4321", lastSmoke: { result: "pass", at: "2026-10-10T00:00:00.000Z" } },
    })
    const { ctx, captured } = taskToolContext()
    try {
      registerTaskTool(ctx)
      const listed = await captured[0].execute({ action: "list", tasksRoot: fixture.container }, {})
      expect(listed.deployment).toEqual([{
        task: "kratos-admin/login",
        url: "http://localhost:4321",
        smoke: "pass",
        smokeAt: "2026-10-10T00:00:00.000Z",
      }])
      expect(listed.summary).toContain("http://localhost:4321")
      expect(listed.summary).toContain("smoke pass")
    } finally {
      await fixture.cleanup()
    }
  })

  it("reports an undeployed task as having nothing, not as a failure", async () => {
    const fixture = await taskSpaceFixture()
    const { ctx, captured } = taskToolContext()
    try {
      registerTaskTool(ctx)
      const listed = await captured[0].execute({ action: "list", tasksRoot: fixture.container }, {})
      expect(listed.deployment).toEqual([{ task: "kratos-admin/login", url: "", smoke: "", smokeAt: "" }])
      expect(listed.summary).not.toContain("Acceptance")
    } finally {
      await fixture.cleanup()
    }
  })
})

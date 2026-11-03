/**
 * The model a task session runs on: who chooses it, and who may change it.
 *
 * Three questions, and this file asks them separately because they fail separately:
 *
 *   1. **Which model a dispatched session starts on** - the call's argument, else the
 *      Plugins page, else the dispatching session's own model. The order is the feature,
 *      so each level is tested with the ones above it present and absent.
 *   2. **What `wts_session_tool action "model"` writes** - the durable `model/selection`
 *      event and the live selection, and the resume that has to happen first when the
 *      member is offline.
 *   3. **Who may call it** - a leader moves its own member, and a member moves neither its
 *      leader nor a sibling. This is the one refusal in the file that is about identity
 *      rather than about arguments, so it is tested from both ends of the same record.
 *
 * The resolver is exercised directly rather than only through the tool: it is pure, and a
 * failure there would be reported by a tool test as "the wrong model was chosen", which
 * says nothing about which of the three levels was wrong.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applyRoute,
  clearRoute,
  currentSelectionOf,
  describeRoutes,
  explainRoute,
  modelCatalogOf,
  resolveDispatchModel,
  routeArmedFor,
  routeInCatalog,
  routeWarningOf,
  selectionOf,
} from "../src/host/task/session-model.js"
import { registerSessionTools } from "../src/host/session-tools.js"
import { PLUGIN_ROOT, taskMetadataPath } from "../src/host/task/shared.js"

/**
 * A task space on disk, holding a record naming two sessions and their roles.
 *
 * The record is what the direction test reads, so the fixture has to be a real one: the
 * leader works in the source checkout and the member in the task space, and the only place
 * that says which is which is this file.
 * @param dir - the task space directory.
 * @param sessions - the `sessions` array the record carries.
 * @returns the same directory.
 */
async function taskSpaceAt(dir, sessions) {
  await mkdir(join(dir, PLUGIN_ROOT), { recursive: true })
  await writeFile(taskMetadataPath(dir), JSON.stringify({
    version: 1,
    task: "space",
    project: "kratos-admin",
    branch: "task/space",
    sourceRoot: "/src/kratos-admin",
    repositories: [],
    sessions,
    createdAt: "2026-01-01T00:00:00.000Z",
  }), "utf8")
  return dir
}

/** A context serving only what a given test needs, so an absent service stays absent. */
function contextWith(services = {}) {
  const captured = []
  return {
    captured,
    ctx: {
      get: (name) => (name === "tools"
        ? { register: (definition) => { captured.push(definition); return () => {} } }
        : services[name]),
      on: services.on,
    },
  }
}

/** The `wts_session_tool` definition a context captured. */
function sessionToolOf(captured) {
  const tool = captured.find((entry) => entry.name === "wts_session_tool")
  if (tool === undefined) throw new Error("wts_session_tool was not registered")
  return tool
}

/**
 * A live agent whose session records what is appended to it.
 *
 * `append` is the durable half of a model switch, so it is the thing worth asserting on:
 * the event type and the payload are the contract with DSH's own projection.
 * @param id - the session id.
 * @param cwd - the working directory.
 * @returns the agent and the list of appended events.
 */
function recordingAgent(id, cwd) {
  const appended = []
  const agent = {
    id,
    status: "idle",
    session: {
      header: { id, cwd, createdAt: 1 },
      snapshotEvents: () => [],
      append: (type, data) => { appended.push({ type, data }) },
    },
  }
  return { agent, appended }
}

/** A catalog shaped like the one `modelCatalogOf` builds. */
const catalog = {
  providers: [
    { provider: "deepseek-account", models: ["deepseek-chat", "deepseek-reasoner"] },
    { provider: "codearts", models: ["gw-1"] },
  ],
  notes: [],
}

let SPACE = ""
let SOURCE = ""

beforeAll(async () => {
  SPACE = await mkdtemp(join(tmpdir(), "wts-model-space-"))
  SOURCE = await mkdtemp(join(tmpdir(), "wts-model-source-"))
})

afterAll(async () => {
  await rm(SPACE, { recursive: true, force: true })
  await rm(SOURCE, { recursive: true, force: true })
})

describe("which model a dispatched session starts on", () => {
  const leader = { provider: "deepseek-account", model: "deepseek-chat" }
  const configured = { provider: "codearts", model: "gw-1" }
  const asked = { provider: "deepseek-account", model: "deepseek-reasoner" }

  it("uses the model the dispatch named above everything else", () => {
    const resolved = resolveDispatchModel({ request: asked, configured, inherited: leader })
    expect(resolved.source).toBe("request")
    expect(resolved.route).toEqual({ provider: "deepseek-account", model: "deepseek-reasoner" })
  })

  it("falls back to the configured model when the dispatch named none", () => {
    const resolved = resolveDispatchModel({ request: undefined, configured, inherited: leader })
    expect(resolved.source).toBe("config")
    expect(resolved.route).toEqual({ provider: "codearts", model: "gw-1" })
  })

  it("inherits the dispatching session's model when nothing else names one", () => {
    const resolved = resolveDispatchModel({ request: undefined, configured: undefined, inherited: leader })
    expect(resolved.source).toBe("leader")
    expect(resolved.route).toEqual({ provider: "deepseek-account", model: "deepseek-chat" })
  })

  it("answers nothing rather than guessing when no level names a route", () => {
    const resolved = resolveDispatchModel({})
    expect(resolved.source).toBe("none")
    expect(resolved.route).toBeUndefined()
  })

  it("does not complete a half-named route from the level below", () => {
    // A provider with no model is not a route, and taking the model from the next level
    // down would be a pairing nobody asked for - reported as "configured" while being a
    // guess. Both halves have to come from one level or the level does not count.
    const resolved = resolveDispatchModel({
      request: { provider: "codearts", model: "" },
      configured: undefined,
      inherited: leader,
    })
    expect(resolved.source).toBe("leader")
    expect(resolved.route).toEqual(leader)
  })

  it("keeps the reasoning effort of the level it took the route from", () => {
    const resolved = resolveDispatchModel({
      request: { provider: "deepseek-account", model: "deepseek-reasoner", reasoningEffort: "high" },
      inherited: leader,
    })
    expect(resolved.route.reasoningEffort).toBe("high")
  })

  it("leaves the effort out of the payload rather than setting it to nothing", () => {
    // The Host appends this object as a durable event whose schema has an optional
    // `reasoningEffort`; an explicit `undefined` is a key that survives serialisation.
    expect(selectionOf("p", "m")).toEqual({ provider: "p", model: "m" })
    expect(selectionOf("p", "m", "")).toEqual({ provider: "p", model: "m" })
  })
})

describe("the model catalog", () => {
  it("merges both provider registries, because either one alone is half the answer", async () => {
    const { ctx } = contextWith({
      llm: {
        listProviders: () => [{ id: "deepseek-account" }, { id: "codearts" }],
        listConfigurableProviders: () => [{ provider: "deepseek-account" }, { provider: "official" }],
        listModels: (provider) => (provider === "official" ? [{ id: "o-1" }] : [{ id: "m-1" }]),
      },
    })
    const built = await modelCatalogOf(ctx)
    expect(built.providers.map((entry) => entry.provider)).toEqual(["deepseek-account", "codearts", "official"])
  })

  it("keeps a provider whose model list throws, and records why", async () => {
    // One provider without an adapter is that provider's answer, not the catalog's. The
    // row still has to show it, because "installed but not logged in" is a state a user
    // needs to see rather than a provider that silently vanished.
    const { ctx } = contextWith({
      llm: {
        listProviders: () => [{ id: "broken" }, { id: "fine" }],
        listConfigurableProviders: () => [],
        listModels: (provider) => {
          if (provider === "broken") throw new Error("no adapter registered")
          return [{ id: "m-1" }]
        },
      },
    })
    const built = await modelCatalogOf(ctx)
    expect(built.providers).toEqual([{ provider: "broken", models: [] }, { provider: "fine", models: ["m-1"] }])
    expect(built.notes.join(" ")).toContain("no adapter registered")
  })

  it("survives a provider whose model list REJECTS, which is what a real host does", async () => {
    // The regression this exists for. `llm.listModels()` is declared
    // `async listModels(provider): Promise<LlmModelInfo[]>`, so a provider without an
    // adapter **rejects** rather than throwing. A `try/catch` around a call that is not
    // awaited never sees that rejection: it lands as an unhandled rejection after the try
    // block has finished, and on a real host it took the whole process down with
    // `dsh: fatal load failure: LlmError: no adapter registered for provider ...`.
    //
    // A synchronous throw in the case above would have passed even with the bug, so this
    // case is the one that actually pins the fix.
    const { ctx } = contextWith({
      llm: {
        listProviders: () => [{ id: "no-adapter" }, { id: "fine" }],
        listConfigurableProviders: () => [],
        listModels: async (provider) => {
          if (provider === "no-adapter") throw new Error("no adapter registered for provider \"no-adapter\"")
          return [{ id: "m-1" }]
        },
      },
    })
    const built = await modelCatalogOf(ctx)
    expect(built.providers).toEqual([{ provider: "no-adapter", models: [] }, { provider: "fine", models: ["m-1"] }])
    expect(built.notes.join(" ")).toContain("no adapter registered")
  })

  it("answers an empty catalog instead of throwing when no llm is served", async () => {
    const { ctx } = contextWith({})
    const built = await modelCatalogOf(ctx)
    expect(built.providers).toEqual([])
    expect(built.notes.length).toBeGreaterThan(0)
  })

  it("refuses a route the host cannot reach", () => {
    expect(routeInCatalog(catalog, "deepseek-account", "deepseek-chat")).toBe(true)
    expect(routeInCatalog(catalog, "deepseek-account", "gpt-4")).toBe(false)
    expect(routeInCatalog(catalog, "nobody", "deepseek-chat")).toBe(false)
  })

  it("answers a provider that never settles instead of waiting on it forever", async () => {
    // A provider whose adapter hangs - an unreachable endpoint, a credential check that
    // does not return - would otherwise hold the whole catalog open, and the menu is
    // unusable until it answers. The timeout is per provider, so one hung route costs its
    // own row and nothing else.
    const { ctx } = contextWith({
      llm: {
        listProviders: () => [{ id: "fast" }, { id: "hangs" }],
        listConfigurableProviders: () => [],
        listModels: (provider) => (provider === "hangs" ? new Promise(() => {}) : Promise.resolve([{ id: "m-1" }])),
      },
    })
    const started = Date.now()
    const built = await modelCatalogOf(ctx, 50)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(built.providers).toEqual([{ provider: "fast", models: ["m-1"] }, { provider: "hangs", models: [] }])
    // A hung provider's row answered empty *because it could not be read*, which is the
    // fact `explainRoute` needs to distinguish "unknown" from "this provider offers none".
    expect(explainRoute(built, "hangs", "m-1").answer).toBe("unknown")
  })

  it("does not grow the wall clock with the number of hung providers", async () => {
    // Task 5: the client's `read` has a 15 s ceiling, so the catalog's wall clock must
    // stay near ONE per-provider timeout rather than the sum of them. All 43 providers
    // hang; a serial implementation would take 43 x 50 ms = 2.15 s and this bound catches
    // it. 1500 ms leaves room for a slow two-core CI runner without admitting a serial
    // regression.
    const providers = Array.from({ length: 43 }, (_, index) => ({ id: `p-${index}` }))
    const { ctx } = contextWith({
      llm: {
        listProviders: () => providers,
        listConfigurableProviders: () => [],
        listModels: () => new Promise(() => {}),
      },
    })
    const started = Date.now()
    const built = await modelCatalogOf(ctx, 50)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(built.providers).toHaveLength(43)
    expect(built.registryRead).toBe("ok")
  })

  it("answers a catalog of providers that all reject almost immediately", async () => {
    // The other half of the bound: a synchronous failure has no timeout to wait out, so
    // 43 rejecting providers must not add 43 timeouts' worth of wall clock. A serial
    // implementation that awaited each one would pass the hung-provider test above only if
    // it also skipped the timeout for settled promises - this one pins the near-zero case.
    const providers = Array.from({ length: 43 }, (_, index) => ({ id: `p-${index}` }))
    const { ctx } = contextWith({
      llm: {
        listProviders: () => providers,
        listConfigurableProviders: () => [],
        listModels: async () => { throw new Error("no adapter registered") },
      },
    })
    const started = Date.now()
    const built = await modelCatalogOf(ctx, 50)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(built.providers.every((entry) => entry.models.length === 0)).toBe(true)
    expect(explainRoute(built, "p-0", "m-1").answer).toBe("unknown")
  })

  it("asks the providers every time, so the list cannot go stale", async () => {
    // There is deliberately no cache. A remembered catalog is one that can disagree with
    // what the deployment actually offers - a model added, or a provider's credential
    // removed, shows up late - and the row would then offer a route that no longer
    // resolves. The wait is absorbed by the timeout above and by the row's own "reading"
    // state, not by remembering an answer nobody checked.
    let calls = 0
    const { ctx } = contextWith({
      llm: {
        listProviders: () => [{ id: "deepseek-account" }],
        listConfigurableProviders: () => [],
        listModels: () => { calls += 1; return Promise.resolve([{ id: "deepseek-chat" }]) },
      },
    })
    await modelCatalogOf(ctx)
    await modelCatalogOf(ctx)
    expect(calls).toBe(2)
  })
})

describe("a route a dispatch named: reachable, unreachable, or could not be read", () => {
  /**
   * A catalog with one good provider, one the host declares but cannot read, and one
   * that is genuinely empty and readable. The third is what makes "empty" ambiguous
   * without the notes - and therefore why the last two cases below are the ones worth
   * separating.
   */
  const mixed = {
    registryRead: "ok",
    providers: [
      { provider: "deepseek-account", models: ["deepseek-chat", "deepseek-reasoner"] },
      { provider: "broken", models: [] },
      { provider: "logged-out", models: [] },
    ],
    notes: [
      "broken: no adapter registered for provider \"broken\"",
      "logged-out: not signed in",
    ],
    default: undefined,
  }

  it("says reachable when the provider lists the model", () => {
    const answer = explainRoute(mixed, "deepseek-account", "deepseek-reasoner")
    expect(answer.answer).toBe("reachable")
    expect(answer.reason).toBe("")
  })

  it("says unreachable when the provider exists, was read, and does not offer it", () => {
    // A usable, non-empty list that lacks the model is evidence: this is a typo or a
    // model that was removed, and a dispatch naming it can be refused on the strength of it.
    const answer = explainRoute(mixed, "deepseek-account", "gpt-4")
    expect(answer.answer).toBe("unreachable")
    expect(answer.reason).toContain("does not offer gpt-4")
  })

  it("says unreachable when no provider of that name is served at all", () => {
    const answer = explainRoute(mixed, "nobody", "deepseek-chat")
    expect(answer.answer).toBe("unreachable")
    expect(answer.reason).toContain("no provider named nobody")
  })

  it("says unknown when the provider's list could not be read", () => {
    // Empty `models` plus a note naming the provider: the list is empty because the read
    // failed, which is not evidence either way about the model.
    const broken = explainRoute(mixed, "broken", "deepseek-chat")
    expect(broken.answer).toBe("unknown")
    expect(broken.reason).toContain("could not be read")
    expect(explainRoute(mixed, "logged-out", "deepseek-chat").answer).toBe("unknown")
  })

  it("treats a readable empty provider as offering nothing, not as unread", () => {
    // The control for the case above: same empty list, no note - so the read succeeded and
    // the provider really offers nothing. An unreachable answer is correct here, and a
    // judgment that treated every empty list as unreadable would answer unknown instead.
    const readable = { ...mixed, providers: [{ provider: "empty", models: [] }], notes: [] }
    expect(explainRoute(readable, "empty", "m-1").answer).toBe("unreachable")
  })

  it("does not read a provider's absence as unreachable when the registry read failed", () => {
    // The case a boolean could not see. `listProviders()` threw, so every provider - even
    // one the host does serve - is absent from the roster. Refusing every model on that
    // basis would turn one registry failure into a deployment-wide refusal.
    const failed = { ...mixed, providers: [], registryRead: "failed", notes: ["listProviders() failed: offline"] }
    expect(explainRoute(failed, "deepseek-account", "deepseek-chat").answer).toBe("unknown")
    expect(explainRoute(failed, "deepseek-account", "deepseek-chat").reason).toContain("registry could not be read")
  })

  it("answers unknown for a catalog with no llm at all, rather than refusing every model", () => {
    const { ctx } = contextWith({})
    const built = modelCatalogOf(ctx)
    return built.then((catalog) => {
      expect(catalog.registryRead).toBe("failed")
      expect(explainRoute(catalog, "deepseek-account", "deepseek-chat").answer).toBe("unknown")
    })
  })

  it("matches a provider note by prefix, not by substring anywhere in the note", () => {
    // A note that merely MENTIONS a provider must not be read as a note about it: the
    // colon-anchored prefix is what keeps "deepseek-account" from matching a sentence
    // about another provider whose id contains it.
    const catalog = {
      registryRead: "ok",
      providers: [{ provider: "account", models: [] }],
      notes: ["other-account: deepseek-account is not signed in"],
      default: undefined,
    }
    expect(explainRoute(catalog, "account", "m-1").answer).toBe("unreachable")
  })

  it("says which of the three it is, in the sentence a caller reads", () => {
    // The whole point of the three states: the two failures must not read alike. A caller
    // told "cannot route to" is entitled to believe the host was asked and answered.
    const unreachable = routeWarningOf(
      explainRoute(mixed, "deepseek-account", "gpt-4"),
      mixed,
      "deepseek-account/gpt-4",
    )
    expect(unreachable).toContain("cannot route to")
    expect(unreachable).toContain(describeRoutes(mixed))
    expect(unreachable).not.toContain("could not be determined")

    const unknown = routeWarningOf(
      explainRoute(mixed, "broken", "deepseek-chat"),
      mixed,
      "broken/deepseek-chat",
    )
    expect(unknown).toContain("could not be determined")
    // The reason is the note the catalog carries for THAT provider, so a caller is told
    // why the read failed rather than that it merely did.
    expect(unknown).toContain("no adapter registered")
    expect(unknown).not.toContain("cannot route to")
  })
})

describe("applying a route", () => {
  it("writes the durable selection and the live one, and can be withdrawn", () => {
    const { agent, appended } = recordingAgent("s-route", "/tmp")
    const selection = { provider: "deepseek-account", model: "deepseek-chat" }
    const applied = applyRoute({ get: () => undefined }, agent, selection)
    expect(applied.durable).toBe(true)
    expect(appended).toEqual([{ type: "model/selection", data: selection }])
    expect(routeArmedFor("s-route")).toBe(true)
    expect(clearRoute("s-route")).toBe(true)
    expect(routeArmedFor("s-route")).toBe(false)
  })

  it("reads the route from the durable projection, not from the agent's constant options", () => {
    // `agent.options` is captured when the agent is created and never written back, so a
    // session that has been switched once still reports its original model there.
    const { ctx } = contextWith({
      sessionProjections: {
        stateOf: () => ({ lastUsed: { provider: "a", model: "old" }, pending: { provider: "b", model: "new" } }),
      },
    })
    expect(currentSelectionOf(ctx, {})).toEqual({ provider: "b", model: "new" })
  })

  it("answers nothing when the deployment serves no projections", () => {
    const { ctx } = contextWith({})
    expect(currentSelectionOf(ctx, {})).toBeUndefined()
  })
})

describe("wts_session_tool action model", () => {
  /**
   * A deployment whose leader and member share one task record, and whose member is live.
   * @param options - extra services, and whether the member starts offline.
   * @returns the context, the member's appended events, and the resume spy.
   */
  async function deployment({ offline = false } = {}) {
    const space = await taskSpaceAt(join(SPACE, `space-${Math.random().toString(36).slice(2)}`), [
      { sessionId: "leader-1", role: "leader", at: "2026-01-01T00:00:00.000Z" },
      { sessionId: "member-1", role: "task", at: "2026-01-01T00:00:00.000Z" },
      { sessionId: "member-2", role: "task", at: "2026-01-01T00:00:00.000Z" },
    ])
    const member = recordingAgent("member-1", space)
    const sibling = recordingAgent("member-2", space)
    const agents = new Map([
      ["member-1", member.agent],
      ["member-2", sibling.agent],
    ])
    const resumed = []
    const services = {
      agents: {
        get: (id) => (offline && id === "member-1" ? undefined : agents.get(id)),
        resume: async (options) => {
          resumed.push(options)
          agents.set(options.resumeSessionId, member.agent)
          return { agent: member.agent }
        },
      },
      llm: {
        listProviders: () => [{ id: "deepseek-account" }],
        listConfigurableProviders: () => [],
        listModels: () => [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
      },
      sessionPersistence: {
        inspect: async () => ({ events: [], meta: { cwd: space } }),
        list: async () => [],
      },
    }
    const { ctx, captured } = contextWith(services)
    registerSessionTools(ctx)
    return { tool: sessionToolOf(captured), member, sibling, resumed, space }
  }

  /** The tool run a leader makes. */
  const leaderRun = { agent: { id: "leader-1", session: { header: { id: "leader-1", cwd: SOURCE } } } }

  it("answers what the session is on, and the routes it could be moved to", async () => {
    const { tool } = await deployment()
    const value = await tool.execute({ action: "model", sessionId: "member-1" }, leaderRun)
    expect(value.offered).toBe(true)
    expect(value.changed).toBe(false)
    expect(value.routes).toEqual(["deepseek-account/deepseek-chat", "deepseek-account/deepseek-reasoner"])
    expect(value.canChange).toBe(true)
  })

  it("moves the member and records the selection durably", async () => {
    const { tool, member } = await deployment()
    const value = await tool.execute({ action: "model", sessionId: "member-1", model: "deepseek-account/deepseek-reasoner" }, leaderRun)
    expect(value.changed).toBe(true)
    expect(value.model).toBe("deepseek-account/deepseek-reasoner")
    expect(member.appended).toEqual([
      { type: "model/selection", data: { provider: "deepseek-account", model: "deepseek-reasoner" } },
    ])
  })

  it("resumes an offline member before writing the selection", async () => {
    // A provider failure is often what disposed the agent, so "offline" is the ordinary
    // case rather than an edge one: the switch has to be able to wake the session itself.
    const { tool, member, resumed } = await deployment({ offline: true })
    const value = await tool.execute({ action: "model", sessionId: "member-1", model: "deepseek-account/deepseek-chat" }, leaderRun)
    expect(value.changed).toBe(true)
    expect(value.resumed).toBe(true)
    expect(resumed).toHaveLength(1)
    expect(member.appended).toHaveLength(1)
  })

  it("refuses a route the host cannot reach, before writing anything", async () => {
    const { tool, member } = await deployment()
    const value = await tool.execute({ action: "model", sessionId: "member-1", model: "deepseek-account/gpt-4" }, leaderRun)
    expect(value.offered).toBe(true)
    expect(value.changed).toBeUndefined()
    expect(value.reason).toContain("not a route this host can reach")
    expect(member.appended).toHaveLength(0)
  })

  it("refuses a model that is not a provider/model pair", async () => {
    const { tool } = await deployment()
    await expect(tool.execute({ action: "model", sessionId: "member-1", model: "deepseek-chat" }, leaderRun))
      .rejects.toThrow(/E4016/)
  })

  it("refuses a member that tries to move a sibling's model", async () => {
    // Both are members of the same task; neither leads it. The record names the leader,
    // and it is not this caller.
    const { tool, sibling } = await deployment()
    const memberRun = { agent: { id: "member-1", session: { header: { id: "member-1", cwd: SPACE } } } }
    const value = await tool.execute({ action: "model", sessionId: "member-2", model: "deepseek-account/deepseek-chat" }, memberRun)
    expect(value.reason).toContain("E4017")
    expect(sibling.appended).toHaveLength(0)
  })

  it("refuses a member that tries to move the leader's model", async () => {
    const { tool } = await deployment()
    const memberRun = { agent: { id: "member-1", session: { header: { id: "member-1", cwd: SPACE } } } }
    const value = await tool.execute({ action: "model", sessionId: "leader-1", model: "deepseek-account/deepseek-chat" }, memberRun)
    expect(value.reason).toContain("E4017")
  })

  it("still answers what a member is on when the caller may not change it", async () => {
    // Reading is the same reach as `status`: asking what a session runs on is not a
    // decision about it. Only the change is gated.
    const { tool } = await deployment()
    const memberRun = { agent: { id: "member-2", session: { header: { id: "member-2", cwd: SPACE } } } }
    const value = await tool.execute({ action: "model", sessionId: "member-1" }, memberRun)
    expect(value.offered).toBe(true)
    expect(value.canChange).toBe(false)
    expect(Array.isArray(value.routes)).toBe(true)
  })

  it("refuses on a deployment that serves no session registry", async () => {
    const { ctx, captured } = contextWith({})
    registerSessionTools(ctx)
    const value = await sessionToolOf(captured).execute({ action: "model", sessionId: "s-1" }, leaderRun)
    expect(value.offered).toBe(false)
  })
})

describe("the record a dispatch keeps", () => {
  it("is readable back from the task space it was written to", async () => {
    // A smoke test for the fixture the direction tests depend on: if this record cannot be
    // read back, every refusal above would pass for the wrong reason.
    const space = await taskSpaceAt(join(SPACE, "record-probe"), [
      { sessionId: "leader-1", role: "leader" },
      { sessionId: "member-1", role: "task" },
    ])
    const record = JSON.parse(await readFile(taskMetadataPath(space), "utf8"))
    expect(record.sessions.map((entry) => entry.role)).toEqual(["leader", "task"])
  })
})

// A switch is a change to a live object; make sure a test that armed one does not leak it
// into the next, which would make a later assertion about "not armed" pass by accident.
afterAll(() => {
  for (const id of ["s-route", "member-1", "member-2"]) clearRoute(id)
})

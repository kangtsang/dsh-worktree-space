import { describe, expect, it, vi } from "vitest"
import { Context } from "@deepseek-ai/cordis"
import { HostConnectionService, serverResponseSchema } from "@deepseek-ai/dsh-client-connection"
import * as source from "../src/host/index.js"
import * as publishedEntry from "../lib/index.js"

// Real Connection is important: a plain rpc.handle mock misses the rc.2
// service-shadow access to webServer that crashes the whole DSH on startup.
// The plugin needs no Settings provider: since 0.1.7 its configuration form
// comes from the exported Config, which the Loader validates per profile row.

const endpoints = ["worktree.scan", "worktree.status", "task.classify-root", "task.suggest-root", "task.create", "task.list", "task.inspect", "task.plan", "task.done"]
const requestFor = (endpoint, overrides = {}) => new Request(`http://localhost/api/dsh-worktree-space/${endpoint}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "client-request", rpcId: "startup-test", method: `dsh-worktree-space/${endpoint}`, payload: {}, ...overrides }),
})

describe.each([
  ["source", source],
  ["package entry", publishedEntry],
])("worktree startup (%s)", (_label, plugin) => {
  it("mounts authenticated-carrier routes, one tool and one skill, cleans them up, and remounts", async () => {
    const root = new Context()
    const register = vi.fn(() => () => {})
    const spawn = vi.fn(() => { throw new Error("startup must not run git") })
    // The tool and skill halves must register against the real service lookup
    // the injected callbacks use, and give their registrations back for teardown.
    const registered = []
    const toolDispose = vi.fn()
    const toolRegister = vi.fn((definition) => { registered.push(definition); return toolDispose })
    const providers = []
    const skillDispose = vi.fn()
    const skillRegister = vi.fn((create) => {
      providers.push(create({ signal: new AbortController().signal, invalidate: () => {} }))
      return skillDispose
    })
    try {
      // Sibling providers match a real profile. Providing webServer on root
      // grants descendants access and accidentally hides the original bug.
      await root.plugin({
        apply(ctx) {
          ctx.provide("webServer", { register })
          ctx.provide("subprocess", { spawn })
          ctx.provide("tools", { register: toolRegister })
          ctx.provide("skills", { registerProvider: skillRegister })
        },
      })
      await root.plugin({
        apply(ctx) {
          new HostConnectionService(ctx, [], { isAuthenticated: () => true })
        },
      })
      const carrier = root.get("connection").createSharedFetchHandler("/api")
      expect(plugin.Config).toBeDefined()

      for (let attempt = 0; attempt < 2; attempt++) {
        const before = registered.length
        const skillBefore = providers.length
        const fiber = root.plugin(plugin)
        await fiber
        for (const endpoint of endpoints) {
          const response = await carrier.fetch(requestFor(endpoint))
          expect(response.status).toBe(200)
          const envelope = serverResponseSchema.parse(await response.json())
          expect(envelope.type).toBe("server-response")
          expect(envelope.rpcId).toBe("startup-test")
        }
        expect(registered.length).toBe(before + 1)
        const tool = registered[before]
        expect(tool.name).toBe("task_worktree_space")
        expect(tool.parameters.properties.action.enum).toEqual(["suggest-root", "create", "add", "list", "done"])
        expect(tool.description).toContain("worktree workspace")
        expect(providers.length).toBe(skillBefore + 1)
        const candidates = await providers[skillBefore].list({})
        expect(candidates.map(({ name }) => name)).toEqual(["task-worktree-space"])
        const body = await providers[skillBefore].get(candidates[0], {})
        expect(body.content).toContain("# Task Worktree Space")
        const mismatched = await carrier.fetch(requestFor("worktree.scan", { method: "worktree.status" }))
        expect((await mismatched.json()).result).toMatchObject({ ok: false, error: { code: "E9001" } })
        const invalid = await carrier.fetch(requestFor("worktree.scan", { type: "invalid" }))
        expect(invalid.status).toBe(400)
        const nonJson = await carrier.fetch(new Request("http://localhost/api/dsh-worktree-space/worktree.scan", { method: "POST", body: "not JSON" }))
        expect(nonJson.status).toBe(415)
        await fiber.dispose()
        for (const endpoint of endpoints) {
          expect((await carrier.fetch(requestFor(endpoint))).status).toBe(404)
        }
        expect(toolDispose).toHaveBeenCalledTimes(before + 1)
        expect(skillDispose).toHaveBeenCalledTimes(skillBefore + 1)
      }
      // Routes stay under Connection's shared /api authentication fence; the
      // plugin must not register its own unauthenticated HTTP listener.
      expect(register).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      await root.fiber.dispose()
    }
  })
})

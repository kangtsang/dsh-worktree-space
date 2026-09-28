import { describe, expect, it, vi } from "vitest"
import { Context } from "@deepseek-ai/cordis"
import { HostConnectionService } from "@deepseek-ai/dsh-client-connection"
import * as plugin from "../src/host/index.js"

/**
 * Mount the plugin the way a profile does, and hand back the tool it registered.
 *
 * The registrations are captured instead of served: every test here is about the
 * card contract, so nothing may reach git — the subprocess double throws if
 * anything tries.
 */
async function mountedTool() {
  const root = new Context()
  const registered = []
  await root.plugin({
    apply(ctx) {
      ctx.provide("webServer", { register: vi.fn(() => () => {}) })
      ctx.provide("subprocess", { spawn: vi.fn(() => { throw new Error("a card must not run git") }) })
      ctx.provide("tools", {
        register: vi.fn((definition) => {
          registered.push(definition)
          return () => {}
        }),
      })
      ctx.provide("skills", { registerProvider: vi.fn(() => () => {}) })
    },
  })
  await root.plugin({
    apply(ctx) {
      new HostConnectionService(ctx, [], { isAuthenticated: () => true })
    },
  })
  await root.plugin(plugin)
  return registered[0]
}

const callArgs = { action: "done", task: "demo", tasksRoot: "E:\\spaces", merge: true, deleteBranch: true }

/** The text of a card view, or an empty string when it carries none. */
const textOf = (view) => view?.content?.[0]?.text ?? ""

describe("the task tool's card contract", () => {
  it("presents a pending call identically twice, so a replay matches the live card", async () => {
    const tool = await mountedTool()
    expect(tool.presentCall(callArgs)).toEqual(tool.presentCall(callArgs))
    expect(tool.presentCall(callArgs)).toMatchObject({
      card: "generic",
      title: "task_worktree_space: done",
      kind: "other",
      rawInput: "demo",
    })
  })

  it("keeps the whole args object out of the pending card", async () => {
    const tool = await mountedTool()
    const serialized = JSON.stringify(tool.presentCall(callArgs))
    expect(serialized).not.toContain("spaces")
    expect(serialized).not.toContain("deleteBranch")
    // A call with no task name carries no salient input rather than an empty one.
    expect(tool.presentCall({ action: "list" }).rawInput).toBeUndefined()
  })

  it("caps its projection, keeps the total, and says how many rows it left out", async () => {
    const tool = await mountedTool()
    const value = {
      summary: "Finished demo.",
      warnings: ["branch 'a' was not deleted", "branch 'b' was not deleted", "branch 'c' was not deleted", "branch 'd' was not deleted"],
      repositories: Array.from({ length: 25 }, (_, index) => ({ name: `repo-${index}`, merged: true, removed: true, error: "" })),
    }
    const meta = tool.output.presentationMeta({}, value)
    expect(meta.repositories).toHaveLength(20)
    expect(meta.total).toBe(25)
    expect(meta.warnings).toHaveLength(3)

    const text = textOf(tool.presentResult(callArgs, { content: [], isError: false, meta }))
    expect(text).toContain("Finished demo.")
    expect(text).toContain("repo-0: merged, worktree removed")
    expect(text).toContain("... and 5 more repositories")
    expect(text).toContain("warnings: branch 'a' was not deleted; branch 'b' was not deleted; branch 'c' was not deleted")
    expect(text).not.toContain("repo-24")
  })

  it("reports a repository that failed without hiding the others", async () => {
    const tool = await mountedTool()
    const meta = tool.output.presentationMeta({}, {
      summary: "Partly finished.",
      warnings: [],
      repositories: [
        { name: "alpha", merged: false, removed: false, error: "the merge in E:\\spaces\\demo\\alpha is resolved but not committed" },
        { name: "beta", merged: true, removed: true, error: "" },
      ],
    })
    const text = textOf(tool.presentResult(callArgs, { content: [], isError: true, meta }))
    expect(text).toContain("alpha: failed: the merge in E:\\spaces\\demo\\alpha is resolved but not committed")
    expect(text).toContain("beta: merged, worktree removed")
  })

  it("falls back to the model-facing text when the Host passes no projection", async () => {
    const tool = await mountedTool()
    const view = tool.presentResult(callArgs, { content: [{ type: "text", text: "plain summary" }], isError: false, meta: undefined })
    expect(textOf(view)).toBe("plain summary")
    expect(view.card).toBe("generic")
    expect(view.title).toBe("task_worktree_space: done")
  })

  it("survives a malformed projection and content that is not text", async () => {
    const tool = await mountedTool()
    // A meta that is not an object at all, and content that is not text: neither
    // throws, and neither leaks the value as JSON.
    expect(textOf(tool.presentResult(callArgs, { content: [], isError: true, meta: "malformed" }))).toBe("")
    expect(textOf(tool.presentResult(callArgs, { content: [{ type: "image" }], isError: false, meta: null }))).toBe("")
    // Args the schema rejects never reach a presenter: the definition answers with
    // no view, so a UI keeps its own default card instead of a wrong one.
    expect(tool.presentResult({}, { content: [], isError: false, meta: null })).toBeUndefined()
    expect(tool.presentCall({})).toBeUndefined()
  })

  it("bounds the card's text and marks the cut, so a partial card never reads as complete", async () => {
    const tool = await mountedTool()
    const text = textOf(tool.presentResult(callArgs, { content: [{ type: "text", text: "x".repeat(9000) }], isError: false, meta: null }))
    expect(text.endsWith("... (truncated)")).toBe(true)
    expect(text.length).toBeLessThan(4100)
  })
})

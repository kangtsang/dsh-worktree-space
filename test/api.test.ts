import { afterEach, describe, expect, it, vi } from "vitest"
import { createWorktreeApi } from "../src/client/lib/api"

describe("worktree client API routing", () => {
  const taskPayload = { sourceRoot: "/repo", task: "fix-login", tasksRoot: "/tasks", repos: ["alpha"], baseRef: "main" }

  afterEach(() => vi.useRealTimers())

  it.each(["scan", "status", "classifyRoot", "suggestRoot"] as const)("bounds never-resolving %s reads to 15 seconds and aborts transport", async operation => {
    vi.useFakeTimers()
    const call = vi.fn().mockImplementation(() => new Promise<never>(() => {}))
    const api = createWorktreeApi({ rpc: { call } })
    const invoke = api[operation] as (...call: any[]) => Promise<unknown>
    const request = operation === "scan" ? invoke(["/repo"]) : invoke("/repo")
    const rejected = expect(request).rejects.toThrow(/timed out/)
    const signal = call.mock.calls[0][3] as AbortSignal
    expect(signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(14999)
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(signal.aborted).toBe(true)
    expect(call).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["scan", "status"] as const)("cancels %s reads when the caller aborts", async operation => {
    vi.useFakeTimers()
    const call = vi.fn().mockImplementation(() => new Promise<never>(() => {}))
    const api = createWorktreeApi({ rpc: { call } })
    const controller = new AbortController()
    const request = operation === "scan" ? api.scan(["/repo"], controller.signal) : api.status("/repo", controller.signal)
    const rejected = expect(request).rejects.toThrow(/cancelled/)
    controller.abort()
    await rejected
    expect(call.mock.calls[0][3].aborted).toBe(true)
    expect(call).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["scan", "status", "classifyRoot", "suggestRoot"] as const)("clears the %s read timer after a successful response", async operation => {
    vi.useFakeTimers()
    const call = vi.fn().mockResolvedValue({ ok: true, value: [] })
    const api = createWorktreeApi({ rpc: { call } })
    const invoke = api[operation] as (...call: any[]) => Promise<unknown>
    await (operation === "scan" ? invoke(["/repo"]) : invoke("/repo"))
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(30000)
    expect(call.mock.calls[0][3].aborted).toBe(false)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it.each([
    { operation: "createTask", args: [taskPayload] },
  ] as const)("does not time out or automatically retry $operation mutations", async ({ operation, args }) => {
    vi.useFakeTimers()
    let reject!: (reason: Error) => void
    const call = vi.fn().mockImplementation(() => new Promise((_, fail) => { reject = fail }))
    const api = createWorktreeApi({ rpc: { call } })
    const invoke = api[operation] as (...call: any[]) => Promise<unknown>
    const request = invoke(...args)
    const failure = new Error("connection closed after mutation")
    const rejected = expect(request).rejects.toBe(failure)
    expect(call.mock.calls[0]).toHaveLength(3)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60000)
    expect(call).toHaveBeenCalledTimes(1)
    reject(failure)
    await rejected
    await vi.advanceTimersByTimeAsync(60000)
    expect(call).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    { operation: "scan", endpoint: "worktree.scan", args: [["/repo"]], payload: { paths: ["/repo"] } },
    { operation: "status", endpoint: "worktree.status", args: ["/repo"], payload: { path: "/repo" } },
    { operation: "classifyRoot", endpoint: "task.classify-root", args: ["/repo"], payload: { sourceRoot: "/repo" } },
    { operation: "suggestRoot", endpoint: "task.suggest-root", args: ["/repo"], payload: { sourceRoot: "/repo", tasksRoot: undefined } },
    { operation: "createTask", endpoint: "task.create", args: [taskPayload], payload: taskPayload },
  ] as const)("routes $operation through the shared /api channel", async ({ operation, endpoint, args, payload }) => {
    const value = { response: endpoint }
    const call = vi.fn().mockResolvedValue({ ok: true, value })
    const api = createWorktreeApi({ rpc: { call } })
    const invoke = api[operation] as (...call: unknown[]) => Promise<unknown>

    await expect(invoke(...args)).resolves.toBe(value)
    const expected: unknown[] = ["/api", `dsh-worktree-space/${endpoint}`, payload]
    if (["scan", "status", "classifyRoot", "suggestRoot"].includes(operation)) expected.push(expect.any(AbortSignal))
    expect(call.mock.calls).toEqual([expected])
  })

  it.each([
    { result: { ok: false, error: { code: "bad-request", message: "fatal: not a git repository" } }, message: "not-git-repository", code: "not-git-repository" },
    { result: { ok: false, error: { code: "bad-request", message: "No such file or directory" } }, message: "worktree-unavailable", code: "worktree-unavailable" },
    { result: { ok: false, error: { code: "cancelled", message: "The request was cancelled." } }, message: "The request was cancelled.", code: "cancelled" },
    { result: { ok: false, error: { code: "bad-request", message: "Invalid path" } }, message: "Invalid path", code: "bad-request" },
    { result: undefined, message: "worktree operation failed", code: undefined },
  ])("rejects unsuccessful results with $message", async ({ result, message, code }) => {
    const call = vi.fn().mockResolvedValue(result)
    const api = createWorktreeApi({ rpc: { call } })

    await expect(api.status("/repo")).rejects.toMatchObject({ message, code })
    expect(call.mock.calls).toEqual([["/api", "dsh-worktree-space/worktree.status", { path: "/repo" }, expect.any(AbortSignal)]])
  })

  it("propagates transport failures without wrapping or retrying them", async () => {
    const error = new Error("connection closed")
    const call = vi.fn().mockRejectedValue(error)
    const api = createWorktreeApi({ rpc: { call } })

    await expect(api.status("/repo")).rejects.toBe(error)
    expect(call.mock.calls).toEqual([["/api", "dsh-worktree-space/worktree.status", { path: "/repo" }, expect.any(AbortSignal)]])
  })
})

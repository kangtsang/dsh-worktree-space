import { afterEach, describe, expect, it, vi } from "vitest"
import { createWorktreeApi } from "../src/client/lib/api"

describe("worktree client API routing", () => {
  const taskPayload = { sourceRoot: "/repo", task: "fix-login", tasksRoot: "/tasks", repos: ["alpha"], baseRef: "main" }
  // Absolute paths, not names: a repository added to a task under way need not sit
  // under the source root that task began from, so there is nothing to resolve one
  // against. The routing test below is what holds that to the wire.
  const addPayload = { task: "fix-login", project: "repo", tasksRoot: "/tasks", repositories: ["/elsewhere/gamma"], baseRef: "release" }

  afterEach(() => vi.useRealTimers())

  /** Every read endpoint, with the arguments its method takes. */
  const READS = [
    { operation: "scan", args: [["/repo"]] },
    { operation: "cachedScan", args: [["/repo"]] },
    { operation: "status", args: ["/repo"] },
    { operation: "classifyRoot", args: ["/repo"] },
    { operation: "suggestRoot", args: ["/repo"] },
  ] as const

  it.each(READS)("bounds never-resolving $operation reads to 15 seconds and aborts transport", async ({ operation, args }) => {
    vi.useFakeTimers()
    const call = vi.fn().mockImplementation(() => new Promise<never>(() => {}))
    const api = createWorktreeApi({ rpc: { call } })
    const invoke = api[operation] as (...call: any[]) => Promise<unknown>
    const request = invoke(...args)
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

  it.each(["scan", "cachedScan", "status"] as const)("cancels %s reads when the caller aborts", async operation => {
    vi.useFakeTimers()
    const call = vi.fn().mockImplementation(() => new Promise<never>(() => {}))
    const api = createWorktreeApi({ rpc: { call } })
    const controller = new AbortController()
    const request = operation === "status" ? api.status("/repo", undefined, controller.signal) : api[operation](["/repo"], controller.signal)
    const rejected = expect(request).rejects.toThrow(/cancelled/)
    controller.abort()
    await rejected
    expect(call.mock.calls[0][3].aborted).toBe(true)
    expect(call).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(READS)("clears the $operation read timer after a successful response", async ({ operation, args }) => {
    vi.useFakeTimers()
    const call = vi.fn().mockResolvedValue({ ok: true, value: [] })
    const api = createWorktreeApi({ rpc: { call } })
    const invoke = api[operation] as (...call: any[]) => Promise<unknown>
    await invoke(...args)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(30000)
    expect(call.mock.calls[0][3].aborted).toBe(false)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it.each([
    { operation: "createTask", args: [taskPayload] },
    { operation: "addRepositories", args: [addPayload] },
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
    { operation: "cachedScan", endpoint: "worktree.cached", args: [["/repo"]], payload: { paths: ["/repo"] } },
    { operation: "status", endpoint: "worktree.status", args: ["/repo"], payload: { path: "/repo" } },
    { operation: "classifyRoot", endpoint: "task.classify-root", args: ["/repo"], payload: { sourceRoot: "/repo" } },
    { operation: "suggestRoot", endpoint: "task.suggest-root", args: ["/repo"], payload: { sourceRoot: "/repo", tasksRoot: undefined } },
    { operation: "createTask", endpoint: "task.create", args: [taskPayload], payload: taskPayload },
    { operation: "addRepositories", endpoint: "task.add-repositories", args: [addPayload], payload: addPayload },
  ] as const)("routes $operation through the shared /api channel", async ({ operation, endpoint, args, payload }) => {
    const value = { response: endpoint }
    const call = vi.fn().mockResolvedValue({ ok: true, value })
    const api = createWorktreeApi({ rpc: { call } })
    const invoke = api[operation] as (...call: unknown[]) => Promise<unknown>

    await expect(invoke(...args)).resolves.toBe(value)
    const expected: unknown[] = ["/api", `dsh-worktree-space/${endpoint}`, payload]
    if (READS.some(read => read.operation === operation)) expected.push(expect.any(AbortSignal))
    expect(call.mock.calls).toEqual([expected])
  })

  it.each([
    // A Host that sends its codes. The dialog acts on these, so they have to
    // survive the trip - the point of the codes is that the code a caller reads
    // is the one to grep for.
    { result: { ok: false, error: { code: "E3004", message: "fatal: not a git repository" } }, message: "fatal: not a git repository", code: "E3004" },
    { result: { ok: false, error: { code: "E3005", message: "No such file or directory" } }, message: "No such file or directory", code: "E3005" },
    { result: { ok: false, error: { code: "E2002", message: "task space already exists: E:/ws" } }, message: "task space already exists: E:/ws", code: "task-space-unregistered" },
    // The message patterns below are a fallback for a Host older than the codes,
    // which is what sent a flat code and left only the wording to match on.
    { result: { ok: false, error: { code: "E9001", message: "fatal: not a git repository" } }, message: "fatal: not a git repository", code: "E3004" },
    { result: { ok: false, error: { code: "E9001", message: "No such file or directory" } }, message: "No such file or directory", code: "E3005" },
    { result: { ok: false, error: { code: "cancelled", message: "The request was cancelled." } }, message: "The request was cancelled.", code: "cancelled" },
    { result: { ok: false, error: { code: "E9001", message: "Invalid path" } }, message: "Invalid path", code: "E9001" },
    { result: undefined, message: "worktree operation failed", code: undefined },
  ])("rejects unsuccessful results with $message", async ({ result, message, code }) => {
    const call = vi.fn().mockResolvedValue(result)
    const api = createWorktreeApi({ rpc: { call } })

    await expect(api.status("/repo")).rejects.toMatchObject({ message, code })
    expect(call.mock.calls).toEqual([["/api", "dsh-worktree-space/worktree.status", { path: "/repo" }, expect.any(AbortSignal)]])
  })

  it("names the merge target when one is given, and leaves it out otherwise", async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, value: {} })
    const api = createWorktreeApi({ rpc: { call } })

    await api.status("/repo", "develop")
    expect(call.mock.calls[0][2]).toEqual({ path: "/repo", target: "develop" })
    await api.status("/repo")
    expect(call.mock.calls[1][2]).toEqual({ path: "/repo" })
  })

  it("propagates transport failures without wrapping or retrying them", async () => {
    const error = new Error("connection closed")
    const call = vi.fn().mockRejectedValue(error)
    const api = createWorktreeApi({ rpc: { call } })

    await expect(api.status("/repo")).rejects.toBe(error)
    expect(call.mock.calls).toEqual([["/api", "dsh-worktree-space/worktree.status", { path: "/repo" }, expect.any(AbortSignal)]])
  })
})

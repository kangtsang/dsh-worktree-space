// @vitest-environment jsdom
import { format, t } from "../src/client/lib/i18n"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorktreesSettings } from "../src/client/components/WorktreesSettings"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function repository(path: string, linked = false) {
  return {
    repoPath: path,
    commonDir: `${path}/.git`,
    worktrees: [
      { path, branch: "main", isMain: true, detached: false, locked: false, prunable: false },
      ...(linked ? [{ path: `${path}.worktrees/task`, branch: "task", isMain: false, detached: false, locked: false, prunable: false }] : []),
    ],
  }
}

function setup() {
  const api = { scan: vi.fn(), cachedScan: vi.fn().mockResolvedValue(null), status: vi.fn(), remove: vi.fn(), prune: vi.fn() }
  const items = [
    { workspaceId: "broad", path: "/projects", title: "Projects" },
    { workspaceId: "narrow", path: "/projects/narrow", title: "Narrow" },
  ]
  const workspaces: any = {
    list: { getSnapshot: () => ({ items }), subscribe: () => () => {} },
    create: vi.fn(), rename: vi.fn(), delete: vi.fn(),
  }
  const uiWorkspace: any = { openWorkspace: vi.fn().mockResolvedValue(undefined) }
  const onCreate = vi.fn()
  const mount = () => render(<WorktreesSettings api={api} workspaces={workspaces} uiWorkspace={uiWorkspace} sessions={{ list: { getSnapshot: () => ({ byId: {} }) } } as any} onCreate={onCreate} />)
  return { api, workspaces, onCreate, mount }
}

afterEach(cleanup)

/** The page opens on tasks; this suite covers the repository list. */
function showRepositories() {
  fireEvent.click(screen.getByRole("button", { name: t("viewRepositories") }))
}

describe("WorktreesSettings loading lifecycle", () => {
  it("shows explicit loading until scan settles, then offers creation for a repository with zero linked worktrees", async () => {
    const next = setup()
    const scan = deferred<any[]>()
    next.api.scan.mockReturnValue(scan.promise)
    next.mount()
    showRepositories()
    expect(screen.getByRole("status").textContent).toContain(t("scanning"))
    expect(screen.queryByText(t("noWorktrees"))).toBeNull()
    expect(screen.getByRole("button", { name: t("refresh") })).toHaveProperty("disabled", true)
    expect(next.api.scan).toHaveBeenCalledWith(["/projects", "/projects/narrow"], expect.any(AbortSignal))

    await act(async () => { scan.resolve([repository("/projects/empty")]) })
    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.getByRole("heading", { name: "empty" })).toBeTruthy()
    expect(document.querySelectorAll(".dws-worktree")).toHaveLength(0)
    expect(next.api.status).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: t("workspaceCreate") }))
    expect(next.onCreate).toHaveBeenCalledExactlyOnceWith({ path: "/projects/empty", title: "empty" })
    expect(next.workspaces.create).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: t("refresh") })).toHaveProperty("disabled", false)
  })

  it("aborts an outstanding scan on unmount and ignores its late result", async () => {
    const next = setup()
    const scan = deferred<any[]>()
    next.api.scan.mockReturnValue(scan.promise)
    const view = next.mount()
    const signal = next.api.scan.mock.calls[0][1] as AbortSignal
    expect(signal.aborted).toBe(false)
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => { scan.resolve([repository("/stale", true)]) })
    expect(next.api.status).not.toHaveBeenCalled()
  })

  it("says a task's repositories are being checked, not unknown, while the reads are in flight", async () => {
    const next = setup()
    const linked = { path: "/spaces/antest/alpha", branch: "feat/antest", isMain: false, detached: false, locked: false, prunable: false }
    next.api.scan.mockResolvedValue([{
      repoPath: "/projects/alpha",
      commonDir: "/projects/alpha/.git",
      worktrees: [
        { path: "/projects/alpha", branch: "develop", isMain: true, detached: false, locked: false, prunable: false },
        linked,
      ],
    }])
    const status = deferred<any>()
    next.api.status.mockReturnValue(status.promise)
    next.mount()

    // The page opens on the task view: the sentinel a refresh writes has to read as
    // "checking", which is what this view used to report as an unknown status.
    await waitFor(() => expect(next.api.status).toHaveBeenCalledTimes(1))
    expect(screen.getByText(t("checkingStatus"))).toBeTruthy()
    expect(screen.queryByText(t("statusUnknown"))).toBeNull()
    // Nothing to act on either, while the answer is still on its way.
    fireEvent.click(screen.getByRole("button", { name: t("filterAttention") }))
    expect(screen.queryByRole("heading", { name: "antest" })).toBeNull()

    await act(async () => { status.resolve({ changedFiles: 0, branchLine: "", output: "" }) })
    fireEvent.click(screen.getByRole("button", { name: t("filterAll") }))
    expect(screen.getByRole("heading", { name: "antest" })).toBeTruthy()
    expect(screen.queryByText(t("checkingStatus"))).toBeNull()
    expect(screen.getByText(t("clean"))).toBeTruthy()
  })

  it("aborts pending linked status checks on unmount", async () => {
    const next = setup()
    const status = deferred<any>()
    next.api.scan.mockResolvedValue([repository("/projects/linked", true)])
    next.api.status.mockReturnValue(status.promise)
    const view = next.mount()
    await waitFor(() => expect(next.api.status).toHaveBeenCalledTimes(1))
    const signal = next.api.status.mock.calls[0][2] as AbortSignal
    expect(signal.aborted).toBe(false)
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => { status.reject(new Error("late cancellation")) })
  })

  it("clears loading and exposes a rejected scan instead of remaining stuck", async () => {
    const next = setup()
    const scan = deferred<any[]>()
    next.api.scan.mockReturnValue(scan.promise)
    next.mount()
    showRepositories()
    await act(async () => { scan.reject(new Error("Worktree request timed out")) })
    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.getByRole("alert").textContent).toContain("Worktree request timed out")
    expect(screen.getByRole("button", { name: t("refresh") })).toHaveProperty("disabled", false)
  })
})

/**
 * The Host remembers the last scan of each Workspace set, so a panel that has just
 * been reopened has something to paint before its own scan answers. What it paints
 * is never the last word: the scan it started alongside is.
 */
describe("WorktreesSettings and the remembered scan", () => {
  function remembered() {
    return {
      repositories: [repository("/projects/linked", true)],
      statuses: { "/projects/linked.worktrees/task": { branchLine: "## task", changedFiles: 3, output: "## task\n M a.txt" } },
    }
  }

  it("paints the remembered rows at once, then replaces them with the fresh scan", async () => {
    const next = setup()
    next.api.cachedScan.mockResolvedValue(remembered())
    const scan = deferred<any[]>()
    next.api.scan.mockReturnValue(scan.promise)
    next.mount()
    showRepositories()

    // The remembered rows are up before the scan has answered anything, with the
    // status the Host still holds, and without the skeleton in front of them.
    await waitFor(() => expect(screen.getByRole("heading", { name: "linked" })).toBeTruthy())
    expect(screen.getByText(format(t("dirty"), { count: "3" }))).toBeTruthy()
    expect(document.querySelectorAll(".dws-skeleton-row")).toHaveLength(0)
    expect(screen.getByRole("status").textContent).toContain(t("refreshing"))

    // The scan is the last word, and an empty result is a result.
    await act(async () => { scan.resolve([]) })
    expect(screen.queryByRole("heading", { name: "linked" })).toBeNull()
    expect(screen.getByRole("heading", { name: t("noMatches") })).toBeTruthy()
  })

  it("ignores a remembered answer that arrives after the fresh scan has landed", async () => {
    const next = setup()
    const cache = deferred<any>()
    next.api.cachedScan.mockReturnValue(cache.promise)
    next.api.scan.mockResolvedValue([])
    next.mount()
    showRepositories()
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull())

    await act(async () => { cache.resolve(remembered()) })
    expect(screen.queryByRole("heading", { name: "linked" })).toBeNull()
  })

  it("scans anyway when the Host cannot answer for the last scan", async () => {
    const next = setup()
    next.api.cachedScan.mockRejectedValue(new Error("Unknown endpoint: worktree.cached"))
    next.api.scan.mockResolvedValue([repository("/projects/linked")])
    next.mount()
    showRepositories()

    await waitFor(() => expect(screen.getByRole("heading", { name: "linked" })).toBeTruthy())
    expect(screen.queryByRole("alert")).toBeNull()
  })
})

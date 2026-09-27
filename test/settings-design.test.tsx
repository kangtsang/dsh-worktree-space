// @vitest-environment jsdom
import { format, t } from "../src/client/lib/i18n"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorktreesSettings } from "../src/client/components/WorktreesSettings"

const clean = { changedFiles: 0, branchLine: "", output: "" }
const linkedPath = "/projects/alpha.worktrees/task"
function worktree(path: string, branch: string, extra = {}) {
  return { path, branch, isMain: false, detached: false, locked: false, prunable: false, ...extra }
}
function repository(name: string, rows: ReturnType<typeof worktree>[] = []) {
  const repoPath = `/projects/${name}`
  return { repoPath, commonDir: `${repoPath}/.git`, worktrees: [worktree(repoPath, `main-${name}`, { isMain: true }), ...rows] }
}
function setup({ repos = [repository("alpha", [worktree(linkedPath, "task/feature")])], items = [] as any[] } = {}) {
  const api = {
    scan: vi.fn().mockResolvedValue(repos),
    cachedScan: vi.fn().mockResolvedValue(null),
    status: vi.fn().mockImplementation(async (path: string) => ({ ...clean, changedFiles: path.includes("dirty") ? 2 : 0 })),
    remove: vi.fn().mockResolvedValue({}),
    prune: vi.fn().mockResolvedValue({}),
  }
  const workspaces = {
    list: { getSnapshot: () => ({ items }), subscribe: () => () => {} },
    create: vi.fn().mockResolvedValue({ workspaceId: "new-workspace", path: linkedPath, title: "" }),
    rename: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  }
  const uiWorkspace = { openWorkspace: vi.fn().mockResolvedValue(undefined) }
  const onCreate = vi.fn()
  const close = vi.fn()
  const mount = () => render(<WorktreesSettings api={api} workspaces={workspaces as any} uiWorkspace={uiWorkspace as any} sessions={{ list: { getSnapshot: () => ({ byId: {} }) } } as any} onCreate={onCreate} close={close} />)
  return { api, workspaces, uiWorkspace, onCreate, close, mount }
}
async function settled() {
  await waitFor(() => expect(screen.getByRole("button", { name: t("refresh") })).toHaveProperty("disabled", false))
  // The page opens on tasks; everything here is about the repository list.
  fireEvent.click(screen.getByRole("button", { name: t("viewRepositories") }))
}
function repoArticle(name: string) {
  return within(screen.getByRole("heading", { name }).closest("article")!)
}
function visibleRepositories() {
  return screen.queryAllByRole("heading", { level: 3 }).map(node => node.textContent)
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe("WorktreesSettings discovery controls", () => {
  it("names the settings entry and the page it opens differently", async () => {
    const next = setup()
    next.mount()
    await settled()

    // The entry stays short enough for the sidebar; the page title can say what
    // the page is for. They are deliberately not one string.
    expect(t("worktrees")).not.toBe(t("worktreesTitle"))
    expect(screen.getByRole("heading", { name: t("worktreesTitle") })).toBeTruthy()
    expect(screen.getByRole("region", { name: t("worktrees") })).toBeTruthy()
  })

  const repos = [
    repository("alpha", [worktree(linkedPath, "task/feature")]),
    repository("beta", [worktree("/external/dirty-checkout", "fix/payments")]),
    repository("empty"),
  ]

  it.each([
    ["ALPHA", "alpha"],
    ["fix/payments", "beta"],
    ["/external/dirty-checkout", "beta"],
    ["main-empty", "empty"],
  ])("searches repository, linked/current branch and path using %s", async (query, expected) => {
    const user = userEvent.setup()
    const next = setup({ repos })
    next.mount()
    await settled()
    await user.type(screen.getByRole("textbox", { name: t("searchPlaceholder") }), query)
    expect(visibleRepositories()).toEqual([expected])
    expect(next.api.scan).toHaveBeenCalledTimes(1)
    expect(next.workspaces.create).not.toHaveBeenCalled()
  })

  it("reports how many of the found projects the filter is showing", async () => {
    const user = userEvent.setup()
    const next = setup({ repos: [repository("alpha", [worktree(linkedPath, "task/feature")]), repository("beta", [worktree("/external/dirty-checkout", "fix/payments")]), repository("empty")] })
    next.mount()
    await settled()
    const summary = () => document.querySelector(".dws-summary")?.textContent ?? ""

    // Nothing is narrowed, so the total stands alone rather than reading 3 / 3.
    expect(summary()).toContain(`3 ${t("repositories")}`)
    expect(summary()).not.toContain("3 / 3")

    await user.click(screen.getByRole("button", { name: t("filterAttention") }))
    expect(summary()).toContain("1 / 3")
    expect(summary()).toContain("1 / 2")
  })

  it("filters all and attention repositories and clears query plus filter from the empty state", async () => {
    const user = userEvent.setup()
    const next = setup({ repos })
    next.mount()
    await settled()
    const filters = within(screen.getByRole("group", { name: t("worktrees") }))
    // The same two filters the task view offers.
    expect([...filters.getAllByRole("button")].map((button) => button.textContent)).toEqual([t("filterAll"), t("filterAttention")])
    expect(filters.getByRole("button", { name: t("filterAll") }).getAttribute("aria-pressed")).toBe("true")
    expect(visibleRepositories()).toEqual(["alpha", "beta", "empty"])
    await user.click(filters.getByRole("button", { name: t("filterAttention") }))
    expect(visibleRepositories()).toEqual(["beta"])
    expect(filters.getByRole("button", { name: t("filterAttention") }).getAttribute("aria-pressed")).toBe("true")
    const search = screen.getByRole("textbox", { name: t("searchPlaceholder") })
    await user.type(search, "no-match")
    const emptyState = screen.getByRole("heading", { name: t("noMatches") }).parentElement!
    // The empty state has no reset of its own any more. The search box's clear
    // removes the query and leaves the filter where it was, which is what the
    // filter's own buttons are for.
    expect(within(emptyState).queryByRole("button")).toBeNull()
    await user.click(screen.getByRole("button", { name: t("clearFilters") }))
    expect(search).toHaveProperty("value", "")
    expect(visibleRepositories()).toEqual(["beta"])
    await user.click(filters.getByRole("button", { name: t("filterAll") }))
    expect(visibleRepositories()).toEqual(["alpha", "beta", "empty"])
    expect(next.api.scan).toHaveBeenCalledTimes(1)
  })

  it("includes locked, prunable, failed-status and unmerged worktrees in attention, but excludes clean repositories", async () => {
    const next = setup({ repos: [
      repository("locked", [worktree("/locked", "locked-task", { locked: true })]),
      repository("prunable", [worktree("/prunable", "prunable-task", { prunable: true })]),
      repository("failed", [worktree("/failed", "failed-task")]),
      repository("pending", [worktree("/pending", "pending-task")]),
      repository("clean", [worktree("/clean", "clean-task")]),
    ] })
    next.api.status.mockImplementation(async path => {
      if (path === "/failed") throw new Error("status unavailable")
      // A clean working tree whose branch still carries commits back to the target.
      return path === "/pending" ? { ...clean, commits: 4 } : clean
    })
    next.mount()
    await settled()
    await userEvent.setup().click(screen.getByRole("button", { name: t("filterAttention") }))
    expect(visibleRepositories()).toEqual(["locked", "prunable", "failed", "pending"])
    // The count is asked for against the branch the source checkout sits on, which
    // is where finishing merges; it is what the row reports beside "no changes".
    expect(next.api.status).toHaveBeenCalledWith("/pending", "main-pending", expect.anything())
    expect(screen.getByText(format(t("pending"), { count: "4" })).closest(".dws-status-pending")).toBeTruthy()
  })

  it("reports the commits a clean task has not merged back, on the task and on its repository", async () => {
    const taskRow = worktree("/spaces/antest/alpha", "feat/antest")
    const next = setup({ repos: [repository("alpha", [taskRow])] })
    next.api.status.mockImplementation(async (path: string) => path === taskRow.path ? { ...clean, commits: 4 } : clean)
    next.mount()
    await waitFor(() => expect(screen.getByRole("button", { name: t("refresh") })).toHaveProperty("disabled", false))

    // The page opens on the task view: the count rides the task's own row and the
    // repository row under it, so a task reads as needing attention while collapsed.
    const badges = screen.getAllByText(format(t("pending"), { count: "4" }))
    expect(badges).toHaveLength(2)
    expect(badges.every(badge => badge.closest(".dws-status-pending"))).toBe(true)
    expect(screen.getAllByText(t("clean")).length).toBeGreaterThan(0)
  })

  it("collapses and expands each repository with accessible state without rescanning", async () => {
    const next = setup({ repos })
    next.mount()
    await settled()
    const user = userEvent.setup()
    const collapse = screen.getByRole("button", { name: `${t("toggleRepository")} alpha` })
    expect(collapse.getAttribute("aria-expanded")).toBe("true")
    await user.click(collapse)
    expect(screen.queryByText("task/feature")).toBeNull()
    expect(screen.getByText("fix/payments")).toBeTruthy()
    const expand = screen.getByRole("button", { name: `${t("toggleRepository")} alpha` })
    expect(expand.getAttribute("aria-expanded")).toBe("false")
    await user.click(expand)
    expect(screen.getByText("task/feature")).toBeTruthy()
    expect(screen.getByRole("button", { name: `${t("toggleRepository")} alpha` }).getAttribute("aria-expanded")).toBe("true")
    expect(next.api.scan).toHaveBeenCalledTimes(1)
  })

})

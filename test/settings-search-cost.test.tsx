// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { t } from "../src/client/lib/i18n"
import { scanAnswer } from "./scan-answer.helper"

/**
 * What the panel costs per keystroke.
 *
 * Two of its answers are derived from the whole scan and the whole Workspace list:
 * the task spaces the repositories group into, and which Workspace owns each of them.
 * Both used to be rebuilt on every render, and a render is every character typed into
 * the search box - so the search, which is the fastest thing on the page to use, was
 * the one paying for arithmetic whose answer nothing in the query could change.
 *
 * The work is counted rather than timed: a timing assertion on a machine shared with
 * a build is a flake waiting for a busy afternoon, while a count is a statement about
 * what the code does rather than about how fast it is today.
 */
const work = vi.hoisted(() => ({ grouped: 0, compared: 0 }))

vi.mock("../src/client/lib/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client/lib/tasks")>()
  return {
    ...actual,
    groupTasks: (...args: Parameters<typeof actual.groupTasks>) => {
      work.grouped += 1
      return actual.groupTasks(...args)
    },
  }
})

vi.mock("../src/client/lib/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client/lib/paths")>()
  return {
    ...actual,
    sameLocation: (...args: Parameters<typeof actual.sameLocation>) => {
      work.compared += 1
      return actual.sameLocation(...args)
    },
  }
})

import { WorktreesSettings } from "../src/client/components/WorktreesSettings"

/** One repository, with the single worktree a source checkout reports. */
function repository(repoPath: string) {
  return {
    repoPath,
    currentBranch: "main",
    worktrees: [{ path: repoPath, branch: "main", isMain: true, detached: false, locked: false, prunable: false }],
  }
}

/** A Workspace of `count` repositories, which is the shape the memo has to hold for. */
function setup(count: number) {
  const lists = Array.from({ length: count }, (_, index) => repository(`/projects/repo-${String(index).padStart(3, "0")}`))
  const api: any = {
    scan: vi.fn().mockResolvedValue(scanAnswer(lists)),
    cachedScan: vi.fn().mockResolvedValue(null),
    status: vi.fn().mockResolvedValue({ changedFiles: 0, commits: 0 }),
    classifyRoot: vi.fn().mockResolvedValue({ isRepository: true }),
    classifyRoots: vi.fn().mockResolvedValue([
      { path: "/projects", isRepository: false, isSourceRoot: true, repositoryCount: count, repositories: [] },
    ]),
  }
  const items = [
    { workspaceId: "root", path: "/projects", title: "Projects" },
    { workspaceId: "inner", path: "/projects/repo-000", title: "Repo 000" },
  ]
  const workspaces: any = { list: { getSnapshot: () => ({ items }), subscribe: () => () => {} }, create: vi.fn(), rename: vi.fn(), delete: vi.fn() }
  const uiWorkspace: any = { openWorkspace: vi.fn() }
  const mount = () => render(<WorktreesSettings api={api} workspaces={workspaces} uiWorkspace={uiWorkspace} sessions={{ list: { getSnapshot: () => ({ byId: {} }) } } as any} />)
  return { api, mount }
}

beforeEach(() => { work.grouped = 0; work.compared = 0 })
afterEach(cleanup)

describe("the search box", () => {
  it("does not regroup the scan or re-own the repositories for what the user types", async () => {
    const next = setup(120)
    next.mount()
    // Wait for the scan and the classification to land, so what follows is measured
    // against a panel that has both answers rather than one still filling them in.
    await waitFor(() => expect(document.querySelectorAll(".dws-repo, .dws-task").length).toBeGreaterThan(0))
    await waitFor(() => expect(work.grouped).toBeGreaterThan(0))
    const grouped = work.grouped
    const compared = work.compared

    const search = screen.getByRole("textbox", { name: t("searchPlaceholder") })
    for (const query of ["r", "re", "rep", "repo"]) fireEvent.change(search, { target: { value: query } })

    // The rows answer the query - the grouping was not thrown away, only not redone.
    expect(work.grouped).toBe(grouped)
    expect(work.compared).toBe(compared)
    expect(document.querySelectorAll(".dws-repo").length).toBeGreaterThan(0)
  })

  it("regroups when the scan does, so the memo is not simply never recomputing", async () => {
    const next = setup(30)
    next.mount()
    await waitFor(() => expect(document.querySelectorAll(".dws-repo, .dws-task").length).toBeGreaterThan(0))
    const grouped = work.grouped

    await waitFor(() => expect(screen.getByRole("button", { name: t("refresh") })).toHaveProperty("disabled", false))
    fireEvent.click(screen.getByRole("button", { name: t("refresh") }))

    await waitFor(() => expect(work.grouped).toBeGreaterThan(grouped))
    await waitFor(() => expect(screen.getByRole("button", { name: t("refresh") })).toHaveProperty("disabled", false))
  })
})

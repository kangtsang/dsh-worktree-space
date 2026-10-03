// @vitest-environment jsdom
import { format, t } from "../src/client/lib/i18n"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorktreesSettings } from "../src/client/components/WorktreesSettings"
import { setPreview } from "../src/client/lib/config-preview"
import { scanAnswer } from "./scan-answer.helper"
import type { ScanAnswer } from "../src/client/lib/types"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function repository(path: string, linked = false) {
  return {
    repoPath: path,
    worktrees: [
      { path, branch: "main", isMain: true, detached: false, locked: false, prunable: false },
      ...(linked ? [{ path: `${path}.worktrees/task`, branch: "task", isMain: false, detached: false, locked: false, prunable: false }] : []),
    ],
  }
}

function setup() {
  const api = {
    scan: vi.fn(), cachedScan: vi.fn().mockResolvedValue(null), status: vi.fn(),
    remove: vi.fn(), prune: vi.fn(),
    // The page asks for every Workspace in one request; nothing here answers it,
    // so the rows stay "checking", which is what these tests are about.
    classifyRoots: vi.fn(() => new Promise(() => {})),
  }
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

/** The page opens on the Workspaces; this suite covers the repository list, so a case
 *  that wants repositories asks for them, and the one about tasks asks for those. */
function showRepositories() {
  fireEvent.click(screen.getByRole("button", { name: t("viewRepositories") }))
}
function showTasks() {
  fireEvent.click(screen.getByRole("button", { name: t("viewTasks") }))
}

describe("WorktreesSettings loading lifecycle", () => {
  it("shows explicit loading until scan settles, then offers creation for a repository with zero linked worktrees", async () => {
    const next = setup()
    const scan = deferred<ScanAnswer>()
    next.api.scan.mockReturnValue(scan.promise)
    next.mount()
    showRepositories()
    expect(screen.getByRole("status").textContent).toContain(t("scanningUnknown"))
    expect(screen.queryByText(t("noWorktrees"))).toBeNull()
    expect(screen.getByRole("button", { name: t("refresh") })).toHaveProperty("disabled", true)
    expect(next.api.scan).toHaveBeenCalledWith(["/projects", "/projects/narrow"], expect.any(AbortSignal), undefined)

    await act(async () => { scan.resolve(scanAnswer([repository("/projects/empty")])) })
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
    const scan = deferred<ScanAnswer>()
    next.api.scan.mockReturnValue(scan.promise)
    const view = next.mount()
    const signal = next.api.scan.mock.calls[0][1] as AbortSignal
    expect(signal.aborted).toBe(false)
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => { scan.resolve(scanAnswer([repository("/stale", true)])) })
    expect(next.api.status).not.toHaveBeenCalled()
  })

  it("says a task's repositories are being checked, not unknown, while the reads are in flight", async () => {
    const next = setup()
    const linked = { path: "/spaces/antest/alpha", branch: "feat/antest", isMain: false, detached: false, locked: false, prunable: false }
    next.api.scan.mockResolvedValue(scanAnswer([{
      repoPath: "/projects/alpha",
      worktrees: [
        { path: "/projects/alpha", branch: "develop", isMain: true, detached: false, locked: false, prunable: false },
        linked,
      ],
    }]))
    const status = deferred<any>()
    next.api.status.mockReturnValue(status.promise)
    next.mount()
    showTasks()

    // In the task view the sentinel a refresh writes has to read as "checking", which is
    // what this view used to report as an unknown status.
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
    next.api.scan.mockResolvedValue(scanAnswer([repository("/projects/linked", true)]))
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
    const scan = deferred<ScanAnswer>()
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
      // The Host answers this even when it remembers no rows, so the two are
      // separate facts and the panel asks for the bounds regardless.
      current: { depth: 2, directories: 2000 },
    }
  }

  it("paints the remembered rows at once, then replaces them with the fresh scan", async () => {
    const next = setup()
    next.api.cachedScan.mockResolvedValue(remembered())
    const scan = deferred<ScanAnswer>()
    next.api.scan.mockReturnValue(scan.promise)
    next.mount()
    showRepositories()

    // The remembered rows are up before the scan has answered anything, with the
    // status the Host still holds, and without the skeleton in front of them.
    await waitFor(() => expect(screen.getByRole("heading", { name: "linked" })).toBeTruthy())
    expect(screen.getByText(format(t("dirty"), { count: "3" }))).toBeTruthy()
    expect(document.querySelectorAll(".dws-skeleton-row")).toHaveLength(0)
    expect(screen.getByRole("status").textContent).toContain(format(t("scanning"), { depth: "2" }))

    // The scan is the last word, and an empty result is a result.
    await act(async () => { scan.resolve(scanAnswer([])) })
    expect(screen.queryByRole("heading", { name: "linked" })).toBeNull()
    expect(screen.getByRole("heading", { name: t("noMatches") })).toBeTruthy()
  })

  it("ignores a remembered answer that arrives after the fresh scan has landed", async () => {
    const next = setup()
    const cache = deferred<any>()
    next.api.cachedScan.mockReturnValue(cache.promise)
    next.api.scan.mockResolvedValue(scanAnswer([]))
    next.mount()
    showRepositories()
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull())

    await act(async () => { cache.resolve(remembered()) })
    expect(screen.queryByRole("heading", { name: "linked" })).toBeNull()
  })

  it("scans anyway when the Host cannot answer for the last scan", async () => {
    const next = setup()
    next.api.cachedScan.mockRejectedValue(new Error("Unknown endpoint: worktree.cached"))
    next.api.scan.mockResolvedValue(scanAnswer([repository("/projects/linked")]))
    next.mount()
    showRepositories()

    await waitFor(() => expect(screen.getByRole("heading", { name: "linked" })).toBeTruthy())
    expect(screen.queryByRole("alert")).toBeNull()
  })
})

describe("WorktreesSettings and the repositories a Workspace spans", () => {
  // The preview store is module state, so a choice one case makes is still in force
  // in the next one. Without this the depth a case chooses outlives it and the next
  // panel opens showing a number nobody asked for. Cleared field by field rather
  // than through `settlePreview`, which drops only the choices the Host has caught
  // up with - a choice nothing has agreed with is exactly what it keeps.
  afterEach(() => setPreview("scanDepth", undefined))

  /** The page opens on this view, and these cases are about it. */
  async function showWorkspace(next: ReturnType<typeof setup>, answer: ScanAnswer) {
    next.api.scan.mockResolvedValue(answer)
    // The classification is what puts a count on the row; answered, because a row
    // that has not answered cannot expand and would hide the behaviour under test.
    next.api.classifyRoots.mockResolvedValue([
      { path: "/projects", isDirectory: true, isRepository: false, isSourceRoot: true, repositoryCount: 2, repositories: [] },
    ])
    next.mount()
    await waitFor(() => expect(next.api.scan).toHaveBeenCalled())
  }

  it("expands a Workspace to the repositories the scan found under it", async () => {
    const next = setup()
    await showWorkspace(next, scanAnswer([repository("/projects/alpha"), repository("/projects/nested/beta")]))

    // Open to begin with, like every other row in this panel: a Workspace is the
    // coarsest thing on the page and the repositories under it are what it is for.
    expect(document.querySelectorAll(".dws-worktree")).toHaveLength(2)
    // Both of them, not just the one that happens to sit directly below: a
    // repository one level down is exactly the one this change exists to show, and
    // it is also one the Workspace's own count includes. Asserted on the titles
    // rather than on the text, because a direct child's name and its path relative
    // to the Workspace are the same word and would match either.
    const titles = [...document.querySelectorAll(".dws-worktree-title strong")].map(node => node.textContent)
    expect(titles.sort()).toEqual(["alpha", "beta"])
    // The nested one shows what it is called relative to the Workspace, the way a
    // worktree below a repository shows its own path relative to that repository.
    const paths = [...document.querySelectorAll(".dws-worktree-path")].map(node => node.textContent)
    expect(paths.sort()).toEqual(["alpha", "nested/beta"])

    const toggle = screen.getByRole("button", { name: `${t("toggleWorkspace")} Projects` })
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    fireEvent.click(toggle)
    expect(document.querySelectorAll(".dws-worktree")).toHaveLength(0)
    expect(toggle.getAttribute("aria-expanded")).toBe("false")

    fireEvent.click(toggle)
    expect(document.querySelectorAll(".dws-worktree")).toHaveLength(2)
  })

  it("names the depth the Host reports, not one the panel guessed", async () => {
    const next = setup()
    // A Host that remembers nothing about these paths: empty rows, but the bounds
    // are a separate fact and have to arrive anyway. This is the case a panel with
    // no previous scan would otherwise be stuck on, unable to name its first one.
    next.api.cachedScan.mockResolvedValue({ repositories: [], statuses: {}, current: { depth: 3, directories: 2000 } })
    const scan = deferred<ScanAnswer>()
    next.api.scan.mockReturnValue(scan.promise)
    next.mount()
    // The bounds arrive on their own call while the scan is already running, so the
    // number turns up mid-scan rather than at its end.
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(format(t("scanning"), { depth: "3" })))

    // Depth 7 is not a value any configuration offers; it can only have come from
    // the Host resolving something of its own, which is the whole point of the
    // message reporting what the walk really used.
    await act(async () => { scan.resolve(scanAnswer([repository("/projects/linked")], true, 7)) })
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull())

    // The number on screen is the number that was sent, so the walk and the label
    // cannot disagree. Held rather than blanked: the next scan is on screen from
    // its first millisecond, which is when there is no answer to read it from yet.
    next.api.scan.mockReturnValue(new Promise(() => {}))
    fireEvent.click(screen.getByRole("button", { name: t("refresh") }))
    expect(screen.getByRole("status").textContent).toBe(format(t("scanning"), { depth: "7" }))
  })

  it("scans at a pending choice at once, rather than at the depth still in force", async () => {
    const next = setup()
    next.api.cachedScan.mockResolvedValue({ repositories: [], statuses: {}, current: { depth: 2, directories: 2000 } })
    next.api.scan.mockResolvedValue(scanAnswer([]))
    next.mount()
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull())

    // The user has just clicked a new depth and the Host has not been told yet.
    // Reading the served value here would show 2 for exactly as long as the choice
    // was in flight - which is the moment they are watching.
    act(() => { setPreview("scanDepth", "5") })
    next.api.scan.mockReturnValue(new Promise(() => {}))
    fireEvent.click(screen.getByRole("button", { name: t("refresh") }))

    expect(screen.getByRole("status").textContent).toBe(format(t("scanning"), { depth: "5" }))
    // And it is that same number the Host is asked to walk, rather than the two
    // being decided separately and left to agree.
    const [, signal, depth] = next.api.scan.mock.calls.at(-1) as any[]
    expect(depth).toBe(5)
    expect(signal).toBeDefined()
  })

  it("never prints the placeholder when it has no depth to name", async () => {
    const next = setup()
    // Nothing has told the panel a depth and nothing is pending: the message falls
    // back to wording of its own, because the alternative is printing the
    // placeholder - "扫描所有工作区（深度 {depth}）" - straight onto the page.
    next.api.cachedScan.mockResolvedValue(null)
    next.api.scan.mockReturnValue(new Promise(() => {}))
    next.mount()
    expect(screen.getByRole("status").textContent).toBe(t("scanningUnknown"))
    expect(document.body.textContent).not.toContain("{depth}")
  })

  it("keeps a Workspace holding nothing closed rather than opening onto an empty list", async () => {
    const next = setup()
    await showWorkspace(next, scanAnswer([repository("/elsewhere/gamma")]))

    const toggle = screen.getByRole("button", { name: `${t("toggleWorkspace")} Projects` })
    expect(toggle.hasAttribute("disabled")).toBe(true)
    expect(toggle.getAttribute("aria-expanded")).toBeNull()
    fireEvent.click(toggle)
    expect(document.querySelectorAll(".dws-worktree")).toHaveLength(0)
  })

  it("lists only the repositories a search matched, not every one the Workspace holds", async () => {
    const next = setup()
    await showWorkspace(next, scanAnswer([repository("/projects/alpha"), repository("/projects/nested/beta")]))

    const search = screen.getByRole("textbox", { name: t("searchPlaceholder") })
    fireEvent.change(search, { target: { value: "beta" } })

    // The row stays, because a repository under it matched - and then it has to
    // show that repository and not the other one. Listing all of them says the
    // search found all of them, and the expanded list is the only place the panel
    // says which repositories are on screen.
    const toggle = screen.getByRole("button", { name: `${t("toggleWorkspace")} Projects` })
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    const titles = [...document.querySelectorAll(".dws-worktree-title strong")].map(node => node.textContent)
    expect(titles).toEqual(["beta"])
  })

  it("drops the Workspace out of a search that matches nothing under it", async () => {
    const next = setup()
    await showWorkspace(next, scanAnswer([repository("/projects/alpha"), repository("/projects/nested/beta")]))

    fireEvent.change(screen.getByRole("textbox", { name: t("searchPlaceholder") }), { target: { value: "nothing-here" } })
    expect(document.querySelectorAll(".dws-worktree")).toHaveLength(0)
  })

  // The badge counted one walk and the list came from another, so a Workspace came
  // to read "0" beside a row listing twelve - and nothing on the page could say
  // which of the two was the real one. The badge now counts the list.
  it("reports on its badge the repositories it actually lists", async () => {
    const next = setup()
    // The classification says zero, the scan says two. The scan is what the row
    // shows, so the badge has to say two - and the two it does not own are not
    // listed at all.
    next.api.classifyRoots.mockResolvedValue([
      { path: "/projects", isDirectory: true, isRepository: false, isSourceRoot: true, repositoryCount: 0, repositories: [] },
      { path: "/projects/narrow", isDirectory: true, isRepository: false, isSourceRoot: true, repositoryCount: 99, repositories: [] },
    ])
    next.api.scan.mockResolvedValue(scanAnswer([repository("/projects/narrow/beta")]))
    next.mount()
    await waitFor(() => expect(next.api.scan).toHaveBeenCalled())

    // The repository sits under `Narrow`, the more specific of the two, so it is
    // listed there and not under `Projects`.
    const projects = screen.getByRole("button", { name: `${t("toggleWorkspace")} Projects` })
    const narrow = screen.getByRole("button", { name: `${t("toggleWorkspace")} Narrow` })
    expect(narrow.getAttribute("aria-expanded")).toBe("true")
    expect(projects.hasAttribute("disabled")).toBe(true)
    expect([...document.querySelectorAll(".dws-worktree-title strong")].map(node => node.textContent)).toEqual(["beta"])
    // Two badges, each counting the rows its own Workspace lists. Neither repeats
    // the classification's numbers, which measured something else. `Projects`
    // also wears the sentence that goes with a count of zero, which is judged on
    // the same list and so appears for the same reason the badge reads zero.
    const badges = [...document.querySelectorAll(".dws-status")].map(node => node.textContent)
    expect(badges).toEqual([
      format(t("workspaceSpans"), { count: "0" }),
      t("workspaceCannot"),
      format(t("workspaceSpans"), { count: "1" }),
    ])
  })
})

// The same rule in all three views, and it was only true of one of them: a row that
// matched stayed on screen and then listed everything underneath it, which says the
// search found all of it. A badge that counts the unfiltered list makes it worse -
// the row claims a number the panel is not showing.
describe("WorktreesSettings and what a search lists inside a row", () => {
  const row = (path: string, branch: string, isMain = false) => ({
    path, branch, isMain, detached: false, locked: false, prunable: false,
  })

  // The main worktree is not a row: `scannedRepositories` folds it into the
  // repository's current branch and leaves the linked worktrees behind. So a
  // repository that lists two branches has three worktrees in the answer.
  const repoWith = (path: string, branches: string[]) => ({
    repoPath: path,
    worktrees: [row(path, "main", true), ...branches.map(branch => row(`${path}.worktrees/${branch}`, branch))],
  })

  const listed = () => [...document.querySelectorAll(".dws-worktree-title strong")].map(node => node.textContent)
  const badge = () => document.querySelector(".dws-repo .dws-count")?.textContent
  const type = (value: string) =>
    fireEvent.change(screen.getByRole("textbox", { name: t("searchPlaceholder") }), { target: { value } })

  it("lists only the worktrees a search matched, and counts those", async () => {
    const next = setup()
    next.api.scan.mockResolvedValue(scanAnswer([repoWith("/projects/alpha", ["feature-x", "feature-y"])]))
    next.mount()
    await waitFor(() => expect(next.api.scan).toHaveBeenCalled())
    showRepositories()
    await waitFor(() => expect(listed()).toHaveLength(2))

    type("feature-x")

    // The row stays - one of its worktrees matched - and then lists that one.
    expect(listed()).toEqual(["feature-x"])
    // The badge counts the list that is on screen. A "2" beside one row says the
    // search missed one, and nothing on the page can tell the reader it did not.
    expect(badge()).toBe("1")
  })

  it("keeps every worktree listed when nothing is being searched for", async () => {
    const next = setup()
    next.api.scan.mockResolvedValue(scanAnswer([repoWith("/projects/alpha", ["feature-x"])]))
    next.mount()
    await waitFor(() => expect(next.api.scan).toHaveBeenCalled())
    showRepositories()
    await waitFor(() => expect(listed()).toHaveLength(1))
    expect(badge()).toBe("1")
  })

  it("keeps a repository whose current branch matched, listing no worktree of its own", async () => {
    const next = setup()
    next.api.scan.mockResolvedValue(scanAnswer([repoWith("/projects/alpha", ["feature-x"])]))
    next.mount()
    await waitFor(() => expect(next.api.scan).toHaveBeenCalled())
    showRepositories()
    await waitFor(() => expect(listed()).toHaveLength(1))

    // `main` is the repository's branch rather than a row under it, so it keeps the
    // repository on screen and finds nothing to list inside it. Dropping the
    // repository instead would hide a repository whose branch the search named.
    type("main")
    expect(document.querySelectorAll(".dws-repo")).toHaveLength(1)
    expect(listed()).toEqual([])
  })

  it("lists only the repositories a search matched inside a task space", async () => {
    const next = setup()
    // A task worktree is one whose parent directory is named after the branch's last
    // segment, which is how `groupTasks` recognises it - so the paths have to say
    // that or nothing is grouped and the view is empty.
    next.api.scan.mockResolvedValue(scanAnswer([
      { repoPath: "/projects/one", worktrees: [row("/projects/one", "main", true), row("/projects/tasks-a/one", "x/tasks-a")] },
      { repoPath: "/projects/two", worktrees: [row("/projects/two", "main", true), row("/projects/tasks-b/two", "x/tasks-b")] },
    ]))
    next.mount()
    await waitFor(() => expect(next.api.scan).toHaveBeenCalled())
    showTasks()
    await waitFor(() => expect(document.querySelectorAll(".dws-task").length).toBeGreaterThan(0))

    type("two")

    // One task space, holding the one repository the search found.
    expect(document.querySelectorAll(".dws-task")).toHaveLength(1)
    expect(listed()).toEqual(["two"])
  })
})

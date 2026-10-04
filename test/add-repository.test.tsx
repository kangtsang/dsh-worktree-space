// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { format, t } from "../src/client/lib/i18n"
import { scanAnswer } from "./scan-answer.helper"
import { WorktreesSettings } from "../src/client/components/WorktreesSettings"

/**
 * Adding a repository to a task that already exists.
 *
 * Two surfaces, one list. The repository view is a scan of the Workspaces, so a
 * repository the user names by hand is registered as a Workspace and becomes a
 * row there; the add dialog offers exactly that view's rows. These cases hold both
 * halves to that, because the two drifting apart is the failure worth naming.
 */

const TASK_PATH = "/spaces/kratos-admin/login"

/** One repository as the scan reports it, with `isMain` on the checkout itself. */
function repository(repoPath: string, linked: Array<{ path: string; branch: string }> = []) {
  return {
    repoPath,
    worktrees: [
      { path: repoPath, branch: "main", isMain: true, detached: false, locked: false, prunable: false },
      ...linked.map((entry) => ({ ...entry, isMain: false, detached: false, locked: false, prunable: false })),
    ],
  }
}

function setup() {
  const classifyRoot = vi.fn()
  const api = {
    scan: vi.fn(),
    cachedScan: vi.fn().mockResolvedValue(null),
    status: vi.fn().mockResolvedValue({ changedFiles: 0, branchLine: "", output: "" }),
    remove: vi.fn(),
    prune: vi.fn(),
    classifyRoot,
    // The page classifies a page of Workspaces in one request; the Host answers it
    // by walking each path now. Derived from the same per-path mock the tests set
    // up, so telling it what one path holds still decides what the row draws. A
    // path that fails is left out of the answer, exactly as the Host leaves it out.
    classifyRoots: vi.fn((paths: string[]) =>
      Promise.all(paths.map((path) => classifyRoot(path).catch(() => undefined))).then((entries) => entries.filter(Boolean))),
    inspectTask: vi.fn(),
    addRepositories: vi.fn(),
  }
  const items: any[] = [{ workspaceId: "spaces", path: "/spaces", title: "Spaces" }]
  // A store that behaves like one: the snapshot changes when a Workspace is created,
  // and the page is subscribed to it. A frozen snapshot hides the whole class of bug
  // this file keeps meeting — something drawn from a list that has already moved on.
  const listeners = new Set<() => void>()
  const workspaces: any = {
    list: {
      getSnapshot: () => ({ items }),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    create: vi.fn(async ({ path }: { path: string }) => {
      items.push({ workspaceId: `ws-${items.length}`, path, title: "" })
      for (const listener of listeners) listener()
    }),
    rename: vi.fn(),
    delete: vi.fn(),
  }
  const uiWorkspace: any = { openWorkspace: vi.fn().mockResolvedValue(undefined) }
  const sessions: any = { list: { getSnapshot: () => ({ byId: {} }) } }
  const mount = () => render(<WorktreesSettings api={api as any} workspaces={workspaces} uiWorkspace={uiWorkspace} sessions={sessions} />)
  return { api, workspaces, mount }
}

/** The task the tests work on: one worktree, `alpha`, on `task/login`. */
const ALPHA_WORKTREE = { path: `${TASK_PATH}/alpha`, branch: "task/login" }

const inspection = {
  isTask: true,
  path: TASK_PATH,
  task: "login",
  project: "kratos-admin",
  tasksRoot: "/spaces",
  branch: "task/login",
  repositories: ["alpha"],
}

afterEach(cleanup)

const showRepositories = () => fireEvent.click(screen.getByRole("button", { name: t("viewRepositories") }))
const showTasks = () => fireEvent.click(screen.getByRole("button", { name: t("viewTasks") }))
const showSpaces = () => fireEvent.click(screen.getByRole("button", { name: t("viewWorkspaces") }))

describe("the workspace view registers a directory as a Workspace", () => {
  async function openField(next: ReturnType<typeof setup>) {
    await waitFor(() => expect(screen.getByRole("button", { name: t("refresh") })).toHaveProperty("disabled", false))
    fireEvent.click(screen.getByRole("button", { name: t("addWorkspace") }))
    return screen.getByRole("textbox", { name: t("addWorkspace") })
  }

  it("registers a directory that exists, whatever it holds", async () => {
    const next = setup()
    next.api.scan.mockResolvedValue(scanAnswer([]))
    // A Workspace may hold no repository at all — one the user is about to clone
    // into is the ordinary case — so only "is this a directory" is asked.
    next.api.classifyRoot.mockImplementation(async (path: string) => ({ isDirectory: path !== "/notes", isRepository: false }))
    next.mount()
    showSpaces()

    fireEvent.change(await openField(next), { target: { value: "  D:\\workspace  " } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("addWorkspaceConfirm") })) })

    expect(next.api.classifyRoot).toHaveBeenCalledWith("D:\\workspace")
    expect(next.workspaces.create).toHaveBeenCalledExactlyOnceWith({ path: "D:\\workspace" })
    expect(screen.queryByRole("textbox", { name: t("addWorkspace") })).toBeNull()
    // The same stale-registry gap the repository entry has to close: the scan
    // names the path itself rather than trusting the list to have caught up.
    expect(next.api.scan.mock.calls[1][0]).toContain("D:\\workspace")
  })

  it("classifies a Workspace it registered, without leaving and coming back to", async () => {
    const next = setup()
    // The badge counts the repositories the row lists, so the scan has to be holding
    // the two the row is about to say about. It used to be told the number instead
    // and to be asked for nothing, which is how the two came to be able to disagree.
    next.api.scan.mockResolvedValue(scanAnswer([
      { repoPath: "/spaces/one", worktrees: [] },
      { repoPath: "/spaces/two", worktrees: [] },
      // The Workspace this test goes on to register. It never reaches `classify-roots`
      // (the page asks about it one path at a time), so the scan is the only thing
      // that can put a repository under it and give its row something to say.
      { repoPath: "/work/one", worktrees: [] },
    ]))
    // `path` is part of the answer, not a courtesy: the page matches each row to
    // the classification that describes it, and a batch is only readable because
    // the Host says which entry is which.
    next.api.classifyRoot.mockImplementation(async (path: string) => ({
      path, isDirectory: true, isRepository: false, isSourceRoot: path === "/spaces", repositoryCount: path === "/spaces" ? 2 : 1, repositories: [],
    }))
    next.mount()
    showSpaces()
    await waitFor(() => expect(screen.getByText(format(t("workspaceSpans"), { count: "2" }))).toBeTruthy())

    fireEvent.change(await openField(next), { target: { value: "/work" } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("addWorkspaceConfirm") })) })

    // The row it drew for the Workspace it had just made was "cannot check", and
    // stayed that way: nothing asked the Host about it, and the refresh button does
    // not ask either. A Workspace with no answer is drawn as unreadable, which is a
    // claim about the Workspace rather than about this page's memory of it.
    await waitFor(() => expect(screen.getByText(format(t("workspaceSpans"), { count: "1" }))).toBeTruthy())
    expect(screen.queryByText(t("workspaceUnreadable"))).toBeNull()
    // And the row that was already fine is not put back to "checking" to achieve it.
    expect(next.api.classifyRoots).toHaveBeenCalledWith(["/spaces"], expect.any(AbortSignal))
    expect(screen.queryByText(t("workspaceChecking"))).toBeNull()
  })

  it("refuses a path that is not a directory, and registers nothing", async () => {
    const next = setup()
    next.api.scan.mockResolvedValue(scanAnswer([]))
    next.api.classifyRoot.mockResolvedValue({ isDirectory: false })
    next.mount()
    showSpaces()

    fireEvent.change(await openField(next), { target: { value: "/notes" } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("addWorkspaceConfirm") })) })

    expect(next.workspaces.create).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain("/notes")
    // The field stays open with what was typed in it, so it can be corrected.
    expect(screen.getByRole("textbox", { name: t("addWorkspace") })).toBeTruthy()
  })

  it("says plainly that a directory already in the list needs nothing done to it", async () => {
    const next = setup()
    next.api.scan.mockResolvedValue(scanAnswer([]))
    next.api.classifyRoot.mockResolvedValue({ isDirectory: true })
    next.mount()
    showSpaces()

    fireEvent.change(await openField(next), { target: { value: "/spaces" } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("addWorkspaceConfirm") })) })

    expect(next.workspaces.create).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain(t("addWorkspaceAlready"))
  })
})

describe("the repository view adds a repository by registering it as a Workspace", () => {
  /** Open the field, once the page has finished its first scan and enabled it. */
  async function openField(next: ReturnType<typeof setup>) {
    await waitFor(() => expect(screen.getByRole("button", { name: t("refresh") })).toHaveProperty("disabled", false))
    fireEvent.click(screen.getByRole("button", { name: t("addRepositorySource") }))
    return screen.getByRole("textbox", { name: t("addRepositorySource") })
  }

  it("registers the path the Host says is a repository, and closes the field", async () => {
    const next = setup()
    next.api.scan.mockResolvedValue(scanAnswer([]))
    // The page classifies its own Workspaces too, so the answer is per path rather
    // than one blanket "yes": the assertion below is about the path that was typed.
    next.api.classifyRoot.mockImplementation(async (path: string) => ({ isRepository: path !== "/notes" }))
    next.mount()
    showRepositories()

    fireEvent.change(await openField(next), { target: { value: "  /work/gamma  " } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("addRepositoryAdd") })) })

    expect(next.api.classifyRoot).toHaveBeenCalledWith("/work/gamma")
    expect(next.workspaces.create).toHaveBeenCalledExactlyOnceWith({ path: "/work/gamma" })
    expect(screen.queryByRole("textbox", { name: t("addRepositorySource") })).toBeNull()
    // Nothing of ours to remember: the next scan finds it like any other row. That
    // scan has to name the path itself — creating a Workspace resolves before the
    // registry publishes it, and this snapshot never will, so scanning it alone is
    // exactly how a repository the user just added stays off the page.
    expect(next.api.scan).toHaveBeenCalledTimes(2)
    expect(next.api.scan.mock.calls[1][0]).toContain("/work/gamma")
  })

  it("notices that the scan already lists it, and registers nothing", async () => {
    const next = setup()
    // The scan has found `/spaces/alpha`, so the panel is already showing it.
    next.api.scan.mockResolvedValue(scanAnswer([repository("/spaces/alpha")]))
    next.api.classifyRoot.mockResolvedValue({ isRepository: true })
    next.mount()
    showRepositories()

    fireEvent.change(await openField(next), { target: { value: "/spaces/alpha" } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("addRepositoryAdd") })) })

    expect(next.workspaces.create).not.toHaveBeenCalled()
    // Not a failure: the repository is in the list they were adding to, so it is a
    // status in the warn colour rather than an alert, and it is not an error to
    // have asked.
    const notice = screen.getByRole("status")
    expect(notice.textContent).toContain(t("addRepositoryAlready"))
    expect(screen.queryByRole("alert")).toBeNull()
    // And the field stays open, so a mistyped path can be corrected in place.
    expect(screen.queryByRole("textbox", { name: t("addRepositorySource") })).not.toBeNull()
  })

  it("registers a repository the scan did not list, even under a registered Workspace", async () => {
    const next = setup()
    // `/spaces` is a registered Workspace and `/spaces/beta` is a repository under
    // it, but this scan returned only `/spaces/alpha`. The list is what decides, so
    // `/spaces/beta` is still registered: whether some ancestor is a Workspace is a
    // different question, and answering it would register a second Workspace over a
    // directory that already has one for no gain.
    next.api.scan.mockResolvedValue(scanAnswer([repository("/spaces/alpha")]))
    next.api.classifyRoot.mockResolvedValue({ isRepository: true })
    next.mount()
    showRepositories()

    fireEvent.change(await openField(next), { target: { value: "/spaces/beta" } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("addRepositoryAdd") })) })

    expect(next.workspaces.create).toHaveBeenCalledExactlyOnceWith({ path: "/spaces/beta" })
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("refuses a directory that is not a repository, and registers nothing", async () => {
    const next = setup()
    next.api.scan.mockResolvedValue(scanAnswer([]))
    next.api.classifyRoot.mockImplementation(async (path: string) => ({ isRepository: path !== "/notes" }))
    next.mount()
    showRepositories()

    fireEvent.change(await openField(next), { target: { value: "/notes" } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("addRepositoryAdd") })) })

    expect(next.workspaces.create).not.toHaveBeenCalled()
    // Said through the dictionary, in the interface language: this refusal is raised
    // two layers below the page, where there is no `t` to word it in, so the library
    // names it and the page says it. A sentence assembled down there is English and
    // reaches a Chinese interface verbatim.
    expect(screen.getByRole("alert").textContent).toBe(format(t("repositoryNotGitRepository"), { path: "/notes" }))
  })
})

describe("adding a repository to a task already under way", () => {
  /** A task holding `alpha`, with two repositories the repository view also lists. */
  function mountedTask(extra: string[] = ["/elsewhere/beta"]) {
    const next = setup()
    next.api.scan.mockResolvedValue(scanAnswer([
      repository("/projects/alpha", [ALPHA_WORKTREE]),
      ...extra.map((path) => repository(path)),
    ]))
    next.api.inspectTask.mockResolvedValue(inspection)
    next.api.addRepositories.mockResolvedValue({ repositories: [] })
    next.api.classifyRoot.mockResolvedValue({ isRepository: true })
    next.mount()
    showTasks()
    return next
  }

  const openDialog = () => fireEvent.click(screen.getByRole("button", { name: t("addRepositoryToTask") }))

  it("offers the repository view's repositories, and not the one the task already has", async () => {
    const next = mountedTask()
    await waitFor(() => expect(screen.getByRole("heading", { name: "login" })).toBeTruthy())
    openDialog()

    await waitFor(() => expect(screen.getByText("/elsewhere/beta")).toBeTruthy())
    expect(screen.queryByText("/projects/alpha")).toBeNull()
    // Each row names the branch its repository has checked out, the way the create
    // dialog's rows do: that branch is what the worktree will be left behind on.
    expect(screen.getAllByTitle(`${t("currentBranchLabel")}: main`).length).toBeGreaterThan(0)
    expect(next.api.inspectTask).toHaveBeenCalledExactlyOnceWith(TASK_PATH)
  })

  it("sends the picked repositories as absolute paths, on the task's own container", async () => {
    const next = mountedTask(["/elsewhere/beta", "/elsewhere/delta"])
    await waitFor(() => expect(screen.getByRole("heading", { name: "login" })).toBeTruthy())
    openDialog()
    await waitFor(() => expect(screen.getByText("/elsewhere/beta")).toBeTruthy())

    fireEvent.click(screen.getByRole("checkbox", { name: /beta/ }))
    fireEvent.click(screen.getByRole("checkbox", { name: /delta/ }))
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("addRepositoriesConfirm") })) })

    expect(next.api.addRepositories).toHaveBeenCalledExactlyOnceWith({
      task: "login",
      project: "kratos-admin",
      tasksRoot: "/spaces",
      repositories: ["/elsewhere/beta", "/elsewhere/delta"],
    })
    // The container the task's own record names, not one derived from the dialog's
    // surroundings: they are the same layout, and only the record is right about
    // a container that was filed somewhere else.
    await waitFor(() => expect(screen.queryByText(t("addRepositoriesTitle"))).toBeNull())
  })

  it("starts from each repository's HEAD, and from a named base when one is asked for", async () => {
    const next = mountedTask()
    await waitFor(() => expect(screen.getByRole("heading", { name: "login" })).toBeTruthy())
    openDialog()
    await waitFor(() => expect(screen.getByText("/elsewhere/beta")).toBeTruthy())
    fireEvent.click(screen.getByRole("checkbox", { name: /beta/ }))
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("addRepositoriesConfirm") })) })
    expect(next.api.addRepositories.mock.calls[0][0]).not.toHaveProperty("baseRef")

    openDialog()
    await waitFor(() => expect(screen.getByText("/elsewhere/beta")).toBeTruthy())
    fireEvent.click(screen.getByRole("checkbox", { name: /beta/ }))
    fireEvent.click(screen.getByRole("radio", { name: t("baseNamed") }))
    fireEvent.change(screen.getByRole("textbox", { name: t("baseNamed") }), { target: { value: "release" } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("addRepositoriesConfirm") })) })
    expect(next.api.addRepositories.mock.calls[1][0]).toMatchObject({ baseRef: "release" })
  })

  it("keeps the dialog open and shows why when the Host refuses", async () => {
    const next = mountedTask()
    next.api.addRepositories.mockRejectedValue(Object.assign(
      new Error("the task space already holds a repository named 'beta'"),
      { code: "E4002" },
    ))
    await waitFor(() => expect(screen.getByRole("heading", { name: "login" })).toBeTruthy())
    openDialog()
    await waitFor(() => expect(screen.getByText("/elsewhere/beta")).toBeTruthy())
    fireEvent.click(screen.getByRole("checkbox", { name: /beta/ }))
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("addRepositoriesConfirm") })) })

    expect(screen.getByRole("alert").textContent).toContain("already holds a repository named 'beta'")
    expect(screen.getByRole("button", { name: t("addRepositoriesConfirm") })).toBeTruthy()
  })

  it("says where the candidates come from, on hover", async () => {
    const next = mountedTask()
    await waitFor(() => expect(screen.getByRole("heading", { name: "login" })).toBeTruthy())
    openDialog()
    await waitFor(() => expect(screen.getByText("/elsewhere/beta")).toBeTruthy())

    // The label says which repositories may be chosen; this is the only place that
    // says where the list itself is built, which is the question it gets asked for.
    const hint = document.querySelector(".dws-field-hint")!
    fireEvent.mouseEnter(hint)
    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toContain(t("addRepositoriesSourceHint")))
  })

  it("offers no way to type a repository: the repository view is the one entry", async () => {
    const next = mountedTask()
    await waitFor(() => expect(screen.getByRole("heading", { name: "login" })).toBeTruthy())
    openDialog()
    await waitFor(() => expect(screen.getByText("/elsewhere/beta")).toBeTruthy())

    // One list, one way in. A second entry point here is a second list to keep in
    // step, and the one that came with it never showed the repository on the page.
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.queryByRole("button", { name: t("addRepositoryAdd") })).toBeNull()
  })

  it("tells two repositories of the same name apart, and names one a space carries", async () => {
    // The candidates come from every Workspace, so the same repository directory name
    // can appear twice - reached through two different Workspaces - and building the
    // element ids out of the name wrote the same id twice. The browser then resolved
    // `for` to the first of them, so choosing the second card ticked the first one.
    // The same shape of id is not even legal for a name with a space in it.
    const next = mountedTask(["/elsewhere/beta", "/elsewhere/delta", "/other/delta", "/elsewhere/my repo"])
    await waitFor(() => expect(screen.getByRole("heading", { name: "login" })).toBeTruthy())
    openDialog()
    await waitFor(() => expect(screen.getByText("/other/delta")).toBeTruthy())

    const cards = () => [...document.querySelectorAll(".dws-check-option")] as HTMLLabelElement[]
    /** The control a card is wired to, found the way the browser resolves `for`. */
    const boxOf = (path: string) => document.getElementById(
      cards().find((card) => card.textContent?.includes(path))!.htmlFor) as HTMLInputElement

    expect(cards()).toHaveLength(4)
    expect(boxOf("/elsewhere/delta").id).not.toBe(boxOf("/other/delta").id)
    // An id has to be a usable id as well as a unique one.
    for (const card of cards()) {
      expect(card.htmlFor).not.toBe("")
      expect(card.htmlFor).not.toMatch(/\s/)
    }

    // Clicking the second card's label therefore ticks the second repository's own box,
    // and leaves the first one alone.
    const second = cards().find((card) => card.textContent?.includes("/other/delta"))!
    fireEvent.click(second)
    expect(boxOf("/other/delta").checked).toBe(true)
    expect(boxOf("/elsewhere/delta").checked).toBe(false)

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("addRepositoriesConfirm") })) })
    expect(next.api.addRepositories).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ repositories: ["/other/delta"] }))
  })

  it("says nothing about where a repository sits, only that it can be added", async () => {
    // `/elsewhere/beta` shares no directory with the task space at all — two
    // absolute POSIX paths share only the leading separator. It is offered, and
    // adding it is not qualified: the merge does not care where it is, and the
    // finish already asks about the one thing that does.
    const next = mountedTask(["/elsewhere/beta", "/elsewhere/delta"])
    await waitFor(() => expect(screen.getByRole("heading", { name: "login" })).toBeTruthy())
    openDialog()
    await waitFor(() => expect(screen.getByText("/elsewhere/beta")).toBeTruthy())

    fireEvent.click(screen.getByRole("checkbox", { name: /beta/ }))
    fireEvent.click(screen.getByRole("checkbox", { name: /delta/ }))
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("addRepositoriesConfirm") })) })

    expect(next.api.addRepositories).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ repositories: ["/elsewhere/beta", "/elsewhere/delta"] }))
    expect(document.querySelector(".dws-field-note-warning")).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { t } from "../src/client/lib/i18n"
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
    commonDir: `${repoPath}/.git`,
    worktrees: [
      { path: repoPath, branch: "main", isMain: true, detached: false, locked: false, prunable: false },
      ...linked.map((entry) => ({ ...entry, isMain: false, detached: false, locked: false, prunable: false })),
    ],
  }
}

function setup() {
  const api = {
    scan: vi.fn(),
    cachedScan: vi.fn().mockResolvedValue(null),
    status: vi.fn().mockResolvedValue({ changedFiles: 0, branchLine: "", output: "" }),
    remove: vi.fn(),
    prune: vi.fn(),
    classifyRoot: vi.fn(),
    inspectTask: vi.fn(),
    addRepositories: vi.fn(),
  }
  const items = [{ workspaceId: "spaces", path: "/spaces", title: "Spaces" }]
  const workspaces: any = {
    list: { getSnapshot: () => ({ items }), subscribe: () => () => {} },
    create: vi.fn(),
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

describe("the repository view adds a repository by registering it as a Workspace", () => {
  /** Open the field, once the page has finished its first scan and enabled it. */
  async function openField(next: ReturnType<typeof setup>) {
    await waitFor(() => expect(screen.getByRole("button", { name: t("refresh") })).toHaveProperty("disabled", false))
    fireEvent.click(screen.getByRole("button", { name: t("addRepositorySource") }))
    return screen.getByRole("textbox", { name: t("addRepositorySource") })
  }

  it("registers the path the Host says is a repository, and closes the field", async () => {
    const next = setup()
    next.api.scan.mockResolvedValue([])
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
    // Nothing of ours to remember: the next scan finds it like any other row.
    expect(next.api.scan).toHaveBeenCalledTimes(2)
  })

  it("says plainly that a repository already in the list needs nothing done to it", async () => {
    const next = setup()
    next.api.scan.mockResolvedValue([])
    next.api.classifyRoot.mockResolvedValue({ isRepository: true })
    next.mount()
    showRepositories()

    // `/spaces` is already a Workspace, so it is already in the list the field
    // exists to add to.
    fireEvent.change(await openField(next), { target: { value: "/spaces" } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("addRepositoryAdd") })) })

    expect(next.workspaces.create).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain(t("addRepositoryAlready"))
  })

  it("refuses a directory that is not a repository, and registers nothing", async () => {
    const next = setup()
    next.api.scan.mockResolvedValue([])
    next.api.classifyRoot.mockImplementation(async (path: string) => ({ isRepository: path !== "/notes" }))
    next.mount()
    showRepositories()

    fireEvent.change(await openField(next), { target: { value: "/notes" } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("addRepositoryAdd") })) })

    expect(next.workspaces.create).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain("/notes")
  })
})

describe("adding a repository to a task already under way", () => {
  /** A task holding `alpha`, with two repositories the repository view also lists. */
  function mountedTask(extra: string[] = ["/elsewhere/beta"]) {
    const next = setup()
    next.api.scan.mockResolvedValue([
      repository("/projects/alpha", [ALPHA_WORKTREE]),
      ...extra.map((path) => repository(path)),
    ])
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

  it("registers a path typed into the dialog, so it joins the repository view too", async () => {
    const next = mountedTask([])
    await waitFor(() => expect(screen.getByRole("heading", { name: "login" })).toBeTruthy())
    openDialog()
    await waitFor(() => expect(next.api.inspectTask).toHaveBeenCalled())

    fireEvent.change(screen.getByRole("textbox", { name: t("addRepositoryManual") }), { target: { value: "/work/gamma" } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("addRepositoryAdd") })) })
    expect(next.workspaces.create).toHaveBeenCalledExactlyOnceWith({ path: "/work/gamma" })

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("addRepositoriesConfirm") })) })
    expect(next.api.addRepositories).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ repositories: ["/work/gamma"] }))
  })

  it("warns about a repository nothing above both of them reaches, and only about that one", async () => {
    // Two absolute POSIX paths share only the leading separator, so a fixture has
    // to say so deliberately: `/work/...` is under one directory with the task
    // space, `/elsewhere/...` is under none.
    const next = mountedTask(["/work/beta", "/elsewhere/delta"])
    await waitFor(() => expect(screen.getByRole("heading", { name: "login" })).toBeTruthy())
    openDialog()
    await waitFor(() => expect(screen.getByText("/work/beta")).toBeTruthy())

    expect(screen.queryByRole("alert")).toBeNull()
    fireEvent.click(screen.getByRole("checkbox", { name: /delta/ }))
    await waitFor(() => expect(document.body.textContent).toContain(t("addRepositoriesIsolation").replace("{names}", "delta")))
    // The one that does share a directory is not named in it.
    expect(document.body.textContent).not.toContain(t("addRepositoriesIsolation").replace("{names}", "beta"))
  })
})
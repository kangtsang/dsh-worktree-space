// @vitest-environment jsdom
import { t } from "../src/client/lib/i18n"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { CreateWorktreeDialog } from "../src/client/components/CreateWorktreeDialog"
import { NewSessionWorktreeButton } from "../src/client/components/NewSessionWorktreeButton"
import { WorktreesSettings } from "../src/client/components/WorktreesSettings"

const target = { workspaceId: "ws-main", path: "/repo", title: "apple" }

function services() {
  return {
    workspaces: {
      create: vi.fn().mockResolvedValue({ workspaceId: "ws-wt", path: "/tasks/fix-login", title: "fix-login" }),
      rename: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    uiWorkspace: {
      openWorkspace: vi.fn().mockResolvedValue(undefined),
    },
  }
}

/** The host's answer for a source root holding two repositories. */
function suggestion() {
  return {
    sourceRoot: "/repo",
    suggested: "/tasks",
    explicit: false,
    branchPrefix: "task/",
    repositories: [
      { name: "alpha", path: "/repo/alpha" },
      { name: "beta", path: "/repo/beta" },
    ],
  }
}

/** A created task spanning the given repository names. */
function createdTask(names: string[] = ["alpha", "beta"]) {
  return {
    task: "fix-login",
    branch: "task/fix-login",
    path: "/tasks/fix-login",
    tasksRoot: "/tasks",
    repositories: names.map((name) => ({ name, path: `/tasks/fix-login/${name}` })),
    warnings: [],
  }
}

describe("CreateWorktreeDialog", () => {
  it("creates one task across every discovered repository and opens it", async () => {
    const user = userEvent.setup()
    const next = services()
    const api = { suggestRoot: vi.fn().mockResolvedValue(suggestion()), createTask: vi.fn().mockResolvedValue(createdTask()), doneTask: vi.fn() }
    const onClose = vi.fn()
    render(<CreateWorktreeDialog target={target as any} api={api as any} workspaces={next.workspaces as any} uiWorkspace={next.uiWorkspace as any} onCreated={vi.fn()} onClose={onClose} />)

    await waitFor(() => expect(screen.getByRole("dialog", { name: t("dialogTitle") })).toBeTruthy())
    // The container arrives pre-filled with the recommendation, and every
    // discovered repository starts included.
    expect(screen.getByLabelText(new RegExp(`^${t("containerLocation")}`))).toHaveProperty("value", "/tasks")
    expect(screen.getByRole("checkbox", { name: /alpha/ })).toHaveProperty("checked", true)
    expect(screen.getByRole("checkbox", { name: /beta/ })).toHaveProperty("checked", true)
    await user.type(screen.getByLabelText(new RegExp(`^${t("taskName")}`)), "Fix login")
    await user.click(screen.getByRole("button", { name: t("createAndOpen") }))

    await waitFor(() => expect(next.uiWorkspace.openWorkspace).toHaveBeenCalledWith("ws-wt"))
    expect(api.createTask).toHaveBeenCalledWith({ sourceRoot: "/repo", task: "fix-login", tasksRoot: "/tasks", repos: ["alpha", "beta"], baseRef: undefined, branchPrefix: "task/" })
    expect(next.workspaces.create).toHaveBeenCalledWith({ path: "/tasks/fix-login" })
    expect(next.workspaces.rename).toHaveBeenCalledWith("ws-wt", "apple/fix-login")
    expect(onClose).toHaveBeenCalled()
  })

  it("creates only the repositories the user keeps", async () => {
    const user = userEvent.setup()
    const next = services()
    const api = { suggestRoot: vi.fn().mockResolvedValue(suggestion()), createTask: vi.fn().mockResolvedValue(createdTask(["alpha"])), doneTask: vi.fn() }
    render(<CreateWorktreeDialog target={target as any} api={api as any} workspaces={next.workspaces as any} uiWorkspace={next.uiWorkspace as any} onCreated={vi.fn()} onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByRole("checkbox", { name: /beta/ })).toBeTruthy())
    await user.click(screen.getByRole("checkbox", { name: /beta/ }))
    await user.type(screen.getByLabelText(new RegExp(`^${t("taskName")}`)), "Fix login")
    await user.click(screen.getByRole("button", { name: t("createAndOpen") }))

    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith({ sourceRoot: "/repo", task: "fix-login", tasksRoot: "/tasks", repos: ["alpha"], baseRef: undefined, branchPrefix: "task/" }))
  })

  it("starts every branch from the named ref the user chose", async () => {
    const user = userEvent.setup()
    const next = services()
    const api = { suggestRoot: vi.fn().mockResolvedValue(suggestion()), createTask: vi.fn().mockResolvedValue(createdTask()), doneTask: vi.fn() }
    render(<CreateWorktreeDialog target={target as any} api={api as any} workspaces={next.workspaces as any} uiWorkspace={next.uiWorkspace as any} onCreated={vi.fn()} onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByRole("radio", { name: t("baseNamed") })).toBeTruthy())
    await user.click(screen.getByRole("radio", { name: t("baseNamed") }))
    await user.type(screen.getByPlaceholderText(t("baseRefPlaceholder")), "main")
    await user.type(screen.getByLabelText(new RegExp(`^${t("taskName")}`)), "Fix login")
    await user.click(screen.getByRole("button", { name: t("createAndOpen") }))

    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith({ sourceRoot: "/repo", task: "fix-login", tasksRoot: "/tasks", repos: ["alpha", "beta"], baseRef: "main", branchPrefix: "task/" }))
  })

  it("refuses to create without a valid name or a selected repository", async () => {
    const user = userEvent.setup()
    const next = services()
    const api = { suggestRoot: vi.fn().mockResolvedValue(suggestion()), createTask: vi.fn(), doneTask: vi.fn() }
    render(<CreateWorktreeDialog target={target as any} api={api as any} workspaces={next.workspaces as any} uiWorkspace={next.uiWorkspace as any} onCreated={vi.fn()} onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByRole("checkbox", { name: /alpha/ })).toBeTruthy())
    const submit = screen.getByRole("button", { name: t("createAndOpen") })
    expect(submit).toHaveProperty("disabled", true)
    await user.type(screen.getByLabelText(new RegExp(`^${t("taskName")}`)), "Fix login")
    await waitFor(() => expect(submit).toHaveProperty("disabled", false))
    await user.click(screen.getByRole("checkbox", { name: /alpha/ }))
    await user.click(screen.getByRole("checkbox", { name: /beta/ }))
    await waitFor(() => expect(submit).toHaveProperty("disabled", true))
    expect(api.createTask).not.toHaveBeenCalled()
  })

  it("reports a source root it cannot use instead of offering a form", async () => {
    const next = services()
    const api = { suggestRoot: vi.fn().mockResolvedValue({ ...suggestion(), repositories: [] }), createTask: vi.fn(), doneTask: vi.fn() }
    render(<CreateWorktreeDialog target={target as any} api={api as any} workspaces={next.workspaces as any} uiWorkspace={next.uiWorkspace as any} onCreated={vi.fn()} onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(t("notSourceRoot"))).toBeTruthy())
    expect(screen.queryByLabelText(t("taskName"))).toBeNull()
  })
})

describe("NewSessionWorktreeButton", () => {
  const workspace = { ...target, sessionIds: ["session-new"] }
  const useWorkspaces = <T,>(selector: (state: { items: Array<typeof workspace> }) => T) => selector({ items: [workspace] })

  it("opens the current workspace from a blank session", async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(<NewSessionWorktreeButton session={{ sessionId: "session-new" as any, blank: true }} useWorkspaces={useWorkspaces as any} onOpen={onOpen} />)

    await user.click(screen.getByRole("button", { name: t("newWorktreeSpace") }))
    expect(onOpen).toHaveBeenCalledWith(workspace)
  })

  it("stays hidden after the session is no longer blank", () => {
    render(<NewSessionWorktreeButton session={{ sessionId: "session-new" as any, blank: false }} useWorkspaces={useWorkspaces as any} onOpen={vi.fn()} />)
    expect(screen.queryByRole("button", { name: t("newWorktreeSpace") })).toBeNull()
  })

  it("stays hidden when the workspace is not a source root", () => {
    render(<NewSessionWorktreeButton session={{ sessionId: "session-new" as any, blank: true }} useWorkspaces={useWorkspaces as any} canCreate={() => false} onOpen={vi.fn()} />)
    expect(screen.queryByRole("button", { name: t("newWorktreeSpace") })).toBeNull()
  })

  it("names the icon in a hover hint, without waiting for the button to be clicked", async () => {
    const user = userEvent.setup()
    render(<NewSessionWorktreeButton session={{ sessionId: "session-new" as any, blank: true }} useWorkspaces={useWorkspaces as any} onOpen={vi.fn()} />)

    const button = screen.getByRole("button", { name: t("newWorktreeSpace") })
    expect(screen.queryByRole("tooltip")).toBeNull()

    await user.hover(button)
    const hint = await screen.findByRole("tooltip")
    expect(hint.textContent).toBe(t("newWorktreeSpace"))
    // The bubble escapes the composer, which clips and stacks over anything drawn inside
    // it: it is portalled to the document body rather than nested in the entry.
    expect(hint.parentElement).toBe(document.body)

    await user.unhover(button)
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull())

    // Keyboard focus raises it too: that is the only way the icon is named without a mouse.
    fireEvent.focus(button)
    expect((await screen.findByRole("tooltip")).textContent).toBe(t("newWorktreeSpace"))
  })
})

describe("WorktreesSettings", () => {
  function renderSettings(rows: any[], items: any[] = []) {
    const workspaces: any = { list: { getSnapshot: () => ({ items }), subscribe: () => () => {} }, create: vi.fn().mockResolvedValue({ workspaceId: "new", path: rows[1]?.path, title: "" }), rename: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) }
    const api: any = { list: vi.fn().mockResolvedValue({ repoPath: "/repo", worktrees: rows }), scan: vi.fn().mockResolvedValue([{ repoPath: "/repo", worktrees: rows }]), cachedScan: vi.fn().mockResolvedValue(null), status: vi.fn().mockImplementation((path: string) => Promise.resolve({ changedFiles: path.includes("dirty") ? 1 : 0, branchLine: "", output: "" })), remove: vi.fn().mockResolvedValue({}), prune: vi.fn().mockResolvedValue({}) }
    const uiWorkspace: any = { openWorkspace: vi.fn().mockResolvedValue(undefined) }
    render(<WorktreesSettings api={api} workspaces={workspaces} uiWorkspace={uiWorkspace} sessions={{ list: { getSnapshot: () => ({ byId: {} }) } } as any} />)
    // The page opens on tasks; these cases cover the repository list.
    fireEvent.click(screen.getByRole("button", { name: t("viewRepositories") }))
    return { api, workspaces, uiWorkspace }
  }

  it("groups linked worktrees without showing the main repository as a row", async () => {
    const next = renderSettings([{ path: "/repo", branch: "main", isMain: true, locked: false, prunable: false }, { path: "/repo.worktrees/feature", branch: "feature", isMain: false, locked: false, prunable: false }], [])
    await waitFor(() => expect(screen.getByText("feature")).toBeTruthy())
    expect(screen.queryByRole("button", { name: t("open") })).toBeNull()
    expect([...document.querySelectorAll(".dws-worktree-title")].some(node => node.textContent?.includes("main"))).toBe(false)
    expect(next.workspaces.create).not.toHaveBeenCalled()
  })

})

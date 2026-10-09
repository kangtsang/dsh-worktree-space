// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CreateWorktreeDialog } from "../src/client/components/CreateWorktreeDialog"
import { format, t } from "../src/client/lib/i18n"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const suggestion = {
  sourceRoot: "/repo",
  suggested: "/tasks",
  explicit: false,
  branchPrefix: "task/",
  repositories: [
    { name: "alpha", path: "/repo/alpha", branch: "main" },
    { name: "beta", path: "/repo/beta", branch: "develop" },
  ],
}
const created = {
  task: "fix-login",
  // The project layer is the source root's own directory name, so `/repo` files
  // its tasks under `/tasks/repo`.
  project: "repo",
  branch: "task/fix-login",
  path: "/tasks/repo/fix-login",
  tasksRoot: "/tasks",
  repositories: [
    { name: "alpha", path: "/tasks/repo/fix-login/alpha" },
    { name: "beta", path: "/tasks/repo/fix-login/beta" },
  ],
}

function setup(config?: any) {
  const api = {
    suggestRoot: vi.fn().mockResolvedValue(suggestion),
    createTask: vi.fn().mockResolvedValue(created),
    doneTask: vi.fn().mockResolvedValue({ task: "fix-login", path: created.path, repositories: [], containerRemoved: true, failed: false, warnings: [] }),
  }
  const workspaces = {
    create: vi.fn().mockResolvedValue({ workspaceId: "ws-task", path: created.path, title: "fix-login" }),
    rename: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  }
  const uiWorkspace = { openWorkspace: vi.fn().mockResolvedValue(undefined) }
  const onClose = vi.fn()
  const onCreated = vi.fn()
  const mount = () => render(<CreateWorktreeDialog target={{ path: "/repo", title: "App" }} api={api as any} workspaces={workspaces as any} uiWorkspace={uiWorkspace as any} config={config} onClose={onClose} onCreated={onCreated} />)
  return { api, workspaces, uiWorkspace, onClose, onCreated, mount }
}
// The label line carries the field's own explanation too, so the control is looked up
// by the name it starts with rather than by the whole label line.
const nameField = () => screen.getByRole("textbox", { name: new RegExp(`^${t("taskName")}`) })
const prefixField = () => screen.getByRole("textbox", { name: new RegExp(`^${t("branchPrefix")}`) }) as HTMLInputElement
const submit = () => screen.getByRole("button", { name: t("createAndOpen") })
const form = () => document.querySelector("form")!
const ready = () => screen.findByRole("textbox", { name: t("taskName") })
/** The repository field, found by the label the group is announced with. */
const repoGroup = () => screen.getByRole("group", { name: t("repositoriesLabel") })
/** What each repository card offers, read off the cards themselves. */
const offered = () => [...document.querySelectorAll(".dws-check-option .dws-checkbox")] as HTMLInputElement[]
/** The selection's count, as the live region beside the bulk actions reports it. */
const count = () => document.querySelector(".dws-check-count")!.textContent

afterEach(cleanup)

describe("native task create flow", () => {
  it("puts each explanation beside the name it explains, and leads the preview with the branch", async () => {
    const next = setup()
    next.mount()
    await ready()

    // The name's explanation sits with the name, not under the input.
    for (const [label, note] of [[t("taskName"), t("taskNameHint")], [t("containerLocation"), t("containerHint")]] as const) {
      const heading = screen.getByText(label).closest(".dws-field-row")
      expect(heading).not.toBeNull()
      expect(heading?.querySelector(".dws-field-note")?.textContent).toBe(note)
      // The control the explanation is about is in the same row, under the label.
      expect(heading?.querySelector("input.dws-input")).not.toBeNull()
      // The label line names the field and then explains it; its first span is the name,
      // so the control's accessible name comes from that and not from the explanation.
      expect(heading?.querySelector("label.dws-field-label > span:first-child")?.textContent).toBe(label)
    }

    // The group is named by the field alone; its count is a live region beside the bulk
    // actions, because a count inside the label would be re-announced on every click.
    // It reads "selected / total", so the total comes from what the dialog offered.
    expect(count()).toBe(format(t("repositoriesCountLabel"), { count: "2", total: String(offered().length) }))
    expect(offered().filter((box) => box.checked)).toHaveLength(2)
    expect([...repoGroup().querySelectorAll("button")].map((button) => button.textContent))
      .toEqual([t("selectAll"), t("selectNone")])

    // The preview shows what will be created and nothing that the form above
    // already says: the branch and the directory share its one line.
    const preview = document.querySelector(".dws-preview")!
    expect([...preview.querySelectorAll("dt")].map((node) => node.textContent)).toEqual([
      t("branch"),
      t("taskDirectoryLabel"),
    ])
    // The selected repositories are visible as checked boxes and counted beside the
    // field, so the preview does not list them again.
    expect(preview.textContent).not.toContain("alpha")
  })

  it("falls back to a plain name and a hint when nothing is selected", async () => {
    const next = setup()
    next.mount()
    const user = userEvent.setup()
    await ready()

    await user.click(screen.getByRole("checkbox", { name: /alpha/ }))
    await user.click(screen.getByRole("checkbox", { name: /beta/ }))

    // Two clicks clear the pre-selected pair, so the field is back to nothing
    // chosen: the count says so and the rule beside it comes back.
    expect(count()).toBe(format(t("repositoriesCountLabel"), { count: "0", total: String(offered().length) }))
    expect(repoGroup().querySelector(".dws-repo-picker-foot .dws-field-note")?.textContent).toBe(t("repositoriesHint"))
    expect(offered().every((box) => !box.checked)).toBe(true)
  })

  it("clears and restores the whole selection from the field's own actions", async () => {
    const next = setup()
    next.mount()
    const user = userEvent.setup()
    await ready()

    // The bulk actions are the pair the field carries, and they act on its cards only.
    await user.click(screen.getByRole("button", { name: t("selectNone") }))
    expect(offered().every((box) => !box.checked)).toBe(true)
    expect(submit()).toHaveProperty("disabled", true)

    await user.click(screen.getByRole("button", { name: t("selectAll") }))
    expect(offered().every((box) => box.checked)).toBe(true)
    await user.type(nameField(), "Fix login")
    fireEvent.submit(form())
    await waitFor(() => expect(next.api.createTask).toHaveBeenCalledWith(expect.objectContaining({ repos: ["/repo/alpha", "/repo/beta"] })))
  })

  it("sends the delivery policy the dialog shows, at its defaults until one is changed", async () => {
    const next = setup()
    next.mount()
    const user = userEvent.setup()
    await ready()

    // Four of the eight are the flow's own decisions; the other four appear only once "merge
    // by itself" is picked, and the line under the grid says where they went.
    expect(document.querySelectorAll("select.dws-select").length).toBe(4)
    expect(screen.queryByText(t("deliveryStrays"))).toBeNull()

    await user.type(nameField(), "Fix login")
    fireEvent.submit(form())
    await waitFor(() => {
      const calls = next.api.createTask.mock.calls
      const payload = calls[calls.length - 1]?.[0] as { delivery?: string }
      // The untouched defaults, as the policy record's own shape: everything a finish decides at
      // its own moment is absent - `merge.target`, `deleteBranch`, `conflicts` and `strays` -
      // because the finish that presses them is the user's, not this flow's.
      expect(JSON.parse(payload.delivery ?? "{}")).toEqual({
        deploy: { target: "none", mode: "on-request" },
        verification: "agent-then-human",
        merge: { mode: "ask" },
      })
    })
  })

  it("shows the four finish-decided choices once the merge is the flow's own", async () => {
    const next = setup()
    next.mount()
    const user = userEvent.setup()
    await ready()

    expect(document.querySelectorAll("select.dws-select").length).toBe(4)
    // "Merge by itself" is what makes a finish the flow's own, and that is what those four
    // decisions belong to - so they are on screen from that moment on.
    await user.selectOptions(screen.getByLabelText(t("deliveryMergeMode")), "auto")
    await user.selectOptions(screen.getByLabelText(t("deliveryVerification")), "agent")
    expect(document.querySelectorAll("select.dws-select").length).toBe(8)
    expect(screen.getByText(t("deliveryStrays"))).toBeTruthy()

    await user.type(nameField(), "Fix login")
    fireEvent.submit(form())
    await waitFor(() => {
      const calls = next.api.createTask.mock.calls
      const payload = calls[calls.length - 1]?.[0] as { delivery?: string }
      // Settled by this flow, so they are written down: the branch, the deletion, the conflict
      // mode and the leftovers all travel with the record now.
      expect(JSON.parse(payload.delivery ?? "{}")).toEqual({
        deploy: { target: "none", mode: "on-request" },
        verification: "agent",
        merge: { mode: "auto", deleteBranch: false },
        conflicts: "ask",
        strays: "archive",
      })
    })
  })

  it("shows the source root, a live normalized preview, and submits with Enter", async () => {
    const next = setup()
    next.mount()
    const user = userEvent.setup()
    await ready()
    expect(screen.getByText("App")).toBeTruthy()
    expect(screen.getByText("/repo")).toBeTruthy()
    expect(submit()).toHaveProperty("disabled", true)
    const input = nameField()
    expect(input.id).not.toBe("")
    // The label line is the field's name and then its explanation: the name it belongs to
    // is the label's first span, which is what the control is announced by.
    expect(document.querySelector(`label[for="${input.id}"] > span:first-child`)?.textContent).toBe(t("taskName"))
    await user.type(input, "Fix login")
    expect(screen.getByText("task/fix-login")).toBeTruthy()
    expect(screen.getByText(created.path)).toBeTruthy()
    expect(document.querySelector(".dws-preview")?.getAttribute("aria-live")).toBe("polite")
    await user.keyboard("{Enter}")
    await waitFor(() => expect(next.uiWorkspace.openWorkspace).toHaveBeenCalledExactlyOnceWith("ws-task"))
    // Paths, not names: the picker selected two repositories that sit directly in
    // the source root, and what identifies them is where they are. The Host cannot
    // rebuild a repository from a directory name when discovery reached it through
    // a level in between.
    // `delivery` rides along on every create; what is inside it is asserted field by field
    // in the test above, so here it only has to be the string the Host parses.
    expect(next.api.createTask).toHaveBeenCalledExactlyOnceWith({ sourceRoot: "/repo", task: "fix-login", tasksRoot: "/tasks", repos: ["/repo/alpha", "/repo/beta"], baseRef: undefined, branchPrefix: "task/", delivery: expect.any(String) })
    expect(next.workspaces.create).toHaveBeenCalledWith({ path: created.path })
    expect(next.workspaces.rename).toHaveBeenCalledWith("ws-task", "App/fix-login")
    expect(next.onCreated).toHaveBeenCalledWith(created.path)
    expect(next.onClose).toHaveBeenCalledTimes(1)
  })

  it("retains accessible radios and uses the named ref the user typed", async () => {
    const next = setup()
    next.mount()
    await ready()
    const head = screen.getByRole("radio", { name: new RegExp(t("baseHead")) })
    const named = screen.getByRole("radio", { name: new RegExp(t("baseNamed")) })
    expect(head).toHaveProperty("checked", true)
    expect(head.getAttribute("name")).toBe(named.getAttribute("name"))
    expect(head.id).not.toBe(named.id)
    fireEvent.click(named)
    fireEvent.change(screen.getByPlaceholderText(t("baseRefPlaceholder")), { target: { value: "origin/main" } })
    fireEvent.change(nameField(), { target: { value: "Fix login" } })
    fireEvent.submit(form())
    await waitFor(() => expect(next.api.createTask).toHaveBeenCalledWith(expect.objectContaining({ baseRef: "origin/main" })))
  })

  it("starts the branch on the host's prefix and sends the prefix the user chose", async () => {
    const next = setup()
    next.mount()
    await ready()

    // The prefix arrives with the suggestion, so the form and the host cannot
    // disagree about the branch a create would make.
    expect(prefixField()).toHaveProperty("value", "task/")
    fireEvent.change(prefixField(), { target: { value: "hotfix/" } })
    fireEvent.change(nameField(), { target: { value: "Fix login" } })
    expect(screen.getByText("hotfix/fix-login")).toBeTruthy()

    // Clearing the field asks for the host's default, not for no prefix at all.
    fireEvent.change(prefixField(), { target: { value: "  " } })
    expect(screen.getByText("task/fix-login")).toBeTruthy()

    fireEvent.change(prefixField(), { target: { value: "hotfix/" } })
    fireEvent.submit(form())
    await waitFor(() => expect(next.api.createTask).toHaveBeenCalledWith(expect.objectContaining({ branchPrefix: "hotfix/" })))
  })

  it("refuses a prefix Git would refuse, and says which rule it broke", async () => {
    const next = setup()
    next.mount()
    await ready()
    fireEvent.change(nameField(), { target: { value: "Fix login" } })
    fireEvent.change(prefixField(), { target: { value: "task /" } })
    expect(submit()).toHaveProperty("disabled", true)
    fireEvent.submit(form())
    expect(next.api.createTask).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toBe(t("invalidBranchPrefix"))
    expect([...screen.getAllByText(t("invalidBranchPrefix"))].some((node) => node.className.includes("dws-field-note-warning"))).toBe(true)
  })

  it("names the branch each repository's HEAD is on, in the repository view's own label", async () => {
    const next = setup()
    next.mount()
    await ready()

    const cards = [...document.querySelectorAll(".dws-check-option")]
    // One per repository, carrying the branch the host reported.
    expect(cards.map((card) => card.querySelector(".dws-branch-label .dws-branch-value")?.textContent)).toEqual(["main", "develop"])
    // The icon is the one the repository view's branch label renders.
    expect(document.querySelectorAll(".dws-check-option .dws-branch-label > svg")).toHaveLength(2)

    // A detached or unreadable HEAD has no branch to name, so its card shows none.
    cleanup()
    const detached = setup()
    detached.api.suggestRoot.mockResolvedValue({
      ...suggestion,
      repositories: [{ name: "alpha", path: "/repo/alpha" }, { name: "beta", path: "/repo/beta" }],
    })
    detached.mount()
    await ready()
    expect(document.querySelectorAll(".dws-check-option .dws-branch-label")).toHaveLength(0)
  })

  it("submits the paths of repositories that sit below the source root", async () => {
    // The shape that broke: discovery walks to maxDepth, so a Workspace registered
    // one level above its repositories reports `repos/alpha`. The dialog used to send
    // back the leaf name, and the Host could only rebuild it as `sourceRoot/alpha` -
    // so every repository it had just listed was refused on create.
    const nested = setup()
    nested.api.suggestRoot.mockResolvedValue({
      ...suggestion,
      repositories: [
        { name: "alpha", path: "/workspace/repos/alpha", branch: "main" },
        { name: "beta", path: "/workspace/repos/beta", branch: "main" },
      ],
    })
    nested.mount()
    const user = userEvent.setup()
    await ready()
    fireEvent.change(nameField(), { target: { value: "fix-login" } })
    fireEvent.submit(form())
    await waitFor(() => expect(nested.api.createTask).toHaveBeenCalledWith(expect.objectContaining({
      repos: ["/workspace/repos/alpha", "/workspace/repos/beta"],
    })))
  })

  // Each invalid input, and the one rule it breaks.
  it.each([
    ["", "fillTaskName"],
    ["   ", "fillTaskName"],
    ["!!!", "invalidNameEmpty"],
    // A name the normalizer can reduce to nothing must not quietly become the
    // placeholder `slugOf` falls back to: one rule decides both whether there is a
    // name and what it is, so nothing here is ever submitted as `task` by accident.
    ["タスク", "invalidNameEmpty"],
    [".hidden", "invalidNameLeadingDot"],
    ["a..b", "invalidNameConsecutiveDots"],
    ["task.", "invalidNameTrailingDot"],
    ["task.lock", "invalidNameLockSuffix"],
  ] as const)("rejects invalid name %j, including direct form submission", async (name, reason) => {
    const next = setup()
    next.mount()
    await ready()
    fireEvent.change(nameField(), { target: { value: name } })
    expect(submit()).toHaveProperty("disabled", true)
    fireEvent.submit(form())
    expect(next.api.createTask).not.toHaveBeenCalled()
    expect(screen.queryByText(/^task\//)).toBeNull()
    expect(screen.getByRole("alert").textContent).toBe(t(reason))
    // A broken name is called out in the warning colour, not in the hint's grey.
    // The same sentence is also in the banner above the form, which is why this
    // asks whether any of them carries the warning class.
    if (reason !== "fillTaskName") {
      expect([...screen.getAllByText(t(reason))].some((node) => node.className.includes("dws-field-note-warning"))).toBe(true)
    }
  })

  it("shows a loading skeleton, disables creation, and retries a failed initial read", async () => {
    const next = setup()
    const read = deferred<typeof suggestion>()
    next.api.suggestRoot.mockReturnValueOnce(read.promise)
    next.mount()
    expect(screen.getByRole("status").textContent).toContain(t("loadingSourceRoot"))
    expect(document.querySelectorAll(".dws-dialog-loading > span[aria-hidden]")).toHaveLength(3)
    expect(submit()).toHaveProperty("disabled", true)
    fireEvent.submit(form())
    expect(next.api.createTask).not.toHaveBeenCalled()
    await act(async () => { read.reject(new Error("Connection interrupted")) })
    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.getByRole("alert").textContent).toContain("Connection interrupted")
    expect(submit()).toHaveProperty("disabled", true)
    fireEvent.click(screen.getByRole("button", { name: t("retry") }))
    await ready()
    expect(next.api.suggestRoot).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("ignores a late initial read after unmount", async () => {
    const next = setup()
    const read = deferred<typeof suggestion>()
    next.api.suggestRoot.mockReturnValueOnce(read.promise)
    const view = next.mount()
    view.unmount()
    await act(async () => { read.resolve(suggestion) })
    expect(next.api.createTask).not.toHaveBeenCalled()
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("blocks duplicate submits, close button, cancel, Escape and outside dismissal while busy", async () => {
    const next = setup()
    const pending = deferred<typeof created>()
    next.api.createTask.mockReturnValueOnce(pending.promise)
    next.mount()
    await ready()
    const user = userEvent.setup()
    fireEvent.change(nameField(), { target: { value: "Fix login" } })
    act(() => { fireEvent.submit(form()); fireEvent.submit(form()) })
    expect(next.api.createTask).toHaveBeenCalledTimes(1)
    expect(nameField()).toHaveProperty("disabled", true)
    expect(screen.getByRole("button", { name: t("close") })).toHaveProperty("disabled", true)
    expect(screen.getByRole("button", { name: t("cancel") })).toHaveProperty("disabled", true)
    await user.click(screen.getByRole("button", { name: t("close") }))
    await user.click(screen.getByRole("button", { name: t("cancel") }))
    await user.keyboard("{Escape}")
    fireEvent.pointerDown(document.querySelector(".dws-dialog-overlay")!)
    expect(next.onClose).not.toHaveBeenCalled()
    await act(async () => { pending.resolve(created) })
    expect(next.onClose).toHaveBeenCalledTimes(1)
  })

  it("rolls the whole create back when registration fails, leaving nothing to retry", async () => {
    const next = setup()
    next.workspaces.create.mockRejectedValue(new Error("Workspace service unavailable"))
    next.mount()
    await ready()
    fireEvent.change(nameField(), { target: { value: "Fix login" } })
    fireEvent.submit(form())
    // A create is one thing or the other: the task space and its branch go back with
    // the registration that failed, so there is no half-made task to offer a retry on.
    await waitFor(() => expect(next.api.doneTask).toHaveBeenCalledWith({
      task: "fix-login",
      project: "repo",
      tasksRoot: "/tasks",
      merge: false,
      deleteBranch: true,
      force: true,
      // The Host cannot see the dialog's registration failing, so the reason has
      // to travel with the request or the log shows a task space and a branch
      // deleted for no stated reason.
      cause: expect.stringContaining("Workspace"),
    }))
    expect(next.workspaces.delete).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain(
      format(t("createRolledBack"), { error: "Workspace service unavailable" }),
    )
    // The dialog is back to its normal state: the fields are live again and the user
    // can simply submit the same name a second time.
    expect(nameField()).toHaveProperty("disabled", false)
    expect(screen.getByRole("button", { name: t("createAndOpen") })).toHaveProperty("disabled", false)
    expect(next.onClose).not.toHaveBeenCalled()
    expect(next.uiWorkspace.openWorkspace).not.toHaveBeenCalled()
  })

  it("names what the rollback could not remove when it fails partway", async () => {
    const next = setup()
    next.workspaces.create.mockRejectedValue(new Error("Workspace service unavailable"))
    next.api.doneTask.mockRejectedValue(new Error("Task is locked"))
    next.mount()
    await ready()
    fireEvent.change(nameField(), { target: { value: "Fix login" } })
    fireEvent.submit(form())
    const alert = await screen.findByRole("alert")
    await waitFor(() => expect(alert.textContent).toContain(
      format(t("rollbackIncomplete"), {
        error: "Workspace service unavailable",
        undo: "Task is locked",
        path: created.path,
        branch: "task/fix-login",
      }),
    ))
    // Both the original failure and the one that stopped the rollback, and the exact
    // path and branch still on disk - the three things manual cleanup needs.
    expect(alert.textContent).toContain("Workspace service unavailable")
    expect(alert.textContent).toContain("Task is locked")
    expect(alert.textContent).toContain(created.path)
    expect(alert.textContent).toContain("task/fix-login")
    expect(next.onClose).not.toHaveBeenCalled()
  })

  it("removes a partially registered Workspace when the rename fails, and rolls the task back too", async () => {
    const next = setup()
    next.workspaces.rename.mockRejectedValue(new Error("Rename unavailable"))
    next.mount()
    await ready()
    fireEvent.change(nameField(), { target: { value: "Fix login" } })
    fireEvent.submit(form())
    // The row exists but is not usable, so it is deleted rather than left pointing at
    // a container that is about to go.
    await waitFor(() => expect(next.workspaces.delete).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(next.api.doneTask).toHaveBeenCalledWith({
      task: "fix-login",
      project: "repo",
      tasksRoot: "/tasks",
      merge: false,
      deleteBranch: true,
      force: true,
      // The Host cannot see the dialog's registration failing, so the reason has
      // to travel with the request or the log shows a task space and a branch
      // deleted for no stated reason.
      cause: expect.stringContaining("Workspace"),
    }))
    expect(next.api.createTask).toHaveBeenCalledTimes(1)
    expect(next.onClose).not.toHaveBeenCalled()
  })
})

describe("the default branch prefix this dialog may record", () => {
  /** The plugin configuration form, as the shell serves it to the dialog. */
  function configForm(prefix: string, accepted = true) {
    let value: unknown = { defaultBranchPrefix: prefix, panelEntry: "hide" }
    const listeners = new Set<() => void>()
    return {
      form: {
        getSnapshot: () => ({ status: "ready", value }),
        subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
        set: vi.fn(async (field: string, next: unknown) => {
          if (!accepted) return false
          value = { ...(value as Record<string, unknown>), [field]: next }
          listeners.forEach((listener) => listener())
          return true
        }),
      },
      read: () => value,
    }
  }
  const remember = () => screen.queryByRole("checkbox", { name: t("rememberPrefix") }) as HTMLInputElement | null

  /**
   * A form whose writes are never answered.
   *
   * `ConfigFormController.mutate` propagates what the transport threw to the caller,
   * so `form.set` rejects as well as resolving `false` — a connection dropped mid
   * round trip rejects every write still queued on it. `false` is a verdict and a
   * rejection is the absence of one, and neither is a reason to undo a task space.
   */
  function unreachableForm(prefix: string) {
    return {
      getSnapshot: () => ({ status: "ready", value: { defaultBranchPrefix: prefix } }),
      subscribe: () => () => {},
      set: vi.fn(async () => { throw new Error("connection closed") }),
    }
  }

  it("offers no checkbox at all when the shell serves no configuration form", async () => {
    // Nothing to save a new default into, so there is nothing to offer: ticking would
    // reach `config?.set` on nothing, come back `undefined` and report the setting as
    // unsaved — a refusal the user never asked for and cannot do anything about.
    const next = setup()
    next.mount()
    await ready()

    fireEvent.change(prefixField(), { target: { value: "feat/" } })
    expect(remember()).toBeNull()
  })

  it("offers the checkbox only once the typed prefix is one worth keeping", async () => {
    const { form: form0 } = configForm("task/")
    const next = setup(form0)
    next.mount()
    await ready()

    // Prefilled from the Host's own default: nothing to save yet, so no offer.
    expect(prefixField().value).toBe("task/")
    expect(remember()).toBeNull()

    fireEvent.change(prefixField(), { target: { value: "task/" } })
    expect(remember()).toBeNull()
    fireEvent.change(prefixField(), { target: { value: "wt/" } })
    expect(remember()).not.toBeNull()
    // An unusable prefix is refused by the field, so it cannot be promised either.
    fireEvent.change(prefixField(), { target: { value: "wt /" } })
    expect(remember()).toBeNull()
    fireEvent.change(prefixField(), { target: { value: "" } })
    expect(remember()).toBeNull()
  })

  it("starts the field from the configured prefix and writes a new one only on create", async () => {
    const { form: form0, read } = configForm("wt/")
    const next = setup(form0)
    next.mount()
    await ready()
    // The configured default wins over whatever the Host would have suggested.
    expect(prefixField().value).toBe("wt/")

    fireEvent.change(prefixField(), { target: { value: "feat/" } })
    fireEvent.click(remember()!)
    // Ticking alone promises; it does not write.
    expect(form0.set).not.toHaveBeenCalled()

    fireEvent.change(nameField(), { target: { value: "Fix login" } })
    fireEvent.submit(form())
    await waitFor(() => expect(next.onClose).toHaveBeenCalledTimes(1))
    expect(next.api.createTask).toHaveBeenCalledWith(expect.objectContaining({ branchPrefix: "feat/" }))
    expect(form0.set).toHaveBeenCalledWith("defaultBranchPrefix", "feat/")
    expect(read()).toMatchObject({ defaultBranchPrefix: "feat/" })
  })

  it("warns with the configured prefix when the field is left empty", async () => {
    const { form } = configForm("wt/")
    const next = setup(form)
    next.mount()
    await ready()

    // The field holds the configured default, so clearing it is what asks for that default
    // — and the sentence beside it names the prefix that would then be used. The copy is in
    // the document twice (once for the eye, once for a screen reader), so the label's own
    // span is the one read here.
    const note = () => document.querySelector(`label[for="${prefixField().id}"] > .dws-field-note`)?.textContent
    fireEvent.change(prefixField(), { target: { value: "" } })
    expect(note()).toBe(format(t("branchPrefixHint"), { prefix: "wt/" }))

    fireEvent.change(prefixField(), { target: { value: "feat/" } })
    expect(note()).toBe(format(t("branchPrefixHint"), { prefix: "feat/" }))
  })

  it("creates the task space even when the Host refuses the new default", async () => {    const { form: form0 } = configForm("task/", false)
    const next = setup(form0)
    next.mount()
    await ready()
    fireEvent.change(prefixField(), { target: { value: "feat/" } })
    fireEvent.click(remember()!)
    fireEvent.change(nameField(), { target: { value: "Fix login" } })
    fireEvent.submit(form())

    // A refused preference may not undo the space that already exists.
    await waitFor(() => expect(next.onCreated).toHaveBeenCalledExactlyOnceWith(created.path))
    expect(next.api.createTask).toHaveBeenCalledTimes(1)
    expect(next.workspaces.create).toHaveBeenCalledTimes(1)
  })

  it("creates the task space even when the form never answers the write at all", async () => {
    // The same outcome, reached the other way: a refusal resolves `false`, while a
    // dropped connection rejects. The rejection used to escape into the catch around
    // the whole create, which cannot tell a preference that never saved from a
    // registration that failed - and `created` was already assigned by then, so it
    // took the task space, its worktrees and its branch back down with it. A
    // transport hiccup cost a task that had actually succeeded.
    const next = setup(unreachableForm("task/"))
    next.mount()
    await ready()
    fireEvent.change(prefixField(), { target: { value: "feat/" } })
    fireEvent.click(remember()!)
    fireEvent.change(nameField(), { target: { value: "Fix login" } })
    fireEvent.submit(form())

    await waitFor(() => expect(next.onCreated).toHaveBeenCalledExactlyOnceWith(created.path))
    expect(next.api.createTask).toHaveBeenCalledTimes(1)
    expect(next.workspaces.create).toHaveBeenCalledTimes(1)
    // Nothing undone: the rollback is what a failed registration is for, and this was
    // not one.
    expect(next.api.doneTask).not.toHaveBeenCalled()
    expect(next.workspaces.delete).not.toHaveBeenCalled()
    // And it is reported the way a refusal is, rather than as a create that failed.
    expect(screen.getByRole("alert").textContent).toBe(t("branchPrefixNotSaved"))
  })
})

describe("the default task space location this dialog may record", () => {
  /**
   * The plugin configuration form, as the shell serves it to the dialog.
   *
   * `refuse` names the one field the Host turns down, which is how the order the two
   * location settings are written in is checked: the strategy is what reads the
   * directory, so a refused directory must never be paired with a strategy naming it.
   */
  function configForm(refuse: string | null = null) {
    let value: unknown = { defaultBranchPrefix: "task/", tasksRootStrategy: "default", tasksRootDirectory: "" }
    const listeners = new Set<() => void>()
    return {
      form: {
        getSnapshot: () => ({ status: "ready", value }),
        subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
        set: vi.fn(async (field: string, next: unknown) => {
          if (field === refuse) return false
          value = { ...(value as Record<string, unknown>), [field]: next }
          listeners.forEach((listener) => listener())
          return true
        }),
      },
      read: () => value,
    }
  }
  const rememberRoot = () => screen.queryByRole("checkbox", { name: t("rememberTasksRoot") }) as HTMLInputElement | null
  // The label line carries the field's own explanation, so the control is looked up by
  // the name it starts with - the same way the name and prefix fields are.
  const containerField = () => screen.getByRole("textbox", { name: new RegExp(`^${t("containerLocation")}`) }) as HTMLInputElement

  /** A form whose writes are never answered; see the same helper in the suite above. */
  const unreachableForm = () => ({
    getSnapshot: () => ({ status: "ready", value: { tasksRootStrategy: "default", tasksRootDirectory: "" } }),
    subscribe: () => () => {},
    set: vi.fn(async () => { throw new Error("connection closed") }),
  })

  it("offers no checkbox at all when the shell serves no configuration form", async () => {
    // The same offer as the prefix above, on the same terms: there is nothing to write
    // the location into, so a moved field cannot promise to become the next default.
    const next = setup()
    next.mount()
    await ready()
    expect(containerField().value).toBe("/tasks")

    fireEvent.change(containerField(), { target: { value: "E:\\worktree-space" } })
    expect(rememberRoot()).toBeNull()
  })

  it("offers the checkbox only once the typed location is one worth keeping", async () => {
    const next = setup(configForm().form)
    next.mount()
    await ready()

    // Prefilled from the Host's own suggestion: nothing to promise yet, so no offer.
    expect(containerField().value).toBe("/tasks")
    expect(rememberRoot()).toBeNull()

    fireEvent.change(containerField(), { target: { value: "/tasks" } })
    expect(rememberRoot()).toBeNull()
    fireEvent.change(containerField(), { target: { value: "E:\\worktree-space" } })
    expect(rememberRoot()).not.toBeNull()
    // The sentence beside the box is the setting's own, because it is the same
    // trade-off the user is deciding - a directory that shares no common ancestor
    // with the project makes the handoff session ask for authorisation by hand.
    expect(screen.getByText(t("tasksRootStrategyHint"))).toBeTruthy()
    // A cleared field names no location at all, so it cannot be promised either.
    fireEvent.change(containerField(), { target: { value: "   " } })
    expect(rememberRoot()).toBeNull()
  })

  it("writes both settings only on create, and creates the space it was asked for", async () => {
    const { form: form0, read } = configForm()
    const next = setup(form0)
    next.mount()
    await ready()

    fireEvent.change(containerField(), { target: { value: "E:\\worktree-space" } })
    fireEvent.click(rememberRoot()!)
    // Ticking alone promises; it does not write.
    expect(form0.set).not.toHaveBeenCalled()

    fireEvent.change(nameField(), { target: { value: "Fix login" } })
    fireEvent.submit(form())
    await waitFor(() => expect(next.onClose).toHaveBeenCalledTimes(1))
    expect(next.api.createTask).toHaveBeenCalledWith(expect.objectContaining({ tasksRoot: "E:\\worktree-space" }))
    // Directory first, strategy second: a directory the Host refuses can then never
    // be paired with the strategy that would read it.
    expect(form0.set.mock.calls).toEqual([["tasksRootDirectory", "E:\\worktree-space"], ["tasksRootStrategy", "custom"]])
    expect(read()).toMatchObject({ tasksRootStrategy: "custom", tasksRootDirectory: "E:\\worktree-space" })
  })

  it("leaves the strategy alone when the Host refuses the directory", async () => {
    const { form: form0, read } = configForm("tasksRootDirectory")
    const next = setup(form0)
    next.mount()
    await ready()

    fireEvent.change(containerField(), { target: { value: "E:\\worktree-space" } })
    fireEvent.click(rememberRoot()!)
    fireEvent.change(nameField(), { target: { value: "Fix login" } })
    fireEvent.submit(form())

    // The task space still exists: a refused preference may not undo it.
    await waitFor(() => expect(next.onCreated).toHaveBeenCalledExactlyOnceWith(created.path))
    expect(next.api.createTask).toHaveBeenCalledTimes(1)
    expect(form0.set).toHaveBeenCalledExactlyOnceWith("tasksRootDirectory", "E:\\worktree-space")
    expect(read()).toMatchObject({ tasksRootStrategy: "default", tasksRootDirectory: "" })
    expect(screen.getByRole("alert").textContent).toBe(t("tasksRootNotSaved"))
  })

  it("reports a refused strategy the same way, after the directory was accepted", async () => {
    const { form: form0, read } = configForm("tasksRootStrategy")
    const next = setup(form0)
    next.mount()
    await ready()

    fireEvent.change(containerField(), { target: { value: "E:\\worktree-space" } })
    fireEvent.click(rememberRoot()!)
    fireEvent.change(nameField(), { target: { value: "Fix login" } })
    fireEvent.submit(form())

    await waitFor(() => expect(next.onCreated).toHaveBeenCalledExactlyOnceWith(created.path))
    // The directory landed but nothing reads it now, which is the inert half of the
    // pair - the strategy is still the derived default, so the setting is not in force.
    expect(read()).toMatchObject({ tasksRootStrategy: "default", tasksRootDirectory: "E:\\worktree-space" })
    expect(screen.getByRole("alert").textContent).toBe(t("tasksRootNotSaved"))
  })

  it("creates the task space even when the form never answers the write at all", async () => {
    // Both writes go through the same guard, so the second one is covered by the same
    // reasoning: the directory write rejects, the strategy write is never reached, and
    // neither rejection may reach the catch that rolls a create back.
    const next = setup(unreachableForm())
    next.mount()
    await ready()
    fireEvent.change(containerField(), { target: { value: "E:\\worktree-space" } })
    fireEvent.click(rememberRoot()!)
    fireEvent.change(nameField(), { target: { value: "Fix login" } })
    fireEvent.submit(form())

    await waitFor(() => expect(next.onCreated).toHaveBeenCalledExactlyOnceWith(created.path))
    expect(next.workspaces.create).toHaveBeenCalledTimes(1)
    expect(next.api.doneTask).not.toHaveBeenCalled()
    // The strategy is not paired with a directory that never landed, and the pair is
    // reported as unsaved the way a refusal is.
    expect(screen.getByRole("alert").textContent).toBe(t("tasksRootNotSaved"))
  })
})

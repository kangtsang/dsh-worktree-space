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
    { name: "alpha", path: "/repo/alpha" },
    { name: "beta", path: "/repo/beta" },
  ],
}
const created = {
  task: "fix-login",
  branch: "task/fix-login",
  path: "/tasks/fix-login",
  tasksRoot: "/tasks",
  repositories: [
    { name: "alpha", path: "/tasks/fix-login/alpha" },
    { name: "beta", path: "/tasks/fix-login/beta" },
  ],
  warnings: [],
}

function setup() {
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
  const mount = () => render(<CreateWorktreeDialog target={{ path: "/repo", title: "App" }} api={api as any} workspaces={workspaces as any} uiWorkspace={uiWorkspace as any} onClose={onClose} onCreated={onCreated} />)
  return { api, workspaces, uiWorkspace, onClose, onCreated, mount }
}
const nameField = () => screen.getByRole("textbox", { name: t("taskName") })
const prefixField = () => screen.getByRole("textbox", { name: t("branchPrefix") })
const submit = () => screen.getByRole("button", { name: t("createAndOpen") })
const form = () => document.querySelector("form")!
const ready = () => screen.findByRole("textbox", { name: t("taskName") })

afterEach(cleanup)

describe("native task create flow", () => {
  it("puts each explanation beside the name it explains, and leads the preview with the branch", async () => {
    const next = setup()
    next.mount()
    await ready()

    // The name's explanation sits with the name, not under the input.
    for (const [label, note] of [[t("taskName"), t("taskNameHint")], [t("containerLocation"), t("containerHint")]] as const) {
      const heading = screen.getByText(label).closest(".dws-field-heading")
      expect(heading).not.toBeNull()
      expect(heading?.querySelector(".dws-field-note")?.textContent).toBe(note)
      // The control the explanation is about follows the heading.
      expect(heading?.nextElementSibling?.tagName).toBe("INPUT")
    }

    // The count is part of the group's name, so nothing repeats it beside it. It
    // reads "selected / total", so the total comes from what the dialog offered.
    const offered = document.querySelectorAll(".dws-check-option").length
    const counted = format(t("repositoriesCountLabel"), { count: "2", total: String(offered) })
    const group = screen.getByRole("group", { name: counted })
    expect(group.querySelector("legend .dws-field-label")?.textContent).toBe(counted)
    expect(group.querySelector("legend .dws-field-note")).toBeNull()

    // The preview shows what will be created and nothing that the form above
    // already says: the branch and the directory share its one line.
    const preview = document.querySelector(".dws-preview")!
    expect([...preview.querySelectorAll("dt")].map((node) => node.textContent)).toEqual([
      t("branch"),
      t("taskDirectoryLabel"),
    ])
    // The selected repositories are visible as checked boxes and counted in the
    // group's name, so the preview does not list them again.
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
    const offered = document.querySelectorAll(".dws-check-option").length
    const cleared = format(t("repositoriesCountLabel"), { count: "0", total: String(offered) })
    const group = screen.getByRole("group", { name: cleared })
    expect(group.querySelector("legend .dws-field-label")?.textContent).toBe(cleared)
    expect(group.querySelector("legend .dws-field-note")?.textContent).toBe(t("repositoriesHint"))
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
    expect(document.querySelector(`label[for="${input.id}"]`)?.textContent).toBe(t("taskName"))
    await user.type(input, "Fix login")
    expect(screen.getByText("task/fix-login")).toBeTruthy()
    expect(screen.getByText(created.path)).toBeTruthy()
    expect(document.querySelector(".dws-preview")?.getAttribute("aria-live")).toBe("polite")
    await user.keyboard("{Enter}")
    await waitFor(() => expect(next.uiWorkspace.openWorkspace).toHaveBeenCalledExactlyOnceWith("ws-task"))
    expect(next.api.createTask).toHaveBeenCalledExactlyOnceWith({ sourceRoot: "/repo", task: "fix-login", tasksRoot: "/tasks", repos: ["alpha", "beta"], baseRef: undefined, branchPrefix: "task/" })
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

  // Each invalid input, and the one rule it breaks.
  it.each([
    ["", "fillTaskName"],
    ["   ", "fillTaskName"],
    ["!!!", "invalidNameEmpty"],
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

  it("retries registration without re-creating the task and guards recovery while busy", async () => {
    const next = setup()
    const registration = deferred<{ workspaceId: string; path: string; title: string }>()
    next.workspaces.create.mockRejectedValueOnce(new Error("Workspace service unavailable")).mockReturnValueOnce(registration.promise)
    next.mount()
    await ready()
    fireEvent.change(nameField(), { target: { value: "Fix login" } })
    fireEvent.submit(form())
    const retry = await screen.findByRole("button", { name: t("retryRegister") })
    expect(screen.getByRole("alert").textContent).toContain(t("registerFailed"))
    expect(nameField()).toHaveProperty("disabled", true)
    expect(screen.getByText(created.path)).toBeTruthy()
    expect(screen.queryByRole("button", { name: t("createAndOpen") })).toBeNull()
    // A programmatic submit must not escape the recovery-only flow.
    fireEvent.submit(form())
    act(() => { fireEvent.click(retry); fireEvent.click(retry) })
    expect(next.workspaces.create).toHaveBeenCalledTimes(2)
    expect(next.api.createTask).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: t("cleanupTask") })).toHaveProperty("disabled", true)
    expect(screen.getByRole("button", { name: t("close") })).toHaveProperty("disabled", true)
    await act(async () => { registration.resolve({ workspaceId: "ws-retry", path: created.path, title: "fix-login" }) })
    expect(next.workspaces.rename).toHaveBeenCalledWith("ws-retry", "App/fix-login")
    expect(next.uiWorkspace.openWorkspace).toHaveBeenCalledExactlyOnceWith("ws-retry")
    expect(next.api.createTask).toHaveBeenCalledTimes(1)
  })

  it("preserves cleanup recovery after failure and closes only after finishing the task succeeds", async () => {
    const next = setup()
    next.workspaces.create.mockRejectedValue(new Error("Registration unavailable"))
    next.api.doneTask.mockRejectedValueOnce(new Error("Task is locked"))
    next.mount()
    await ready()
    fireEvent.change(nameField(), { target: { value: "Fix login" } })
    fireEvent.submit(form())
    fireEvent.click(await screen.findByRole("button", { name: t("cleanupTask") }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Task is locked"))
    expect(next.onClose).not.toHaveBeenCalled()
    expect(screen.getByText(created.path)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: t("cleanupTask") }))
    await waitFor(() => expect(next.onClose).toHaveBeenCalledTimes(1))
    expect(next.api.doneTask).toHaveBeenCalledWith({ task: "fix-login", tasksRoot: "/tasks" })
    expect(next.api.createTask).toHaveBeenCalledTimes(1)
    expect(next.uiWorkspace.openWorkspace).not.toHaveBeenCalled()
  })

  it("rolls back partial Workspace registration on both initial failure and retry failure", async () => {
    const next = setup()
    next.workspaces.rename.mockRejectedValue(new Error("Rename unavailable"))
    next.mount()
    await ready()
    fireEvent.change(nameField(), { target: { value: "Fix login" } })
    fireEvent.submit(form())
    fireEvent.click(await screen.findByRole("button", { name: t("retryRegister") }))
    await waitFor(() => expect(next.workspaces.delete).toHaveBeenCalledTimes(2))
    expect(next.api.createTask).toHaveBeenCalledTimes(1)
    expect(next.api.doneTask).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: t("retryRegister") })).toBeTruthy()
    expect(next.onClose).not.toHaveBeenCalled()
  })
})

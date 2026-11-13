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

/** What `task.branches` answers for the two repositories the fixture holds. */
const branchLists = () => ({
  "/repo/alpha": { branches: ["main", "develop", "release/2.0"], truncated: 0 },
  "/repo/beta": { branches: ["main", "hotfix"], truncated: 0 },
})

function setup(config?: any) {
  const api = {
    suggestRoot: vi.fn().mockResolvedValue(suggestion),
    // Read as soon as the dialog opens, so every case needs the batch to answer.
    branches: vi.fn().mockImplementation(() => Promise.resolve(branchLists())),
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

    // Every field carries a short explanation on its own name's line, right-aligned against
    // it, and the control below starts the block. The rule is the same for all of them, so
    // the same field never lays out two ways depending on how long its wording happens to
    // be - the long version, where there is one, goes behind the `?` beside the name.
    for (const [label, note] of [
      [t("taskName"), t("taskNameHint")],
      [t("branchPrefix"), format(t("branchPrefixHint"), { prefix: "task/" })],
      [t("containerLocation"), t("containerLocationHint")],
    ] as const) {
      const heading = screen.getByText(label).closest(".dws-field-row")
      expect(heading).not.toBeNull()
      expect(heading?.querySelector("label.dws-field-label > .dws-field-note")?.textContent).toBe(note)
      // The control the explanation is about is in the same row, under the label.
      expect(heading?.querySelector("input.dws-input")).not.toBeNull()
      // The label line names the field and then explains it; its first span is the name,
      // so the control's accessible name comes from that and not from the explanation.
      expect(heading?.querySelector("label.dws-field-label > span:first-child")?.textContent).toBe(label)
    }

    // The container root's full sentence is too long for that slot, so it is behind the `?`
    // beside the name - while the short one stays on the line. Both, not either.
    const containerRow = screen.getByText(t("containerLocation")).closest(".dws-field-row")
    expect(containerRow?.querySelector(".dws-field-hint")).not.toBeNull()
    expect(containerRow?.querySelector("label.dws-field-label > .dws-field-note")?.textContent).toBe(t("containerLocationHint"))

    // The acceptance menu carries a field name of its own now that it has three answers,
    // and its explanation rides on that name's line, pushed right, the same way every named
    // field's note sits beside its name. Whichever kind is chosen, the menu is there and so
    // is the note: someone deciding between the three is exactly who needs it.
    const kindSelect = screen.getByRole("combobox", { name: t("deliveryAcceptanceKind") })
    const deployRow = kindSelect.closest(".dws-field-row")
    const deployLabel = deployRow?.querySelector("label.dws-field-label")
    expect(deployLabel).not.toBeNull()
    // The chosen answer's cost, in one line, beside the field's name - and it changes with
    // the menu rather than being a caption for it.
    const costNote = deployRow?.querySelector(`label.dws-field-label > .dws-field-note`)
    expect(costNote?.textContent).toBe(t("deliveryAcceptanceNoneHint"))
    // And nothing repeats it below.
    expect([...(deployRow?.querySelectorAll("p.dws-field-note") ?? [])]).toHaveLength(0)

    // The group is named by the field alone; its count is a live region beside the bulk
    // actions, because a count inside the label would be re-announced on every click.
    // It reads "selected / total", so the total comes from what the dialog offered.
    expect(count()).toBe(format(t("repositoriesCountLabel"), { count: "2", total: String(offered().length) }))
    expect(offered().filter((box) => box.checked)).toHaveLength(2)
    // The bulk actions are the field's own; each card also has a branch button of
    // its own, which is not one of them. They sit on the band under the cards, beside
    // the name of the field that follows.
    expect([...document.querySelectorAll(".dws-repo-actions button")].map((button) => button.textContent))
      .toEqual([t("selectAll"), t("selectNone")])
    expect(repoGroup().querySelectorAll(".dws-check-option .dws-branch-button")).toHaveLength(2)

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

  it("offers the one delivery decision, and sends it flat at its default", async () => {
    const next = setup()
    next.mount()
    const user = userEvent.setup()
    await ready()

    // A menu, not a tick: there are three answers now, and two of them record an acceptance
    // the finish waits on - a single tick could not say which. No other delivery control
    // stands here - the seven that used to were defaults recorded for decisions a finish
    // takes. What it does not show, it does not send.
    const kindSelect = screen.getByRole("combobox", { name: t("deliveryAcceptanceKind") }) as HTMLSelectElement
    expect(kindSelect.value).toBe("none")
    // Its three answers are exactly the policy's three, in the order the menu lists them.
    expect([...kindSelect.options].map((option) => option.value)).toEqual(["none", "smoke", "deploy"])
    // The menu is NOT one of the repository cards. The selection count and the bulk actions
    // select on the repository cards' own class, and this field must not be swept up by them.
    expect(offered()).toHaveLength(suggestion.repositories.length)

    await user.type(nameField(), "Fix login")
    fireEvent.submit(form())
    await waitFor(() => {
      const calls = next.api.createTask.mock.calls
      const payload = calls[calls.length - 1]?.[0] as { acceptanceKind?: string; delivery?: string }
      // Sent flat rather than as a policy blob, and sent even at the default, so what the
      // user chose is what the Host records.
      expect(payload.acceptanceKind).toBe("none")
      expect(payload.delivery).toBeUndefined()
    })
  })

  it("sends the acceptance kind the dialog shows once it is changed", async () => {
    const next = setup()
    next.mount()
    const user = userEvent.setup()
    await ready()

    // The one choice this dialog records, so it travels alone: no merge mode, no
    // verification, no conflict or stray policy alongside it any more.
    await user.selectOptions(screen.getByRole("combobox", { name: t("deliveryAcceptanceKind") }), "deploy")
    await user.type(nameField(), "Fix login")
    fireEvent.submit(form())
    await waitFor(() => {
      const calls = next.api.createTask.mock.calls
      const payload = calls[calls.length - 1]?.[0] as { acceptanceKind?: string; delivery?: string }
      expect(payload.acceptanceKind).toBe("deploy")
      expect(payload.delivery).toBeUndefined()
    })
  })

  it("sends the smoke-only kind, which owes no environment", async () => {
    const next = setup()
    next.mount()
    const user = userEvent.setup()
    await ready()

    // The third answer is the whole reason the field lost its boolean shape: a task whose
    // acceptance is a test suite and nothing else. It still wants an entry script, because
    // that is what records the verdict, so the script field appears for it too.
    expect(screen.queryByRole("textbox", { name: t("deployScript") })).toBeNull()
    await user.selectOptions(screen.getByRole("combobox", { name: t("deliveryAcceptanceKind") }), "smoke")
    expect(screen.getByRole("textbox", { name: t("deployScript") })).not.toBeNull()
    // And the cost line beside the field says which debt this answer records - scoped to
    // the acceptance field's own row, since every named field carries a note of its own.
    const kindRow = screen.getByRole("combobox", { name: t("deliveryAcceptanceKind") }).closest(".dws-field-row")
    expect(kindRow?.querySelector("label.dws-field-label > .dws-field-note")?.textContent).toBe(t("deliveryAcceptanceSmokeHint"))
    await user.type(nameField(), "Fix login")
    fireEvent.submit(form())
    await waitFor(() => expect(next.api.createTask).toHaveBeenCalledWith(expect.objectContaining({ acceptanceKind: "smoke" })))
  })

  it("sends the deploy script a chosen acceptance names", async () => {
    const next = setup()
    next.mount()
    const user = userEvent.setup()
    await ready()

    // The field belongs to the acceptance: naming a script for a task that owes none would
    // say nothing, so it appears only once a kind that runs a script is chosen.
    expect(screen.queryByRole("textbox", { name: t("deployScript") })).toBeNull()
    await user.selectOptions(screen.getByRole("combobox", { name: t("deliveryAcceptanceKind") }), "deploy")
    const script = screen.getByRole("textbox", { name: t("deployScript") })
    expect(script).toHaveProperty("placeholder", t("deployScriptPlaceholder"))
    await user.type(script, ".worktree-space/deploy/notify.sh")
    await user.type(nameField(), "Fix login")
    fireEvent.submit(form())

    await waitFor(() => expect(next.api.createTask).toHaveBeenCalledWith(expect.objectContaining({ deployScript: ".worktree-space/deploy/notify.sh" })))
  })

  it("leaves deployScript out of the request when the field is empty", async () => {
    const next = setup()
    next.mount()
    const user = userEvent.setup()
    await ready()

    await user.selectOptions(screen.getByRole("combobox", { name: t("deliveryAcceptanceKind") }), "deploy")
    expect(screen.getByRole("textbox", { name: t("deployScript") })).toHaveProperty("value", "")
    await user.type(nameField(), "Fix login")
    fireEvent.submit(form())

    await waitFor(() => expect(next.api.createTask).toHaveBeenCalledTimes(1))
    const payload = next.api.createTask.mock.calls[0]?.[0] as Record<string, unknown>
    // An empty field leaves the request exactly as it was: no key at all, rather than an
    // empty string the Host would then have to read back as "no script".
    expect("deployScript" in payload).toBe(false)
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
    // `acceptanceKind` rides along on every create; what it means is asserted in the
    // acceptance tests above, so here it only has to be the flat field the Host reads.
    expect(next.api.createTask).toHaveBeenCalledExactlyOnceWith({ sourceRoot: "/repo", task: "fix-login", tasksRoot: "/tasks", repos: ["/repo/alpha", "/repo/beta"], baseRef: undefined, branchPrefix: "task/", acceptanceKind: "none" })
    expect(next.workspaces.create).toHaveBeenCalledWith({ path: created.path })
    expect(next.workspaces.rename).toHaveBeenCalledWith("ws-task", "App/fix-login")
    expect(next.onCreated).toHaveBeenCalledWith(created.path)
    expect(next.onClose).toHaveBeenCalledTimes(1)
  })

  it("starts every repository from its own HEAD until a shared branch is chosen", async () => {
    const next = setup()
    next.mount()
    await ready()
    await waitFor(() => expect(next.api.branches).toHaveBeenCalled())
    // No shared branch chosen: the create names no baseRef at all, which is what
    // "each repository starts from its own HEAD" means on the wire.
    fireEvent.change(nameField(), { target: { value: "Fix login" } })
    fireEvent.submit(form())
    await waitFor(() => expect(next.api.createTask).toHaveBeenCalledWith(expect.objectContaining({ baseRef: undefined })))
  })

  it("offers only the branches every selected repository carries, and sends the chosen one", async () => {
    // alpha carries main/develop/release/2.0 and beta carries main/hotfix, so the
    // shared set is just main. A branch only one of them carries cannot be sent as
    // `baseRef`: a create passes one ref to every worktree it cuts.
    const next = setup()
    next.mount()
    await ready()
    await waitFor(() => expect(next.api.branches).toHaveBeenCalled())
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("baseRefEachOwnHead")) }))
    const options = [...document.querySelectorAll(".dws-branch-picker .dws-branch-options button")].map((node) => node.textContent)
    expect(options).toEqual(["main"])
    fireEvent.click(screen.getByRole("button", { name: "main" }))
    fireEvent.change(nameField(), { target: { value: "Fix login" } })
    fireEvent.submit(form())
    await waitFor(() => expect(next.api.createTask).toHaveBeenCalledWith(expect.objectContaining({ baseRef: "main" })))
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

  // The picker is per repository, so the branch button belongs to the card
  // rather than to the field's bulk actions. A card that is still a label would
  // forward a click on that button to the checkbox and tick the repository.
  describe("a per-repository start point", () => {
    /** Open the branch picker of the card whose name is given. */
    const openPicker = (name: string) => {
      const card = [...document.querySelectorAll(".dws-check-option")].find((node) => node.querySelector(".dws-check-label")?.textContent === name)!
      fireEvent.click(card.querySelector(".dws-branch-button") as HTMLElement)
      return card
    }
    const branchesPanel = () => document.querySelector(".dws-branch-picker") as HTMLElement
    /** Click one of the panel's own buttons, by its text. */
    const choose = (name: string) => {
      const button = [...branchesPanel().querySelectorAll("button")].find((node) => node.textContent === name) as HTMLElement | undefined
      expect(button, `no option named ${name}`).toBeDefined()
      fireEvent.click(button!)
    }

    it("reads every selected repository's branches in one batch as the dialog opens", async () => {
      const next = setup()
      next.mount()
      await ready()
      await waitFor(() => expect(next.api.branches).toHaveBeenCalledTimes(1))
      expect(next.api.branches).toHaveBeenCalledWith(["/repo/alpha", "/repo/beta"])
    })

    it("shows the checked-out branch until one is chosen, then shows the choice", async () => {
      const next = setup()
      next.mount()
      await ready()
      await waitFor(() => expect(next.api.branches).toHaveBeenCalled())
      // Both cards name the branch the suggestion said HEAD is on.
      expect([...document.querySelectorAll(".dws-check-option .dws-branch-value")].map((node) => node.textContent)).toEqual(["main", "develop"])
      openPicker("alpha")
      // One flat list: the Host offers local branches only, so there is no
      // second group for a reader to tell apart from the first.
      expect(branchesPanel().querySelectorAll(".dws-branch-options")).toHaveLength(1)
      choose("release/2.0")
      expect(document.querySelector(".dws-check-option .dws-branch-value")?.textContent).toBe("release/2.0")
      // The choice is the request's per-repository override; the untouched one is
      // deliberately absent so it falls back to the global default.
      fireEvent.change(nameField(), { target: { value: "fix-login" } })
      fireEvent.submit(form())
      await waitFor(() => expect(next.api.createTask).toHaveBeenCalledWith(expect.objectContaining({
        baseRef: undefined,
        baseRefs: { alpha: "release/2.0" },
      })))
    })

    it("focuses the picker's own search, which the dialog's focus scope must not take back", async () => {
      const next = setup()
      next.mount()
      await ready()
      await waitFor(() => expect(next.api.branches).toHaveBeenCalled())
      openPicker("alpha")
      const search = screen.getByRole("textbox", { name: t("baseRefPickerSearch") }) as HTMLInputElement
      // The panel is portalled out of the dialog's overlay; a modal dialog that still
      // holds the focus scope pulls focus back to its own content on every focusin, so
      // the search could never be typed into. Opening the list focuses it.
      expect(document.activeElement).toBe(search)
      fireEvent.change(search, { target: { value: "main" } })
      expect(search.value).toBe("main")
    })

    it("filters the list by what is typed into the picker's own search", async () => {
      const next = setup()
      next.mount()
      await ready()
      await waitFor(() => expect(next.api.branches).toHaveBeenCalled())
      openPicker("alpha")
      const search = screen.getByRole("textbox", { name: t("baseRefPickerSearch") })
      fireEvent.change(search, { target: { value: "develop" } })
      const options = [...branchesPanel().querySelectorAll(".dws-branch-options button")].map((node) => node.textContent)
      expect(options).toEqual(["develop"])
      fireEvent.change(search, { target: { value: "no-such-branch" } })
      expect(branchesPanel().textContent).toContain("no-such-branch")
      expect(branchesPanel().querySelectorAll(".dws-branch-options button")).toHaveLength(0)
    })

    it("names how many branches were left out rather than dropping them silently", async () => {
      const next = setup()
      next.api.branches.mockResolvedValue({ "/repo/alpha": { branches: ["main"], truncated: 7 }, "/repo/beta": { branches: [], truncated: 0 } })
      next.mount()
      await ready()
      await waitFor(() => expect(next.api.branches).toHaveBeenCalled())
      openPicker("alpha")
      expect(branchesPanel().textContent).toContain(format(t("baseRefTruncated"), { count: "7" }))
    })

    it("shows a reading state while the batch is in flight and never an empty list", async () => {
      const next = setup()
      let release: (value: Record<string, unknown>) => void = () => {}
      const pending = new Promise<Record<string, unknown>>((resolve) => { release = resolve })
      next.api.branches.mockReturnValue(pending)
      next.mount()
      await ready()
      openPicker("alpha")
      expect(branchesPanel().textContent).toContain(t("baseRefLoading"))
      expect(branchesPanel().textContent).not.toContain(t("baseRefEmpty"))
      release({ "/repo/alpha": { branches: ["main"], truncated: 0 }, "/repo/beta": { branches: [], truncated: 0 } })
      await waitFor(() => expect(branchesPanel().textContent).toContain("main"))
    })

    it("offers a retry when the read fails, and a successful retry fills the list", async () => {
      const next = setup()
      next.api.branches
        .mockRejectedValueOnce(new Error("connection lost"))
        .mockResolvedValue(branchLists())
      next.mount()
      await ready()
      // The failed read settles before the panel is opened, so what the panel
      // shows is the error and its retry rather than a reading state.
      await waitFor(() => expect(next.api.branches).toHaveBeenCalled())
      openPicker("alpha")
      expect(branchesPanel().textContent).toContain("connection lost")
      expect(branchesPanel().textContent).toContain(t("baseRefRetry"))
      fireEvent.click([...branchesPanel().querySelectorAll("button")].find((node) => node.textContent === t("baseRefRetry"))!)
      await waitFor(() => expect(next.api.branches).toHaveBeenCalledTimes(2))
      expect(branchesPanel().textContent).toContain("release/2.0")
    })

    it("keeps a chosen branch when the repository is unticked and does not send it", async () => {
      const next = setup()
      next.mount()
      await ready()
      await waitFor(() => expect(next.api.branches).toHaveBeenCalled())
      openPicker("alpha")
      choose("release/2.0")
      fireEvent.click(screen.getByRole("checkbox", { name: /alpha/ }))
      // The value is still on the card, not thrown away with the selection.
      expect(document.querySelector(".dws-check-option .dws-branch-value")?.textContent).toBe("release/2.0")
      fireEvent.change(nameField(), { target: { value: "fix-login" } })
      fireEvent.submit(form())
      await waitFor(() => expect(next.api.createTask).toHaveBeenCalledWith(expect.objectContaining({
        repos: ["/repo/beta"],
      })))
      expect(next.api.createTask.mock.calls[0][0]).not.toHaveProperty("baseRefs")
    })

    it("lets the text and the checkbox toggle the tick, but not the card or its button", async () => {
      const next = setup()
      next.mount()
      await ready()
      const card = document.querySelector(".dws-check-option") as HTMLElement
      const box = card.querySelector(".dws-checkbox") as HTMLInputElement
      // The card is a div, not a label: clicking its blank space does nothing.
      expect(card.tagName).toBe("DIV")
      fireEvent.click(card)
      expect(box.checked).toBe(true)
      // The text is a label for the box, so it is still a click target.
      fireEvent.click(card.querySelector(".dws-check-label") as HTMLElement)
      expect(box.checked).toBe(false)
      // Opening the picker does not toggle the tick either.
      fireEvent.click(card.querySelector(".dws-branch-button") as HTMLElement)
      expect(box.checked).toBe(false)
      expect(document.querySelector(".dws-branch-picker")).not.toBeNull()
    })

    it("lets a chosen override go back to the dialog's global default", async () => {
      const next = setup()
      next.mount()
      await ready()
      await waitFor(() => expect(next.api.branches).toHaveBeenCalled())
      openPicker("alpha")
      choose("release/2.0")
      openPicker("alpha")
      choose(t("baseRefReset"))
      expect(document.querySelector(".dws-check-option .dws-branch-value")?.textContent).toBe("main")
      fireEvent.change(nameField(), { target: { value: "fix-login" } })
      fireEvent.submit(form())
      await waitFor(() => expect(next.api.createTask).toHaveBeenCalledWith(expect.objectContaining({
        baseRef: undefined,
      })))
      expect(next.api.createTask.mock.calls[0][0]).not.toHaveProperty("baseRefs")
    })

    it("puts the shared start point under the repository list, and says how the two levels relate", async () => {
      const next = setup()
      next.mount()
      await ready()
      // The shared value is the list's own default - it answers "where does this task
      // start" for every repository the cards left alone - so it follows the list. The
      // task's name and container are a different question and come after it.
      const list = repoGroup()
      const shared = document.querySelector(".dws-base-fieldset")!
      const details = document.querySelector(".dws-details-fieldset")!
      expect(list.compareDocumentPosition(shared) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(shared.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      // And it says which level wins, because the pickers on the cards above are the
      // other half of this one question.
      expect(shared.textContent).toContain(t("baseRefUniformHint"))
      // The band that closes the list carries this field's name on the left and the
      // list's own count and bulk actions on the right: one line, not two rows.
      const heading = shared.querySelector(".dws-base-heading")!
      expect(heading.querySelector(".dws-field-label")?.textContent).toBe(t("basedOn"))
      expect(heading.querySelector(".dws-check-count")).not.toBeNull()
      expect(heading.querySelectorAll(".dws-repo-actions button")).toHaveLength(2)
    })

    it("puts the whole rule set behind the hint beside the field's own name", async () => {
      const user = userEvent.setup()
      const next = setup()
      next.mount()
      await ready()
      const shared = document.querySelector(".dws-base-fieldset")!
      const hint = shared.querySelector(".dws-base-heading .dws-field-hint") as HTMLElement
      expect(hint).not.toBeNull()
      await user.hover(hint)
      expect((await screen.findByRole("tooltip")).textContent).toBe(t("baseRefRules"))
      // The same rules reach a reader who never hovers: the field's button names the
      // hidden copy as its description.
      const button = shared.querySelector(".dws-base-ref-button") as HTMLElement
      const describedBy = button.getAttribute("aria-describedby")
      expect(describedBy).not.toBeNull()
      expect(document.getElementById(describedBy!)?.textContent).toBe(t("baseRefRules"))
    })

    it("sends the shared ref and the overrides together, each in its own role", async () => {
      const next = setup()
      next.mount()
      await ready()
      await waitFor(() => expect(next.api.branches).toHaveBeenCalled())
      // The shared field offers the intersection over the ticked repositories.
      // Both are ticked, so it is alpha's develop/release/2.0 against beta's
      // hotfix ... minus main, which both carry. Choose the one they share.
      fireEvent.click(screen.getByRole("button", { name: new RegExp(t("baseRefEachOwnHead")) }))
      fireEvent.click(screen.getByRole("button", { name: "main" }))
      openPicker("beta")
      choose("hotfix")
      fireEvent.change(nameField(), { target: { value: "fix-login" } })
      fireEvent.submit(form())
      await waitFor(() => expect(next.api.createTask).toHaveBeenCalledWith(expect.objectContaining({
        baseRef: "main",
        baseRefs: { beta: "hotfix" },
      })))
    })
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

  it("refuses an unusable configured prefix rather than sending it", async () => {
    // The field is validated as typed, but the request carries `effectivePrefix`, which
    // falls back to the configured default when the field is empty. Validating only the
    // typed text let an illegal *configured* prefix through this check, and the Host
    // then refused the create - after the user had filled the form in and pressed the
    // button, with the refusal arriving from somewhere they could not see.
    const { form: config } = configForm("bad prefix/")
    const next = setup(config)
    next.mount()
    await ready()

    // Clearing the field is what asks for the configured default; the field itself is
    // prefilled with it, so this is the reachable shape of the bug.
    fireEvent.change(prefixField(), { target: { value: "" } })
    fireEvent.change(nameField(), { target: { value: "Fix login" } })
    fireEvent.submit(form())

    expect(next.api.createTask).not.toHaveBeenCalled()
    // And the sentence names the prefix that was refused, because it is not in the field
    // for the user to read it off.
    await waitFor(() => expect(document.querySelector(".dws-error")?.textContent)
      .toContain(format(t("invalidConfiguredBranchPrefix"), { prefix: "bad prefix/" })))
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

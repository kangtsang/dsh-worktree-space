// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ARCHIVE_DIRECTORY_HINT, ARCHIVE_DIRECTORY_HINT_FALLBACK, ARCHIVE_DIRECTORY_LABEL, ARCHIVE_DIRECTORY_LABEL_FALLBACK, PluginConfigCard } from "../src/client/components/PluginConfigCard"
import { setPreview, settlePreview } from "../src/client/lib/config-preview"
import { t } from "../src/client/lib/i18n"

/**
 * The configuration form as the shell serves it: a snapshot the card reads and a
 * write that lands in that same snapshot, which is what the real form does after a
 * round trip.
 */
function configForm(prefix = "task/", accepted = true, archiveDirectory = "", archiveStrategy = "container",
  tasksRootStrategy = "default", tasksRootDirectory = "", ignoredScanDirectories: string[] = [], removedScanDirectories: string[] = [],
  taskModelProvider = "", taskModel = "") {
  let value: Record<string, unknown> = {
    entryStyle: "quick",
    scanDepth: 2,
    maxScanDirectories: 2000,
    defaultBranchPrefix: prefix,
    archiveDocumentsStrategy: archiveStrategy,
    archiveDocumentsDirectory: archiveDirectory,
    tasksRootStrategy,
    tasksRootDirectory,
    ignoredScanDirectories,
    removedScanDirectories,
    taskModelProvider,
    taskModel,
  }
  const listeners = new Set<() => void>()
  return {
    form: {
      getSnapshot: () => ({ status: "ready", value }),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      set: vi.fn(async (field: string, next: unknown) => {
        if (!accepted) return false
        value = { ...value, [field]: next }
        listeners.forEach((listener) => listener())
        return true
      }),
    },
    read: () => value,
  }
}

/** The locked row shows the value as plain text, labelled; Edit swaps that for a field. */
const lockedElement = () => prefixRow().querySelector(".dws-plugin-config-locked")
const lockedPrefix = () => lockedElement()?.textContent
/** The row carrying a given label: two text rows now share the button copy. */
const rowFor = (label: string) => screen.getByText(label).closest(".dws-plugin-config-row") as HTMLElement
const prefixRow = () => rowFor(t("defaultBranchPrefixSettingsLabel"))
const prefixInput = () => screen.getByRole("textbox", { name: t("defaultBranchPrefixSettingsLabel") }) as HTMLInputElement
const saveButton = () => within(prefixRow()).getByRole("button", { name: t("configSave") }) as HTMLButtonElement
const editButton = () => within(prefixRow()).getByRole("button", { name: t("configEdit") }) as HTMLButtonElement
const hintIn = (label: string) => screen.getByText(label).closest(".dws-plugin-config-row")?.querySelector(".dws-plugin-config-hint")?.textContent

/**
 * The copy the archive destination row shows.
 *
 * Its keys belong to the session that owns the dictionaries and may not have landed
 * yet, in which case the row falls back to wording of its own — so the test resolves
 * the label the way the row does rather than assuming a dictionary entry.
 */
const ARCHIVE_LABEL = t(ARCHIVE_DIRECTORY_LABEL) === ARCHIVE_DIRECTORY_LABEL ? ARCHIVE_DIRECTORY_LABEL_FALLBACK : t(ARCHIVE_DIRECTORY_LABEL)
const ARCHIVE_HINT = t(ARCHIVE_DIRECTORY_HINT) === ARCHIVE_DIRECTORY_HINT ? ARCHIVE_DIRECTORY_HINT_FALLBACK : t(ARCHIVE_DIRECTORY_HINT)

afterEach(() => {
  cleanup()
  // The optimistic store is module state shared with the sidebar; leave it empty.
  settlePreview({})
})

describe("the configuration card's branch prefix row", () => {
  it("keeps the prefix locked behind Edit, then saves the edit through the same form", async () => {
    const { form, read } = configForm("task/")
    render(<PluginConfigCard form={form} />)

    // Read from the served section, as a value nobody may type into yet: no field at all
    // until the reader asks for one.
    expect(lockedPrefix()).toBe("task/")
    expect(screen.queryByRole("textbox", { name: t("defaultBranchPrefixSettingsLabel") })).toBeNull()
    expect(editButton()).toBeTruthy()

    fireEvent.click(editButton())
    expect(lockedElement()).toBeNull()
    expect(prefixInput().value).toBe("task/")
    // Save is live as soon as the field is: re-saving the value in force is allowed.
    expect(saveButton().disabled).toBe(false)

    fireEvent.change(prefixInput(), { target: { value: "wt/" } })
    fireEvent.click(saveButton())

    await waitFor(() => expect(form.set).toHaveBeenCalledWith("defaultBranchPrefix", "wt/"))
    expect(read()).toMatchObject({ defaultBranchPrefix: "wt/" })
    // The written value lands the row back in its locked state, with the confirmation.
    await waitFor(() => expect(lockedPrefix()).toBe("wt/"))
    expect(screen.getByRole("status").textContent).toBe(t("configSaved"))
  })

  it("does not claim a prefix the Host refused", async () => {
    const { form, read } = configForm("task/", false)
    render(<PluginConfigCard form={form} />)

    fireEvent.click(editButton())
    fireEvent.change(prefixInput(), { target: { value: "wt/" } })
    fireEvent.click(saveButton())

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(t("configNotSaved")))
    // The row falls back to what is actually in force rather than to the typed value.
    expect(read()).toMatchObject({ defaultBranchPrefix: "task/" })
    await waitFor(() => expect(prefixInput().value).toBe("task/"))
  })

  it("refuses to save an emptied prefix, which is not a prefix at all", async () => {
    const { form } = configForm("task/")
    render(<PluginConfigCard form={form} />)

    fireEvent.click(editButton())
    fireEvent.change(prefixInput(), { target: { value: "   " } })
    // Save stays live - pressing it is always allowed - but an empty prefix is not a
    // prefix, so nothing reaches the Host and the field stays open for a real value.
    expect(saveButton().disabled).toBe(false)
    fireEvent.click(saveButton())
    expect(form.set).not.toHaveBeenCalled()
    expect(lockedElement()).toBeNull()
  })

  it("shows a prefix the create dialog saved, before this card's form catches up", () => {
    // The dialog publishes the new prefix into the shared optimistic store and writes
    // it through the form, so a card that is already open has to follow the store
    // during that round trip rather than keep showing the old value.
    setPreview("defaultBranchPrefix", "feat/")
    const { form } = configForm("task/")
    render(<PluginConfigCard form={form} />)
    expect(lockedPrefix()).toBe("feat/")
  })

  it("puts every note under its own row's label, and swaps the prefix's for the edit hint", () => {
    // Same shape for all three: label, note beneath it, control on the trailing side.
    const { form } = configForm("task/")
    render(<PluginConfigCard form={form} />)
    expect(hintIn(t("scanDepth"))).toBe(t("scanDepthHint"))
    expect(hintIn(t("maxScanDirectories"))).toBe(t("maxScanDirectoriesHint"))
    expect(hintIn(t("defaultBranchPrefixSettingsLabel"))).toBe(t("defaultBranchPrefixHint"))

    // Editing is the one moment the note changes, because what to do next has changed.
    fireEvent.click(editButton())
    expect(hintIn(t("defaultBranchPrefixSettingsLabel"))).toBe(t("configPrefixEditHint"))
  })
})

describe("the configuration card's sidebar entry row", () => {
  it("offers the three entries at once, and saves the one chosen", async () => {
    const { form, read } = configForm()
    render(<PluginConfigCard form={form} />)

    // Three answers on screen rather than behind a menu: this setting IS the choice, so
    // the row shows all of them and marks the one in force.
    const group = screen.getByRole("group", { name: t("entryStyleLabel") })
    expect(within(group).getAllByRole("button").map((button) => button.textContent))
      .toEqual([t("entryStyleStandard"), t("entryStyleQuick"), t("entryStyleCompact")])
    expect(within(group).getByRole("button", { name: t("entryStyleQuick") }).getAttribute("aria-pressed")).toBe("true")

    fireEvent.click(within(group).getByRole("button", { name: t("entryStyleCompact") }))
    await waitFor(() => expect(form.set).toHaveBeenCalledWith("entryStyle", "compact"))
    expect(read()).toMatchObject({ entryStyle: "compact" })
    expect(within(group).getByRole("button", { name: t("entryStyleCompact") }).getAttribute("aria-pressed")).toBe("true")
  })
})

describe("the configuration card's sidebar entry row", () => {
  it("offers the three entries at once, and saves the one chosen", async () => {
    const { form, read } = configForm()
    render(<PluginConfigCard form={form} />)

    // Three answers on screen rather than behind a menu: this setting IS the choice, so
    // the row shows all of them and marks the one in force.
    const group = screen.getByRole("group", { name: t("entryStyleLabel") })
    expect(within(group).getAllByRole("button").map((button) => button.textContent))
      .toEqual([t("entryStyleStandard"), t("entryStyleQuick"), t("entryStyleCompact")])
    expect(within(group).getByRole("button", { name: t("entryStyleQuick") }).getAttribute("aria-pressed")).toBe("true")

    fireEvent.click(within(group).getByRole("button", { name: t("entryStyleCompact") }))
    await waitFor(() => expect(form.set).toHaveBeenCalledWith("entryStyle", "compact"))
    expect(read()).toMatchObject({ entryStyle: "compact" })
    expect(within(group).getByRole("button", { name: t("entryStyleCompact") }).getAttribute("aria-pressed")).toBe("true")
  })

  it("shows the entry a configuration written before this row is actually using", async () => {
    // `entryStyle` is absent from every profile that has never chosen one, and the entry
    // in force is then derived from the two switches this replaced. A row that read only
    // the new field would label itself "quick" to someone whose entry is the panel row,
    // and the first click would move an entry that had never moved.
    const { form } = configForm()
    const snapshot = form.getSnapshot
    form.getSnapshot = () => ({ status: "ready", value: { ...(snapshot().value as Record<string, unknown>), entryStyle: undefined, panelEntry: "show", sidebarEntry: "hide" } })
    render(<PluginConfigCard form={form} />)

    const group = screen.getByRole("group", { name: t("entryStyleLabel") })
    expect(within(group).getByRole("button", { name: t("entryStyleStandard") }).getAttribute("aria-pressed")).toBe("true")
    expect(within(group).getByRole("button", { name: t("entryStyleQuick") }).getAttribute("aria-pressed")).toBe("false")
  })
})

describe("the configuration card's handoff access row", () => {
  it("offers the handoff sessions' access as a choice, off by default and described as a permission", () => {
    const { form } = configForm()
    render(<PluginConfigCard form={form} />)

    // Its own row beside the entry it governs, with a note that says what the two states do
    // and what the wider one costs - a note rather than a label, because one of the two is a
    // permission over the whole machine and the row is the last place that can be said.
    expect(hintIn(t("handoffFullAccess"))).toBe(t("handoffFullAccessHint"))
    // Off is the default and the answer for a Host that serves no such key: the arrangement
    // that keeps the sandbox in the conversation.
    expect(screen.getByLabelText(t("handoffFullAccess")).textContent).toContain(t("handoffFullAccessOff"))
  })

  it("saves the access choice through the form the other rows use, and names both states", async () => {
    const { form, read } = configForm()
    render(<PluginConfigCard form={form} />)

    fireEvent.click(screen.getByLabelText(t("handoffFullAccess")))
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: t("handoffFullAccessOn") })).toBeTruthy()
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: t("handoffFullAccessOff") })).toBeTruthy()
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: t("handoffFullAccessOn") }))

    await waitFor(() => expect(form.set).toHaveBeenCalledWith("handoffFullAccess", "on"))
    expect(read()).toMatchObject({ handoffFullAccess: "on" })
    expect(screen.getByLabelText(t("handoffFullAccess")).textContent).toContain(t("handoffFullAccessOn"))
  })
})

describe("the configuration card's archive strategy row", () => {
  it("offers the two roots, and names the one in force", () => {
    const { form } = configForm()
    render(<PluginConfigCard form={form} />)

    // The row is the shape the other display choices have: label, note beneath it, the
    // value on the trailing side. The Host serves the shipped strategy, so the container
    // root is what it names.
    expect(hintIn(t("archiveDocumentsStrategy"))).toBe(t("archiveDocumentsStrategyHint"))
    expect(screen.getByLabelText(t("archiveDocumentsStrategy")).textContent).toContain(t("archiveStrategyContainer"))

    fireEvent.click(screen.getByLabelText(t("archiveDocumentsStrategy")))
    const menu = within(screen.getByRole("menu"))
    expect([t("archiveStrategyContainer"), t("archiveStrategyCustom")]
      .map((name) => menu.getByRole("menuitem", { name }))).toHaveLength(2)
  })

  it("saves the choice through the form the other display choices use", async () => {
    const { form, read } = configForm("task/", true, "", "custom")
    render(<PluginConfigCard form={form} />)

    fireEvent.click(screen.getByLabelText(t("archiveDocumentsStrategy")))
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: t("archiveStrategyContainer") }))

    expect(screen.getByLabelText(t("archiveDocumentsStrategy")).textContent).toContain(t("archiveStrategyContainer"))
    await waitFor(() => expect(form.set).toHaveBeenCalledWith("archiveDocumentsStrategy", "container"))
    expect(read()).toMatchObject({ archiveDocumentsStrategy: "container" })
  })

  it("draws the directory row only while the custom strategy is in force", async () => {
    // A directory beside the computed root is read by nothing, so showing it would read
    // as a setting being ignored. Driving it from the control itself rather than from the
    // fixture is also what proves the row follows a pending choice.
    const { form } = configForm("task/", true, "E:\\archived-docs")
    render(<PluginConfigCard form={form} />)

    expect(screen.queryByLabelText(ARCHIVE_LABEL)).toBeNull()

    fireEvent.click(screen.getByLabelText(t("archiveDocumentsStrategy")))
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: t("archiveStrategyCustom") }))

    await waitFor(() => expect(screen.getByLabelText(ARCHIVE_LABEL).textContent).toBe("E:\\archived-docs"))
  })
})

describe("the configuration card's task space location rows", () => {
  /** The form as the Host serves it when a directory of the user's own is the location. */
  const customForm = (tasksRootDirectory: string) => configForm("task/", true, "", "container", "custom", tasksRootDirectory)

  it("offers the two locations, and names the one in force", () => {
    const { form } = configForm()
    render(<PluginConfigCard form={form} />)

    // The archive strategy's shape: a label, a note beneath it, and the value on the
    // trailing side. The Host serves the shipped strategy, so the derived location is
    // what it names.
    expect(hintIn(t("tasksRootStrategy"))).toBe(t("tasksRootStrategyHint"))
    expect(screen.getByLabelText(t("tasksRootStrategy")).textContent).toContain(t("tasksRootStrategyDefault"))

    fireEvent.click(screen.getByLabelText(t("tasksRootStrategy")))
    const menu = within(screen.getByRole("menu"))
    expect([t("tasksRootStrategyDefault"), t("tasksRootStrategyCustom")]
      .map((name) => menu.getByRole("menuitem", { name }))).toHaveLength(2)
  })

  it("saves the choice through the form the other display choices use", async () => {
    const { form, read } = configForm()
    render(<PluginConfigCard form={form} />)

    fireEvent.click(screen.getByLabelText(t("tasksRootStrategy")))
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: t("tasksRootStrategyCustom") }))

    await waitFor(() => expect(form.set).toHaveBeenCalledWith("tasksRootStrategy", "custom"))
    expect(read()).toMatchObject({ tasksRootStrategy: "custom" })
    expect(screen.getByLabelText(t("tasksRootStrategy")).textContent).toContain(t("tasksRootStrategyCustom"))
  })

  it("draws the directory row only while the custom location is in force", async () => {
    // A directory the derived location never reads is worth no row: showing it would
    // read as a setting being ignored. Driving it from the control rather than from the
    // fixture is also what proves the row follows a pending choice.
    const { form } = configForm("task/", true, "", "container", "custom", "E:\\worktree-space")
    render(<PluginConfigCard form={form} />)

    expect(screen.getByLabelText(t("tasksRootDirectory")).textContent).toBe("E:\\worktree-space")

    fireEvent.click(screen.getByLabelText(t("tasksRootStrategy")))
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: t("tasksRootStrategyDefault") }))

    await waitFor(() => expect(screen.queryByLabelText(t("tasksRootDirectory"))).toBeNull())
  })

  it("keeps the directory row off the card while the derived location is in force", () => {
    const { form } = configForm("task/", true, "", "container", "default", "E:\\worktree-space")
    render(<PluginConfigCard form={form} />)

    // Served but inert: the strategy is what decides, so a leftover directory from an
    // earlier custom run is not shown as if it were being used.
    expect(screen.queryByLabelText(t("tasksRootDirectory"))).toBeNull()
  })

  it("saves a location, and lets it be cleared back to the derived one", async () => {
    const { form, read } = customForm("E:\\worktree-space")
    render(<PluginConfigCard form={form} />)

    // The prefix row's shape: a note under the label, the value locked behind Edit.
    expect(hintIn(t("tasksRootDirectory"))).toBe(t("tasksRootDirectoryHint"))
    const row = rowFor(t("tasksRootDirectory"))
    fireEvent.click(within(row).getByRole("button", { name: t("configEdit") }))
    const input = within(row).getByRole("textbox", { name: t("tasksRootDirectory") }) as HTMLInputElement
    expect(input.value).toBe("E:\\worktree-space")

    fireEvent.change(input, { target: { value: "E:\\spaces" } })
    fireEvent.click(within(row).getByRole("button", { name: t("configSave") }))
    await waitFor(() => expect(form.set).toHaveBeenCalledWith("tasksRootDirectory", "E:\\spaces"))
    expect(read()).toMatchObject({ tasksRootDirectory: "E:\\spaces" })

    // Empty is this setting's own "not set", which leaves the derived location in place —
    // a value the row sends rather than one it refuses.
    fireEvent.click(within(row).getByRole("button", { name: t("configEdit") }))
    fireEvent.change(within(row).getByRole("textbox", { name: t("tasksRootDirectory") }), { target: { value: "   " } })
    fireEvent.click(within(row).getByRole("button", { name: t("configSave") }))
    await waitFor(() => expect(form.set).toHaveBeenCalledWith("tasksRootDirectory", ""))
    expect(read()).toMatchObject({ tasksRootDirectory: "" })
  })
})

describe("the configuration card's archive destination row", () => {
  /** The form as the Host serves it when a directory of its own is the root in force. */
  const customForm = (archiveDirectory: string) => configForm("task/", true, archiveDirectory, "custom")

  it("shows the destination the Host serves, with its own note under the label", () => {
    const { form } = customForm("E:\\archived-docs")
    render(<PluginConfigCard form={form} />)

    // The row is the prefix row's shape: a label with a note beneath it, and the value
    // locked behind Edit.
    expect(hintIn(ARCHIVE_LABEL)).toBe(ARCHIVE_HINT)
    expect(screen.getByLabelText(ARCHIVE_LABEL).textContent).toBe("E:\\archived-docs")
  })

  it("saves a destination, and lets it be cleared back to the container root", async () => {
    const { form, read } = customForm("E:\\archived-docs")
    render(<PluginConfigCard form={form} />)

    const row = rowFor(ARCHIVE_LABEL)
    fireEvent.click(within(row).getByRole("button", { name: t("configEdit") }))
    const input = within(row).getByRole("textbox", { name: ARCHIVE_LABEL }) as HTMLInputElement
    expect(input.value).toBe("E:\\archived-docs")

    fireEvent.change(input, { target: { value: "E:\\docs" } })
    fireEvent.click(within(row).getByRole("button", { name: t("configSave") }))
    await waitFor(() => expect(form.set).toHaveBeenCalledWith("archiveDocumentsDirectory", "E:\\docs"))
    expect(read()).toMatchObject({ archiveDocumentsDirectory: "E:\\docs" })

    // Empty is the setting's own "not set", which falls back to the container root — a
    // value the row sends rather than one it refuses; the prefix row is the one that
    // refuses.
    fireEvent.click(within(row).getByRole("button", { name: t("configEdit") }))
    fireEvent.change(within(row).getByRole("textbox", { name: ARCHIVE_LABEL }), { target: { value: "   " } })
    fireEvent.click(within(row).getByRole("button", { name: t("configSave") }))
    await waitFor(() => expect(form.set).toHaveBeenCalledWith("archiveDocumentsDirectory", ""))
    expect(read()).toMatchObject({ archiveDocumentsDirectory: "" })
  })
})

/**
 * The model row.
 *
 * The one row whose options come from the Host rather than from the schema, so the cases
 * that matter are the ones a fixed list does not have: the catalog arriving late, the
 * catalog being unreachable, and a configured route the catalog no longer carries.
 */
describe("the task session model row", () => {
  const CATALOG = {
    providers: [
      { provider: "deepseek-account", models: ["deepseek-chat", "deepseek-reasoner"] },
      { provider: "codearts", models: ["gw-1"] },
    ],
  }

  it("is unspecified by default, and says what that means", () => {
    // The shipped state has to be the one that needs no thought: a dispatch that names no
    // model starts on the dispatching session's model. A concrete model first in the list
    // would read as a recommendation, and every untouched profile would be moved onto it.
    const { form } = configForm()
    render(<PluginConfigCard form={form} models={CATALOG} />)
    expect(screen.getByLabelText(t("taskModelLabel")).textContent).toContain(t("taskModelInherit"))
    expect(hintIn(t("taskModelLabel"))).toBe(t("taskModelHint"))
  })

  it("offers every route the Host can reach, and writes both halves", async () => {
    const { form, read } = configForm()
    render(<PluginConfigCard form={form} models={CATALOG} />)

    fireEvent.click(screen.getByLabelText(t("taskModelLabel")))
    const menu = within(screen.getByRole("menu"))
    expect(menu.getByRole("menuitem", { name: "deepseek-account/deepseek-reasoner" })).toBeTruthy()
    expect(menu.getByRole("menuitem", { name: "codearts/gw-1" })).toBeTruthy()

    fireEvent.click(menu.getByRole("menuitem", { name: "codearts/gw-1" }))
    // Both halves, provider first: a model id is never configured under the previous
    // provider, not even for the moment between two writes.
    await waitFor(() => expect(form.set).toHaveBeenCalledWith("taskModelProvider", "codearts"))
    await waitFor(() => expect(form.set).toHaveBeenCalledWith("taskModel", "gw-1"))
    expect(read()).toMatchObject({ taskModelProvider: "codearts", taskModel: "gw-1" })
  })

  it("clears both halves when unspecified is chosen again", async () => {
    const { form, read } = configForm("task/", true, "", "container", "default", "", [], [], "codearts", "gw-1")
    render(<PluginConfigCard form={form} models={CATALOG} />)
    expect(screen.getByLabelText(t("taskModelLabel")).textContent).toContain("codearts/gw-1")

    fireEvent.click(screen.getByLabelText(t("taskModelLabel")))
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: t("taskModelInherit") }))
    await waitFor(() => expect(form.set).toHaveBeenCalledWith("taskModelProvider", ""))
    await waitFor(() => expect(form.set).toHaveBeenCalledWith("taskModel", ""))
    expect(read()).toMatchObject({ taskModelProvider: "", taskModel: "" })
  })

  it("keeps a configured route the catalog no longer carries, rather than erasing it", async () => {
    // A provider that was uninstalled still has to be visible: it is what the
    // configuration says, and a row that showed "unspecified" instead would make the next
    // save drop a setting nobody touched.
    const { form } = configForm("task/", true, "", "container", "default", "", [], [], "uninstalled", "gone")
    render(<PluginConfigCard form={form} models={CATALOG} />)
    expect(screen.getByLabelText(t("taskModelLabel")).textContent).toContain("uninstalled/gone")
  })

  it("says so when the catalog cannot be read, and still offers unspecified", () => {
    const { form } = configForm()
    render(<PluginConfigCard form={form} models={{ providers: [] }} />)
    expect(screen.getByLabelText(t("taskModelLabel")).textContent).toContain(t("taskModelInherit"))
    fireEvent.click(screen.getByLabelText(t("taskModelLabel")))
    // The only choice is "unspecified", which is a real answer rather than an empty menu.
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem")).toHaveLength(1)
  })

  it("asks the Host for the catalog when the shell did not hand one in", async () => {
    const { form } = configForm()
    const loadModels = vi.fn(async () => CATALOG)
    render(<PluginConfigCard form={form} loadModels={loadModels} />)
    await waitFor(() => expect(loadModels).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByLabelText(t("taskModelLabel")))
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "deepseek-account/deepseek-chat" })).toBeTruthy()
  })

  it("asks the Host once per attempt, even when the loader is an inline arrow", async () => {
    // The flicker this pins: `loadModels={() => api.models()}` makes a new function on
    // every render, so listing it as an effect dependency re-ran the read on every render.
    // Setting the loading state caused the next render, which produced the next function -
    // the row and everything below it flickered, and the Host was asked repeatedly for one
    // menu. Re-rendering the card must not re-ask.
    const { form } = configForm()
    let calls = 0
    const { rerender } = render(<PluginConfigCard form={form} loadModels={() => { calls += 1; return Promise.resolve(CATALOG) }} />)
    await waitFor(() => expect(calls).toBe(1))

    // Same unstable shape as the caller above, and several renders of it.
    for (let i = 0; i < 3; i += 1) {
      rerender(<PluginConfigCard form={form} loadModels={() => { calls += 1; return Promise.resolve(CATALOG) }} />)
    }
    await waitFor(() => expect(screen.getByLabelText(t("taskModelLabel")).getAttribute("aria-busy")).toBe("false"))
    expect(calls).toBe(1)
  })

  it("says the list is still being read, rather than showing it as empty", async () => {
    // The Host walks every provider before answering, which takes seconds on a real
    // deployment. Saying "Not specified" for that whole wait reads as "this deployment
    // has no models", which is the wrong conclusion and the one a reader draws fastest.
    let release: (value: typeof CATALOG) => void = () => {}
    const pending = new Promise<typeof CATALOG>((resolve) => { release = resolve })
    const { form } = configForm()
    render(<PluginConfigCard form={form} loadModels={() => pending} />)

    const row = () => screen.getByLabelText(t("taskModelLabel"))
    expect(row().textContent).toContain(t("taskModelLoading"))
    expect(row().getAttribute("aria-busy")).toBe("true")
    // The note under the label says the same thing, so the reason is on screen and not
    // only in the control's value.
    expect(hintIn(t("taskModelLabel"))).toBe(t("taskModelLoadingHint"))

    // The menu says it too, instead of opening onto a single "unspecified" row.
    fireEvent.click(row())
    expect(within(screen.getByRole("menu")).getByText(t("taskModelLoadingMenu"))).toBeTruthy()
    // "Unspecified" stays live: it is the value in force and the one a reader keeping the
    // default needs. Every other row waits for its answer.
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: t("taskModelInherit") })).toHaveProperty("disabled", false)

    release!(CATALOG)
    await waitFor(() => expect(row().getAttribute("aria-busy")).toBe("false"))
    expect(row().textContent).not.toContain(t("taskModelLoading"))
  })

  it("offers a retry when the read failed, and asks the Host again", async () => {
    const { form } = configForm()
    const loadModels = vi.fn()
      .mockRejectedValueOnce(new Error("gateway timeout"))
      .mockResolvedValue(CATALOG)
    render(<PluginConfigCard form={form} loadModels={loadModels} />)

    await waitFor(() => expect(screen.getByLabelText(t("taskModelLabel")).textContent).toContain(t("taskModelUnavailable")))
    fireEvent.click(screen.getByLabelText(t("taskModelLabel")))
    fireEvent.click(within(screen.getByRole("menu")).getByRole("button", { name: t("taskModelRetry") }))

    // A plain second call: the Host keeps no catalog between reads, so a retry has nothing
    // to bypass and takes no argument saying it wants to.
    await waitFor(() => expect(loadModels).toHaveBeenCalledTimes(2))
    expect(loadModels).toHaveBeenLastCalledWith()
    await waitFor(() => expect(screen.getByLabelText(t("taskModelLabel")).textContent).not.toContain(t("taskModelUnavailable")))
  })
})



// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ARCHIVE_DIRECTORY_HINT, ARCHIVE_DIRECTORY_HINT_FALLBACK, ARCHIVE_DIRECTORY_LABEL, ARCHIVE_DIRECTORY_LABEL_FALLBACK, PluginConfigCard } from "../src/client/components/PluginConfigCard"
import { setPreview, settlePreview } from "../src/client/lib/configPreview"
import { t } from "../src/client/lib/i18n"

/**
 * The configuration form as the shell serves it: a snapshot the card reads and a
 * write that lands in that same snapshot, which is what the real form does after a
 * round trip.
 */
function configForm(prefix = "task/", accepted = true, archiveDirectory = "") {
  let value: Record<string, unknown> = {
    panelEntry: "hide",
    sidebarEntry: "show",
    scanDepth: 3,
    maxScanDirectories: 3000,
    defaultBranchPrefix: prefix,
    archiveDocumentsDirectory: archiveDirectory,
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

describe("the configuration card's archive destination row", () => {
  it("shows the destination the Host serves, with its own note under the label", () => {
    const { form } = configForm("task/", true, "E:\\archived-docs")
    render(<PluginConfigCard form={form} />)

    // The row is the prefix row's shape: a label with a note beneath it, and the value
    // locked behind Edit.
    expect(hintIn(ARCHIVE_LABEL)).toBe(ARCHIVE_HINT)
    expect(screen.getByLabelText(ARCHIVE_LABEL).textContent).toBe("E:\\archived-docs")
  })

  it("saves a destination, and lets it be cleared back to the computed one", async () => {
    const { form, read } = configForm("task/", true, "E:\\archived-docs")
    render(<PluginConfigCard form={form} />)

    const row = rowFor(ARCHIVE_LABEL)
    fireEvent.click(within(row).getByRole("button", { name: t("configEdit") }))
    const input = within(row).getByRole("textbox", { name: ARCHIVE_LABEL }) as HTMLInputElement
    expect(input.value).toBe("E:\\archived-docs")

    fireEvent.change(input, { target: { value: "E:\\docs" } })
    fireEvent.click(within(row).getByRole("button", { name: t("configSave") }))
    await waitFor(() => expect(form.set).toHaveBeenCalledWith("archiveDocumentsDirectory", "E:\\docs"))
    expect(read()).toMatchObject({ archiveDocumentsDirectory: "E:\\docs" })

    // Empty is the setting's own "not set", so clearing the field is a value the row
    // sends rather than one it refuses — the prefix row is the one that refuses.
    fireEvent.click(within(row).getByRole("button", { name: t("configEdit") }))
    fireEvent.change(within(row).getByRole("textbox", { name: ARCHIVE_LABEL }), { target: { value: "   " } })
    fireEvent.click(within(row).getByRole("button", { name: t("configSave") }))
    await waitFor(() => expect(form.set).toHaveBeenCalledWith("archiveDocumentsDirectory", ""))
    expect(read()).toMatchObject({ archiveDocumentsDirectory: "" })
  })
})

describe("the configuration card's beta notice", () => {
  it("says the plugin is experimental, and links where to report a problem", () => {
    const { form } = configForm()
    render(<PluginConfigCard form={form} />)

    // The card is where the plugin's own settings live, so it is where a user learns what
    // they are setting up: a beta, with one place to complain about it.
    const notice = document.querySelector(".dws-beta-notice")
    expect(notice?.textContent).toContain(t("betaBadge"))
    expect(notice?.textContent).toContain(t("betaNotice"))
    expect(screen.getByRole("link", { name: t("betaNoticeLink") }).getAttribute("href"))
      .toBe("https://github.com/kangtsang/dsh-worktree-space/issues")
  })
})

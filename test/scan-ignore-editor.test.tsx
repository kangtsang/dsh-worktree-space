// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { format, t } from "../src/client/lib/i18n"
import { MAX_IGNORED_SCAN_DIRECTORIES } from "../src/client/lib/scan-ignore"
import { ScanIgnoreEditor } from "../src/client/components/ScanIgnoreEditor"

const BUILT_IN = ["node_modules", "target", "__pycache__"]

/** Open the dialog the way the configuration row does. */
function open(configured: string[] = [], disabled: string[] = []) {
  const onSave = vi.fn()
  const onClose = vi.fn()
  render(<ScanIgnoreEditor builtIn={BUILT_IN} configured={configured} disabled={disabled} onSave={onSave} onClose={onClose} />)
  return { user: userEvent.setup(), onSave, onClose }
}

/**
 * The names on screen, each stripped of the controls sitting inside its tag.
 *
 * A tag that is being asked about carries its question and two buttons, and a
 * name read out of the tag's whole text would come back with all of that on the
 * end of it. The name itself is its own element for exactly this reason.
 */
const tags = (): string[] => {
  const list = document.querySelector('[data-ignore-list="names"]')
  if (list === null) return []
  // `hidden: true`, because while the question is open Radix marks the dialog under
  // it `aria-hidden` - which is the correct thing for a screen reader to be told,
  // and the reason a role query cannot see the tags from inside it. The tags are
  // still there and still say what they said; the question is what the person is
  // being asked now.
  return within(list as HTMLElement).getAllByRole("listitem", { hidden: true })
    .map((node) => node.querySelector(".dws-ignore-name")?.textContent?.trim() ?? "")
    .filter((name) => name !== "")
}

/** The names wearing the module tint, which are the ones the Host ships. */
const shippedTags = (): string[] => {
  const list = document.querySelector('[data-ignore-list="names"]')
  if (list === null) return []
  return Array.from(list.querySelectorAll(".dws-ignore-tag-shipped")).map((node) => node.querySelector(".dws-ignore-name")?.textContent?.trim() ?? "")
}

/** The confirming button of the add row, which shares its name with the one that opened it. */
const confirmAdd = () => document.querySelector(".dws-add-source-row .dws-button-primary") as HTMLButtonElement

/**
 * The dialog's own Cancel, not the one beside a name being asked about.
 *
 * Two buttons carry the same name while a question is open, which is the point of
 * asking it in the row: it has to be answerable next to what it concerns. The
 * footer's is the one that discards the lot.
 */
const discard = () => within(document.querySelector(".dws-dialog-footer") as HTMLElement).getByRole("button", { name: t("cancel") })

const removeButton = (name: string) => screen.getByRole("button", { name: format(t("ignoredScanDirectoriesRemove"), { name }) })

/**
 * The question about removing a built-in name is a dialog of its own, so both
 * answers are read from it rather than from anywhere on the page. `document` is the
 * right root: the dialog is a portal, and it is a sibling of the one under test
 * rather than a descendant of it.
 */
const question = () => document.querySelector(".dws-confirm-dialog") as HTMLElement | null
const asking = () => question() !== null
const declineQuestion = () => within(question() as HTMLElement).getByRole("button", { name: t("cancel") })
const confirmQuestion = () => within(question() as HTMLElement).getByRole("button", { name: t("configConfirm") })
const questionText = () => question()?.textContent ?? ""

/** The scheme the list is ordered by, so the expectation is not a literal copy of it. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/**
 * The names on screen, compared as a set rather than as a sequence.
 *
 * The list is sorted for the reader, so an expectation written in the order the
 * names were declared or added answers a question nobody asked - and it stops
 * being right the moment a single name is added that belongs earlier in the
 * alphabet than several that are already there. Most cases here are about which
 * names are on the list; the ones about the order read `tags()` directly.
 */
const expectNames = (expected: string[]) =>
  expect([...tags()].sort((left, right) => collator.compare(left, right)))
    .toEqual([...expected].sort((left, right) => collator.compare(left, right)))

describe("ScanIgnoreEditor", () => {
  it("shows the built-in names and the configured ones in a single list, in one order", () => {
    const { onSave } = open(["output"])
    // One list, one kind of tag. The built-ins are not drawn differently, because
    // to the person reading it a directory the scan skips is a directory the scan
    // skips; the only thing that makes them different is the question on removal.
    //
    // Sorted, and sorted as one list: `builtIn` arrives in whatever order it was
    // declared in and a user's own names land after it, which is not an order
    // anyone looks a name up in. Asserted against the sorted list rather than
    // against the declaration so the test says what the reader sees.
    expect(tags()).toEqual([...BUILT_IN, "output"].sort((left, right) => collator.compare(left, right)))
    // A name the user added sits among the built-ins rather than after them.
    expect(tags().indexOf("output")).toBeLessThan(tags().length - 1)
    // Opening the dialog is not an edit: nothing is sent until Save says so.
    expect(onSave).not.toHaveBeenCalled()
  })

  it("sorts numbers as numbers and leaves the order alone when searching", async () => {
    // Names that no built-in contains, so searching for one of them matches the
    // two added and nothing else - `__pycache__` contains "cache" and would have
    // come along for the ride.
    const { user } = open(["output", "zeta10", "zeta2"])
    // `zeta2` before `zeta10`: compared as text these are in the other order,
    // because "1" sorts before "2". A directory list a person reads by eye is not
    // a list they expect to be wrong in.
    const names = tags()
    expect(names.indexOf("zeta2")).toBeLessThan(names.indexOf("zeta10"))

    await user.clear(screen.getByRole("textbox", { name: t("ignoredScanDirectoriesSearch") }))
    await user.type(screen.getByRole("textbox", { name: t("ignoredScanDirectoriesSearch") }), "zeta")
    // The order a filtered list is in is the order it had, not a fresh sort of the
    // handful that survived - the same names, in the same places.
    expect(tags()).toEqual(["zeta2", "zeta10"])
  })

  it("marks the built-in names apart in colour, and only in colour", () => {
    const { user } = open(["output"])
    // Colour is a hint that this one will ask before it goes. It is not what makes
    // it ask, and it is not the only thing that says so - so the two halves are
    // worth checking apart: the tint, and the question that follows a click.
    // Also a set, for the same reason: which names are tinted, not where they sit.
    expect([...shippedTags()].sort((left, right) => collator.compare(left, right)))
      .toEqual([...BUILT_IN].sort((left, right) => collator.compare(left, right)))
    // A name that got its tint from the Host and one the user typed are the same
    // kind of tag to every control here, which is what "asks first" is worth.
    expect(screen.getByRole("button", { name: format(t("ignoredScanDirectoriesRemove"), { name: "output" }) })).not.toBeNull()
    expect(screen.getByRole("button", { name: format(t("ignoredScanDirectoriesRemove"), { name: "target" }) })).not.toBeNull()
    void user
  })

  it("starts from what the Host serves, with the built-in names it no longer skips absent", () => {
    // A name the configuration switched off is simply not on the list. It is not
    // drawn greyed out in a section of its own: the question this dialog answers is
    // "what will the scan skip", and a name it will not skip is not part of it.
    open(["output"], ["target"])
    expectNames(["node_modules", "__pycache__", "output"])
  })

  it("adds a name, and only sends it when saved", async () => {
    const { user, onSave } = open()
    await user.click(screen.getByRole("button", { name: t("ignoredScanDirectoriesAdd") }))
    await user.type(screen.getByRole("textbox", { name: t("ignoredScanDirectoriesAdd") }), "output")
    expect(onSave).not.toHaveBeenCalled()
    await user.click(confirmAdd())
    expectNames([...BUILT_IN, "output"])
    expect(onSave).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: t("configSave") }))
    // Added names and names taken away are read back out of one list, so the two
    // can never drift into a name that is in both or in neither.
    expect(onSave).toHaveBeenCalledWith(["output"], [])
  })

  it("adding a name that is already on the list changes nothing, and says nothing", async () => {
    const { user, onSave } = open(["output"])
    // Both kinds: a name the user added, and one the Host ships. Neither is a
    // mistake worth reporting and neither makes a second entry - the answer is the
    // list as it stands, which is what an idempotent add has to mean.
    for (const name of ["OUTPUT", "node_modules"]) {
      await user.click(screen.getByRole("button", { name: t("ignoredScanDirectoriesAdd") }))
      await user.type(screen.getByRole("textbox", { name: t("ignoredScanDirectoriesAdd") }), name)
      await user.click(confirmAdd())
    }
    expectNames([...BUILT_IN, "output"])
    expect(screen.queryByRole("alert")).toBeNull()
    await user.click(screen.getByRole("button", { name: t("configSave") }))
    expect(onSave).toHaveBeenCalledWith(["output"], [])
  })

  it("never shows the same name twice, whatever the configuration carried", () => {
    // A configuration written by hand, or by an older build, can hold a repeat.
    // Two tags that read alike and mean the same thing would be two answers to a
    // question with one.
    const { onSave } = open(["output", "OUTPUT", "Output", "NODE_MODULES"])
    expectNames([...BUILT_IN, "output"])
    expect(onSave).not.toHaveBeenCalled()
  })

  it("takes a name the user added away in one click, and records nothing built-in", async () => {
    const { user, onSave } = open(["output", "logs", "tmp"])
    await user.click(removeButton("logs"))
    expectNames([...BUILT_IN, "output", "tmp"])
    await user.click(screen.getByRole("button", { name: t("configSave") }))
    expect(onSave).toHaveBeenCalledWith(["output", "tmp"], [])
  })

  it("asks in a dialog of its own, naming the directory, before taking a built-in away", async () => {
    const { user, onSave } = open(["output"])
    await user.click(removeButton("target"))
    // The cost of this lands on the next scan rather than on this dialog, which is
    // why it is asked: twenty-odd bare crosses is the shape that gets clicked
    // through, and a scan that then walks node_modules is a scan that stops.
    //
    // A dialog rather than an expanded tag. The tag row is a wrapping grid of
    // chips, and a sentence plus two buttons inside a 28px chip breaks the run of
    // them - at this width the sentence wraps to three lines in a row that grew to
    // hold it. It also names the directory, because "are you sure?" about which of
    // twenty-odd names is a question nobody can answer from the prompt alone.
    expect(asking()).toBe(true)
    expect(questionText()).toContain("target")
    expectNames([...BUILT_IN, "output"])
    expect(onSave).not.toHaveBeenCalled()
  })

  it("cancelling the question leaves the built-in name alone", async () => {
    const { user, onSave } = open()
    await user.click(removeButton("target"))
    await user.click(declineQuestion())
    expect(asking()).toBe(false)
    expectNames(BUILT_IN)
    await user.click(screen.getByRole("button", { name: t("configSave") }))
    expect(onSave).toHaveBeenCalledWith([], [])
  })

  it("confirming takes the built-in name off the list and into the removal setting", async () => {
    const { user, onSave } = open(["output"])
    await user.click(removeButton("target"))
    await user.click(confirmQuestion())
    // Gone from the list, and recorded as a removal rather than as an omission: a
    // name missing from the list is ambiguous - added by nobody, or taken off by
    // somebody - and only the second one is something the Host has to be told.
    expectNames(["node_modules", "__pycache__", "output"])
    await user.click(screen.getByRole("button", { name: t("configSave") }))
    expect(onSave).toHaveBeenCalledWith(["output"], ["target"])
  })

  it("takes a built-in name away and puts it back without asking the second time", async () => {
    const { user, onSave } = open()
    await user.click(removeButton("target"))
    await user.click(confirmQuestion())
    await user.click(removeButton("__pycache__"))
    await user.click(confirmQuestion())
    expectNames(["node_modules"])
    // Back on the list, and back in force. Typed into the add box rather than
    // restored from somewhere else, because the list is the whole of what is kept:
    // a built-in name on it is skipped whether or not either setting mentions it.
    await user.click(screen.getByRole("button", { name: t("ignoredScanDirectoriesAdd") }))
    await user.type(screen.getByRole("textbox", { name: t("ignoredScanDirectoriesAdd") }), "target")
    await user.click(confirmAdd())
    expectNames(["node_modules", "target"])
    await user.click(screen.getByRole("button", { name: t("configSave") }))
    // `target` needs no entry in either setting, which is what stops a name from
    // ending up in neither one - where the Host would read the absence as "still
    // skip it" and quietly disagree with a list showing it as present.
    expect(onSave).toHaveBeenCalledWith([], ["__pycache__"])
  })

  it("says what an empty list means", async () => {
    const { user } = open()
    for (const name of BUILT_IN) {
      await user.click(removeButton(name))
      await user.click(confirmQuestion())
    }
    // Not a shrug of a message: an empty list is a scan that walks every directory
    // under the Workspace, and a user who arrives at it by accident should know.
    expect(screen.getByText(t("ignoredScanDirectoriesNone"))).toBeTruthy()
  })

  it("finds a name by typing part of it", async () => {
    const { user } = open(["output", "logs"])
    const search = screen.getByRole("textbox", { name: t("ignoredScanDirectoriesSearch") })
    await user.type(search, "out")
    expectNames(["output"])
    await user.clear(search)
    await user.type(search, "nothing-like-this")
    expect(tags()).toEqual([])
    expect(screen.getByText(t("ignoredScanDirectoriesNoMatch"))).toBeTruthy()
  })

  it("sends an empty pair when everything is put back to the built-ins", async () => {
    // Empty is a value here, not an absence of one: it means "nothing beyond what
    // the Host ships", and that has to be a thing the user can ask for.
    const { user, onSave } = open(["output"], ["target"])
    await user.click(removeButton("output"))
    await user.click(screen.getByRole("button", { name: t("ignoredScanDirectoriesAdd") }))
    await user.type(screen.getByRole("textbox", { name: t("ignoredScanDirectoriesAdd") }), "target")
    await user.click(confirmAdd())
    await waitFor(() => expect(screen.queryByText(t("ignoredScanDirectoriesNone"))).toBeNull())
    await user.click(screen.getByRole("button", { name: t("configSave") }))
    // Back to where it started: `target` is on the list and the Host ships it, so
    // it needs no entry in either setting. Writing `target` into the additions here
    // would be the same behaviour reached by a longer road, and one a rename would
    // quietly strand.
    expect(onSave).toHaveBeenCalledWith([], [])
  })

  it("cancelling sends nothing at all", async () => {
    const { user, onSave, onClose } = open(["output"])
    await user.click(removeButton("output"))
    await user.click(removeButton("target"))
    await user.click(confirmQuestion())
    await user.click(discard())
    expect(onSave).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it("offers no corner close button, because 取消 already is that way out", async () => {
    const { user } = open()
    await user.click(removeButton("__pycache__"))
    expect(screen.getByText(/仓库扫描会进入这个目录/)).toBeTruthy()
    // The corner button sat on the first line of the sentence, and it was the same
    // way out as the 取消 button already in the footer.
    expect(screen.queryByRole("button", { name: t("close") })).toBeNull()
    expect(screen.getByRole("button", { name: t("cancel") })).toBeTruthy()
  })

  it("refuses a path rather than storing a name the walk could never match", async () => {
    const { user, onSave } = open()
    await user.click(screen.getByRole("button", { name: t("ignoredScanDirectoriesAdd") }))
    const input = screen.getByRole("textbox", { name: t("ignoredScanDirectoriesAdd") })
    await user.type(input, "a/b")
    // A directory name is one path component. A name with a separator in it is not
    // a name, and storing it would be a setting that looks like it does something.
    expect(confirmAdd().disabled).toBe(true)
    await user.clear(input)
    await user.type(input, "  output  ")
    // A name typed with room around it is the name, not a name with spaces in it.
    await user.click(confirmAdd())
    expectNames([...BUILT_IN, "output"])
    expect(onSave).not.toHaveBeenCalled()
  })

  it("refuses one more than the ceiling, and says what to do about it", async () => {
    const full = Array.from({ length: MAX_IGNORED_SCAN_DIRECTORIES }, (_, index) => `dir-${index}`)
    const { user, onSave } = open(full)
    // Not disabled: a control that stops working is the one reply that leaves a
    // user with nothing to act on. The click is answered with the reason.
    await user.click(screen.getByRole("button", { name: t("ignoredScanDirectoriesAdd") }))
    expect(screen.getByRole("alert").textContent).toBe(format(t("ignoredScanDirectoriesFull"), { count: String(MAX_IGNORED_SCAN_DIRECTORIES) }))
    // The row does not open onto an input that would then refuse the name, which
    // is the same refusal one click later and reads as the button being broken.
    expect(screen.queryByRole("textbox", { name: t("ignoredScanDirectoriesAdd") })).toBeNull()
    expect(onSave).not.toHaveBeenCalled()
  })

  it("takes a name again once one has been taken off", async () => {
    const full = Array.from({ length: MAX_IGNORED_SCAN_DIRECTORIES }, (_, index) => `dir-${index}`)
    const { user, onSave } = open(full)
    await user.click(screen.getByRole("button", { name: t("ignoredScanDirectoriesAdd") }))
    await user.click(removeButton("dir-0"))
    // The banner has served its purpose; it is not left standing over a list that
    // is no longer full.
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
    await user.click(screen.getByRole("button", { name: t("ignoredScanDirectoriesAdd") }))
    await user.type(screen.getByRole("textbox", { name: t("ignoredScanDirectoriesAdd") }), "output")
    await user.click(confirmAdd())
    await user.click(screen.getByRole("button", { name: t("configSave") }))
    expect(onSave).toHaveBeenCalledWith([...full.slice(1), "output"], [])
  })

  it("lets a built-in name be removed at the ceiling", async () => {
    // The ceiling is on the names the user brings, which is where a runaway comes
    // from. Taking a built-in out of the list makes room rather than adding to it.
    const full = Array.from({ length: MAX_IGNORED_SCAN_DIRECTORIES }, (_, index) => `dir-${index}`)
    const { user, onSave } = open(full, ["target"])
    await user.click(removeButton("__pycache__"))
    await user.click(confirmQuestion())
    await user.click(screen.getByRole("button", { name: t("configSave") }))
    expect(onSave).toHaveBeenCalledWith(full, ["target", "__pycache__"])
  })
})

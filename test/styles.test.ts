import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const styles = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8")

/** One rule's declarations, by its exact selector. */
function rule(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = styles.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`))
  return match?.[1] ?? ""
}

describe("floating panel surface", () => {
  it("keeps the depth select's chevron inside the box it belongs to", () => {
    // The select fills the box the chevron is positioned against; sizing the
    // select to its content instead left the chevron in a gap beside the control.
    expect(rule(".dws-depth-box")).toContain("position: relative")
    expect(rule(".dws-depth-box .dws-select")).toContain("width: 100%")
    expect(rule(".dws-depth-box > svg")).toContain("position: absolute")
  })

  it("fills the dialog with an opaque layered surface", () => {
    const dialog = rule(".dws-dialog-content")
    expect(dialog).not.toBe("")
    expect(dialog).toContain("background: var(--wt-surface)")
  })

  it("gives the create form room while confirmations stay narrow", () => {
    expect(rule(".dws-dialog-content")).toContain("width: min(460px, calc(100vw - 32px))")
    // One and a half times the confirmation width.
    expect(rule(".dws-create-dialog")).toContain("width: min(690px, calc(100vw - 32px))")
  })

  it("keeps the create form inside a 1080p viewport without scrolling", () => {
    // These numbers are what let the whole form fit a 1080p window: a taller cap
    // than a confirmation gets, and the spacing chosen to stay under it. Raising
    // the spacing means re-checking that the scrollbar stays away.
    expect(rule(".dws-create-dialog")).toContain("max-height: min(840px, calc(100dvh - 32px))")
    expect(rule(".dws-field")).toContain("margin: 0 0 15px")
    expect(rule(".dws-dialog-body")).toContain("padding: 16px 24px 18px")
  })

  it("lays the preview out in two columns, one fact per column", () => {
    expect(rule(".dws-preview")).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))")
    // Nothing spans both columns: the two facts it reports share the line.
    expect(rule(".dws-preview-row:last-child")).toBe("")
  })

  it("sizes the preview's label column to its label, never splitting one", () => {
    // A fixed label column cut a label mid-word once the label carried a count;
    // the value wraps inside its own column instead.
    expect(rule(".dws-preview-row")).toContain("grid-template-columns: max-content minmax(0, 1fr)")
  })

  it("never paints a surface with a translucent menu token", () => {
    // --dsw-specific-menu is about 58% opaque. It exists for menus over content
    // that should stay visible, and using it as a dialog background let the page
    // show through the panel.
    expect(styles).not.toContain("--dsw-specific-")
  })

  it("keeps every surface token the dialog reads defined on the dialog itself", () => {
    // The dialog renders in the shell overlay, outside the settings panel, so it
    // cannot inherit the settings scope's custom properties.
    const scope = rule(".dws-settings, .dws-dialog-content, .dws-new-session-action, .dws-footer-action")
    expect(scope).not.toBe("")
    for (const token of ["--wt-surface", "--wt-line", "--wt-text"]) expect(scope).toContain(`${token}:`)
  })
})

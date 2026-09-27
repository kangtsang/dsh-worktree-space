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
  it("warns in one amber, defined once", () => {
    // The plugin's warnings were the alias theme's amber-600, which sat close enough to the
    // error red to read twice on one row. They name a single token now, so the tone is set
    // in one place instead of in every rule that wears it. The exact hex is checked so the
    // token cannot silently lose its value or be re-pointed back at the alias amber.
    const root = rule(".dws-settings, .dws-dialog-content, .dws-manage-page, .dws-new-session-action, .dws-footer-action")
    expect(root).toContain("--wt-warn: #fe9a00")
    expect(styles).not.toContain("amber-600")
    for (const selector of [".dws-status-unavailable", ".dws-status-pending .dws-status-dot", ".dws-space-status"]) {
      expect(rule(selector)).toContain("var(--wt-warn)")
    }
    expect(rule(".dws-notice")).toContain("var(--wt-warn)")
  })

  it("draws the plugin's own mark in the label's ink, not in the warning amber", () => {
    // The sidebar row and the footer shortcut wear the plugin's mark. It was amber,
    // which read as a warning beside a green state dot; it is the ordinary label ink
    // now, and takes the foreground from the theme so it survives a dark surface.
    expect(rule(".dws-brand-glyph")).toContain("var(--dsw-alias-label-primary)")
    expect(styles).not.toContain("amber-400")
  })

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
    const scope = rule(".dws-settings, .dws-dialog-content, .dws-manage-page, .dws-new-session-action, .dws-footer-action")
    expect(scope).not.toBe("")
    for (const token of ["--wt-surface", "--wt-line", "--wt-text"]) expect(scope).toContain(`${token}:`)
  })

  it("draws one navigation for both hosts of the page", () => {
    // The panel's column and the dialog's are one component, so the row geometry lives
    // in one rule and the two frames differ only in the width and the inset they set.
    const nav = rule(".dws-nav")
    expect(nav).toContain("width: var(--dws-nav-width)")
    expect(nav).toContain("padding: var(--dws-nav-pad)")
    expect(rule(".dws-nav-item")).toContain("justify-content: var(--dws-nav-align)")
    // The label hugs the column's inner edge in both, the way the shell's own rows do:
    // the dialog tunes the width and the inset, and must not move the text.
    expect(nav).toContain("--dws-nav-align: flex-end")
    const dialogNav = rule(".dws-manage-page .dws-nav")
    expect(dialogNav).toContain("border-right: 0")
    expect(dialogNav).not.toContain("--dws-nav-align")
  })

  it("nests a repository's worktrees as a block instead of hanging them off a rail", () => {
    // The tree's guide was a rail plus a connector per row; for a hierarchy that is
    // never deeper than one level it was one line of chrome per level, so the rows are
    // an inset block under their parent now — and nothing draws a line into them.
    expect(styles).not.toContain(".dws-worktree::before")
    const list = rule(".dws-worktree-list")
    expect(list).not.toContain("border-left")
    // The block is not a surface of its own either: its rows are the same white as the
    // row above, so the indent alone carries the hierarchy.
    expect(list).not.toContain("background")
    expect(list).not.toContain("border-radius")
  })

  it("indents a child's icon onto the column its parent's name starts on", () => {
    // A child used to start at the list's own padding, so its folder sat under the
    // parent's folder and read as a sibling. It starts where the parent's name does —
    // past that row's chevron, icon and the gap after it — so one folder sits *under*
    // another; the tokens come from the list so a size change moves the indent with it.
    const tokens = rule(".dws-repo-list")
    expect(tokens).toContain("--dws-chevron-size: 14px")
    expect(tokens).toContain("--dws-row-gap: 9px")
    expect(tokens).toContain("--dws-lead-icon: 24px")
    expect(rule(".dws-chevron-placeholder")).toContain("width: var(--dws-chevron-size)")
    expect(rule(".dws-repo-toggle")).toContain("gap: var(--dws-row-gap)")
    const list = rule(".dws-worktree-list")
    expect(list).toContain("padding: 4px 12px 5px calc(var(--dws-chevron-size) + var(--dws-row-gap) + var(--dws-lead-icon) + var(--dws-row-gap))")
  })

  it("draws nothing between a parent row and the rows it holds", () => {
    // The indent was once spent on two more guides — a hairline rail down the block and a
    // tab bridging the gap up to the parent's icon — and the offset alone carries the
    // hierarchy without them, so neither pseudo-element is left to draw a line.
    expect(styles).not.toContain(".dws-worktree-list::before")
    expect(styles).not.toContain(".dws-worktree-list::after")
  })

  it("draws the picker's checkbox as a ticked tile, not as a filled dot", () => {
    // A chosen repository used to be a small filled square — the same mark a selected
    // radio wears — which read as a bullet rather than as a box someone ticked.
    const checked = rule(".dws-checkbox:checked")
    expect(checked).toContain("background: var(--dsw-alias-button-primary-fill)")
    // The tick is two borders of a rotated box, so it needs no mask or glyph to load.
    const tick = rule(".dws-checkbox::before")
    expect(tick).toContain("border-left:")
    expect(tick).toContain("border-bottom:")
    expect(tick).toContain("rotate(-45deg)")
    // Both states of the tick are drawn, so a chosen repository cannot render empty.
    expect(rule(".dws-checkbox:checked::before")).toContain("scale(1)")
    // The whole card is the state, not only its corner: a chosen one is bordered and tinted.
    expect(rule(".dws-check-option:has(.dws-checkbox:checked)")).toContain("background: var(--wt-soft)")
  })

  it("sizes every status dot once, whatever colour it wears", () => {
    // The amber dot only looked bigger than the green one: both were 7.5px, and measuring a
    // 4x screenshot of the panel found five blobs of exactly 30x30 device pixels. The size
    // therefore lives on the dot element alone and every state only ever sets its colour,
    // so no state can grow its dot without this notice.
    const dot = rule(".dws-status-dot")
    expect(dot).toContain("width: 7.5px")
    expect(dot).toContain("height: 7.5px")
    expect(dot).toContain("border-radius: 50%")
    // The fill follows the state's text colour, which is what keeps one size rule enough.
    expect(dot).toContain("background: currentColor")
    expect(rule(".dws-status-dirty .dws-status-dot, .dws-status-zero .dws-status-dot")).toContain("color: var(--wt-warn)")
    expect(rule(".dws-status-clean .dws-status-dot")).toContain("color: var(--dsw-alias-state-success-primary)")
  })

  it("gives the typed setting the width of the controls beside it, in both states", () => {
    // A field that stretches across the row reads as a different kind of control than the
    // selects it sits among. The number is the select's own rendered width, measured off a
    // screenshot of the card rather than guessed: the first attempt at this was wider than
    // the pill beside it and the row had to be re-measured.
    expect(rule(".dws-plugin-config-text")).toContain("92px")
    // Locked and editing occupy that same column, at the select's height, so the row does
    // not move when the field appears - the bug that made this two elements instead of one.
    expect(rule(".dws-plugin-config-locked")).toContain("36px")
    expect(rule(".dws-plugin-config-edit")).toContain("min-height: 36px")
    // The visible box is the wrapper: the input inside it cannot be trusted to be 36px,
    // because the Host styles inputs outside this plugin's cascade layer.
    expect(rule(".dws-plugin-config-edit .dws-input")).toContain("min-height: 0 !important")
  })
})

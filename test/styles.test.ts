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
    // A tenth wider than the 690px that was one and a half times the
    // confirmation width; the archive dialog kept the 690px.
    expect(rule(".dws-create-dialog")).toContain("width: min(759px, calc(100vw - 32px))")
    expect(rule(".dws-finish-dialog")).toContain("width: min(690px, calc(100vw - 32px))")
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
    // in one rule and the two frames differ only in the width and the inset they set. The
    // width is the host's to declare, with the column's own as a fallback: the panel's back
    // row sits outside the column, in the heading's band, and takes the same width from the
    // same variable, which is what keeps the two bands one column.
    const nav = rule(".dws-nav")
    expect(nav).toContain("width: var(--dws-nav-width, 208px)")
    expect(nav).toContain("padding: var(--dws-nav-pad)")
    expect(rule(".dws-nav-item")).toContain("justify-content: var(--dws-nav-align)")
    // The label hugs the column's inner edge in both, the way the shell's own rows do:
    // the dialog tunes the width and the inset, and must not move the text.
    expect(nav).toContain("--dws-nav-align: flex-end")
    expect(rule(".dws-panel")).toContain("--dws-nav-width: 208px")
    expect(rule(".dws-panel-lead-nav")).toContain("width: var(--dws-nav-width)")
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

  it("gives both typed settings one length, in both states", () => {
    // Two rows a reader types into, so one length for both - half of what the path row used
    // to stretch to (472px, measured off a screenshot of the card). One field stretching
    // across the line while the other sat narrow beside it read as two kinds of control.
    expect(rule(".dws-plugin-config-text")).toContain("236px")
    // Nothing gives either typed row a width of its own any more: a second rule here would
    // put the two back out of line, which is the whole point of the shared column.
    expect(rule(".dws-plugin-config-wide .dws-plugin-config-text")).toBe("")
    // Locked and editing occupy that same column, at the select's height, so the row does
    // not move when the field appears - the bug that made this two elements instead of one.
    expect(rule(".dws-plugin-config-locked")).toContain("36px")
    expect(rule(".dws-plugin-config-edit")).toContain("min-height: 36px")
    // The visible box is the wrapper: the input inside it cannot be trusted to be 36px,
    // because the Host styles inputs outside this plugin's cascade layer.
    expect(rule(".dws-plugin-config-edit .dws-input")).toContain("min-height: 0 !important")
  })

  it("keeps the toolbar out of the scroller and the rows inside it", () => {
    // The list used to be the whole page in one scroller, so a search box and a set of
    // filters left the screen as soon as the rows got long. The section is a column now:
    // one pinned block above, and one element below it that scrolls, so both hosts pin
    // the same things without either of them knowing about it.
    expect(rule(".dws-settings")).toContain("min-height: 0")
    expect(rule(".dws-settings")).toContain("overflow: hidden")
    expect(rule(".dws-settings-pinned")).toContain("flex: none")
    const body = rule(".dws-list-body")
    expect(body).toContain("flex: 1 1 auto")
    expect(body).toContain("min-height: 0")
    expect(body).toContain("overflow: auto")
    // The hairline that separates the toolbar from the rows belongs to the boundary
    // between them, so it stays where the rows start rather than riding the first row.
    expect(body).toContain("border-top: 1px solid var(--wt-line)")
    // The two frames let the section fill them: the panel's column and the dialog's,
    // each of which now hands its height down instead of scrolling by itself.
    expect(rule(".dws-panel-content")).toContain("display: flex")
    expect(rule(".dws-panel-content > .dws-settings")).toContain("flex: 1 1 auto")
    expect(rule(".dws-manage-page-content")).toContain("overflow: hidden")
    // And nothing else claims the border the boundary just took over.
    expect(rule(".dws-repo-list")).not.toContain("border-top")
  })

  it("hands the panel's height down instead of letting the panel scroll", () => {
    // The section was a column, but the frame above it was not: `.dws-panel-scroll` kept
    // `overflow: auto` while its child grew to its natural height, so in the panel (and
    // not in the dialog, which is bounded) the heading and the toolbar scrolled away with
    // the rows. The chain has to be bounded at every link for the list to be the only
    // scroller, which is what both hosts promise.
    const scroll = rule(".dws-panel-scroll")
    expect(scroll).toContain("display: flex")
    expect(scroll).toContain("flex-direction: column")
    expect(scroll).toContain("overflow: hidden")
    expect(scroll).not.toContain("overflow: auto")
    expect(rule(".dws-panel-content")).toContain("flex: 1 1 auto")
  })

  it("starts the panel's view tabs on the toolbar's line, in a band of their own", () => {
    // The panel held its navigation and its reading column in one row, with the way back
    // leading the column. The tabs therefore began under the back row while the search box
    // began under the page's heading, and the two columns disagreed about where their first
    // row was. The page is two bands now: the back row and the heading share the first, and
    // the second begins after it, which is what puts the tabs and the toolbar on one line.
    expect(rule(".dws-panel")).toContain("flex-direction: column")
    expect(rule(".dws-panel-lead")).toContain("flex: none")
    expect(rule(".dws-panel-body")).toContain("flex: 1 1 auto")
    expect(rule(".dws-panel-body")).toContain("overflow: hidden")
    // The heading's top inset moved into the band it shares with the back row, and the
    // reading column below lost its own, so nothing but the band positions the toolbar.
    expect(rule(".dws-panel-heading")).toContain("padding: 28px 32px 20px 24px")
    expect(rule(".dws-panel-content")).toContain("padding: 0 32px 48px 24px")
    // The column carries the settings' own 2px and no top inset besides.
    expect(rule(".dws-panel .dws-nav")).toContain("--dws-nav-pad: 2px 14px 24px")
  })
})

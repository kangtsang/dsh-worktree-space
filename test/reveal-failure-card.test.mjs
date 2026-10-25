import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const plugin = readFileSync(`${ROOT}src/client/plugin.tsx`, "utf8")
const styles = readFileSync(`${ROOT}src/client/styles.css`, "utf8")

/**
 * The failure card that reports a directory that would not open.
 *
 * Asserted against the source rather than by rendering: the overlay component needs the
 * whole shell around it - workspace service, plugin config, session service - and a
 * harness that invented all of them would be testing the harness. What is worth pinning
 * is the four properties below, each of which was wrong or missing at some point.
 */
describe("the failure card for opening a directory", () => {
  it("stays until dismissed instead of disappearing on a timer", () => {
    // An error that fades is one a reader can miss while looking at the window it is
    // about. There is no `setTimeout` on this state at all, which is the strong form of
    // the rule: nothing can take it down except a dismissal.
    const region = plugin.slice(plugin.indexOf("const [revealFailure"))
    const untilReturn = region.slice(0, region.indexOf("return <>"))
    expect(untilReturn).not.toMatch(/setTimeout|revealTimer/)
  })

  it("can be dismissed three ways: the button, Escape, and only those", () => {
    // The button is the visible one; Escape is what a reader reaches for when a corner
    // panel is covering the thing they were reading.
    expect(plugin).toContain('onClick={() => setRevealFailure(null)}')
    expect(plugin).toContain('event.key === "Escape"')
    expect(plugin).toMatch(/addEventListener\("keydown", onKey, true\)/)
    // And the listener is removed with the card, so a stale one cannot close a later one.
    expect(plugin).toMatch(/removeEventListener\("keydown", onKey, true\)/)
  })

  it("is announced as an alert, and its dismiss button is named", () => {
    // `role="alert"` is what makes a screen reader read it when it appears; a bare `div`
    // would leave the card silent for the reader least able to notice it visually.
    expect(plugin).toContain('role="alert"')
    expect(plugin).toContain('aria-label={t("close")}')
  })

  it("declares its own colour aliases, because it is not inside the plugin's surfaces", () => {
    // The `--wt-*` aliases are declared on `.dws-settings`, `.dws-dialog-content` and
    // friends. This card is fixed to the viewport as a sibling of the shell, so it is
    // none of those: every alias it read resolved to nothing, the declarations were
    // dropped whole, and it came out with no background, no border and no state colour.
    // That is the bug this pins.
    const start = styles.indexOf(".dws-error-card {")
    const rule = styles.slice(start, styles.indexOf("}", start) + 1)
    for (const alias of ["--wt-surface", "--wt-line", "--wt-danger", "--wt-text", "--wt-secondary"]) {
      expect(rule, `${alias} must be declared on the card itself`).toContain(`${alias}:`)
    }
    // And the surface it resolves to is the opaque one, not the alpha-carrying module tone.
    expect(rule).toContain("--wt-surface: var(--dsw-alias-bg-layer-1)")
    expect(rule).toContain("background: var(--wt-surface)")
    expect(rule).not.toContain("background: var(--wt-soft)")
    expect(rule).toContain("border-left: 3px solid var(--wt-danger)")
  })

  it("sizes itself from its content rather than from the viewport", () => {
    // A card that stretched to the viewport would be a panel. The first version let a
    // run of raw svg text set the height instead, which is what made it fill the screen.
    const start = styles.indexOf(".dws-error-card {")
    const rule = styles.slice(start, styles.indexOf("}", start) + 1)
    expect(rule).toContain("height: auto")
    expect(rule).toContain("max-height:")
  })

  it("sets the icon markup as html rather than as a text child", () => {
    // `menu-icons` returns svg markup as a string. The row menu inserts it by assignment,
    // but React escapes a string child: the first version printed the entire
    // `<svg xmlns=…>` on screen, and that run of text is what set the card's height.
    const card = plugin.slice(plugin.indexOf('className="dws-error-card"'), plugin.indexOf("</div>", plugin.indexOf("dws-error-card-close")) + 8)
    expect(card).toContain("dangerouslySetInnerHTML")
    // And never as a bare child of the mark or the close button.
    expect(card).not.toMatch(/>\s*\{alertIconSvg\}\s*</)
    expect(card).not.toMatch(/>\s*\{closeIconSvg\}\s*</)
  })

  it("reports a refusal, and has no error code to strip any more", () => {
    // The card used to lead with a sentence peeled off a Host `E6003: …` message. Both
    // actions now go through the host's own open-in-app capability, which answers
    // whether it accepted - so there is no code to parse, and the sentence is this
    // plugin's own words about a request the host declined.
    expect(plugin).toContain('t("workspaceRevealFailed")')
    expect(plugin).toContain('t("workspaceRevealUnavailable")')
    // No leftover machinery for a message shape that no longer exists.
    expect(plugin).not.toMatch(/raw\.replace\(\/\^E\\d\{4\}/)
  })
})

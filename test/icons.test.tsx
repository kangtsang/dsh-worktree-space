// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import * as icons from "../src/client/components/icons"

/**
 * The plugin draws its chrome from hugeicons now, behind the small adapter in
 * `icons.tsx`. What matters to every call site is that an icon still is a component
 * taking `size` and `className`, and that the glyph reaches the renderer with a stroke:
 * hugeicons' own data carries a per-path stroke, but the component only attaches a
 * stroke when it is given a width, and an icon with no stroke paints nothing.
 */
describe("the icon surface", () => {
  const names = ["FolderGit", "FolderGit2", "FolderClosed", "GitPullRequest", "AlertCircle", "Check", "Loader2", "X", "ChevronLeft", "ChevronRight", "ChevronDown", "Plus", "RefreshCw", "Search"] as const

  it("exports every glyph the components draw", () => {
    for (const name of names) expect(typeof icons[name], name).toBe("function")
  })

  it("draws a glyph at the size and class a call site asks for, in currentColor", () => {
    const markup = renderToStaticMarkup(<icons.FolderClosed size={18} className="dws-repo-icon" />)
    expect(markup).toContain('width="18"')
    expect(markup).toContain('height="18"')
    expect(markup).toContain('class="dws-repo-icon"')
    expect(markup).toContain('viewBox="0 0 24 24"')
    // The colour is the call site's, so an icon inherits the row it sits in.
    expect(markup).toContain('color="currentColor"')
    // The stroke is what makes the drawing visible; 1.5 is the family's own weight.
    expect(markup).toContain('stroke-width="1.5"')
    expect(markup).toContain('stroke="currentColor"')
    // A folder, not a dot: the glyph has geometry of its own.
    expect(markup).toContain("<path")
  })

  it("marks an icon decorative when the call site says so", () => {
    expect(renderToStaticMarkup(<icons.ChevronRight size={14} aria-hidden="true" />)).toContain('aria-hidden="true"')
  })

  it("draws the plugin's own mark as the lucide folder-git that named it", () => {
    // The one glyph outside the hugeicons family on purpose: this is the mark readers
    // already know the plugin by, so the drawing has to be lucide's, not a lookalike.
    const markup = renderToStaticMarkup(<icons.BrandGlyph size={18} className="dws-brand-glyph" aria-hidden="true" />)
    expect(markup).toContain('viewBox="0 0 24 24"')
    expect(markup).toContain('width="18"')
    expect(markup).toContain('height="18"')
    expect(markup).toContain('class="dws-brand-glyph"')
    expect(markup).toContain('stroke="currentColor"')
    // Lucide's own weight, and its two branch nodes.
    expect(markup).toContain('stroke-width="2"')
    expect(markup).toContain('cx="13"')
    expect(markup).toContain('cx="20"')
    expect(markup).toContain('d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5"')
  })
})

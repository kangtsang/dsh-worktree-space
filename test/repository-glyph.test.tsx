import { renderToStaticMarkup } from "react-dom/server"
import { FolderGit2 } from "lucide-react"
import { describe, expect, it } from "vitest"
import { repositoryGlyphMask } from "../src/client/components/repositoryGlyph"

const PREFIX = 'url("data:image/svg+xml,'

/** The mask's SVG source, decoded back out of the CSS value. */
function decodeMask() {
  expect(repositoryGlyphMask.startsWith(PREFIX)).toBe(true)
  expect(repositoryGlyphMask.endsWith('")')).toBe(true)
  return decodeURIComponent(repositoryGlyphMask.slice(PREFIX.length, -2))
}

describe("repository glyph mask", () => {
  it("restates exactly the icon it stands in for", () => {
    const real = renderToStaticMarkup(<FolderGit2 />)
    const mask = decodeMask()

    // Every shape the real icon draws appears in the mask, value for value.
    const geometry = [...real.matchAll(/ (d|cx|cy|r)="([^"]+)"/g)]
    expect(geometry.length).toBeGreaterThan(0)
    for (const [, name, value] of geometry) expect(mask).toContain(`${name}="${value}"`)

    // Same stroke setup as the icon, painted opaque: a mask reads alpha, not color.
    expect(real).toContain('stroke="currentColor"')
    expect(real).toContain("stroke-width=\"2\"")
    expect(real).toContain('fill="none"')
    expect(mask).toContain('stroke="#000"')
    expect(mask).toContain('fill="none"')
    for (const attribute of ['viewBox="0 0 24 24"', 'stroke-width="2"', 'stroke-linecap="round"', 'stroke-linejoin="round"']) {
      expect(real).toContain(attribute)
      expect(mask).toContain(attribute)
    }
  })

  it("draws no more shapes than the icon does", () => {
    const real = renderToStaticMarkup(<FolderGit2 />)
    const count = (markup: string) => [...markup.matchAll(/<(path|circle|rect|line|polyline|polygon|ellipse)\b/g)].length
    expect(count(decodeMask())).toBe(count(real))
  })
})

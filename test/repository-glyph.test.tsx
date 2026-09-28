import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { BrandGlyph, FolderGit2 } from "../src/client/components/icons"
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
    // The weight is the hugeicons family's own 1.5, which the component passes as a
    // prop and the mask carries on the outer `<svg>`.
    expect(real).toContain('stroke="currentColor"')
    expect(real).toContain('stroke-width="1.5"')
    expect(real).toContain('fill="none"')
    expect(mask).toContain('stroke="#000"')
    expect(mask).toContain('fill="none"')
    for (const attribute of ['viewBox="0 0 24 24"', 'stroke-width="1.5"', 'stroke-linecap="round"', 'stroke-linejoin="round"']) {
      expect(real).toContain(attribute)
      expect(mask).toContain(attribute)
    }
  })

  it("draws no more shapes than the icon does", () => {
    const real = renderToStaticMarkup(<FolderGit2 />)
    const count = (markup: string) => [...markup.matchAll(/<(path|circle|rect|line|polyline|polygon|ellipse)\b/g)].length
    expect(count(decodeMask())).toBe(count(real))
  })

  it("draws the plugin's own glyph on the tile the plugin list shows it on", () => {
    // The package's own mark, read from the package root vitest runs in.
    const shipped = readFileSync("icon.svg", "utf8")
    const shapes = (markup: string) => [...markup.matchAll(/ (d|cx|cy|r)="([^"]+)"/g)].map(([, name, value]) => `${name}=${value}`)

    // The drawing `BrandGlyph` makes, which leads the panel list, the footer and the
    // workspace selector: the plugin is recognised by this glyph wherever it appears.
    expect(shapes(shipped).length).toBeGreaterThan(0)
    expect(shapes(shipped)).toEqual(shapes(renderToStaticMarkup(<BrandGlyph />)))

    // Standing on the tile, which is the package's own and not the entries': square,
    // radius 40, the three-stop gradient running corner to corner.
    expect(shipped).toContain('width="510"')
    expect(shipped).toContain('height="510"')
    expect(shipped).toContain('rx="40"')
    const stops = [...shipped.matchAll(/<stop offset="([^"]+)" stop-color="([^"]+)"/g)].map(([, offset, color]) => `${offset} ${color}`)
    expect(stops).toEqual(["0.1 #fee7a8", "0.36 #ffeda0", "0.64 #efa5ff"])
  })
})

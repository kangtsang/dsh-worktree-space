// @vitest-environment jsdom
import { readFileSync } from "node:fs"
import { render } from "@testing-library/react"
import { FolderGit2 } from "lucide-react"
import { afterEach, describe, expect, it } from "vitest"
import { repositoryGlyphMask } from "../src/client/components/repositoryGlyph"

/**
 * The settings nav row is painted from geometry restated as CSS (a mask takes
 * shapes, not components), and the package's own mark is `icon.svg`. All three have
 * to be the same drawing, so this compares the shapes themselves rather than the
 * text that carries them.
 */
function shapes(svg: string) {
  return [...svg.matchAll(/<(path|circle)\b([^>]*?)\/?>/g)].map(([, tag, attributes]) => {
    const read = (name: string) => attributes.match(new RegExp(`${name}="([^"]+)"`))?.[1] ?? ""
    return tag === "path" ? `path ${read("d")}` : `circle ${read("cx")},${read("cy")},${read("r")}`
  })
}

/** The mask value as the SVG source it encodes. */
function decoded(mask: string) {
  const prefix = 'url("data:image/svg+xml,'
  expect(mask.startsWith(prefix)).toBe(true)
  return decodeURIComponent(mask.slice(prefix.length, -2))
}

afterEach(() => { document.body.innerHTML = "" })

describe("the plugin's own glyph", () => {
  it("is the icon the repository rows render", () => {
    const { container } = render(<FolderGit2 />)
    const rendered = container.querySelector("svg")!.outerHTML

    expect(shapes(decoded(repositoryGlyphMask))).toEqual(shapes(rendered))
  })

  it("is the mark this package ships as icon.svg", () => {
    // Read from the package root: vitest runs with the repository as its directory.
    const shipped = readFileSync("icon.svg", "utf8")

    expect(shapes(decoded(repositoryGlyphMask))).toEqual(shapes(shipped))
  })
})

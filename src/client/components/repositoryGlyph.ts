import type { ComponentProps } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import FolderGit2Icon from "@hugeicons/core-free-icons/FolderGit2Icon"

/**
 * The repository glyph — the hugeicons `FolderGit2Icon` the repository rows and their New
 * buttons render — restated as a `mask-image` value.
 *
 * The settings navigation row belongs to DSH, which takes no icon from a contributed
 * section, so the only way to give that row this shape is CSS. CSS needs the geometry as
 * data rather than as a component, so the shapes are written out here; `repository-glyph.test.tsx`
 * renders the real icon and compares the two, so they cannot drift apart unnoticed.
 *
 * The two say the same thing because they are the same drawing: the glyph's own tags and
 * attributes, with `stroke` swapped for the opaque black a mask reads and the stroke width
 * set where the drawing is a whole one rather than a part.
 *
 * The package's `icon.svg` — what the plugin list and the plugin's own page show — is a
 * different mark, and deliberately so: the plugin's own `BrandGlyph` on a gradient tile,
 * after the artwork. The test pins it to that pairing rather than to this one.
 *
 * TODO(DSH): the row is not ours to paint yet. As of DSH 0.1.7-rc.1 the
 * `settings.section` registrant options are `id`, `order` and `label` only, and the
 * settings shell picks a nav glyph from a fixed id-to-icon table, falling back to the
 * settings gear for every plugin section. Overriding it from here was tried and
 * withdrawn: marking the shell's row from the client only survives until React next
 * writes that button's `className`, which is on the next click. When the slot (or
 * the section options) accepts an icon, hand it this glyph — one line in the
 * registration — and delete this note.
 */
type GlyphNode = readonly [string, Readonly<Record<string, string | number>>]

/** The attributes the outer `<svg>` carries, which the mask and the icon share. */
const STROKE = {
  fill: "none",
  stroke: "#000",
  "stroke-width": "1.5",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
} as const

/**
 * A glyph's tags and attributes, as `@hugeicons/core-free-icons` exports them. The
 * package keeps this type to itself, so the shape is taken from the component that
 * consumes it rather than reached for through `dist/`.
 */
type Glyph = ComponentProps<typeof HugeiconsIcon>["icon"]

const attributes = (record: Readonly<Record<string, string | number>>) =>
  Object.entries(record)
    .filter(([name]) => name !== "stroke")
    .map(([name, value]) => `${name}="${value}"`)
    .join(" ")

const shapes = (glyph: Glyph) => (glyph as readonly GlyphNode[])
  .map(([tag, record]) => `<${tag} ${attributes(record)}/>`)
  .join("")

const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${Object.entries(STROKE).map(([name, value]) => `${name}="${value}"`).join(" ")}>${shapes(FolderGit2Icon)}</svg>`

/** The repository glyph as a `mask-image` value, painted in `currentColor` by the row. */
export const repositoryGlyphMask = `url("data:image/svg+xml,${encodeURIComponent(markup)}")`

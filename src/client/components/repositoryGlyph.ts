/**
 * The repository glyph — lucide's `FolderGit2`, the same icon the repository
 * rows and their New buttons render — restated as a `mask-image` value.
 *
 * The settings navigation row belongs to DSH, which takes no icon from a
 * contributed section, so the only way to give that row this shape is CSS. CSS
 * needs the geometry as data rather than as a component, so the shapes are
 * written out here; `repositoryGlyph.test.tsx` renders the real icon and
 * compares the two, so they cannot drift apart unnoticed.
 *
 * TODO(DSH): the row is not ours to paint yet. As of DSH 0.1.7-rc.1 the
 * `settings.section` registrant options are `id`, `order` and `label` only, and the
 * settings shell picks a nav glyph from a fixed id-to-icon table, falling back to
 * the settings gear for every plugin section. Overriding it from here was tried and
 * withdrawn: marking the shell's row from the client only survives until React next
 * writes that button's `className`, which is on the next click. When the slot (or
 * the section options) accepts an icon, hand it this glyph — one line in the
 * registration — and delete this note.
 */
type GlyphNode = readonly [string, Readonly<Record<string, string>>]

/** lucide's own stroke setup. A mask reads alpha, so the paint is opaque black. */
const STROKE = {
  fill: "none",
  stroke: "#000",
  "stroke-width": "2",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
} as const

const NODES: readonly GlyphNode[] = [
  ["path", { d: "M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5" }],
  ["circle", { cx: "13", cy: "12", r: "2" }],
  ["path", { d: "M18 19c-2.8 0-5-2.2-5-5v8" }],
  ["circle", { cx: "20", cy: "19", r: "2" }],
]

const attributes = (record: Readonly<Record<string, string>>) =>
  Object.entries(record).map(([name, value]) => `${name}="${value}"`).join(" ")

const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${attributes(STROKE)}>${NODES.map(([tag, record]) => `<${tag} ${attributes(record)}/>`).join("")}</svg>`

/** The repository glyph as a `mask-image` value, painted in `currentColor`. */
export const repositoryGlyphMask = `url("data:image/svg+xml,${encodeURIComponent(markup)}")`

/**
 * Lucide's `book-x`, restated as markup.
 *
 * The item this plugin adds to a DSH menu is built imperatively, in DSH's DOM,
 * so the icon has to arrive as markup rather than as an import from a package
 * this plugin does not depend on. The three paths are Lucide's own, on its
 * 24-unit grid, at the size the neighbouring rows use; nothing here paints a
 * colour of its own, so the item keeps the menu's hover and disabled colours.
 */
const VIEW_BOX = "0 0 24 24"
const SIZE = 14
const STROKE = 2
const PATHS = [
  "m14.5 7-5 5",
  "M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20",
  "m9.5 7 5 5",
]

/** Lucide's `book-x` as an SVG element string, stroked in the current colour. */
export const archiveIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="${VIEW_BOX}" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS.map((d) => `<path d="${d}" stroke="currentColor" stroke-width="${STROKE}"/>`).join("")}</svg>`

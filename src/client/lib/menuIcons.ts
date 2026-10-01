/**
 * The glyphs this plugin puts in DSH's own menus.
 *
 * Those items are built imperatively, in DSH's DOM, so an icon has to arrive as
 * markup rather than as an import from a package this plugin does not depend on.
 * Every path below is Lucide's own, on its 24-unit grid, at the size the
 * neighbouring rows use; nothing here paints a colour of its own, so an item keeps
 * the menu's hover and disabled colours.
 */

const VIEW_BOX = "0 0 24 24"
const SIZE = 14
const STROKE = 2

/** Lucide's `book-x`, which is what the shell's own removal rows wear. */
const ARCHIVE_PATHS = [
  "m14.5 7-5 5",
  "M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20",
  "m9.5 7 5 5",
]

/**
 * Lucide's `plus`: the glyph the management panel's own "New Worktree Space"
 * wears, at the menu's size rather than the panel's, so the row lines up with the
 * shell's rows beside it.
 */
const CREATE_PATHS = [
  "M5 12h14",
  "M12 5v14",
]

/** One Lucide glyph as an SVG element string, stroked in the current colour. */
const iconSvg = (paths: string[]) => `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="${VIEW_BOX}" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.map((d) => `<path d="${d}" stroke="currentColor" stroke-width="${STROKE}"/>`).join("")}</svg>`

/** Lucide's `book-x`, for the item that finishes a task space. */
export const archiveIconSvg = iconSvg(ARCHIVE_PATHS)

/** Lucide's `plus`, for the item that starts a task space. */
export const createIconSvg = iconSvg(CREATE_PATHS)

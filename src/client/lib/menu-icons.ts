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

/**
 * Lucide's `folder-open`, for the item that shows a Workspace in the file manager.
 *
 * A folder rather than an arrow-out-of-a-box: the row sits next to "New Worktree
 * Space", whose glyph is a folder's sibling, and the two are about the same thing -
 * the directory itself - which keeps them readable as a pair.
 */
const OPEN_PATHS = [
  "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2",
]

/** One Lucide glyph as an SVG element string, stroked in the current colour. */
const iconSvg = (paths: string[]) => `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="${VIEW_BOX}" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.map((d) => `<path d="${d}" stroke="currentColor" stroke-width="${STROKE}"/>`).join("")}</svg>`

/** Lucide's `book-x`, for the item that finishes a task space. */
export const archiveIconSvg = iconSvg(ARCHIVE_PATHS)

/** Lucide's `plus`, for the item that starts a task space. */
export const createIconSvg = iconSvg(CREATE_PATHS)

/** Lucide's `folder-open`, for the item that shows a directory in the file manager. */
export const openFolderIconSvg = iconSvg(OPEN_PATHS)

/**
 * The glyph for an IDE entry: Lucide's `code-xml`, a pair of angle brackets.
 *
 * Not the product's own logo. Those are trademarks, they would have to be shipped as
 * image files rather than be drawn here, and the same entry serves several products -
 * one neutral glyph keeps the menu readable as "open this in an editor".
 */
const IDE_PATHS = [
  "m18 16 4-4-4-4",
  "m6 8-4 4 4 4",
  "m14.5 4-5 16",
]

/** Lucide's `code-xml`, for the item that opens a directory in an IDE. */
export const ideIconSvg = iconSvg(IDE_PATHS)

/**
 * Lucide's `circle-alert`, for the mark on an error card.
 *
 * Its own size rather than the menu's: the card is a panel-level surface, and a 14px
 * glyph beside a two-line message reads as a bullet. The colour comes from the card.
 */
const ALERT_PATHS = [
  "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z",
  "M12 8v4",
  "M12 16h.01",
]

/** Lucide's `x`, for dismissing a card. */
const CLOSE_PATHS = [
  "M18 6 6 18",
  "m6 6 12 12",
]

const largeIconSvg = (paths: string[], size: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${VIEW_BOX}" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.map((d) => `<path d="${d}" stroke="currentColor" stroke-width="${STROKE}"/>`).join("")}</svg>`

/** Lucide's `circle-alert`, for the mark on an error card. */
export const alertIconSvg = largeIconSvg(ALERT_PATHS, 16)

/** Lucide's `x`, for the dismiss button on an error card. */
export const closeIconSvg = largeIconSvg(CLOSE_PATHS, 14)

/** Lucide's `chevron-right`, for a row that opens a submenu. */
const CHEVRON_PATHS = ["m9 18 6-6-6-6"]

/** Lucide's `chevron-right`, at the menu row's size. */
export const chevronIconSvg = largeIconSvg(CHEVRON_PATHS, 14)

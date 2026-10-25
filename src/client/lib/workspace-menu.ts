/**
 * Where the Web UI's workspace list keeps its identity, and how a menu finds it.
 *
 * DSH renders the Workspace row menu itself and projects no Workspace id into the
 * menu's markup, so an entry added to that menu cannot be told which row it
 * belongs to from where it renders. The row does carry the id, though — as
 * `data-row-key="workspace:<id>"` — and the row's own action button is inside it,
 * which is what lets an added item resolve its target instead of guessing it.
 */

/** Every row of the workspace list, workspace rows included. */
export const WORKSPACE_ROW = '[data-row-key^="workspace:"]'

/** Marks the items this plugin added, so they are never added twice. */
export const OWN_MENU_ITEM = "data-dws-menu-item"

/**
 * Marks a submenu this plugin opened.
 *
 * It is a `[role="menu"]` too, and the scan that fills the shell's row menu looks for
 * exactly that - so it carries its own attribute and the scan skips it. Without this a
 * submenu would be found, judged to belong to the remembered row, and filled with a
 * second copy of every entry.
 */
export const OWN_SUBMENU = "data-dws-submenu"

/**
 * Which row a submenu was opened from, so it can go when that row does.
 *
 * The value is the owning row's `OWN_MENU_ITEM` value. A menu the shell closed must not
 * leave a flyout standing: its rows would act on a workspace the user is no longer
 * looking at, and the menu it belongs to is gone.
 */
export const OWNER_ITEM = "data-dws-submenu-owner"

/** The trigger the workspace list renders inside each row. */
export const WORKSPACE_ROW_TRIGGER = "button"

/**
 * The Workspace id a row's key names.
 * @param value - the row's `data-row-key`.
 * @returns the Workspace id, or undefined when the key names something else.
 */
export function workspaceIdFromRowKey(value: string | null | undefined): string | undefined {
  const key = String(value ?? "")
  if (!key.startsWith("workspace:")) return undefined
  const id = key.slice("workspace:".length).trim()
  return id === "" ? undefined : id
}


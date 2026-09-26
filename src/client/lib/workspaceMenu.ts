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

/** Marks the item this plugin added, so it is never added twice. */
export const OWN_MENU_ITEM = "data-dws-archive-item"

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


import { useEffect } from "react"
import type { createWorktreeApi } from "../lib/api"
import { archiveIconSvg } from "../lib/archiveIcon"
import { useT } from "../lib/i18n"
import type { WorkspacesService } from "../lib/types"
import { OWN_MENU_ITEM, WORKSPACE_ROW, WORKSPACE_ROW_TRIGGER, workspaceIdFromRowKey } from "../lib/workspaceMenu"

/** How long after a row's trigger a newly opened menu still counts as that row's. */
const TRIGGER_WINDOW_MS = 1500

interface WorkspaceArchiveEntryProps {
  api: ReturnType<typeof createWorktreeApi>
  workspaces: WorkspacesService
  /** Called with the task container's path when the added item is chosen. */
  onArchive: (path: string) => void
}

/**
 * Adds "Archive workspace" to the workspace list's own row menu.
 *
 * DSH renders that menu itself and declares no slot for a workspace-level entry,
 * so this adapts to its markup: the row is identified by the `data-row-key` DSH
 * puts on it, the menu is the one that appeared just after that row's own trigger
 * was used, and the item is only added once the Host confirms the directory is a
 * task container. Nothing is added anywhere else, and a wrong guess costs an
 * entry that the dialog then refuses — never an archive of the wrong task.
 *
 * Owns no shell structure: the marker and the item it inserted are removed on
 * disposal, so the adaptation is HMR-safe.
 */
export function WorkspaceArchiveEntry({ api, workspaces, onArchive }: WorkspaceArchiveEntryProps) {
  const t = useT()

  useEffect(() => {
    let row: Element | null = null
    let triggeredAt = 0
    let active = true
    let scheduled = false
    let scanning = false
    /** Menus already asked about, so one open menu costs one Host query. */
    const decided = new WeakSet<Element>()

    const rememberRow = (event: Event) => {
      const target = event.target as Element | null
      const candidate = target?.closest?.(WORKSPACE_ROW) ?? null
      // Only a control in the row opens its menu; the row itself toggles open.
      if (candidate === null || target?.closest?.(WORKSPACE_ROW_TRIGGER) == null) return
      row = candidate
      triggeredAt = Date.now()
    }

    const insert = (menu: Element, path: string) => {
      const item = document.createElement("button")
      item.type = "button"
      item.setAttribute("role", "menuitem")
      item.setAttribute(OWN_MENU_ITEM, "")
      item.className = "dws-menu-item"
      const icon = document.createElement("span")
      icon.className = "dws-menu-item-icon"
      icon.innerHTML = archiveIconSvg
      const text = document.createElement("span")
      // Read at insertion time: the menu is built per open, and the interface
      // language can change while this component is mounted.
      text.textContent = t("archiveWorkspace")
      item.append(icon, text)
      item.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()
        // Close the shell's menu the way its own rows do, then open ours.
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
        onArchive(path)
      })
      // DSH's own rows are rename and delete; this belongs between them, so it goes
      // before delete. Every row is a button inside its own wrapper, and the indent
      // lives on the button, so this borrows the shell's own classes and its own
      // wrapper rather than inventing a look - a hand-made class sat to the right of
      // the other two, because the wrapper is the list item and it was not one.
      const rows = [...menu.querySelectorAll('[role="menuitem"]')]
      const dangerRow = rows.find((row) => typeof row.className === "string" && row.className.includes("danger"))
      const row = dangerRow ?? rows[rows.length - 1]
      const nativeWrap = row?.parentElement ?? null
      const list = nativeWrap?.parentElement ?? null
      const plain = rows.find((candidate) => candidate !== row && !String(candidate.className).includes("danger")) ?? row
      const nativeItemClass = String(plain?.className ?? "").split(/\s+/).filter((name) => name !== "" && !name.includes("selected")).join(" ")
      if (nativeItemClass !== "") item.className = `${nativeItemClass} dws-menu-item`
      const slot = document.createElement("div")
      if (typeof nativeWrap?.className === "string" && nativeWrap.className !== "") slot.className = nativeWrap.className
      slot.appendChild(item)
      if (row !== undefined && nativeWrap !== null && list !== null) list.insertBefore(slot, nativeWrap)
      else if (row !== undefined && nativeWrap !== null) nativeWrap.insertBefore(item, row)
      else menu.appendChild(item)
    }

    const attach = async () => {
      if (scanning || !active) return
      scanning = true
      try {
        for (const menu of document.querySelectorAll('[role="menu"]')) {
          if (decided.has(menu)) continue
          if (menu.querySelector(`[${OWN_MENU_ITEM}]`) !== null) continue
          const element = row
          if (element === null || !element.isConnected) continue
          if (Date.now() - triggeredAt > TRIGGER_WINDOW_MS) continue
          const workspaceId = workspaceIdFromRowKey(element.getAttribute("data-row-key"))
          if (workspaceId === undefined) continue
          const workspace = workspaces.list.getSnapshot().items.find((item) => item.workspaceId === workspaceId)
          if (workspace === undefined) continue
          decided.add(menu)
          let isTask = false
          try {
            isTask = (await api.inspectTask(workspace.path)).isTask
          } catch {
            isTask = false
          }
          if (!active || !isTask || !menu.isConnected) continue
          insert(menu, workspace.path)
        }
      } finally {
        scanning = false
      }
    }

    // A streaming conversation mutates the DOM constantly, so coalesce the bursts
    // into one scan per frame instead of one per mutation.
    const schedule = () => {
      if (scheduled || !active) return
      scheduled = true
      const run = () => { scheduled = false; void attach() }
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(run)
      else queueMicrotask(run)
    }

    document.addEventListener("pointerdown", rememberRow, true)
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      active = false
      document.removeEventListener("pointerdown", rememberRow, true)
      observer.disconnect()
      for (const item of document.querySelectorAll(`[${OWN_MENU_ITEM}]`)) item.remove()
    }
  }, [api, workspaces, onArchive, t])

  return null
}

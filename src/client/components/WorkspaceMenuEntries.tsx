import { useEffect } from "react"
import type { createWorktreeApi } from "../lib/api"
import { useT } from "../lib/i18n"
import { archiveIconSvg, createIconSvg } from "../lib/menuIcons"
import type { Workspace, WorkspacesService } from "../lib/types"
import { OWN_MENU_ITEM, WORKSPACE_ROW, WORKSPACE_ROW_TRIGGER, workspaceIdFromRowKey } from "../lib/workspaceMenu"

/** How long after a row's trigger a newly opened menu still counts as that row's. */
const TRIGGER_WINDOW_MS = 1500

/** One item this plugin puts in a workspace's own menu. */
interface MenuEntry {
  icon: string
  label: string
  choose: () => void
}

interface WorkspaceMenuEntriesProps {
  api: ReturnType<typeof createWorktreeApi>
  workspaces: WorkspacesService
  /** Whether a Workspace holds code repositories, so a task space can start there. */
  canCreate: (workspace: Workspace) => boolean
  /** Called with the Workspace to start a task space in. */
  onCreate: (target: Pick<Workspace, "path" | "title">) => void
  /** Called with the task container's path when the finish item is chosen. */
  onArchive: (path: string) => void
}

/**
 * Adds this plugin's own items to the workspace list's row menu: starting a task
 * space in a Workspace that holds repositories, and finishing one whose directory
 * is a task container.
 *
 * DSH renders that menu itself and declares no slot for a workspace-level entry,
 * so this adapts to its markup: the row is identified by the `data-row-key` DSH
 * puts on it, the menu is the one that appeared just after that row's own trigger
 * was used, and an item is only added once the Host confirms it belongs there.
 * Nothing is added anywhere else, and a wrong guess costs an entry that the dialog
 * then refuses — never an action on the wrong Workspace.
 *
 * Both items come from one adapter rather than two: they share the row, the menu
 * and the one scan that finds them, and one of them can then sit above the other
 * in a fixed order instead of wherever a second adapter's own timing put it.
 *
 * Owns no shell structure: the marker and the items it inserted are removed on
 * disposal, so the adaptation is HMR-safe.
 */
export function WorkspaceMenuEntries({ api, workspaces, canCreate, onCreate, onArchive }: WorkspaceMenuEntriesProps) {
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

    /**
     * The items that belong in this Workspace's menu.
     *
     * `canCreate` is the same classification the composer's own button reads, so
     * the two ways into a task space cannot disagree about where one can start.
     */
    const entriesFor = (workspace: Workspace, isTask: boolean): MenuEntry[] => [
      ...(canCreate(workspace)
        ? [{ icon: createIconSvg, label: t("workspaceCreate"), choose: () => onCreate({ path: workspace.path, title: workspace.title }) }]
        : []),
      ...(isTask
        ? [{ icon: archiveIconSvg, label: t("archiveWorkspace"), choose: () => onArchive(workspace.path) }]
        : []),
    ]

    const insert = (menu: Element, entries: MenuEntry[]) => {
      // DSH's own rows are rename and delete; these belong between them, so they go
      // before delete. Every row is a button inside its own wrapper, and the indent
      // lives on the button, so these borrow the shell's own classes and its own
      // wrapper rather than inventing a look - a hand-made class sat to the right of
      // the other two, because the wrapper is the list item and it was not one.
      const rows = [...menu.querySelectorAll('[role="menuitem"]')]
      const dangerRow = rows.find((row) => typeof row.className === "string" && row.className.includes("danger"))
      const anchorRow = dangerRow ?? rows[rows.length - 1]
      const nativeWrap = anchorRow?.parentElement ?? null
      const list = nativeWrap?.parentElement ?? null
      const plain = rows.find((candidate) => candidate !== anchorRow && !String(candidate.className).includes("danger")) ?? anchorRow
      const nativeItemClass = String(plain?.className ?? "").split(/\s+/).filter((name) => name !== "" && !name.includes("selected")).join(" ")

      for (const entry of entries) {
        const item = document.createElement("button")
        item.type = "button"
        item.setAttribute("role", "menuitem")
        item.setAttribute(OWN_MENU_ITEM, "")
        item.className = nativeItemClass === "" ? "dws-menu-item" : `${nativeItemClass} dws-menu-item`
        const icon = document.createElement("span")
        icon.className = "dws-menu-item-icon"
        icon.innerHTML = entry.icon
        const text = document.createElement("span")
        // Read at insertion time: the menu is built per open, and the interface
        // language can change while this component is mounted.
        text.textContent = entry.label
        item.append(icon, text)
        item.addEventListener("click", (event) => {
          event.preventDefault()
          event.stopPropagation()
          // Close the shell's menu the way its own rows do, then act.
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
          entry.choose()
        })
        if (anchorRow !== undefined && nativeWrap !== null && list !== null) {
          const slot = document.createElement("div")
          if (typeof nativeWrap.className === "string" && nativeWrap.className !== "") slot.className = nativeWrap.className
          slot.appendChild(item)
          // Each item goes immediately before the shell's last row, so listing them
          // in order is what puts them in order.
          list.insertBefore(slot, nativeWrap)
        } else if (anchorRow !== undefined && nativeWrap !== null) {
          nativeWrap.insertBefore(item, anchorRow)
        } else {
          menu.appendChild(item)
        }
      }
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
          const entries = entriesFor(workspace, isTask)
          if (!active || entries.length === 0 || !menu.isConnected) continue
          insert(menu, entries)
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
  }, [api, workspaces, canCreate, onCreate, onArchive, t])

  return null
}

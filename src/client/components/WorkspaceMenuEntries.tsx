import { useEffect } from "react"
import type { createWorktreeApi } from "../lib/api"
import { format, useT } from "../lib/i18n"
import { archiveIconSvg, chevronIconSvg, createIconSvg, ideIconSvg, openFolderIconSvg } from "../lib/menu-icons"
import type { Workspace, WorkspacesService } from "../lib/types"
import type { OpenCapability, OpenTarget } from "../lib/open-in-app"
import { OWNER_ITEM, OWN_MENU_ITEM, OWN_SUBMENU, WORKSPACE_ROW, WORKSPACE_ROW_TRIGGER, workspaceIdFromRowKey } from "../lib/workspace-menu"

/** How long after a row's trigger a newly opened menu still counts as that row's. */
const TRIGGER_WINDOW_MS = 1500

/**
 * How long a submenu survives the pointer leaving it.
 *
 * Long enough to cross the gap between the parent row and the flyout, short enough that
 * a pointer moving on does not leave a list behind.
 */
const CLOSE_DELAY_MS = 180

/** One item this plugin puts in a workspace's own menu. */
interface MenuEntry {
  icon: string
  /**
   * Whether the icon is a product's own svg rather than this plugin's glyph.
   *
   * Ours are drawn at 14px on a 24-unit grid by `menu-icons.ts`; a product's arrives at
   * whatever size its vendor chose (IDEA's is 64×64), so it needs a box the row
   * controls rather than its own dimensions.
   */
  iconFit?: boolean
  label: string
  choose: () => void
  /**
   * A submenu, offered when this row is hovered or activated.
   *
   * Used for the applications a directory can be opened with: the Host reports a list
   * that differs per machine, and putting every entry in the row menu would push the
   * shell's own rename and delete out of sight on a machine with a full toolchain.
   */
  submenu?: MenuEntry[]
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
  /**
   * Called with a Workspace's path when the reveal item is chosen.
   *
   * The caller owns what happens after: opening is a Host call that can fail in ways
   * worth reporting (no file manager, a directory since deleted), and reporting is the
   * panel's own surface, not a menu item's.
   */
  onReveal: (path: string) => void
  /** Called with a path and a Host application id when one is chosen from the submenu. */
  onOpenIn: (path: string, application: string) => void
  /**
   * What this deployment can open a directory with, asked of the Host.
   *
   * `null` until the probe returns. The entries appear once it does, so a menu opened
   * in the first moments after load simply has fewer rows rather than dead ones.
   */
  capability: OpenCapability | null
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
export function WorkspaceMenuEntries({ api, workspaces, canCreate, onCreate, onArchive, onReveal, onOpenIn, capability }: WorkspaceMenuEntriesProps) {
  const t = useT()

  useEffect(() => {
    let row: Element | null = null
    let triggeredAt = 0
    let active = true
    let scheduled = false
    let scanning = false
    /**
     * A counter for the identity each inserted row carries.
     *
     * Per effect rather than global: the values only have to be unique among the rows
     * on screen, and a fresh series each mount keeps a stale number from ever matching
     * a row that has since been replaced.
     */
    let itemId = 0
    /** A pending submenu close, so a pointer crossing the gap does not lose it. */
    let closeTimer: ReturnType<typeof setTimeout> | null = null
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
     * The same record from the keyboard, because the trigger is a button.
     *
     * A pointer records the row on the way down and the shell opens its menu on the
     * click after it; a keyboard user activates the same button and gets the same
     * menu, with nothing for this adapter to hear. Without this the row is whatever
     * the mouse was last used on, so a keyboard user who opened one row's menu
     * within the window after using the mouse on another gets that other Workspace's
     * actions — on a Workspace they never pointed at.
     */
    const rememberRowOnKey = (event: KeyboardEvent) => {
      // `Spacebar` is what older engines report for the key now named ` `.
      if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return
      rememberRow(event)
    }

    /**
     * The items that belong in this Workspace's menu.
     *
     * `canCreate` is the same classification the composer's own button reads, so
     * the two ways into a task space cannot disagree about where one can start.
     *
     * The reveal entry follows, and only when the Host says it can hand a path to a
     * desktop: an entry for something that cannot open anything fails on every press,
     * and a menu is the wrong place to report that.
     *
     * The applications are a SUBMENU rather than a row each. The Host reports whatever
     * the machine has installed - three editors on one machine, none on another - and a
     * flat list would push the shell's own rename and delete off the menu on a machine
     * with a full toolchain.
     */
    const entriesFor = (workspace: Workspace, isTask: boolean, apps: readonly OpenTarget[], fileManager: boolean): MenuEntry[] => [
      ...(canCreate(workspace)
        ? [{ icon: createIconSvg, label: t("workspaceCreate"), choose: () => onCreate({ path: workspace.path, title: workspace.title }) }]
        : []),
      ...(isTask
        ? [{ icon: archiveIconSvg, label: t("archiveWorkspace"), choose: () => onArchive(workspace.path) }]
        : []),
      ...(fileManager
        ? [{ icon: openFolderIconSvg, label: t("workspaceReveal"), choose: () => onReveal(workspace.path) }]
        : []),
      ...(apps.length === 0
        ? []
        : [{
            icon: ideIconSvg,
            label: t("workspaceOpenIn"),
            choose: () => { /* the row opens its submenu; it never acts on its own */ },
            submenu: apps.map((app) => ({
              // The Host serves each application's own icon from its route; a machine
              // that reports none gets the neutral glyph instead of a broken image.
              icon: app.icon === undefined ? ideIconSvg : `<img src="${app.icon}" alt="" width="14" height="14" />`,
              iconFit: app.icon === undefined,
              label: format(t("workspaceOpenInApp"), { app: app.name }),
              choose: () => onOpenIn(workspace.path, app.id),
            })),
          }]),
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
        // A unique value rather than an empty marker: a submenu has to name the row it
        // came from, so that it can go when that row's menu does. Presence is all the
        // other readers ask for, so every one of them still matches.
        itemId += 1
        const identity = `wts-${String(itemId)}`
        item.setAttribute(OWN_MENU_ITEM, identity)
        if (entry.submenu !== undefined) item.setAttribute("aria-haspopup", "menu")
        item.className = nativeItemClass === "" ? "dws-menu-item" : `${nativeItemClass} dws-menu-item`
        const icon = document.createElement("span")
        icon.className = entry.iconFit === true ? "dws-menu-item-icon dws-menu-item-icon-brand" : "dws-menu-item-icon"
        icon.innerHTML = entry.icon
        const text = document.createElement("span")
        // Read at insertion time: the menu is built per open, and the interface
        // language can change while this component is mounted.
        text.textContent = entry.label
        item.append(icon, text)
        if (entry.submenu !== undefined) {
          // A chevron, so the row reads as "there is more here" before it is hovered.
          const chevron = document.createElement("span")
          chevron.className = "dws-menu-item-chevron"
          chevron.innerHTML = chevronIconSvg
          item.append(chevron)
        }
        if (entry.submenu !== undefined) {
          // Hover opens it, and a click does nothing at all.
          //
          // A click was the first spelling and it was wrong: the shell closes its own
          // menu on a menu-item click, so pressing the parent left an orphan submenu
          // with the menu it belonged to already gone - a list the user had to answer
          // before they could get back to anything. Hovering has no such side effect,
          // which is why every menu that has submenus works this way.
          const items = entry.submenu
          item.addEventListener("pointerenter", () => { openSubmenu(item, identity, items, nativeItemClass) })
          // Leaving the row for anywhere else in the menu closes the flyout - and leaving
          // it for the flyout does not, because the moment of overlap is what the delay
          // is for. The row is a sibling of the box rather than its ancestor, so this
          // fires on the way across; the box cancels the pending close as it is entered.
          item.addEventListener("pointerleave", () => { scheduleCloseSubmenu() })
          item.addEventListener("click", (event) => {
            // Both default and propagation, so the shell does not read this as "the
            // user chose a row" and close the menu underneath the submenu.
            event.preventDefault()
            event.stopPropagation()
          })
        } else {
          item.addEventListener("click", (event) => {
            event.preventDefault()
            event.stopPropagation()
            // Close the shell's menu the way its own rows do, then act.
            closeSubmenu()
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
            entry.choose()
          })
        }
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

    /**
     * Open a submenu beside the row that owns it.
     *
     * Positioned with a fixed box rather than nested inside the row: the shell's menu is
     * the thing being borrowed, and a second `[role="menu"]` inside it would be found by
     * the same scan that inserts these entries - it would try to fill the submenu too.
     * A fixed box also escapes the menu's own overflow, which a flyout inside it cannot.
     *
     * One open at a time: opening a second replaces the first, so a stray press cannot
     * leave two lists on screen.
     *
     * @param owner - the row the submenu belongs to.
     * @param identity - that row's `OWN_MENU_ITEM` value, so the flyout can be tied to it.
     * @param items - the entries to show.
     * @param itemClass - the shell's row class, so the submenu looks like the menu.
     */
    const openSubmenu = (owner: HTMLElement, identity: string, items: MenuEntry[], itemClass: string) => {
      closeSubmenu()
      const box = document.createElement("div")
      box.setAttribute("role", "menu")
      box.setAttribute(OWN_SUBMENU, "")
      box.setAttribute(OWNER_ITEM, identity)
      box.className = "dws-submenu"
      for (const item of items) {
        const row = document.createElement("button")
        row.type = "button"
        row.setAttribute("role", "menuitem")
        row.className = itemClass === "" ? "dws-menu-item" : `${itemClass} dws-menu-item`
        const icon = document.createElement("span")
        icon.className = item.iconFit === true ? "dws-menu-item-icon dws-menu-item-icon-brand" : "dws-menu-item-icon"
        icon.innerHTML = item.icon
        const label = document.createElement("span")
        label.textContent = item.label
        row.append(icon, label)
        row.addEventListener("click", (event) => {
          event.preventDefault()
          event.stopPropagation()
          closeSubmenu()
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
          item.choose()
        })
        box.appendChild(row)
      }
      // Mounted INSIDE the menu it belongs to, not on `body`, and that is what makes it
      // reachable with a mouse at all.
      //
      // The shell closes its menu when the pointer leaves it. A flyout on `body` is a
      // different subtree, so moving onto it *is* leaving - the menu shut, and the
      // flyout went with it, which is the "it closes as soon as I reach for it" report.
      // A DOM descendant does not count as leaving: moving between an element and its
      // child never fires `pointerleave` on the parent, wherever the child is painted.
      //
      // `position: fixed` is kept, so the box still escapes the menu's own overflow and
      // is placed by viewport coordinates rather than by the menu's scroll position.
      const shellMenu = owner.closest('[role="menu"]')
      const host = shellMenu ?? document.body
      host.appendChild(box)
      // The surface is copied from the menu this flyout belongs to, rather than named as
      // a token here. The shell owns that menu's look - background, border, radius,
      // shadow - and a plugin cannot know which of its aliases produced it in a given
      // theme. Reading the resolved values is the only way the two boxes are certain to
      // match; a token would be a second guess that drifts the moment the shell changes.
      //
      // The background is taken from the nearest ancestor that actually paints one, not
      // from the `[role="menu"]` element itself. A menu is frequently transparent with
      // its surface on a wrapper - the role is about semantics, not paint - so reading
      // the menu alone copied `rgba(0, 0, 0, 0)` and the flyout came out see-through.
      const surface = shellMenu === null ? null : paintedSurfaceOf(shellMenu)
      if (surface !== null && shellMenu !== null && typeof getComputedStyle === "function") {
        const shell = getComputedStyle(surface.element)
        // Text colour and font come from the menu itself, not from the wrapper: those
        // are inherited properties, so the menu is where the shell set them.
        const text = getComputedStyle(shellMenu)
        box.style.background = shell.backgroundColor
        box.style.borderRadius = shell.borderRadius
        box.style.boxShadow = shell.boxShadow
        box.style.color = text.color
        box.style.font = text.font
        // The border is copied only when the shell actually draws one, and then as a
        // whole. `borderColor` on its own is a trap: for an element with no border,
        // the computed value is the initial `rgb(0, 0, 0)`, so taking it drew a hard
        // black outline around a flyout whose menu had none. The width and the style
        // are what say whether there is a border at all; the colour is only meaningful
        // once they do.
        const width = Number.parseFloat(shell.borderTopWidth)
        if (Number.isFinite(width) && width > 0 && shell.borderTopStyle !== "none") {
          box.style.border = shell.border
        } else {
          // No border to copy: the flyout keeps the one its own rule sets, and that rule
          // is written to read as the shell's chrome rather than as an outline.
          box.style.border = "none"
        }
      }
      const anchor = owner.getBoundingClientRect()
      const size = box.getBoundingClientRect()
      // To the right of the row, and flipped left when there is no room - the menu may
      // be near the window edge, and a list that runs off it cannot be read.
      const roomRight = window.innerWidth - anchor.right
      const left = roomRight >= size.width + 8 ? anchor.right + 4 : Math.max(8, anchor.left - size.width - 4)
      const top = Math.min(anchor.top, Math.max(8, window.innerHeight - size.height - 8))
      box.style.left = `${String(left)}px`
      box.style.top = `${String(top)}px`
      // Hovering the submenu keeps it: the pointer leaves the parent row on its way
      // here, and closing on that alone would make the list unreachable by mouse.
      box.addEventListener("pointerenter", () => { cancelCloseSubmenu() })
      // And leaving it closes after a moment, so a pointer that crosses the gap on its
      // way to somewhere else does not lose it mid-move.
      box.addEventListener("pointerleave", () => { scheduleCloseSubmenu() })
    }

    /**
     * Take the submenu down, if one is open.
     *
     * Also the way it goes when the shell closes the menu it belongs to: a submenu
     * outliving its parent was the complaint this fixes, so nothing here holds one open
     * on its own.
     */
    const closeSubmenu = () => {
      cancelCloseSubmenu()
      for (const box of document.querySelectorAll(`[${OWN_SUBMENU}]`)) box.remove()
    }

    /** Close the submenu shortly, unless the pointer comes back first. */
    const scheduleCloseSubmenu = () => {
      cancelCloseSubmenu()
      closeTimer = setTimeout(() => { closeTimer = null; closeSubmenu() }, CLOSE_DELAY_MS)
    }

    /** Call off a pending close. */
    const cancelCloseSubmenu = () => {
      if (closeTimer !== null) { clearTimeout(closeTimer); closeTimer = null }
    }

    /**
     * Whether the menu a submenu belongs to is still on screen.
     *
     * The shell owns its menu and closes it whenever it likes - a click elsewhere, a
     * scroll, its own item being pressed. When it goes, the submenu has to go with it:
     * a flyout left standing belongs to nothing, and its rows would act on a workspace
     * the user is no longer looking at.
     * @param box - the submenu.
     * @returns whether its owner row is still connected and still in a menu.
     */
    const ownerStillOpen = (box: Element): boolean => {
      const ownerAttr = box.getAttribute(OWNER_ITEM)
      if (ownerAttr === null) return false
      const owner = document.querySelector(`[${OWN_MENU_ITEM}="${ownerAttr}"]`)
      return owner !== null && owner.isConnected && owner.closest('[role="menu"]') !== null
    }

    /**
     * The nearest element at or above `node` that actually paints a background.
     *
     * A menu is usually a transparent `[role="menu"]` inside a wrapper that carries the
     * surface - the role says what the element is, not what it looks like. Copying the
     * menu's own `backgroundColor` therefore copied `rgba(0, 0, 0, 0)`, and the flyout
     * came out see-through over whatever it was covering.
     *
     * "Paints" means a colour with a non-zero alpha, and it is checked up the chain
     * because a wrapper may be transparent too. An image or a gradient counts as painted
     * even though `backgroundColor` cannot describe it: the flyout cannot reproduce those,
     * so it falls back to the shell's own surface token rather than to nothing.
     *
     * @param node - the menu to start from.
     * @returns the painting element, or null when nothing in the chain paints.
     */
    const paintedSurfaceOf = (node: Element): { element: Element } | null => {
      if (typeof getComputedStyle !== "function") return null
      let current: Element | null = node
      while (current !== null) {
        const style = getComputedStyle(current)
        // An opaque colour is the case worth copying.
        if (style.backgroundColor !== "" && style.backgroundColor !== "transparent") {
          const alpha = /rgba?\([^)]*?,\s*([\d.]+)\s*\)/.exec(style.backgroundColor)
          const opaque = alpha === null || Number.parseFloat(alpha[1]) > 0
          if (opaque) return { element: current }
        }
        // A background image (a gradient, a texture) cannot be copied as a colour, but it
        // does mean this element is the surface: stopping here keeps the search from
        // climbing to the page and copying that instead.
        if (style.backgroundImage !== "" && style.backgroundImage !== "none") return { element: current }
        current = current.parentElement
      }
      return null
    }

    const attach = async () => {
      if (scanning || !active) return
      scanning = true
      try {
        // A menu that closed takes its submenu with it, whether or not the pointer ever
        // left the row. This runs on every scan - which is every DOM change - so the
        // flyout cannot outlive its owner by more than a frame.
        for (const box of document.querySelectorAll(`[${OWN_SUBMENU}]`)) {
          if (!ownerStillOpen(box)) closeSubmenu()
        }
        for (const menu of document.querySelectorAll('[role="menu"]')) {
          // A submenu is a `[role="menu"]` too, and it is nested inside the shell's menu
          // now - so this loop would find it and fill it a second time, with every entry
          // repeated. Its own attribute is what says "this one is mine and already built".
          if (menu.hasAttribute(OWN_SUBMENU)) continue
          if (decided.has(menu)) continue
          if (menu.querySelector(`[${OWN_MENU_ITEM}]`) !== null) continue
          const element = row
          if (element === null || !element.isConnected) continue
          if (Date.now() - triggeredAt > TRIGGER_WINDOW_MS) continue
          const workspaceId = workspaceIdFromRowKey(element.getAttribute("data-row-key"))
          if (workspaceId === undefined) continue
          const workspace = workspaces.list.getSnapshot().items.find((item) => item.workspaceId === workspaceId)
          if (workspace === undefined) continue
          // Built once per open. `capability` arrives from the caller and is stable by
          // the time anyone opens a menu - it is probed at mount - so there is no
          // half-answered state to revisit here.
          decided.add(menu)
          let isTask = false
          try {
            isTask = (await api.inspectTask(workspace.path)).isTask
          } catch {
            isTask = false
          }
          const entries = entriesFor(workspace, isTask, capability?.applications ?? [], capability?.available === true)
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
    document.addEventListener("keydown", rememberRowOnKey, true)
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      active = false
      document.removeEventListener("pointerdown", rememberRow, true)
      document.removeEventListener("keydown", rememberRowOnKey, true)
      observer.disconnect()
      for (const item of document.querySelectorAll(`[${OWN_MENU_ITEM}]`)) item.remove()
    }
  }, [api, workspaces, canCreate, onCreate, onArchive, onReveal, onOpenIn, capability, t])

  return null
}

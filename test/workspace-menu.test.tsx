// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorkspaceMenuEntries } from "../src/client/components/WorkspaceMenuEntries"
import { format, t } from "../src/client/lib/i18n"
import { OWN_MENU_ITEM, workspaceIdFromRowKey } from "../src/client/lib/workspace-menu"

const repositoryPath = "E:\\workspace\\public\\kratos-admin"
const taskPath = "E:\\worktree-space\\antest"
const workspace = { workspaceId: "w1", path: repositoryPath, title: "public" }

/** The row and the menu DSH renders, reproduced closely enough to adapt to. */
function workspaceRow(workspaceId: string) {
  const row = document.createElement("div")
  row.setAttribute("data-row-key", `workspace:${workspaceId}`)
  row.setAttribute("role", "treeitem")
  const actions = document.createElement("span")
  const trigger = document.createElement("button")
  trigger.type = "button"
  trigger.textContent = "⋯"
  actions.appendChild(trigger)
  row.appendChild(actions)
  document.body.appendChild(row)
  return { row, trigger }
}

function rowMenu() {
  const menu = document.createElement("div")
  menu.setAttribute("role", "menu")
  // DSH's rows are wrapped and the list sits inside the menu, so inserting before
  // a row has to climb to the menu's own child; the delete row is marked `danger`,
  // which is how it is told apart from rename.
  const list = document.createElement("div")
  list.className = "_list"
  for (const [text, className] of [["rename", "_item"], ["delete", "_item _danger"]] as const) {
    const wrap = document.createElement("div")
    wrap.className = "_itemWrap"
    const row = document.createElement("button")
    row.setAttribute("role", "menuitem")
    row.className = className
    row.textContent = text
    wrap.appendChild(row)
    list.appendChild(wrap)
  }
  menu.appendChild(list)
  document.body.appendChild(menu)
  return menu
}

/** Opens the row's own menu the way the shell does: a pointer on its trigger, then the menu. */
function openMenu(workspaceId = "w1") {
  const { trigger } = workspaceRow(workspaceId)
  trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }))
  return rowMenu()
}

/** Opens a row's own menu from the keyboard, which is what a button does for Enter. */
function openMenuWithKeyboard(workspaceId: string, key = "Enter") {
  const { trigger } = workspaceRow(workspaceId)
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
  return rowMenu()
}

/** Our items are inserted asynchronously, one frame after the menu appears. */
const ownItems = () => [...document.querySelectorAll(`[${OWN_MENU_ITEM}]`)]
const ownItem = (label: string) => ownItems().find((item) => item.textContent === label) ?? null
const rowLabels = (menu: Element) => [...menu.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent)

// Generous on purpose: the items land a frame after the mutation, and the suite
// runs in parallel with a build, so a tight budget flakes under load. The waits
// that expect nothing pass a small budget, since there is nothing to wait for.
async function until(check: () => boolean, { attempts = 200 } = {}) {
  for (let attempt = 0; attempt < attempts && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
}

function setup({ canHost = true, isTask = false, items = [workspace], apps = [] as Array<{ id: string; name: string; icon?: string }>, fileManager = true } = {}) {
  const api = {
    inspectTask: vi.fn().mockResolvedValue({ path: workspace.path, isTask, task: "antest", tasksRoot: "E:\\worktree-space", repositories: [] }),
    // The workspace menu asks the Host which IDEs this machine has. Empty by default,
    // which is the answer a machine without one gives.
  }
  const workspaces = { list: { getSnapshot: () => ({ items }), subscribe: () => () => {} } }
  const canCreate = vi.fn().mockReturnValue(canHost)
  const onCreate = vi.fn()
  const onArchive = vi.fn()
  const onReveal = vi.fn()
  const onOpenIn = vi.fn()
  const view = render(<WorkspaceMenuEntries api={api as any} workspaces={workspaces as any} canCreate={canCreate} onCreate={onCreate} onArchive={onArchive} onReveal={onReveal} onOpenIn={onOpenIn} capability={{ available: fileManager, applications: apps }} />)
  return { api, canCreate, onCreate, onArchive, onReveal, onOpenIn, view }
}

afterEach(() => {
  cleanup()
  // The rows and menus are ours, not React's, so cleanup alone leaves them.
  document.body.innerHTML = ""
})

describe("workspace menu identity", () => {
  it("reads the workspace id out of a row key", () => {
    expect(workspaceIdFromRowKey("workspace:abc-123")).toBe("abc-123")
    expect(workspaceIdFromRowKey("session:abc-123")).toBeUndefined()
    expect(workspaceIdFromRowKey("workspace:")).toBeUndefined()
    expect(workspaceIdFromRowKey(null)).toBeUndefined()
  })
})

describe("this plugin's entries in the workspace menu", () => {
  it("offers a task space in a Workspace that holds repositories", async () => {
    const next = setup()
    const menu = openMenu()

    await until(() => ownItem(t("workspaceCreate")) !== null)
    expect(next.canCreate).toHaveBeenCalledWith(workspace)
    expect(menu.contains(ownItem(t("workspaceCreate")))).toBe(true)
    // Between the shell's own rows rather than after them: rename, ours, delete.
    expect(rowLabels(menu)).toEqual(["rename", t("workspaceCreate"), t("workspaceReveal"), "delete"])
    // Carrying the glyph the management panel's own create button wears - Lucide's
    // plus, two paths on its 24-unit grid.
    expect(ownItem(t("workspaceCreate"))?.querySelectorAll("svg path")).toHaveLength(2)

    // The same shape as the rows beside it, which is what makes it line up: each is
    // a button inside its own wrapper, the wrappers share one parent, and the button
    // wears the shell's item class - borrowed from rename, not from delete.
    const ours = ownItem(t("workspaceCreate"))
    expect(ours?.className).toContain("_item")
    expect(ours?.className).not.toContain("danger")
    expect(ours?.parentElement?.className).toBe("_itemWrap")
    const wraps = [...menu.querySelectorAll('[role="menuitem"]')].map((row) => row.parentElement)
    expect(new Set(wraps.map((wrap) => wrap?.parentElement)).size).toBe(1)
    expect(wraps).toContain(ours?.parentElement)

    ours?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    expect(next.onCreate).toHaveBeenCalledWith({ path: repositoryPath, title: "public" })
    expect(next.onArchive).not.toHaveBeenCalled()
  })

  it("offers finishing a task space, but not starting one there", async () => {
    // A task space is a linked worktree, which the classification the composer
    // reads also refuses, so the two ways in agree about where one can start.
    const next = setup({ canHost: false, isTask: true })
    const menu = openMenu()

    await until(() => ownItem(t("archiveWorkspace")) !== null)
    expect(rowLabels(menu)).toEqual(["rename", t("archiveWorkspace"), t("workspaceReveal"), "delete"])
    // The shell's own archive glyph, which is what its session rows use.
    expect(ownItem(t("archiveWorkspace"))?.querySelectorAll("svg path")).toHaveLength(3)

    ownItem(t("archiveWorkspace"))?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    expect(next.onArchive).toHaveBeenCalledWith(workspace.path)
    expect(next.onCreate).not.toHaveBeenCalled()
  })

  it("puts every entry in one menu, in the order this plugin lists them", async () => {
    setup({ canHost: true, isTask: true })
    const menu = openMenu()

    await until(() => ownItems().length === 3)
    expect(rowLabels(menu)).toEqual(["rename", t("workspaceCreate"), t("archiveWorkspace"), t("workspaceReveal"), "delete"])
    // One wrapper each, all hanging off the shell's own list.
    expect(new Set(ownItems().map((item) => item.parentElement)).size).toBe(3)
    expect(new Set(ownItems().map((item) => item.parentElement?.parentElement)).size).toBe(1)
  })

  it("offers only the reveal entry when the Workspace holds no repositories and is no task container", async () => {
    // The reveal entry is unconditional: every Workspace is a directory, and opening
    // it is a fact about the row rather than about what the directory holds. The two
    // task entries are the ones that depend on classification.
    const next = setup({ canHost: false, isTask: false })
    const menu = openMenu()

    await waitFor(() => expect(next.api.inspectTask).toHaveBeenCalledTimes(1))
    await until(() => ownItem(t("workspaceReveal")) !== null)
    expect(ownItems()).toHaveLength(1)
    expect(rowLabels(menu)).toEqual(["rename", t("workspaceReveal"), "delete"])

    ownItem(t("workspaceReveal"))?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    expect(next.onReveal).toHaveBeenCalledExactlyOnceWith(workspace.path)
    expect(next.onCreate).not.toHaveBeenCalled()
    expect(next.onArchive).not.toHaveBeenCalled()
  })

  it("puts the applications in a submenu that opens on hover, not on a click", async () => {
    // The Host reports whatever a machine has installed. A row each would push the
    // shell's own rename and delete off the menu on a machine with a full toolchain,
    // so the applications live behind one row.
    //
    // Hover rather than click, and that is not a preference: the shell closes its own
    // menu when a menu item is clicked, so pressing the parent left an orphan flyout
    // with the menu it belonged to already gone.
    const next = setup({
      canHost: true,
      isTask: false,
      apps: [
        { id: "idea", name: "IntelliJ IDEA" },
        { id: "code", name: "Visual Studio Code" },
      ],
    })
    const menu = openMenu()

    await until(() => ownItem(t("workspaceOpenIn")) !== null)
    expect(rowLabels(menu)).toEqual([
      "rename",
      t("workspaceCreate"),
      t("workspaceReveal"),
      t("workspaceOpenIn"),
      "delete",
    ])

    // A click must not open it and must not act: the shell would read the click as
    // "this row was chosen" and take the menu away underneath.
    const parent = ownItem(t("workspaceOpenIn"))
    parent?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    expect(document.querySelector("[data-dws-submenu]")).toBeNull()
    expect(next.onOpenIn).not.toHaveBeenCalled()
    expect(next.onReveal).not.toHaveBeenCalled()

    // Hovering does.
    parent?.dispatchEvent(new Event("pointerenter"))
    const submenu = document.querySelector("[data-dws-submenu]")
    expect(submenu).not.toBeNull()
    expect([...(submenu?.querySelectorAll('[role="menuitem"]') ?? [])].map((row) => row.textContent)).toEqual([
      format(t("workspaceOpenInApp"), { app: "IntelliJ IDEA" }),
      format(t("workspaceOpenInApp"), { app: "Visual Studio Code" }),
    ])

    // Choosing one hands back the Host's application id, never a path: what to start is
    // the Host's business, and a path from here would be a command the client chose.
    ;[...(submenu?.querySelectorAll('[role="menuitem"]') ?? [])][0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    expect(next.onOpenIn).toHaveBeenCalledExactlyOnceWith(workspace.path, "idea")
    // And the flyout goes with the choice.
    expect(document.querySelector("[data-dws-submenu]")).toBeNull()
  })

  it("takes the submenu down when the shell closes the menu it belongs to", async () => {
    // The shell owns its menu and closes it whenever it likes - a click elsewhere, a
    // scroll, Escape. A flyout left standing belongs to nothing, and its rows would act
    // on a workspace the user is no longer looking at.
    const next = setup({ canHost: true, apps: [{ id: "idea", name: "IntelliJ IDEA" }] })
    const menu = openMenu()

    await until(() => ownItem(t("workspaceOpenIn")) !== null)
    ownItem(t("workspaceOpenIn"))?.dispatchEvent(new Event("pointerenter"))
    expect(document.querySelector("[data-dws-submenu]")).not.toBeNull()

    // The shell's menu goes, the way it does when the user clicks away.
    menu.remove()
    // The scan that notices is the one the MutationObserver already drives; give it the
    // frame it coalesces into.
    await until(() => document.querySelector("[data-dws-submenu]") === null)
    expect(document.querySelector("[data-dws-submenu]")).toBeNull()
    expect(next.onOpenIn).not.toHaveBeenCalled()
  })

  it("ties each flyout to the row that opened it", async () => {
    // Two workspace rows, two menus: the flyout names its owner, which is what lets the
    // scan tell "my menu is still open" from "my menu is gone".
    const second = { workspaceId: "w2", path: "E:\\workspace\\other", title: "other" }
    setup({ canHost: true, apps: [{ id: "idea", name: "IntelliJ IDEA" }], items: [workspace, second] })
    const menu = openMenu()
    await until(() => ownItem(t("workspaceOpenIn")) !== null)
    const owner = ownItem(t("workspaceOpenIn"))
    const identity = owner?.getAttribute(OWN_MENU_ITEM)
    expect(identity).toBeTruthy()
    // A non-empty value, so a flyout can select its own row rather than any of them.
    expect(identity).not.toBe("")

    owner?.dispatchEvent(new Event("pointerenter"))
    const submenu = document.querySelector("[data-dws-submenu]")
    expect(submenu?.getAttribute("data-dws-submenu-owner")).toBe(identity)
  })

  it("mounts the flyout inside the menu it belongs to", async () => {
    // Not a cosmetic choice, and not `body`. The shell closes its menu when the pointer
    // leaves it, and a flyout in another subtree *is* leaving - so reaching for the
    // submenu shut both. A DOM descendant does not count as leaving: moving between an
    // element and its child never fires `pointerleave` on the parent, wherever the child
    // is painted. This test is what keeps that from being undone.
    const next = setup({ canHost: true, apps: [{ id: "idea", name: "IntelliJ IDEA" }] })
    const menu = openMenu()
    await until(() => ownItem(t("workspaceOpenIn")) !== null)

    ownItem(t("workspaceOpenIn"))?.dispatchEvent(new Event("pointerenter"))
    const submenu = document.querySelector("[data-dws-submenu]")
    expect(submenu).not.toBeNull()
    expect(menu.contains(submenu)).toBe(true)
    // And it is still positioned by the viewport, so it escapes the menu's own overflow
    // rather than being clipped by it.
    expect((submenu as HTMLElement).style.position === "" || (submenu as HTMLElement).style.position === "fixed").toBe(true)

    // Leaving the row closes it shortly - but entering the flyout calls that off, which
    // is how the pointer gets across the gap between the two boxes.
    ownItem(t("workspaceOpenIn"))?.dispatchEvent(new Event("pointerleave"))
    submenu?.dispatchEvent(new Event("pointerenter"))
    await new Promise((resolve) => setTimeout(resolve, 260))
    expect(document.querySelector("[data-dws-submenu]")).not.toBeNull()
    // Nothing was chosen by any of that: hovering is not selecting.
    expect(next.onOpenIn).not.toHaveBeenCalled()
  })

  it("takes the flyout's surface from the element that actually paints one", async () => {
    // A menu is usually a transparent `[role="menu"]` inside a wrapper that carries the
    // surface: the role says what the element is, not what it looks like. Copying the
    // menu's own `backgroundColor` therefore copied `rgba(0, 0, 0, 0)`, and the flyout
    // came out see-through over whatever it was covering.
    //
    // jsdom resolves no cascade for our stylesheet, so the wrapper here is given the
    // background inline - which is exactly the shape being tested: the menu is
    // transparent, something above it is not, and the flyout must find that something.
    const next = setup({ canHost: true, apps: [{ id: "idea", name: "IntelliJ IDEA" }] })
    const menu = openMenu()
    await until(() => ownItem(t("workspaceOpenIn")) !== null)

    // The shell's wrapper: a parent of the menu, painting the surface the menu sits on.
    const wrapper = document.createElement("div")
    wrapper.style.background = "rgb(250, 250, 250)"
    wrapper.style.borderRadius = "10px"
    menu.parentElement?.insertBefore(wrapper, menu)
    wrapper.appendChild(menu)

    ownItem(t("workspaceOpenIn"))?.dispatchEvent(new Event("pointerenter"))
    const submenu = document.querySelector("[data-dws-submenu]") as HTMLElement | null
    expect(submenu).not.toBeNull()
    // The painted colour, not the menu's transparent one.
    expect(submenu?.style.background).toBe("rgb(250, 250, 250)")
    expect(submenu?.style.background).not.toContain("rgba(0, 0, 0, 0)")
    expect(next.onOpenIn).not.toHaveBeenCalled()
  })

  it("offers no submenu when the Host lists no applications", async () => {
    // A machine where nothing is registered for directories: the row would be a menu
    // that opens onto nothing.
    setup({ canHost: true, apps: [] })
    const menu = openMenu()
    await until(() => ownItem(t("workspaceReveal")) !== null)
    expect(rowLabels(menu)).toEqual(["rename", t("workspaceCreate"), t("workspaceReveal"), "delete"])
    expect(document.querySelector("[data-dws-submenu]")).toBeNull()
  })

  it("offers no file-manager entry on a machine that has none", async () => {
    // A headless server, or a deployment whose Host cannot reach a desktop at all: the
    // probe answers `available: false` and the entry is not offered, rather than being
    // offered and failing on every press.
    const next = setup({ canHost: false, isTask: false, fileManager: false })
    const menu = openMenu()

    await until(() => ownItems().length >= 1)
    expect(next.api.inspectTask).toHaveBeenCalled()
    expect(ownItem(t("workspaceReveal"))).toBeNull()
    expect(rowLabels(menu)).toEqual(["rename", "delete"])
  })

  it("offers the applications even when there is no file manager", async () => {
    // The two are independent: a Host that can launch an application on a directory has
    // no reason to need a file manager as well.
    const next = setup({
      canHost: false,
      isTask: false,
      fileManager: false,
      apps: [{ id: "idea", name: "IntelliJ IDEA" }],
    })
    const menu = openMenu()

    await until(() => ownItem(t("workspaceOpenIn")) !== null)
    expect(rowLabels(menu)).toEqual(["rename", t("workspaceOpenIn"), "delete"])
  })

  it("ignores a row it has no Workspace for, and a menu opened without one", async () => {
    const next = setup({ items: [] })
    openMenu("unknown")
    // Nothing to wait for either way: this only gives the adapter its chance.
    await until(() => next.api.inspectTask.mock.calls.length > 0, { attempts: 20 })
    expect(next.api.inspectTask).not.toHaveBeenCalled()
    expect(ownItems()).toHaveLength(0)

    // A menu that appeared with no row interaction behind it is not ours to fill.
    workspaceRow("w1")
    rowMenu()
    await until(() => false, { attempts: 20 })
    expect(ownItems()).toHaveLength(0)
  })

  it("puts its entries in the row the keyboard opened, not the one the mouse last used", async () => {
    // Which row a menu belongs to was recorded on `pointerdown` alone, so a keyboard
    // user activating a row's trigger never recorded anything and inherited whichever
    // row the mouse had been used on - as long as it was within the window. Choosing
    // "start a task space" then offered one for a Workspace the user never pointed at.
    const second = { workspaceId: "w2", path: "E:\\workspace\\other", title: "other" }
    const next = setup({ items: [workspace, second] })
    // The mouse was last used on the first row...
    workspaceRow("w1").trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }))
    // ...and the menu about to appear belongs to the second one.
    const menu = openMenuWithKeyboard("w2", " ")

    await until(() => ownItem(t("workspaceCreate")) !== null)
    // The entry acts on the Workspace whose row opened the menu, which is the only
    // thing here that says which row that was.
    ownItem(t("workspaceCreate"))?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    expect(next.onCreate).toHaveBeenCalledExactlyOnceWith({ path: second.path, title: second.title })
    expect(rowLabels(menu)).toEqual(["rename", t("workspaceCreate"), t("workspaceReveal"), "delete"])
  })

  it("takes its entries back when the plugin goes away", async () => {
    const next = setup({ canHost: true, isTask: true })
    openMenu()
    await until(() => ownItems().length === 2)

    next.view.unmount()
    expect(ownItems()).toHaveLength(0)
  })
})

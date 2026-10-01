// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorkspaceMenuEntries } from "../src/client/components/WorkspaceMenuEntries"
import { t } from "../src/client/lib/i18n"
import { OWN_MENU_ITEM, workspaceIdFromRowKey } from "../src/client/lib/workspaceMenu"

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

function setup({ canHost = true, isTask = false, items = [workspace] } = {}) {
  const api = { inspectTask: vi.fn().mockResolvedValue({ path: workspace.path, isTask, task: "antest", tasksRoot: "E:\\worktree-space", repositories: [] }) }
  const workspaces = { list: { getSnapshot: () => ({ items }), subscribe: () => () => {} } }
  const canCreate = vi.fn().mockReturnValue(canHost)
  const onCreate = vi.fn()
  const onArchive = vi.fn()
  const view = render(<WorkspaceMenuEntries api={api as any} workspaces={workspaces as any} canCreate={canCreate} onCreate={onCreate} onArchive={onArchive} />)
  return { api, canCreate, onCreate, onArchive, view }
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
    expect(rowLabels(menu)).toEqual(["rename", t("workspaceCreate"), "delete"])
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
    expect(rowLabels(menu)).toEqual(["rename", t("archiveWorkspace"), "delete"])
    // The shell's own archive glyph, which is what its session rows use.
    expect(ownItem(t("archiveWorkspace"))?.querySelectorAll("svg path")).toHaveLength(3)

    ownItem(t("archiveWorkspace"))?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    expect(next.onArchive).toHaveBeenCalledWith(workspace.path)
    expect(next.onCreate).not.toHaveBeenCalled()
  })

  it("puts both entries in one menu, in the order this plugin lists them", async () => {
    setup({ canHost: true, isTask: true })
    const menu = openMenu()

    await until(() => ownItems().length === 2)
    expect(rowLabels(menu)).toEqual(["rename", t("workspaceCreate"), t("archiveWorkspace"), "delete"])
    // One wrapper each, all hanging off the shell's own list.
    expect(new Set(ownItems().map((item) => item.parentElement)).size).toBe(2)
    expect(new Set(ownItems().map((item) => item.parentElement?.parentElement)).size).toBe(1)
  })

  it("stays out of the menu when the Workspace holds no repositories and is no task container", async () => {
    const next = setup({ canHost: false, isTask: false })
    const menu = openMenu()

    await waitFor(() => expect(next.api.inspectTask).toHaveBeenCalledTimes(1))
    expect(ownItems()).toHaveLength(0)
    expect(rowLabels(menu)).toEqual(["rename", "delete"])
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

  it("takes its entries back when the plugin goes away", async () => {
    const next = setup({ canHost: true, isTask: true })
    openMenu()
    await until(() => ownItems().length === 2)

    next.view.unmount()
    expect(ownItems()).toHaveLength(0)
  })
})

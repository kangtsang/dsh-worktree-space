// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorkspaceArchiveEntry } from "../src/client/components/WorkspaceArchiveEntry"
import { t } from "../src/client/lib/i18n"
import { OWN_MENU_ITEM, workspaceIdFromRowKey } from "../src/client/lib/workspaceMenu"

const taskPath = "E:\\worktree-space\\antest"

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

/** Our item is inserted asynchronously, one frame after the menu appears. */
const ownItem = () => document.querySelector(`[${OWN_MENU_ITEM}]`)
// Generous on purpose: the item lands a frame after the mutation, and the suite
// runs in parallel with a build, so a tight budget flakes under load. The waits
// that expect nothing pass a small budget, since there is nothing to wait for.
async function until(check: () => boolean, { attempts = 200 } = {}) {
  for (let attempt = 0; attempt < attempts && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
}

function setup({ isTask = true, items = [{ workspaceId: "w1", path: taskPath, title: "kratos-admin/antest" }] } = {}) {
  const api = { inspectTask: vi.fn().mockResolvedValue({ path: taskPath, isTask, task: "antest", tasksRoot: "E:\\worktree-space", repositories: [] }) }
  const workspaces = { list: { getSnapshot: () => ({ items }), subscribe: () => () => {} } }
  const onArchive = vi.fn()
  const view = render(<WorkspaceArchiveEntry api={api as any} workspaces={workspaces as any} onArchive={onArchive} />)
  return { api, onArchive, view }
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

describe("archive entry in the workspace menu", () => {
  it("adds the entry to the menu of the row it was opened from", async () => {
    const next = setup()
    const { trigger } = workspaceRow("w1")
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }))
    const menu = rowMenu()

    await until(() => ownItem() !== null)
    expect(next.api.inspectTask).toHaveBeenCalledWith(taskPath)
    expect(menu.contains(ownItem())).toBe(true)
    expect(ownItem()?.textContent).toBe(t("archiveWorkspace"))
    // Between the shell's own rows rather than after them: rename, archive, delete.
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent))
      .toEqual(["rename", t("archiveWorkspace"), "delete"])
    // Carrying DSH's own archive glyph, which is what the session row uses.
    expect(ownItem()?.querySelectorAll("svg path")).toHaveLength(3)

    // The same shape as the rows beside it, which is what makes it line up: each is
    // a button inside its own wrapper, the wrappers share one parent, and the button
    // wears the shell's item class - borrowed from rename, not from delete.
    const ours = ownItem()
    expect(ours?.className).toContain("_item")
    expect(ours?.className).not.toContain("danger")
    expect(ours?.parentElement?.className).toBe("_itemWrap")
    // Every row's wrapper hangs off the same list, so ours sits at their depth.
    const wraps = [...menu.querySelectorAll('[role="menuitem"]')].map((row) => row.parentElement)
    expect(new Set(wraps.map((wrap) => wrap?.parentElement)).size).toBe(1)
    expect(wraps).toContain(ours?.parentElement)

    ownItem()?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    expect(next.onArchive).toHaveBeenCalledWith(taskPath)
  })

  it("stays out of the menu when the row is not a task container", async () => {
    const next = setup({ isTask: false })
    const { trigger } = workspaceRow("w1")
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }))
    rowMenu()

    await waitFor(() => expect(next.api.inspectTask).toHaveBeenCalledTimes(1))
    expect(ownItem()).toBeNull()
  })

  it("ignores a row it has no Workspace for, and a menu opened without one", async () => {
    const next = setup({ items: [] })
    const { trigger } = workspaceRow("unknown")
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }))
    rowMenu()
    // Nothing to wait for either way: this only gives the adapter its chance.
    await until(() => next.api.inspectTask.mock.calls.length > 0, { attempts: 20 })
    expect(next.api.inspectTask).not.toHaveBeenCalled()
    expect(ownItem()).toBeNull()

    // A menu that appeared with no row interaction behind it is not ours to fill.
    workspaceRow("w1")
    rowMenu()
    await until(() => false, { attempts: 20 })
    expect(ownItem()).toBeNull()
  })

  it("takes its entry back when the plugin goes away", async () => {
    const next = setup()
    const { trigger } = workspaceRow("w1")
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }))
    rowMenu()
    await until(() => ownItem() !== null)

    next.view.unmount()
    expect(ownItem()).toBeNull()
  })
})

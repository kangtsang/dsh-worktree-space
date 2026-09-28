// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act } from "react"
import { WorktreePanelPage } from "../src/client/components/WorktreePanel"
import { WorktreeManagePanel } from "../src/client/components/WorktreeManagePanel"
import { WorktreesSettings } from "../src/client/components/WorktreesSettings"
import { t } from "../src/client/lib/i18n"

afterEach(cleanup)

/**
 * The section reads on mount, so its answers arrive after the render. Flushing them
 * inside `act` keeps them from landing as an update React never asked for — which the
 * suite reported for these tests, and only these.
 */
const settle = () => act(async () => {})

/** The page's own props: the shell's main column is what matters here, not the lists. */
function mount(onBack: () => void) {
  const api: any = { scan: vi.fn().mockResolvedValue([]), cachedScan: vi.fn().mockResolvedValue(null), status: vi.fn() }
  const workspaces: any = { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} }, create: vi.fn(), rename: vi.fn(), delete: vi.fn() }
  const props = {
    api,
    workspaces,
    uiWorkspace: { openWorkspace: vi.fn() } as any,
    sessions: { list: { getSnapshot: () => ({ byId: {} }) } } as any,
    onCreate: vi.fn(),
  }
  render(<WorktreePanelPage {...props} onBack={onBack} />)
  return props
}

describe("the management page as a main panel", () => {
  it("carries its own navigation, led by the way back to the conversation", async () => {
    const onBack = vi.fn()
    mount(onBack)
    await settle()

    const nav = screen.getByRole("navigation", { name: t("worktreesTitle") })
    // Selecting this panel took the column the conversation was in, so the way back
    // leads the column rather than leaving the user to find their session again.
    fireEvent.click(within(nav).getByRole("button", { name: t("backToConversation") }))
    expect(onBack).toHaveBeenCalledTimes(1)
    // The refresh control says what it does instead of being an icon at the far edge.
    expect(screen.getByRole("button", { name: t("refresh") }).textContent).toBe(t("refresh"))
  })

  it("switches views from that navigation, and leaves the toolbar to the filters", async () => {
    mount(vi.fn())
    await settle()
    const nav = screen.getByRole("navigation", { name: t("worktreesTitle") })

    // The three views live in the column, so the toolbar no longer offers them: it
    // reads the filters first, the fold button right after, and the summary stays right.
    expect(within(nav).getAllByRole("button").map((button) => button.textContent))
      .toEqual([t("backToConversation"), t("viewTasks"), t("viewWorkspaces"), t("viewRepositories")])
    expect(within(nav).getByRole("button", { name: t("viewTasks") }).getAttribute("aria-current")).toBe("true")
    expect(screen.queryByRole("group", { name: t("viewSwitch") })).toBeNull()
    expect(within(screen.getByRole("group", { name: t("filters") })).getAllByRole("button").map((button) => button.textContent))
      .toEqual([t("filterAll"), t("filterAttention"), t("collapseAll")])

    fireEvent.click(within(nav).getByRole("button", { name: t("viewWorkspaces") }))
    expect(within(nav).getByRole("button", { name: t("viewWorkspaces") }).getAttribute("aria-current")).toBe("true")
    // The workspace view is the one that answered: it lists Workspaces, and there are
    // none in this fixture.
    await waitFor(() => expect(screen.getByText(t("workspaceEmpty"))).toBeTruthy())
  })

  it("switches the dialog's views from the same navigation the panel draws", async () => {
    const api: any = { scan: vi.fn().mockResolvedValue([]), cachedScan: vi.fn().mockResolvedValue(null), status: vi.fn() }
    const workspaces: any = { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} }, create: vi.fn(), rename: vi.fn(), delete: vi.fn() }
    const onClose = vi.fn()
    render(<WorktreeManagePanel
      api={api}
      workspaces={workspaces}
      uiWorkspace={{ openWorkspace: vi.fn() } as any}
      sessions={{ list: { getSnapshot: () => ({ byId: {} }) } } as any}
      onCreate={vi.fn()}
      onClose={onClose}
    />)
    await settle()

    // The dialog is the panel's page in a window: the same three views in the same
    // column, selected the same way — and no way back, because closing is the way out.
    const nav = screen.getByRole("navigation", { name: t("worktreesTitle") })
    expect(within(nav).getAllByRole("button").map((button) => button.textContent))
      .toEqual([t("viewTasks"), t("viewWorkspaces"), t("viewRepositories")])
    expect(within(nav).getByRole("button", { name: t("viewTasks") }).getAttribute("aria-current")).toBe("true")
    // The navigation is the switcher, so the toolbar keeps only the filters here too.
    expect(screen.queryByRole("group", { name: t("viewSwitch") })).toBeNull()

    fireEvent.click(within(nav).getByRole("button", { name: t("viewWorkspaces") }))
    expect(within(nav).getByRole("button", { name: t("viewWorkspaces") }).getAttribute("aria-current")).toBe("true")
    await waitFor(() => expect(screen.getByText(t("workspaceEmpty"))).toBeTruthy())
    // The dialog did not close on the way: switching views is not leaving the page.
    expect(onClose).not.toHaveBeenCalled()
  })

  it("leaves the dialog's own layout alone: without a navigation, the toolbar keeps the switcher", async () => {
    const api: any = { scan: vi.fn().mockResolvedValue([]), cachedScan: vi.fn().mockResolvedValue(null), status: vi.fn() }
    const workspaces: any = { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} }, create: vi.fn(), rename: vi.fn(), delete: vi.fn() }
    render(<WorktreesSettings
      api={api}
      workspaces={workspaces}
      uiWorkspace={{ openWorkspace: vi.fn() } as any}
      sessions={{ list: { getSnapshot: () => ({ byId: {} }) } } as any}
      heading={false}
      onCreate={vi.fn()}
    />)
    await settle()

    // A host that brings no navigation of its own gets the switcher where it was,
    // then the very same filters-and-fold run the panel reads, and no nav column.
    const group = screen.getByRole("group", { name: t("viewSwitch") })
    expect(within(group).getAllByRole("button").map((button) => button.textContent))
      .toEqual([t("viewTasks"), t("viewWorkspaces"), t("viewRepositories")])
    expect(within(screen.getByRole("group", { name: t("filters") })).getAllByRole("button").map((button) => button.textContent))
      .toEqual([t("filterAll"), t("filterAttention"), t("collapseAll")])
    // The two runs are set off from each other, which the panel's own single run is not.
    expect(document.querySelectorAll(".dws-filter-separator")).toHaveLength(1)
    expect(screen.queryByRole("navigation", { name: t("worktreesTitle") })).toBeNull()
  })

  it("pins the toolbar and scrolls only the rows, in both hosts", async () => {
    // One frame for both: the section is a reading column whose toolbar sits above
    // the one element that scrolls, so the search box and the filters stay put
    // however long the list of rows becomes. jsdom lays nothing out, so what is
    // checked here is the structure the stylesheet's rules are written against.
    mount(vi.fn())
    await settle()
    const pinned = document.querySelector(".dws-settings-pinned")
    const body = document.querySelector(".dws-list-body")
    expect(pinned).toBeTruthy()
    expect(body).toBeTruthy()
    expect(pinned?.querySelector(".dws-toolbar")).toBeTruthy()
    expect(pinned?.querySelector(".dws-list-controls")).toBeTruthy()
    // The rows are inside the scroller and the toolbar is not, which is the whole
    // difference between pinned and scrolled content.
    expect(pinned?.contains(body as Node)).toBe(false)
    expect(body?.querySelector(".dws-repo-list")).toBeTruthy()
    // The panel draws its heading, and the heading is pinned with the toolbar: a
    // heading that scrolled away would leave the page unlabelled.
    expect(pinned?.querySelector(".dws-panel-heading")).toBeNull()
    expect(document.querySelector(".dws-panel-content")?.contains(pinned as Node)).toBe(true)

    cleanup()
    // The dialog is the same page, so it must not grow a second scroll area that
    // moves the toolbar with the rows.
    render(<WorktreeManagePanel
      api={{ scan: vi.fn().mockResolvedValue([]), cachedScan: vi.fn().mockResolvedValue(null), status: vi.fn() } as any}
      workspaces={{ list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} }, create: vi.fn(), rename: vi.fn(), delete: vi.fn() } as any}
      uiWorkspace={{ openWorkspace: vi.fn() } as any}
      sessions={{ list: { getSnapshot: () => ({ byId: {} }) } } as any}
      onCreate={vi.fn()}
      onClose={vi.fn()}
    />)
    await settle()
    expect(document.querySelector(".dws-manage-page-content")?.querySelector(".dws-settings-pinned")).toBeTruthy()
    expect(document.querySelector(".dws-manage-page-content")?.querySelector(".dws-list-body")).toBeTruthy()
  })

  it("renders a repository's worktrees as one set the parent owns", async () => {
    const api: any = {
      scan: vi.fn().mockResolvedValue([{ repoPath: "/projects/alpha", currentBranch: "main", worktrees: [{ path: "/projects/alpha", branch: "main", isMain: true, locked: false, prunable: false }, { path: "/spaces/task/alpha", branch: "task/task", isMain: false, locked: false, prunable: false }] }]),
      cachedScan: vi.fn().mockResolvedValue(null),
      status: vi.fn().mockResolvedValue({ changedFiles: 0, branchLine: "", output: "" }),
    }
    const workspaces: any = { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} }, create: vi.fn(), rename: vi.fn(), delete: vi.fn() }
    render(<WorktreesSettings
      api={api}
      workspaces={workspaces}
      uiWorkspace={{ openWorkspace: vi.fn() } as any}
      sessions={{ list: { getSnapshot: () => ({ byId: {} }) } } as any}
    />)
    await settle()
    // A repository's worktrees are one list of their own under the repository row —
    // the nesting the tree rail used to draw, said with the list instead of a line.
    const list = document.querySelector(".dws-worktree-list")
    expect(list).toBeTruthy()
    expect(list?.querySelectorAll(".dws-worktree").length).toBe(1)
    // The stylesheet draws no connector into the rows any more: `styles.test.ts`
    // holds that rule, because reading a file is not this environment's job.
  })
})

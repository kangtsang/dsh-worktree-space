// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act } from "react"
import { WorktreesPage } from "../src/client/components/WorktreePanel"
import { WorktreeManagePanel } from "../src/client/components/WorktreeManagePanel"
import { WorktreesSettings } from "../src/client/components/WorktreesSettings"
import { t } from "../src/client/lib/i18n"
import { scanAnswer } from "./scan-answer.helper"

afterEach(cleanup)

/**
 * The section reads on mount, so its answers arrive after the render. Flushing them
 * inside `act` keeps them from landing as an update React never asked for — which the
 * suite reported for these tests, and only these.
 */
const settle = () => act(async () => {})

/** The page's own props: the shell's main column is what matters here, not the lists. */
function props() {
  const api: any = { scan: vi.fn().mockResolvedValue(scanAnswer([])), cachedScan: vi.fn().mockResolvedValue(null), status: vi.fn() }
  const workspaces: any = { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} }, create: vi.fn(), rename: vi.fn(), delete: vi.fn() }
  return {
    api,
    workspaces,
    uiWorkspace: { openWorkspace: vi.fn() } as any,
    sessions: { list: { getSnapshot: () => ({ byId: {} }) } } as any,
    onCreate: vi.fn(),
  }
}

describe("the management page in its dialog", () => {
  it("draws the three views in one navigation column", async () => {
    const shared = props()
    render(<WorktreesPage {...shared} />)
    await settle()

    // The page is one frame now: a navigation column and the reading column beside it.
    // The panel's second host used to bring its own bands and a way back; both went with
    // it, because closing the dialog is the way back.
    const nav = screen.getByRole("navigation", { name: t("worktreesTitle") })
    expect(within(nav).getAllByRole("button").map((button) => button.textContent))
      .toEqual([t("viewWorkspaces"), t("viewRepositories"), t("viewTasks")])
    expect(within(nav).getByRole("button", { name: t("viewWorkspaces") }).getAttribute("aria-current")).toBe("true")
    expect(document.querySelector(".dws-manage-page-content")).toBeTruthy()
    // The page brings no chrome of its own: the dialog's header says what this is and its
    // close is the way out, so there is no second title and no way-back row to find.
    expect(document.querySelector(".dws-manage-page")?.children).toHaveLength(2)
  })

  it("switches views from that navigation, and leaves the toolbar to the filters", async () => {
    render(<WorktreesPage {...props()} />)
    await settle()
    const nav = screen.getByRole("navigation", { name: t("worktreesTitle") })

    // The three views live in the column, so the toolbar no longer offers them: it
    // reads the filters first, the fold button right after, and the summary stays right.
    expect(screen.queryByRole("group", { name: t("viewSwitch") })).toBeNull()
    expect(within(screen.getByRole("group", { name: t("filters") })).getAllByRole("button").map((button) => button.textContent))
      .toEqual([t("filterAll"), t("filterWithWorktrees"), t("expandAll")])

    fireEvent.click(within(nav).getByRole("button", { name: t("viewTasks") }))
    expect(within(nav).getByRole("button", { name: t("viewTasks") }).getAttribute("aria-current")).toBe("true")
    await waitFor(() => expect(screen.getByText(t("noTasks"))).toBeTruthy())
    fireEvent.click(within(nav).getByRole("button", { name: t("viewWorkspaces") }))
    expect(within(nav).getByRole("button", { name: t("viewWorkspaces") }).getAttribute("aria-current")).toBe("true")
    // The workspace view is the one that answered: it lists Workspaces, and there are
    // none in this fixture.
    await waitFor(() => expect(screen.getByText(t("workspaceEmpty"))).toBeTruthy())
  })

  it("switches the dialog's views from the same navigation the page draws", async () => {
    const shared = props()
    const onClose = vi.fn()
    render(<WorktreeManagePanel
      api={shared.api}
      workspaces={shared.workspaces}
      uiWorkspace={shared.uiWorkspace}
      sessions={shared.sessions}
      onCreate={shared.onCreate}
      onClose={onClose}
    />)
    await settle()

    // The dialog is the page in a window: the same three views in the same column,
    // selected the same way.
    const nav = screen.getByRole("navigation", { name: t("worktreesTitle") })
    expect(within(nav).getAllByRole("button").map((button) => button.textContent))
      .toEqual([t("viewWorkspaces"), t("viewRepositories"), t("viewTasks")])
    expect(within(nav).getByRole("button", { name: t("viewWorkspaces") }).getAttribute("aria-current")).toBe("true")

    fireEvent.click(within(nav).getByRole("button", { name: t("viewRepositories") }))
    expect(within(nav).getByRole("button", { name: t("viewRepositories") }).getAttribute("aria-current")).toBe("true")
    fireEvent.click(within(nav).getByRole("button", { name: t("viewWorkspaces") }))
    expect(within(nav).getByRole("button", { name: t("viewWorkspaces") }).getAttribute("aria-current")).toBe("true")
    await waitFor(() => expect(screen.getByText(t("workspaceEmpty"))).toBeTruthy())
    // The dialog did not close on the way: switching views is not leaving the page.
    expect(onClose).not.toHaveBeenCalled()
  })

  // The gear row is the page's way to the Host's Plugins page, where this plugin's
  // configuration is edited. It is offered by the host, not assumed: a build whose
  // shell has no such panel must not draw a row that goes nowhere.
  it("offers the plugin-settings row only when the host can take it there", async () => {
    render(<WorktreesPage {...props()} />)
    await settle()
    // Without the handler, the column holds the three views and nothing else.
    const nav = screen.getByRole("navigation", { name: t("worktreesTitle") })
    expect(within(nav).queryByRole("button", { name: t("pluginSettings") })).toBeNull()
    cleanup()

    // With it, the dialog draws the row and a click lands on the host's handler — the
    // dialog closes on the way out, see plugin.tsx.
    const onOpenSettings = vi.fn()
    const shared = props()
    render(<WorktreeManagePanel {...shared} onOpenSettings={onOpenSettings} onClose={vi.fn()} />)
    await settle()
    const dialogRow = screen.getByRole("button", { name: t("pluginSettings") })
    expect(document.querySelector(".dws-nav")?.contains(dialogRow)).toBe(true)
    fireEvent.click(dialogRow)
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it("leaves a host that brings no navigation its own switcher", async () => {
    const shared = props()
    render(<WorktreesSettings
      api={shared.api}
      workspaces={shared.workspaces}
      uiWorkspace={shared.uiWorkspace}
      sessions={shared.sessions}
      onCreate={shared.onCreate}
    />)
    await settle()

    // A host that brings no navigation of its own gets the switcher where it was,
    // then the very same filters-and-fold run the page reads, and no nav column.
    const group = screen.getByRole("group", { name: t("viewSwitch") })
    expect(within(group).getAllByRole("button").map((button) => button.textContent))
      .toEqual([t("viewWorkspaces"), t("viewRepositories"), t("viewTasks")])
    expect(within(screen.getByRole("group", { name: t("filters") })).getAllByRole("button").map((button) => button.textContent))
      .toEqual([t("filterAll"), t("filterWithWorktrees"), t("expandAll")])
    // The two runs are set off from each other, which the page's own single run is not.
    expect(document.querySelectorAll(".dws-filter-separator")).toHaveLength(1)
    expect(screen.queryByRole("navigation", { name: t("worktreesTitle") })).toBeNull()
  })

  it("pins the toolbar and scrolls only the rows", async () => {
    // The section is a reading column whose toolbar sits above the one element that
    // scrolls, so the search box and the filters stay put however long the list of rows
    // becomes. jsdom lays nothing out, so what is checked here is the structure the
    // stylesheet's rules are written against.
    const shared = props()
    render(<WorktreeManagePanel
      api={shared.api}
      workspaces={shared.workspaces}
      uiWorkspace={shared.uiWorkspace}
      sessions={shared.sessions}
      onCreate={shared.onCreate}
      onClose={vi.fn()}
    />)
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
    expect(document.querySelector(".dws-manage-page-content")?.querySelector(".dws-settings-pinned")).toBeTruthy()
    expect(document.querySelector(".dws-manage-page-content")?.querySelector(".dws-list-body")).toBeTruthy()
  })

  it("renders a repository's worktrees as one set the parent owns", async () => {
    const api: any = {
      scan: vi.fn().mockResolvedValue(scanAnswer([{ repoPath: "/projects/alpha", currentBranch: "main", worktrees: [{ path: "/projects/alpha", branch: "main", isMain: true, detached: false, locked: false, prunable: false }, { path: "/spaces/task/alpha", branch: "task/task", isMain: false, detached: false, locked: false, prunable: false }] }])),
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
    // This fixture is a repository and its worktrees, so the repository view is the one
    // that has something to show; the page opens on the Workspaces.
    fireEvent.click(screen.getByRole("button", { name: t("viewRepositories") }))
    await settle()
    // A repository's worktrees are one list of their own under the repository row —
    // the nesting the tree rail used to draw, said with the list instead of a line.
    // The row starts folded like every other one, so this opens it first.
    fireEvent.click(screen.getByRole("button", { name: `${t("toggleRepository")} alpha` }))
    const list = document.querySelector(".dws-worktree-list")
    expect(list).toBeTruthy()
    expect(list?.querySelectorAll(".dws-worktree").length).toBe(1)
    // The stylesheet draws no connector into the rows any more: `styles.test.ts`
    // holds that rule, because reading a file is not this environment's job.
  })
})

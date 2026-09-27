// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act } from "react"
import { WorktreePanelPage } from "../src/client/components/WorktreePanel"
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
})

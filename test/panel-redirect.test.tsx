// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { WorktreePlugin } from "../src/client/plugin"

/**
 * The `main` panel the sidebar row selects must put the column back where it was.
 *
 * The first version always selected `null`, the shell's "show the Conversation"
 * selection - so opening the management dialog from the Plugins page, a plugin detail
 * page or the task board replaced that page with the conversation behind the dialog, and
 * closing the dialog left the reader somewhere they had not asked to be. This drives the
 * registration the way the layout does and asserts the selection that comes back.
 */
function mount(activePanelId: string | null) {
  const registered: Array<{ name: string; key?: string; render?: () => unknown }> = []
  const selections: Array<string | null> = []
  const panelInfo = { getSnapshot: () => ({ activePanelId }), subscribe: () => () => {} }
  const ctx: any = {
    connection: { rpc: { call: vi.fn() } },
    workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} } },
    uiWorkspace: {},
    layout: {
      panelInfo,
      selectPanel: (id: string | null) => { selections.push(id) },
    },
    effect: (effect: () => unknown) => effect(),
    slots: {
      inject: (_name: string, run: () => unknown) => { run(); return () => {} },
      register: (options: any, render: any) => { registered.push({ ...options, render }); return () => {} },
      entries: () => [],
    },
    inject: (_names: string[], run: (scope: unknown) => void) => run({}),
  }
  WorktreePlugin.apply(ctx)
  const panel = registered.find((entry) => entry.name === "main")
  return { panel, selections }
}

describe("the panel the sidebar row selects", () => {
  it("gives the column back to the panel that was selected before", async () => {
    const { panel, selections } = mount("plugins")
    expect(panel, "the main panel is registered under its key").toBeTruthy()

    // The layout renders the panel it selected, then runs its effects. Rendering here is
    // what the shell does on the click; the restore happens in the effect that follows.
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(panel!.render!() as any) })
    expect(selections, "the Plugins page is selected again, not the conversation").toEqual(["plugins"])
    await act(async () => { root.unmount() })
  })

  it("falls back to the conversation when nothing was selected before", async () => {
    // `null` is a real selection - it is what "show the Conversation" means - so the
    // remembered value has to survive as a value rather than be read as "nothing".
    const { panel, selections } = mount(null)
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(panel!.render!() as any) })
    expect(selections).toEqual([null])
    await act(async () => { root.unmount() })
  })
})

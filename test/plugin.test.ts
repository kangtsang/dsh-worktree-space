import { describe, expect, it, vi } from "vitest"
import { WorktreePlugin } from "../src/client/plugin"

/** A context with just enough of cordis for the plugin to apply against. */
function context(registeredSlots: string[], configForms?: { get: (name: string) => unknown; whileServed?: (names: string[], run: () => void) => () => void }) {
  return {
    connection: { rpc: { call: vi.fn() } },
    workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} } },
    uiWorkspace: {},
    // Only the panel page uses it, to show the conversation again.
    layout: { selectPanel: vi.fn() },
    effect: (effect: () => unknown) => effect(),
    slots: { inject: (name: string) => { registeredSlots.push(name); return () => {} } },
    inject: (names: string[], run: (ctx: unknown) => void) => { run(configForms === undefined ? {} : { configForms }) },
  }
}

/** The configuration the Host serves, with the two entry preferences spelled out. */
function served(values: { panelEntry?: string; sidebarEntry?: string }) {
  const form = {
    getSnapshot: () => ({ status: "ready", value: { panelEntry: "hide", sidebarEntry: "show", ...values } }),
    subscribe: () => () => {},
  }
  return { get: () => form, whileServed: (_names: string[], run: () => void) => { run(); return () => {} } }
}

describe("WorktreePlugin compatibility", () => {
  it("loads against the DSH client contract without a DOM", () => {
    const registeredSlots: string[] = []
    const ctx = context(registeredSlots)

    expect(() => WorktreePlugin.apply(ctx as any)).not.toThrow()
    // Without the configuration service the defaults stand: the sidebar footer's
    // shortcut to the page, and not the panel row — that one is asked for.
    expect(registeredSlots).toEqual(["conversation.input.dock", "shell.overlay", "main", "sidebar.footer.action"])
    expect(WorktreePlugin.inject).toEqual(["slots", "connection", "locale", "workspaces", "uiWorkspace", "sessions", "layout"])
  })

  it("adds the panel row when the configuration asks for it", () => {
    const registeredSlots: string[] = []
    WorktreePlugin.apply(context(registeredSlots, served({ panelEntry: "show" })) as any)

    // The panel row joins the footer shortcut, and the card that fills the Plugins
    // page's configuration section for this bundle stays either way.
    expect(registeredSlots).toEqual(["conversation.input.dock", "shell.overlay", "main", "sidebar.panellist", "sidebar.footer.action", "plugins.bundle.config"])
  })

  it("keeps the panel row when the configuration hides the footer shortcut", () => {
    const registeredSlots: string[] = []
    WorktreePlugin.apply(context(registeredSlots, served({ panelEntry: "show", sidebarEntry: "hide" })) as any)

    // Hiding a shortcut may not hide the way in: the panel row stays.
    expect(registeredSlots).toEqual(["conversation.input.dock", "shell.overlay", "main", "sidebar.panellist", "plugins.bundle.config"])
  })

  it("registers neither entry when the configuration asks for neither, but keeps the page", () => {
    const registeredSlots: string[] = []
    WorktreePlugin.apply(context(registeredSlots, served({ panelEntry: "hide", sidebarEntry: "hide" })) as any)

    // Both ways in hidden, so neither slot is registered — but the `main` panel is:
    // the row is a preference, the page itself is what the id means, and hiding a row
    // must not leave the shell with a selection it cannot resolve.
    expect(registeredSlots).toEqual(["conversation.input.dock", "shell.overlay", "main", "plugins.bundle.config"])
  })
})

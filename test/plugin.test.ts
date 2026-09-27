import { describe, expect, it, vi } from "vitest"
import { WorktreePlugin } from "../src/client/plugin"

/** A context with just enough of cordis for the plugin to apply against. */
function context(registeredSlots: string[], configForms?: { get: (name: string) => unknown; whileServed?: (names: string[], run: () => void) => () => void }) {
  return {
    connection: { rpc: { call: vi.fn() } },
    workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} } },
    uiWorkspace: {},
    effect: (effect: () => unknown) => effect(),
    slots: { inject: (name: string) => { registeredSlots.push(name); return () => {} } },
    inject: (names: string[], run: (ctx: unknown) => void) => { run(configForms === undefined ? {} : { configForms }) },
  }
}

describe("WorktreePlugin compatibility", () => {
  it("loads against the DSH client contract without a DOM", () => {
    const registeredSlots: string[] = []
    const ctx = context(registeredSlots)

    expect(() => WorktreePlugin.apply(ctx as any)).not.toThrow()
    // Without the configuration service the defaults stand: the panel row under New
    // session, and the sidebar footer's shortcut to the same page.
    expect(registeredSlots).toEqual(["conversation.input.dock", "shell.overlay", "main", "sidebar.panellist", "sidebar.footer.action"])
    expect(WorktreePlugin.inject).toEqual(["slots", "connection", "locale", "workspaces", "uiWorkspace", "sessions"])
  })

  it("keeps the panel row when the configuration hides the footer shortcut", () => {
    const registeredSlots: string[] = []
    // The client reads this plugin's own configuration through the same service its
    // neighbours use; here it says "no shortcut in the sidebar footer".
    const form = {
      getSnapshot: () => ({ status: "ready", value: { sidebarEntry: "hide" } }),
      subscribe: () => () => {},
    }
    WorktreePlugin.apply(context(registeredSlots, { get: () => form, whileServed: (_names: string[], run: () => void) => { run(); return () => {} } }) as any)

    // Hiding a shortcut may not hide the way in: the panel row stays, and so does
    // the card that fills the Plugins page's configuration section for this bundle.
    expect(registeredSlots).toEqual(["conversation.input.dock", "shell.overlay", "main", "sidebar.panellist", "plugins.bundle.config"])
  })
})

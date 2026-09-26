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
    // Without the configuration service the defaults stand: the sidebar entry, and
    // not the Settings one, since a workspace tool belongs in the sidebar.
    expect(registeredSlots).toEqual(["conversation.input.dock", "shell.overlay", "sidebar.footer.action"])
    expect(WorktreePlugin.inject).toEqual(["slots", "connection", "locale", "workspaces", "uiWorkspace", "sessions"])
  })

  it("registers the Settings entry instead when the configuration asks for it", () => {
    const registeredSlots: string[] = []
    // The client reads this plugin's own configuration through the same service its
    // neighbours use; here it says "sidebar hidden, Settings shown".
    const form = {
      getSnapshot: () => ({ status: "ready", value: { sidebarEntry: "hide", settingsEntry: "show" } }),
      subscribe: () => () => {},
    }
    WorktreePlugin.apply(context(registeredSlots, { get: () => form, whileServed: (_names: string[], run: () => void) => { run(); return () => {} } }) as any)

    // The Settings entry, and the card that fills the Plugins page's configuration
    // section for this bundle — without which the Host schema is never shown.
    expect(registeredSlots).toEqual(["conversation.input.dock", "shell.overlay", "settings.section", "plugins.bundle.config"])
  })
})

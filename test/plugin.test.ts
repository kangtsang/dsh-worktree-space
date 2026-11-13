import { describe, expect, it, vi } from "vitest"
import { WorktreePlugin } from "../src/client/plugin"

/** A context with just enough of cordis for the plugin to apply against. */
function context(registeredSlots: string[], configForms?: { get: (name: string) => unknown; whileServed?: (names: string[], run: () => void) => () => void }) {
  return {
    connection: { rpc: { call: vi.fn() } },
    workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} } },
    uiWorkspace: {},
    // The panel the sidebar row selects redirects through these: it opens the dialog and
    // hands the column back to the panel that was selected before, which it tracks by
    // subscribing to the selection.
    layout: {
      selectPanel: vi.fn(),
      panelInfo: { getSnapshot: () => ({ activePanelId: null }), subscribe: () => () => {} },
    },
    effect: (effect: () => unknown) => effect(),
    slots: { inject: (name: string) => { registeredSlots.push(name); return () => {} } },
    inject: (names: string[], run: (ctx: unknown) => void) => { run(configForms === undefined ? {} : { configForms }) }
  }
}

/** The configuration the Host serves, with the entry choice spelled out. */
function served(values: { entryStyle?: string; panelEntry?: string; sidebarEntry?: string }) {
  const form = {
    getSnapshot: () => ({ status: "ready", value: { entryStyle: "quick", panelEntry: "hide", sidebarEntry: "show", ...values } }),
    subscribe: () => () => {},
  }
  return { get: () => form, whileServed: (_names: string[], run: () => void) => { run(); return () => {} } }
}

/** The slots a run registered, in registration order. */
function slotsOf(config?: ReturnType<typeof served>) {
  const registeredSlots: string[] = []
  WorktreePlugin.apply(context(registeredSlots, config) as any)
  return registeredSlots
}

describe("WorktreePlugin compatibility", () => {
  it("loads against the DSH client contract without a DOM", () => {
    const registeredSlots = slotsOf()

    // Without the configuration service the fallback stands: the shortcut in the sidebar
    // footer, which is the arrangement every existing configuration derives to.
    expect(registeredSlots).toEqual(["conversation.input.dock", "shell.overlay", "main", "sidebar.footer.action"])
    // `remote` carries the host's open-in-app and directory-picker namespaces, and a
    // nested namespace is declared separately: `remote` alone does not make
    // `remote.session` readable. Without these the plugin still renders, but every host
    // capability answers "unavailable" - which is what left the workspace menu with no
    // "open in application" row on a machine that has one.
    expect(WorktreePlugin.inject).toEqual([
      "slots", "connection", "locale", "workspaces", "uiWorkspace", "sessions", "layout",
      "remote", "remote.session", "remote.directoryPicker",
    ])
  })

  it("puts the entry in the panel list for the standard form, and nowhere else", () => {
    // One form at a time, which is what replaced the two switches: those offered four
    // arrangements, and the fourth put the plugin nowhere in the sidebar at all.
    expect(slotsOf(served({ entryStyle: "standard" })))
      .toEqual(["conversation.input.dock", "shell.overlay", "main", "sidebar.panellist", "plugins.bundle.config"])
  })

  it("keeps the footer shortcut for the quick form", () => {
    expect(slotsOf(served({ entryStyle: "quick" })))
      .toEqual(["conversation.input.dock", "shell.overlay", "main", "sidebar.footer.action", "plugins.bundle.config"])
  })

  it("registers neither slot for the compact form, which the overlay draws instead", () => {
    // The compact entry has no slot to register into: its button is portalled into the
    // host's settings row, so it is rendered by the overlay rather than registered here.
    // The `main` panel stays registered either way - the row addresses it by key.
    expect(slotsOf(served({ entryStyle: "compact" })))
      .toEqual(["conversation.input.dock", "shell.overlay", "main", "plugins.bundle.config"])
  })

  it("derives the entry from the two switches a configuration may still carry", () => {
    // `entryStyle` is empty for every configuration written before it existed. The footer
    // shortcut was the shipped default, so a configuration that still has it on keeps it -
    // including the both-on arrangement, where the footer is the entry actually in use and
    // the panel row was an addition beside it. Losing the row costs a second way in;
    // losing the shortcut costs the one the reader had been clicking.
    expect(slotsOf(served({ entryStyle: undefined as unknown as string, panelEntry: "show", sidebarEntry: "show" })))
      .toEqual(["conversation.input.dock", "shell.overlay", "main", "sidebar.footer.action", "plugins.bundle.config"])
    expect(slotsOf(served({ entryStyle: undefined as unknown as string, panelEntry: "hide", sidebarEntry: "show" })))
      .toEqual(["conversation.input.dock", "shell.overlay", "main", "sidebar.footer.action", "plugins.bundle.config"])
    // The panel row is what a configuration gets when the footer was switched off and the
    // row left on: the only arrangement where the row was the sole way in.
    expect(slotsOf(served({ entryStyle: undefined as unknown as string, panelEntry: "show", sidebarEntry: "hide" })))
      .toEqual(["conversation.input.dock", "shell.overlay", "main", "sidebar.panellist", "plugins.bundle.config"])
  })
})

describe("the Plugins-page registrations", () => {
  /**
   * A list slot takes `id`; a keyed slot takes `key`. Putting a `key` on a list slot is
   * accepted by the register call and then never dispatched - the component simply never
   * renders, with no error anywhere. The configuration card is keyed, and this helper
   * records what each registration actually carried so that mistake stays caught.
   */
  function registrationsOf(name: string) {
    const options: Array<Record<string, unknown>> = []
    const ctx = {
      connection: { rpc: { call: vi.fn() } },
      workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} } },
      uiWorkspace: {},
      layout: {
        selectPanel: vi.fn(),
        panelInfo: { getSnapshot: () => ({ activePanelId: null }), subscribe: () => () => {} },
      },
      effect: (effect: () => unknown) => effect(),
      slots: {
        inject: (_name: string, run: () => unknown) => { run(); return () => {} },
        register: (o: Record<string, unknown>) => { options.push(o); return () => {} },
      },
      inject: (names: string[], run: (ctx: unknown) => void) => {
        run({ configForms: { get: () => ({ getSnapshot: () => ({ status: "ready", value: {} }), subscribe: () => () => {} }), whileServed: (_n: string[], r: () => void) => { r(); return () => {} } } })
      },
    }
    WorktreePlugin.apply(ctx as any)
    return options.filter((option) => option.name === name)
  }

  it("adds nothing to the Plugins detail page", () => {
    // The update pill lives in this plugin's own surfaces; the detail page is the
    // Host's, and the plugin no longer contributes a row to it.
    expect(registrationsOf("plugins.detail.actions")).toHaveLength(0)
  })

  it("keeps the keyed configuration card on a key, because that slot is keyed", () => {
    // The opposite mistake: `plugins.bundle.config` is `kind: "keyed"`, so it needs the
    // settings namespace and would be ignored with an `id`.
    const config = registrationsOf("plugins.bundle.config")
    expect(config).toHaveLength(1)
    expect(config[0]).toHaveProperty("key")
    expect(config[0]).not.toHaveProperty("id")
  })
})

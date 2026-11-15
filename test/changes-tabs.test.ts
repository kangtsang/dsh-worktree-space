/**
 * The changes sidebar's registration.
 *
 * The two tab types and their bodies are the one part of the feature that live
 * in the shell's namespaces rather than this plugin's own: a key that does not
 * match the definition's `id` registers a body nothing ever renders, and a
 * definition whose pattern does not match an address silently refuses to open
 * it. Neither is visible at runtime, so both are asserted here.
 */
import { describe, expect, it } from "vitest"
import { WorktreePlugin } from "../src/client/plugin"

interface Definition {
  id: string
  kind: string
  patterns?: string[]
  canOpen?: (address: string) => boolean
}

interface Registration {
  key: string
  component: unknown
}

function applyWithSidebar() {
  const definitions: Definition[] = []
  const registrations: Registration[] = []
  const sidebarRight = { openResource() {} }
  const sidebarRightTabs = { register(definition: Definition) { definitions.push(definition); return () => {} } }
  const slots = {
    inject(_name: string, run: () => unknown) { run(); return () => {} },
    register(options: { key?: string; name?: string }, component: unknown) {
      if (typeof options.key === "string") registrations.push({ key: options.key, component })
      return () => {}
    },
  }
  const ctx = {
    connection: { rpc: { call: async () => ({ ok: false }) } },
    workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} } },
    uiWorkspace: {},
    layout: {
      selectPanel() {},
      panelInfo: { getSnapshot: () => ({ activePanelId: null }), subscribe: () => () => {} },
    },
    effect: (run: () => unknown) => run(),
    slots: {
      inject(_name: string, run: () => unknown) { run(); return () => {} },
      register(options: { name?: string }, _component: unknown) { void options; return () => {} },
    },
    inject(names: string[], run: (scope: unknown) => void) {
      if (names.includes("sidebarRightTabs")) run({ sidebarRight, sidebarRightTabs, slots })
      else run({})
    },
  }
  WorktreePlugin.apply(ctx as never)
  return { definitions, registrations }
}

describe("changes sidebar registration", () => {
  it("registers 变更总览 and 变更查看, each with the body keyed by its own id", () => {
    const { definitions, registrations } = applyWithSidebar()
    expect(definitions.map((definition) => definition.kind)).toEqual(["wts-changes-overview", "wts-changes-view"])
    for (const definition of definitions) {
      const registration = registrations.find((entry) => entry.key === definition.id)
      expect(registration, `no body registered under ${definition.id}`).toBeDefined()
      expect(typeof registration?.component).toBe("function")
    }
  })

  it("claims only the addresses this plugin mints", () => {
    const { definitions } = applyWithSidebar()
    const overview = definitions.find((definition) => definition.kind === "wts-changes-overview")
    const view = definitions.find((definition) => definition.kind === "wts-changes-view")
    expect(overview?.canOpen?.("dsh-resource://wts-changes-overview/C%3A%5Ctasks%5Csample")).toBe(true)
    expect(overview?.canOpen?.("dsh-resource://elsewhere/anything")).toBe(false)
    expect(view?.canOpen?.("dsh-resource://wts-changes-view/C%3A%5Ctasks%5Csample%5Crepo?base=main")).toBe(true)
    expect(view?.canOpen?.("dsh-resource://wts-changes-view/")).toBe(false)
  })
})

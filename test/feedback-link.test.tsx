// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorktreesSettings } from "../src/client/components/WorktreesSettings"
import { WorktreesPage } from "../src/client/components/WorktreePanel"
import { WorktreeManagePanel } from "../src/client/components/WorktreeManagePanel"
import { ISSUES_URL } from "../src/client/lib/links"

/**
 * Every prop the components read on mount has to be answered - a missing one throws
 * during render and the assertions below would fail for the wrong reason. Nothing here
 * needs a repository, a task or a session: no workspaces is a state the panel opens in
 * anyway, and classifyRoots is left unanswered so the rows stay "checking".
 */
function stubs() {
  return {
    api: {
      classifyRoots: vi.fn(() => new Promise(() => {})),
      scan: vi.fn(async () => ({ lists: [], complete: true })),
      cachedScan: vi.fn(async () => null),
      status: vi.fn(), remove: vi.fn(), prune: vi.fn(),
    } as any,
    workspaces: {
      list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} },
      create: vi.fn(), rename: vi.fn(), delete: vi.fn(),
    } as any,
    uiWorkspace: { openWorkspace: vi.fn().mockResolvedValue(undefined) } as any,
    sessions: { list: { getSnapshot: () => ({ byId: {} }) } } as any,
    onCreate: vi.fn(),
  }
}

async function settle() {
  await act(async () => { await Promise.resolve() })
}

afterEach(cleanup)

describe("the plugin description carries a feedback link", () => {
  // The link hangs off the sentence that describes what the plugin does - not the one
  // that describes the current tab. An earlier version put it on the view description
  // and looked right in the panel, because the two sit two rows apart.
  it("is in the manage panel, where the description is read", async () => {
    const s = stubs()
    // The dialog renders through a portal, so it lives on document.body rather than
    // inside the container render() returns.
    render(<WorktreeManagePanel api={s.api} workspaces={s.workspaces} uiWorkspace={s.uiWorkspace} sessions={s.sessions} onCreate={s.onCreate} onClose={vi.fn()} />)
    await settle()

    const description = document.body.querySelector(".dws-manage-dialog .dws-form-note")
    expect(description, "the manage dialog header is the description").not.toBeNull()
    expect(description!.textContent, "this is the sentence the plugin describes itself with").toContain("一个包含多个 Git 仓库的工作任务")

    const link = description!.querySelector<HTMLAnchorElement>("a.dws-feedback-link")
    expect(link, "the feedback link follows that description").not.toBeNull()
    expect(link!.getAttribute("href")).toBe(ISSUES_URL)
    expect(link!.textContent).toBe("使用反馈")
    expect(link!.getAttribute("target")).toBe("_blank")
    expect(link!.getAttribute("rel")).toContain("noreferrer")

    // Nothing stands between the sentence and the link. A middot read as punctuation
    // belonging to the sentence it was attached to, and the two should abut.
    expect(description!.querySelector(".dws-feedback-sep"), "no separator is rendered").toBeNull()
    expect(description!.textContent, "the link follows the sentence directly")
      .toMatch(/按需清理。?使用反馈$/)
  })

  it("is not on the tab description, which names the current view", async () => {
    const s = stubs()
    const { container } = render(<WorktreesSettings api={s.api} workspaces={s.workspaces} uiWorkspace={s.uiWorkspace} sessions={s.sessions} onCreate={s.onCreate} />)
    await settle()
    const viewDescription = container.querySelector(".dws-view-description")
    expect(viewDescription, "the view description paragraph is still there").not.toBeNull()
    expect(viewDescription!.querySelector("a"), "the tab description is not where the link goes").toBeNull()
  })

  it("is not on the sidebar panel, which says the same sentence and stays bare", async () => {
    const s = stubs()
    render(<WorktreesPage api={s.api} workspaces={s.workspaces} uiWorkspace={s.uiWorkspace} sessions={s.sessions} onCreate={s.onCreate} variant="panel" />)
    await settle()
    const sidebar = document.body.querySelector(".dws-panel-lead")
    expect(sidebar, "the sidebar panel renders its own heading").not.toBeNull()
    expect(sidebar!.textContent, "the sidebar still says what the plugin does").toContain("一个包含多个 Git 仓库的工作任务")
    expect(sidebar!.querySelector("a"), "the sidebar panel has no feedback link").toBeNull()
  })

  // WorktreesSettings renders its own <h2> + description header when `heading` is set,
  // and the only production caller passes heading={false} - so that branch never runs
  // in the app. A test that renders the component directly would exercise it happily
  // and prove nothing about what a reader can reach.
  it("has no dead copy of the description that only tests can see", async () => {
    const s = stubs()
    const { container } = render(<WorktreesSettings api={s.api} workspaces={s.workspaces} uiWorkspace={s.uiWorkspace} sessions={s.sessions} onCreate={s.onCreate} heading />)
    await settle()
    const header = container.querySelector(".dws-settings-header")
    expect(header, "the heading branch still renders when asked for").not.toBeNull()
    expect(header!.querySelector("a.dws-feedback-link"), "that unreachable branch carries no second link").toBeNull()
  })

  it("is reachable by role and name, not only by CSS class", async () => {
    // A link that only a stylesheet can find is not one a keyboard can press.
    const s = stubs()
    render(<WorktreeManagePanel api={s.api} workspaces={s.workspaces} uiWorkspace={s.uiWorkspace} sessions={s.sessions} onCreate={s.onCreate} onClose={vi.fn()} />)
    await settle()
    const byName = screen.getAllByRole("link", { name: "使用反馈" })
    expect(byName).toHaveLength(1)
    expect(byName[0].getAttribute("href")).toBe(ISSUES_URL)
  })

  it("says 使用反馈 in Chinese and Feedback in English", async () => {
    // The dictionaries are module-private and reach the panel only through
    // installLocale, so the test goes through that too - asserting against a copy of
    // the strings would have tested the copy.
    const { installLocale, NS } = await import("../src/client/lib/i18n")
    const registered: Record<string, Record<string, Record<string, string>>> = {}
    const locale = {
      register: (ns: string, dictionaries: any) => { registered[ns] = dictionaries; return () => {} },
      bind: (ns: string) => (key: string) => registered[ns]?.zh?.[key] ?? key,
    }
    const dispose = installLocale({ get: (name: string) => (name === "locale" ? locale : undefined) })
    try {
      expect(registered[NS], "installLocale registered nothing under our namespace").toBeDefined()
      // Not `toBe("feedbackLink")`: a key the dictionary forgot renders to the reader
      // as the bare key string, which is exactly what this catches.
      expect(registered[NS].zh.feedbackLink).toBe("使用反馈")
      expect(registered[NS].en.feedbackLink).toBe("Feedback")
      expect(registered[NS].zh.feedbackLink).not.toBe("feedbackLink")
    } finally {
      dispose()
    }
  })

  // Every assertion above is satisfiable by a link aimed at nothing useful. This is the
  // part that makes them bite: the href is the one the plugin already uses, the
  // tracker's host is this repository's own, and the scheme is https - a link that had
  // lost its scheme would still pass an equality check against a relative path.
  it("aims at this repository's own issue tracker over https", () => {
    expect(ISSUES_URL).toBe("https://github.com/kangtsang/dsh-worktree-space/issues")
    const url = new URL(ISSUES_URL)
    expect(url.protocol).toBe("https:")
    expect(url.host).toBe("github.com")
    expect(url.pathname).toBe("/kangtsang/dsh-worktree-space/issues")
  })
})
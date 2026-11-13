// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorktreesSettings } from "../src/client/components/WorktreesSettings"
import { WorktreesPage } from "../src/client/components/WorktreePanel"
import { WorktreeManagePanel } from "../src/client/components/WorktreeManagePanel"
import { ISSUES_URL, STAR_URL, VIDEO_URL } from "../src/client/lib/links"

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
    // The flow line is the second line of the block: its own element under the
    // description, not a newline inside it - the host wraps both in one <p>.
    expect(description!.querySelector(".dws-usage-flow")?.textContent).toContain("使用流程")

    // The flow line ends with three links in Chinese: the video, the feedback link and
    // the star. They wear the same class, so each is picked out by its text. The star's
    // mark is a character in the run rather than an SVG, so it is part of that text -
    // which is exactly what makes one underline cover both.
    const links = [...description!.querySelectorAll<HTMLAnchorElement>("a.dws-feedback-link")]
    expect(links.map(link => link.textContent), "the video, the feedback link, then the star").toEqual(["视频介绍", "使用反馈", "\u2606 Star"])
    const video = links[0]
    expect(video.getAttribute("href")).toBe(VIDEO_URL)
    expect(video.getAttribute("target")).toBe("_blank")
    expect(video.getAttribute("rel")).toContain("noreferrer")
    const link = links[1]
    expect(link, "the feedback link follows that description").not.toBeNull()
    expect(link!.getAttribute("href")).toBe(ISSUES_URL)
    expect(link!.textContent).toBe("使用反馈")
    expect(link!.getAttribute("target")).toBe("_blank")
    expect(link!.getAttribute("rel")).toContain("noreferrer")
    // The star goes to the repository, not to its issues page: a star is given to the
    // project, and a reader who lands on the issue tracker has to navigate away again.
    const star = links[2]
    expect(star.getAttribute("href")).toBe(STAR_URL)
    expect(star.getAttribute("target")).toBe("_blank")
    expect(star.getAttribute("rel")).toContain("noreferrer")
    // The mark is a text character, not an inline SVG: an SVG is a replaced box that
    // `text-decoration` skips, so the word was underlined and the star beside it was not.
    // A character shares the run, which is what makes one underline cover both.
    const mark = star.querySelector(".dws-star-mark")
    expect(mark, "the star carries its own mark").not.toBeNull()
    // U+2606, the hollow star: a filled one would claim the reader had already starred
    // the project, which this side does not know.
    expect(mark!.textContent).toBe("\u2606")
    expect(mark!.getAttribute("aria-hidden")).toBe("true")
    expect(star.querySelector("svg"), "no replaced box in the link").toBeNull()

    // Nothing but one space stands between the sentence and the link. A middot read
    // as punctuation belonging to the sentence it was attached to, and the copy now
    // ends on a bracket, so the link needs its own air.
    expect(description!.querySelector(".dws-feedback-sep"), "no separator is rendered").toBeNull()
    expect(description!.textContent, "the links follow the sentence directly")
      .toMatch(/销毁任务空间）\s+视频介绍\s+使用反馈\s+\u2606\s+Star$/)
  })

  it("is not on the tab description, which names the current view", async () => {
    const s = stubs()
    const { container } = render(<WorktreesSettings api={s.api} workspaces={s.workspaces} uiWorkspace={s.uiWorkspace} sessions={s.sessions} onCreate={s.onCreate} />)
    await settle()
    const viewDescription = container.querySelector(".dws-view-description")
    expect(viewDescription, "the view description paragraph is still there").not.toBeNull()
    expect(viewDescription!.querySelector("a"), "the tab description is not where the link goes").toBeNull()
  })

  it("is on the page itself, whose navigation brings no heading of its own", async () => {
    // The page has one frame now - the dialog - and the sentence moved with it. What
    // the page draws is the navigation column and the lists; the description belongs
    // to the dialog's header, so a reader who lands here still has a way to report a
    // problem from the place that is offering the feature.
    const s = stubs()
    render(<WorktreesPage api={s.api} workspaces={s.workspaces} uiWorkspace={s.uiWorkspace} sessions={s.sessions} onCreate={s.onCreate} />)
    await settle()
    const nav = document.body.querySelector(".dws-nav")
    expect(nav, "the page draws its navigation column").not.toBeNull()
    // The page no longer repeats the description the dialog's header says once.
    expect(document.body.querySelector(".dws-feedback-link"), "the page carries no second copy").toBeNull()
  })

  it("offers the video only in Chinese, because it has no English narration", async () => {
    // The dictionaries hold both languages, so the key resolves either way - but the
    // video itself is Chinese, and a reader in the English interface cannot follow it.
    // This pins the guard rather than the string: the link is absent, not renamed. The
    // same test also proves the key still exists in both dictionaries, so offering the
    // video in another language later is a matter of the guard, not of a missing string.
    const { installLocale, NS } = await import("../src/client/lib/i18n")
    const registered: Record<string, Record<string, Record<string, string>>> = {}
    // One object, not a fresh one per call: `useSyncExternalStore` compares snapshots
    // by identity, so a new object each time re-renders forever.
    const snapshot = { language: "en" }
    const locale = {
      register: (ns: string, dictionaries: any) => { registered[ns] = dictionaries; return () => {} },
      bind: (ns: string) => (key: string) => registered[ns]?.en?.[key] ?? key,
      subscribe: () => () => {},
      getSnapshot: () => snapshot,
    }
    const dispose = installLocale({ get: (name: string) => (name === "locale" ? locale : undefined) })
    try {
      const s = stubs()
      // The manage dialog is the only place the description is rendered: the section below
      // its header starts on the toolbar and carries no title of its own.
      render(<WorktreeManagePanel api={s.api} workspaces={s.workspaces} uiWorkspace={s.uiWorkspace} sessions={s.sessions} onCreate={s.onCreate} onClose={vi.fn()} />)
      await settle()
      expect(document.body.querySelector("a[href='" + VIDEO_URL + "']"), "English offers no video link").toBeNull()
      expect(document.body.querySelector("a.dws-feedback-link")?.getAttribute("href")).toBe(ISSUES_URL)

      expect(registered[NS].zh.videoLink).toBe("视频介绍")
      expect(registered[NS].en.videoLink).toBe("Video introduction")
    } finally {
      dispose()
    }
  })


  it("is reachable by role and name, not only by CSS class", async () => {
    // A link that only a stylesheet can find is not one a keyboard can press.
    const s = stubs()
    render(<WorktreeManagePanel api={s.api} workspaces={s.workspaces} uiWorkspace={s.uiWorkspace} sessions={s.sessions} onCreate={s.onCreate} onClose={vi.fn()} />)
    await settle()
    const byName = screen.getAllByRole("link", { name: "使用反馈" })
    expect(byName).toHaveLength(1)
    expect(byName[0].getAttribute("href")).toBe(ISSUES_URL)
    // The video is reachable the same way, and is a distinct name rather than a second
    // "使用反馈" - two links with one name would be one link a screen reader cannot tell
    // from the other.
    const video = screen.getAllByRole("link", { name: "视频介绍" })
    expect(video).toHaveLength(1)
    expect(video[0].getAttribute("href")).toBe(VIDEO_URL)
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
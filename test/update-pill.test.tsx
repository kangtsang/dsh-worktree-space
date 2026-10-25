// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * These tests run against the source, where `PLUGIN_VERSION` is the `0.0.0-dev` fallback:
 * the build define that stamps the real version does not exist under vitest, and the
 * hook deliberately skips itself for a development build. So `meta` is mocked to a real
 * version, and `update-check` is left real - the registry lookup and the comparison are
 * the parts worth exercising, and they do not depend on how the version got there.
 */
const VERSION = "1.3.6"

/** A registry that answers one version, for every host. */
function stubRegistry(version: string) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ version }) })))
}

/** A clipboard that records what was written. */
function stubClipboard(write: (text: string) => Promise<void> = async () => {}) {
  const written: string[] = []
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { written.push(text); await write(text) } },
  })
  return written
}

/**
 * Render the pill with `meta` reporting a real version.
 * @param latest - what the registry will answer.
 */
async function renderPill(latest: string | null) {
  vi.resetModules()
  vi.doMock("../src/client/lib/meta", async () => {
    const actual = await vi.importActual<typeof import("../src/client/lib/meta")>("../src/client/lib/meta")
    return { ...actual, PLUGIN_VERSION: VERSION }
  })
  if (latest === null) {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline") }))
  } else {
    stubRegistry(latest)
  }
  const { UpdatePill } = await import("../src/client/components/UpdatePill")
  return render(<UpdatePill />)
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.doUnmock("../src/client/lib/meta")
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, "clipboard")
})

describe("installSpec", () => {
  it("is the name@version the Plugins page accepts", async () => {
    // Pinned to the exact version rather than @latest: the pill exists because a
    // particular version is newer than the one running.
    const { installSpec } = await import("../src/client/components/UpdatePill")
    expect(installSpec("1.3.7")).toBe("dsh-worktree-space@1.3.7")
  })
})

describe("UpdatePill", () => {
  it("renders nothing when this bundle is current", async () => {
    const { container } = await renderPill(VERSION)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(container.querySelector(".dws-update-pill")).toBeNull()
  })

  it("renders nothing when the registry cannot be reached", async () => {
    // A plugin that announced an outage would be worse than one that stayed quiet.
    const { container } = await renderPill(null)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(container.querySelector(".dws-update-pill")).toBeNull()
  })

  it("links a left click to the changelog, not to a releases page", async () => {
    // This repository publishes by tag and keeps its notes in docs/CHANGELOG.md, so
    // /releases would land on an empty list.
    await renderPill("99.0.0")
    const pill = await waitFor(() => {
      const found = document.querySelector(".dws-update-pill")
      expect(found).not.toBeNull()
      return found as HTMLAnchorElement
    })
    expect(pill.getAttribute("href")).toContain("docs/CHANGELOG.md")
    expect(pill.getAttribute("href")).toContain("github.com/kangtsang/dsh-worktree-space")
    expect(pill.getAttribute("target")).toBe("_blank")
  })

  it("copies the install spec on a right click, and suppresses the browser menu", async () => {
    const written = stubClipboard()
    await renderPill("99.0.0")
    const pill = await waitFor(() => {
      const found = document.querySelector(".dws-update-pill")
      expect(found).not.toBeNull()
      return found as HTMLElement
    })

    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
    fireEvent(pill, event)
    expect(event.defaultPrevented).toBe(true)
    await waitFor(() => expect(written).toEqual(["dsh-worktree-space@99.0.0"]))
  })

  it("confirms the copy, then goes back to the plain label", async () => {
    vi.useFakeTimers()
    try {
      stubClipboard()
      await renderPill("99.0.0")
      await vi.waitFor(() => expect(document.querySelector(".dws-update-pill")).not.toBeNull())
      const pill = document.querySelector(".dws-update-pill") as HTMLElement

      fireEvent.contextMenu(pill)
      await vi.waitFor(() => expect(pill.getAttribute("data-copied")).toBe("true"))
      // The accessible name says what was copied, so a reader who cannot see the label
      // change still learns the spec.
      expect(pill.getAttribute("aria-label")).toContain("dsh-worktree-space@99.0.0")

      vi.advanceTimersByTime(2000)
      await vi.waitFor(() => expect(pill.getAttribute("data-copied")).toBe("false"))
    } finally {
      vi.useRealTimers()
    }
  })

  it("says what a right click does, on one line, before anything is copied", async () => {
    stubClipboard()
    await renderPill("99.0.0")
    const pill = await waitFor(() => {
      const found = document.querySelector(".dws-update-pill")
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    // A right-click copy is not something a reader would guess at, so the bubble names
    // both actions and the spec. It is the plugin's own bubble rather than a native
    // : the shell styles its tooltips, and this one has to match.
    expect(pill.getAttribute("title")).toBeNull()
    fireEvent.pointerEnter(pill.parentElement as HTMLElement)
    fireEvent.mouseEnter(pill.parentElement as HTMLElement)
    const bubble = await waitFor(() => {
      const found = document.querySelector(".dws-hint")
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(bubble.textContent).toContain("dsh-worktree-space@99.0.0")
    expect(bubble.textContent).toContain("v99.0.0")
    // One line: a newline here would wrap the bubble into two rows.
    expect(bubble.textContent).not.toContain(String.fromCharCode(10))
  })

  it("leaves the pill usable when the clipboard refuses", async () => {
    // A denied permission or an insecure context. Nothing is confirmed, and the link
    // still works - the copy is a convenience, not the pill's purpose.
    stubClipboard(async () => { throw new Error("denied") })
    await renderPill("99.0.0")
    const pill = await waitFor(() => {
      const found = document.querySelector(".dws-update-pill")
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    fireEvent.contextMenu(pill)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(pill.getAttribute("data-copied")).toBe("false")
    expect(pill.getAttribute("href")).toContain("docs/CHANGELOG.md")
  })
})

describe("UpdatePill compact", () => {
  it("takes the Plugins-detail form when asked for it", async () => {
    // The detail page's capsule shares a row with that page's own outline buttons, so it
    // takes their height and type rather than the heading row's. Without the marker it
    // would be a 14px capsule in a row of 13px buttons.
    stubClipboard()
    vi.resetModules()
    vi.doMock("../src/client/lib/meta", async () => {
      const actual = await vi.importActual<typeof import("../src/client/lib/meta")>("../src/client/lib/meta")
      return { ...actual, PLUGIN_VERSION: VERSION }
    })
    stubRegistry("99.0.0")
    const { UpdatePill } = await import("../src/client/components/UpdatePill")
    render(<UpdatePill compact />)

    const pill = await waitFor(() => {
      const found = document.querySelector(".dws-update-pill")
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(pill.classList.contains("dws-update-pill-compact")).toBe(true)
    // The same two actions, unchanged: compact is a size, not a different control.
    expect(pill.getAttribute("href")).toContain("docs/CHANGELOG.md")
  })
})

describe("the Plugins-detail capsule's subject guard", () => {
  /**
   * The guard is three facts about the Host's slot props, and each was wrong once:
   * the discriminator is `"bundle"` (not `"package"`), the package is nested under
   * `pkg`, and it is named by its manifest name - `dsh-worktree-space` - not by the
   * settings key this plugin calls `worktree-space`. Asserted here rather than only in
   * the component so the shape is written down where the next reader looks.
   */
  const accepts = (subject: unknown): boolean => {
    const s = subject as { kind?: string; pkg?: { name?: string } }
    return s?.kind === "bundle" && s.pkg?.name === "dsh-worktree-space"
  }

  it("accepts this bundle's own page", () => {
    expect(accepts({ kind: "bundle", pkg: { name: "dsh-worktree-space", version: "1.3.0" } })).toBe(true)
  })

  it("rejects another bundle's page", () => {
    expect(accepts({ kind: "bundle", pkg: { name: "dsh-mnemon" } })).toBe(false)
  })

  it("rejects the row and item pages, which are other shapes", () => {
    // `{ kind: "row", pkg, row }` and `{ kind: "item", id }`.
    expect(accepts({ kind: "row", pkg: { name: "dsh-worktree-space" }, row: {} })).toBe(false)
    expect(accepts({ kind: "item", id: "dsh-worktree-space" })).toBe(false)
  })

  it("rejects the settings key as a name", () => {
    // The defect this catches: comparing against `worktree-space` never matched.
    expect(accepts({ kind: "bundle", pkg: { name: "worktree-space" } })).toBe(false)
  })
})

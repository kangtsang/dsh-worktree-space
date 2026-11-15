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

  it("names only the release notes and the version, on one line", async () => {
    await renderPill("99.0.0")
    const pill = await waitFor(() => {
      const found = document.querySelector(".dws-update-pill")
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(pill.getAttribute("title")).toBeNull()
    fireEvent.pointerEnter(pill.parentElement as HTMLElement)
    fireEvent.mouseEnter(pill.parentElement as HTMLElement)
    const bubble = await waitFor(() => {
      const found = document.querySelector(".dws-hint")
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(bubble.textContent).toContain("v99.0.0")
    // The copy gesture is gone, so the bubble must not teach one.
    expect(bubble.textContent).not.toContain("右键")
    expect(bubble.textContent).not.toContain("dsh-worktree-space@")
    // One line: a newline here would wrap the bubble into two rows.
    expect(bubble.textContent).not.toContain(String.fromCharCode(10))
  })

  it("has no copy gesture on the right button", async () => {
    await renderPill("99.0.0")
    const pill = await waitFor(() => {
      const found = document.querySelector(".dws-update-pill")
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
    fireEvent(pill, event)
    // The browser's own menu is no longer suppressed, and nothing is copied.
    expect(event.defaultPrevented).toBe(false)
    expect(pill.getAttribute("data-copied")).toBeNull()
  })
})
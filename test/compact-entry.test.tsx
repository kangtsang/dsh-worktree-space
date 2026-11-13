// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorktreeCompactEntry } from "../src/client/components/WorktreeCompactEntry"
import { t } from "../src/client/lib/i18n"

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
})

/**
 * The host's foot as the shell renders it: a settings area holding a trigger row, which
 * is where the account control and the Settings button live.
 *
 * The class names carry a hashed suffix in a real build, which is why the component
 * matches on a fragment rather than the exact name - so the fixture spells them the way
 * a build does, and a selector that quietly relied on the bare name would fail here.
 */
function settingsFoot() {
  const area = document.createElement("div")
  area.className = "settingsArea__a1b2c"
  const row = document.createElement("div")
  row.className = "triggerRow__d3e4f"
  area.append(row)
  document.body.append(area)
  return row
}

describe("the compact entry", () => {
  it("puts its button at the end of the settings row, not where the overlay is", async () => {
    const row = settingsFoot()
    const onOpen = vi.fn()
    render(<WorktreeCompactEntry onOpen={onOpen} />)

    // The row is found after the effect runs, which is one frame later than the mount.
    await vi.waitFor(() => expect(row.querySelector(".dws-compact-entry-button")).not.toBeNull())
    // The host node is a plain span, so the row keeps its own flex layout: the entry
    // contributes a button and nothing else.
    const host = row.querySelector(".dws-compact-entry")
    expect(host?.tagName).toBe("SPAN")
    fireEvent.click(screen.getByRole("button", { name: t("worktrees") }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it("falls back to a button of its own when the host has no such row", async () => {
    // A shell whose foot is not the one this was written against still gets a way in:
    // the fallback is the same button in the overlay, not an entry that silently
    // disappeared. Twenty attempts at 50ms is the whole search, so the fixture waits
    // that out rather than for a timer that will never fire.
    const onOpen = vi.fn()
    render(<WorktreeCompactEntry onOpen={onOpen} />)
    const button = screen.getByRole("button", { name: t("worktrees") })
    expect(button.closest(".dws-compact-entry-floating")).not.toBeNull()
    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it("removes its node from the host row when it unmounts", async () => {
    // The row belongs to the host: leaving a node behind would put an orphan button in
    // the foot after the plugin is gone, and a reload is not the way out of that.
    const row = settingsFoot()
    const view = render(<WorktreeCompactEntry onOpen={vi.fn()} />)
    await vi.waitFor(() => expect(row.querySelector(".dws-compact-entry")).not.toBeNull())
    view.unmount()
    expect(row.querySelector(".dws-compact-entry")).toBeNull()
  })
})

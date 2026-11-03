// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BranchPicker } from "../src/client/components/BranchPicker"
import { t } from "../src/client/lib/i18n"

/** A bare entry so the panel can be opened without the whole create dialog. */
const entry = { branches: ["main", "develop", "release/2.0"], truncated: 0 }

// cleanup() rather than emptying the body by hand: the panel is portalled there,
// and React has to unmount it so its own removal is the one that happens.
afterEach(cleanup)

describe("BranchPicker", () => {
  it("lists the repository's branches in one list, and chooses the one clicked", () => {
    const onChoose = vi.fn()
    render(<BranchPicker repository="alpha" entry={entry} loading={false} error="" chosen={undefined} current="main" onChoose={onChoose} onRetry={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: t("changeBaseRef") }))
    const panel = document.querySelector(".dws-branch-picker")!
    const lists = [...panel.querySelectorAll(".dws-branch-options")]
    expect(lists).toHaveLength(1)
    expect([...lists[0].querySelectorAll("button")].map((button) => button.textContent)).toEqual(["main", "develop", "release/2.0"])
    fireEvent.click(screen.getByRole("button", { name: "release/2.0" }))
    expect(onChoose).toHaveBeenCalledWith("release/2.0")
  })

  it("filters the list by what is typed, and names a filter with no matches", () => {
    render(<BranchPicker repository="alpha" entry={entry} loading={false} error="" chosen={undefined} current="main" onChoose={vi.fn()} onRetry={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: t("changeBaseRef") }))
    const search = screen.getByRole("textbox", { name: t("baseRefPickerSearch") }) as HTMLInputElement
    fireEvent.change(search, { target: { value: "develop" } })
    const panel = document.querySelector(".dws-branch-picker")!
    expect([...panel.querySelectorAll(".dws-branch-options button")].map((button) => button.textContent)).toEqual(["develop"])
    fireEvent.change(search, { target: { value: "nope" } })
    expect(panel.textContent).toContain("nope")
    expect(panel.querySelectorAll(".dws-branch-options button")).toHaveLength(0)
  })

  it("says it is reading while the batch is in flight, not that there are no branches", () => {
    render(<BranchPicker repository="alpha" entry={undefined} loading error="" chosen={undefined} current={undefined} onChoose={vi.fn()} onRetry={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: t("changeBaseRef") }))
    const panel = document.querySelector(".dws-branch-picker")!
    expect(panel.textContent).toContain(t("baseRefLoading"))
    expect(panel.textContent).not.toContain(t("baseRefEmpty"))
  })

  it("offers a retry and the reason when the read failed", () => {
    const onRetry = vi.fn()
    render(<BranchPicker repository="alpha" entry={undefined} loading={false} error="connection lost" chosen={undefined} current={undefined} onChoose={vi.fn()} onRetry={onRetry} />)
    fireEvent.click(screen.getByRole("button", { name: t("changeBaseRef") }))
    const panel = document.querySelector(".dws-branch-picker")!
    expect(panel.textContent).toContain("connection lost")
    fireEvent.click(screen.getByRole("button", { name: t("baseRefRetry") }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    // A failed read is not "no branches": the empty-list sentence is absent.
    expect(panel.textContent).not.toContain(t("baseRefEmpty"))
  })

  it("names how many branches were left out", () => {
    render(<BranchPicker repository="alpha" entry={{ branches: ["main"], truncated: 7 }} loading={false} error="" chosen={undefined} current="main" onChoose={vi.fn()} onRetry={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: t("changeBaseRef") }))
    expect(document.querySelector(".dws-branch-picker")!.textContent).toContain("7")
  })

  it("can clear a chosen override back to the dialog's default", () => {
    const onChoose = vi.fn()
    render(<BranchPicker repository="alpha" entry={entry} loading={false} error="" chosen="release/2.0" current="main" onChoose={onChoose} onRetry={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: t("changeBaseRef") }))
    fireEvent.click(screen.getByRole("button", { name: t("baseRefReset") }))
    expect(onChoose).toHaveBeenCalledWith(undefined)
  })

  it("says in its own tooltip that the choice is not a checkout", () => {
    render(<BranchPicker repository="alpha" entry={entry} loading={false} error="" chosen={undefined} current="main" onChoose={vi.fn()} onRetry={vi.fn()} />)
    const button = screen.getByRole("button", { name: t("changeBaseRef") })
    // The old wording was "switch branch", which reads as `git checkout`. The choice
    // only says where this task's worktree starts; the source repository keeps the
    // branch it has, and the tooltip says so where the button is pressed.
    expect(button.getAttribute("title")).toContain(t("baseRefNotCheckout"))
  })

  it("closes on Escape", () => {
    render(<BranchPicker repository="alpha" entry={entry} loading={false} error="" chosen={undefined} current="main" onChoose={vi.fn()} onRetry={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: t("changeBaseRef") }))
    expect(document.querySelector(".dws-branch-picker")).not.toBeNull()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(document.querySelector(".dws-branch-picker")).toBeNull()
  })
})

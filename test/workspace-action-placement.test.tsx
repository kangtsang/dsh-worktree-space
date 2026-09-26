// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { WorkspaceActionPlacement } from "../src/client/components/WorkspaceActionPlacement"

afterEach(cleanup)
function Fixture({ row = true }: { row?: boolean }) {
  return <div data-slot="conversation.composer">
    {row ? <div data-testid="hero-row"><button aria-haspopup="menu">Workspace</button><div data-slot="conversation.hero.agentPreset">Preset</div></div> : null}
    <div data-testid="dock"><WorkspaceActionPlacement><button title="Create worktree">Create worktree</button></WorkspaceActionPlacement></div>
  </div>
}
it("places the action between the official workspace picker and preset, not in the dock", () => {
  const result = render(<Fixture />)
  const row = screen.getByTestId("hero-row")
  expect(row.children[0].textContent).toBe("Workspace")
  expect(row.children[1].textContent).toBe("Create worktree")
  expect(row.children[2].textContent).toBe("Preset")
  expect(screen.getByTestId("dock").textContent).toBe("")
  result.unmount()
  expect(document.querySelector('.dws-hero-action')).toBeNull()
})
it("follows host row removal and recreation without leaving duplicate buttons", async () => {
  const result = render(<Fixture />)
  result.rerender(<Fixture row={false} />)
  await waitFor(() => expect(screen.queryByText("Create worktree")).toBeNull())
  result.rerender(<Fixture />)
  await waitFor(() => expect(screen.getAllByText("Create worktree")).toHaveLength(1))
  expect(screen.getByTestId("hero-row").children[1].textContent).toBe("Create worktree")
})
it("does not fall back to an orphan standalone row if host slots are unavailable", () => {
  render(<WorkspaceActionPlacement><button>Create worktree</button></WorkspaceActionPlacement>)
  expect(screen.queryByText("Create worktree")).toBeNull()
})

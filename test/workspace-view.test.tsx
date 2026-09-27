// @vitest-environment jsdom
import { format, t } from "../src/client/lib/i18n"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorktreesSettings } from "../src/client/components/WorktreesSettings"

/** One classification per workspace path, as the host would answer. */
function setup(classification: (path: string) => unknown) {
  const api: any = {
    scan: vi.fn().mockResolvedValue([]),
    status: vi.fn(),
    classifyRoot: vi.fn().mockImplementation((path: string) => Promise.resolve(classification(path))),
  }
  const items = [
    { workspaceId: "single", path: "/projects/alpha", title: "Alpha" },
    { workspaceId: "multi", path: "/projects", title: "Projects" },
    { workspaceId: "plain", path: "/notes", title: "Notes" },
  ]
  const workspaces: any = {
    list: { getSnapshot: () => ({ items }), subscribe: () => () => {} },
    create: vi.fn(), rename: vi.fn(), delete: vi.fn(),
  }
  const uiWorkspace: any = { openWorkspace: vi.fn().mockResolvedValue(undefined) }
  const onCreate = vi.fn()
  const mount = () => render(<WorktreesSettings api={api} workspaces={workspaces} uiWorkspace={uiWorkspace} sessions={{ list: { getSnapshot: () => ({ byId: {} }) } } as any} onCreate={onCreate} />)
  return { api, onCreate, mount }
}

afterEach(cleanup)

describe("WorktreesSettings workspace view", () => {
  it("says what each Workspace can host, and offers creation only where it can", async () => {
    const next = setup((path) => {
      if (path === "/projects") return { path, isRepository: false, isSourceRoot: true, repositoryCount: 3, repositories: [] }
      if (path === "/projects/alpha") return { path, isRepository: true, isSourceRoot: true, repositoryCount: 1, repositories: [] }
      return { path, isRepository: false, isSourceRoot: false, repositoryCount: 0, repositories: [] }
    })
    next.mount()
    fireEvent.click(screen.getByRole("button", { name: t("viewWorkspaces") }))

    // The answers arrive, so no row may be left saying it is still checking: the
    // effect that fills them once re-ran on its own state and aborted its own work.
    expect(await screen.findByText(t("workspaceCannot"))).toBeTruthy()
    expect(screen.getByText(format(t("workspaceSpans"), { count: "0" }))).toBeTruthy()
    expect(screen.getByText(format(t("workspaceSpans"), { count: "1" }))).toBeTruthy()
    expect(screen.getByText(format(t("workspaceSpans"), { count: "3" }))).toBeTruthy()
    expect(screen.queryByText(t("workspaceChecking"))).toBeNull()
    // Every count rides the heading, zero included, while the sentence saying no task
    // space can start there is not a count: it sits outside the heading, so it ends
    // where the creation buttons of the rows that can host one end.
    expect(screen.getByText(format(t("workspaceSpans"), { count: "0" })).closest(".dws-repo-heading")).toBeTruthy()
    const cannot = document.querySelector(".dws-space-status")
    expect(cannot?.textContent).toBe(t("workspaceCannot"))
    expect(cannot?.parentElement?.className).toBe("dws-repo-header")
    // The summary counts Workspaces here, not tasks, which is what it did before.
    expect(document.querySelector(".dws-summary")?.textContent).toBe(`3 ${t("workspaceCount")}`)

    // Only the two that can host a task space offer it, and they name themselves.
    const create = screen.getAllByRole("button", { name: t("workspaceCreate") })
    expect(create).toHaveLength(2)
    fireEvent.click(create[1])
    expect(next.onCreate).toHaveBeenCalledWith({ path: "/projects", title: "Projects" })
  })
})

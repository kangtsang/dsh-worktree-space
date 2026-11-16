// @vitest-environment jsdom
/**
 * The 变更查看 header.
 *
 * The tab's chip says only "变更查看", so the line under it is the whole answer to "which
 * repository, compared how". It used to name the two branches and leave the repository to
 * be inferred from the file paths below; the repository's name leads it now, and this
 * pins both the name and its place in the line.
 */
import { cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChangesViewTab } from "../src/client/components/changes/ChangesViewTab"
import { changesViewAddress } from "../src/client/lib/change-address"

afterEach(cleanup)

function mount(path: string) {
  const api: any = {
    changesList: vi.fn().mockResolvedValue({
      path,
      branch: "main",
      head: "abc1234",
      base: "origin/main",
      baseCommit: "def5678",
      files: [],
      totals: { files: 0, insertions: 0, deletions: 0 },
    }),
    changesFile: vi.fn(),
  }
  const tab = { id: "tab-1", contentId: changesViewAddress(path, "origin/main"), kind: "wts-changes-view", actions: { openResource() {} } }
  render(<ChangesViewTab
    useTabInfo={() => ({ tab })}
    api={api}
    sessionId="session-1"
    syncComments={() => true}
  />)
  return { api }
}

describe("the changes view header", () => {
  it("names the repository before the two branches", async () => {
    const path = "D:\\code\\openapi\\alpha-trade-integrate"
    mount(path)

    const repo = await waitFor(() => {
      const found = document.querySelector(".dws-changes-repo")
      if (found === null) throw new Error("the repository is not named yet")
      return found as HTMLElement
    })
    // The directories are spelled the way the panel spells every path.
    expect(repo.textContent).toBe("alpha-trade-integrate")
    expect(repo.getAttribute("title")).toBe(path)
    // The two branches follow it, so the line reads "repository · 分支: branch → base".
    const scope = document.querySelector(".dws-changes-scope")
    expect(scope).toBeTruthy()
    expect(repo.compareDocumentPosition(scope as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

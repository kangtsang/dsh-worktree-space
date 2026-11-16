// @vitest-environment jsdom
/**
 * The 变更总览 rows.
 *
 * A row states what it carries. When it carries nothing, "+0 −0 0 个文件" was three
 * numbers saying nothing - and reading as a measurement - so the row says it in words,
 * in the muted voice the branch line above it already uses.
 */
import { cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChangesOverviewTab } from "../src/client/components/changes/ChangesOverviewTab"
import { changesOverviewAddress } from "../src/client/lib/change-address"
import { format, t } from "../src/client/lib/i18n"

afterEach(cleanup)

function mount(repositories: unknown[]) {
  const api: any = {
    changesOverview: vi.fn().mockResolvedValue({ kind: "workspace", title: "openapi", path: "/code/openapi", repositories }),
  }
  const tab = { id: "tab-1", contentId: changesOverviewAddress("/code/openapi"), kind: "wts-changes-overview", actions: { openResource() {} } }
  render(<ChangesOverviewTab useTabInfo={() => ({ tab })} api={api} sessionId="session-1" syncComments={() => true} />)
}

const row = (name: string) => {
  const found = [...document.querySelectorAll(".dws-change-repo")].find((candidate) => (candidate.textContent ?? "").startsWith(name))
  if (found === undefined) throw new Error(`no row for ${name}`)
  return found as HTMLElement
}

describe("the changes overview rows", () => {
  it("says a repository carries nothing instead of drawing three zeros", async () => {
    mount([
      { name: "alpha-app-gateway", path: "/code/openapi/alpha-app-gateway", branch: "main", base: "origin/main", baseCommit: "abc1234", files: 0, insertions: 0, deletions: 0 },
    ])
    await waitFor(() => expect(document.querySelectorAll(".dws-change-repo")).toHaveLength(1))

    const empty = row("alpha-app-gateway")
    expect(empty.querySelector(".dws-change-repo-none")?.textContent).toBe(t("changesNoChanges"))
    expect(empty.querySelector(".dws-change-repo-counts")).toBeNull()
    expect(empty.querySelector(".dws-line-files")).toBeNull()
    expect(empty.textContent).not.toContain("+0")
  })

  it("still draws the counts when there are any", async () => {
    mount([
      { name: "alpha-risk-trade", path: "/code/openapi/alpha-risk-trade", branch: "main", base: "origin/main", baseCommit: "abc1234", files: 5, insertions: 12, deletions: 7 },
    ])
    await waitFor(() => expect(document.querySelectorAll(".dws-change-repo")).toHaveLength(1))

    const counted = row("alpha-risk-trade")
    expect(counted.querySelector(".dws-change-repo-none")).toBeNull()
    expect(counted.querySelector(".dws-change-repo-counts")?.textContent).toBe("+12−7")
    expect(counted.querySelector(".dws-line-files")?.textContent).toBe(format(t("changesFileCount"), { count: "5" }))
  })
})

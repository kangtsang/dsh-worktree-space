import { describe, expect, it } from "vitest"
import { rememberedRepositories, scannedRepositories } from "../src/client/lib/scan"
import type { WorktreeList } from "../src/client/lib/types"

function repository(path: string, linked = false): WorktreeList {
  return {
    repoPath: path,
    worktrees: [
      { path, branch: "main", isMain: true, detached: false, locked: false, prunable: false },
      ...(linked ? [{ path: `${path}.worktrees/task`, branch: "task", isMain: false, detached: false, locked: false, prunable: false }] : []),
    ],
  }
}

const status = { branchLine: "## task", changedFiles: 3, output: "## task\n M a.txt" }

describe("the rows a scan produces", () => {
  it("lists each repository once and keeps only its linked worktrees", () => {
    // The same repository arrives twice, once spelled with a trailing separator,
    // as it does when a task space is scanned on top of its source root.
    const repositories = scannedRepositories([repository("/projects/one", true), repository("/projects/one/", true)])

    expect(repositories).toHaveLength(1)
    expect(repositories[0]).toMatchObject({ repoPath: "/projects/one", currentBranch: "main" })
    expect(repositories[0].worktrees).toHaveLength(1)
    expect(repositories[0].worktrees[0]).toMatchObject({ path: "/projects/one.worktrees/task", isMain: false })
  })
})

describe("the rows a remembered scan paints", () => {
  it("uses the status the Host still holds for a worktree", () => {
    const repositories = rememberedRepositories({
      repositories: [repository("/projects/one", true)],
      statuses: { "/projects/one.worktrees/task": status },
    })

    expect(repositories[0].worktrees[0]).toMatchObject({ path: "/projects/one.worktrees/task", changedFiles: 3, branchLine: "## task" })
    expect(repositories[0].worktrees[0].statusError).toBeUndefined()
    expect(repositories[0].worktrees[0].checking).toBeUndefined()
  })

  it("leaves a worktree the Host was never asked about as still being checked", () => {
    const repositories = rememberedRepositories({
      repositories: [repository("/projects/one", true)],
      statuses: {},
    })

    // A flag rather than a message in `statusError`: the flag is what later tells
    // "not read yet" apart from "could not be read", and it must not depend on how
    // the panel happens to word the label.
    expect(repositories[0].worktrees[0]).toMatchObject({ path: "/projects/one.worktrees/task", checking: true })
    expect(repositories[0].worktrees[0].statusError).toBeUndefined()
  })
})

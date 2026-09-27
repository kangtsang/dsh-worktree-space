import { describe, expect, it } from "vitest"
import { groupTasks, taskContainerOf } from "../src/client/lib/tasks"
import type { Worktree, WorktreeList } from "../src/client/lib/types"

function worktree(path: string, branch: string | undefined, extra: Partial<Worktree> = {}): Worktree {
  return { path, branch, isMain: false, detached: false, locked: false, prunable: false, ...extra }
}
function repository(repoPath: string, rows: Worktree[]): WorktreeList {
  return { repoPath, commonDir: `${repoPath}/.git`, worktrees: [worktree(repoPath, "main", { isMain: true }), ...rows] }
}
const root = "E:\\worktree-space"
const taskPath = (task: string, name: string) => `${root}\\${task}\\${name}`

describe("task grouping", () => {
  it("recognizes only the container layout a task is created in", () => {
    expect(taskContainerOf(worktree(taskPath("antest", "api"), "feat/antest"))).toBe(`${root}\\antest`)
    // A hand-made worktree keeps its repository's own directory name and does
    // not sit on the branch its container is named after.
    expect(taskContainerOf(worktree("/projects/alpha.worktrees/task", "task/feature"))).toBeUndefined()
    expect(taskContainerOf(worktree("/projects/alpha.worktrees/alpha.worktrees", "task/feature"))).toBeUndefined()
    // The repository's own working tree is never a task.
    expect(taskContainerOf({ ...worktree(`${root}\\antest\\api`, "feat/antest"), isMain: true })).toBeUndefined()
    // A detached worktree has no branch to match.
    expect(taskContainerOf(worktree(taskPath("antest", "api"), undefined))).toBeUndefined()
  })

  it("groups the worktrees of one task across repositories", () => {
    const tasks = groupTasks([
      repository("/projects/api", [worktree(taskPath("antest", "api"), "feat/antest", { changedFiles: 3 })]),
      repository("/projects/web", [worktree(taskPath("antest", "web"), "feat/antest")]),
    ])

    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      name: "antest",
      path: `${root}\\antest`,
      tasksRoot: root,
      branch: "feat/antest",
      changedFiles: 3,
      lockedRepositories: 0,
      unknownRepositories: 0,
    })
    expect(tasks[0].repositories.map((entry) => [entry.name, entry.branch])).toEqual([
      ["api", "feat/antest"],
      ["web", "feat/antest"],
    ])
  })

  it("keeps tasks apart, orders them by name, and leaves other worktrees alone", () => {
    const tasks = groupTasks([
      repository("/projects/api", [
        worktree(taskPath("zebra", "api"), "feat/zebra"),
        worktree(taskPath("antest", "api"), "feat/antest"),
        worktree("/projects/api.worktrees/spike", "spike"),
      ]),
    ])

    expect(tasks.map((task) => task.name)).toEqual(["antest", "zebra"])
  })

  it("counts a task once when two scans surface the same worktree", () => {
    const row = worktree(taskPath("antest", "api"), "feat/antest", { changedFiles: 2 })
    const tasks = groupTasks([repository("/projects/api", [row]), repository("E:\\worktree-space\\antest\\api", [row])])

    expect(tasks).toHaveLength(1)
    expect(tasks[0].repositories).toHaveLength(1)
    expect(tasks[0].changedFiles).toBe(2)
  })

  it("reports a shared branch only when every repository agrees on one", () => {
    const agreeing = groupTasks([
      repository("/projects/api", [worktree(taskPath("antest", "api"), "feat/antest")]),
      repository("/projects/web", [worktree(taskPath("antest", "web"), "feat/antest")]),
    ])
    expect(agreeing[0].branch).toBe("feat/antest")

    const disagreeing = groupTasks([
      repository("/projects/api", [worktree(taskPath("antest", "api"), "feat/antest")]),
      // Same task, a different branch: someone checked another branch out inside
      // one of its worktrees, so the task has no single branch to report.
      repository("/projects/web", [worktree(taskPath("antest", "web"), "wip/antest")]),
    ])
    expect(disagreeing[0].branch).toBeUndefined()
  })

  it("adds up the commits each repository still has to merge back", () => {
    const tasks = groupTasks([
      repository("/projects/api", [worktree(taskPath("antest", "api"), "feat/antest", { commits: 3 })]),
      repository("/projects/web", [worktree(taskPath("antest", "web"), "feat/antest", { commits: 1 })]),
    ])

    expect(tasks[0].commits).toBe(4)
    expect(tasks[0].repositories.map((entry) => [entry.name, entry.commits])).toEqual([["api", 3], ["web", 1]])
    // A row whose status carried no count contributes nothing rather than NaN.
    const uncounted = groupTasks([repository("/projects/api", [worktree(taskPath("antest", "api"), "feat/antest")])])
    expect(uncounted[0].commits).toBe(0)
    expect(uncounted[0].repositories[0].commits).toBe(0)
  })

  it("separates unavailable status, a locked worktree and a stale record from a clean one", () => {
    const tasks = groupTasks([
      repository("/projects/api", [worktree(taskPath("antest", "api"), "feat/antest", { statusError: "worktree-unavailable" })]),
      repository("/projects/web", [worktree(taskPath("antest", "web"), "feat/antest", { locked: true })]),
      repository("/projects/docs", [worktree(taskPath("antest", "docs"), "feat/antest", { prunable: true })]),
    ])

    expect(tasks[0]).toMatchObject({ unknownRepositories: 1, lockedRepositories: 1, prunableRepositories: 1, changedFiles: 0 })
    expect(tasks[0].repositories.find((entry) => entry.name === "api")?.unknown).toBe(true)
    expect(tasks[0].repositories.find((entry) => entry.name === "docs")?.prunable).toBe(true)
  })
})

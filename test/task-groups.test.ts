import { describe, expect, it } from "vitest"
import { groupTasks, taskContainerOf } from "../src/client/lib/tasks"
import type { Worktree, WorktreeList } from "../src/client/lib/types"

function worktree(path: string, branch: string | undefined, extra: Partial<Worktree> = {}): Worktree {
  return { path, branch, isMain: false, detached: false, locked: false, prunable: false, ...extra }
}
function repository(repoPath: string, rows: Worktree[]): WorktreeList {
  return { repoPath, worktrees: [worktree(repoPath, "main", { isMain: true }), ...rows] }
}
const root = "E:\\worktree-space"
// A task space is `<container root>/<project>/<task>`, and the project is the
// source root's own directory name.
const project = "kratos-admin"
const taskPath = (task: string, name: string) => `${root}\\${project}\\${task}\\${name}`

describe("task grouping", () => {
  it("recognizes only the container layout a task is created in", () => {
    expect(taskContainerOf(worktree(taskPath("antest", "api"), "feat/antest"))).toBe(`${root}\\${project}\\antest`)
    // A hand-made worktree keeps its repository's own directory name and does
    // not sit on the branch its container is named after.
    expect(taskContainerOf(worktree("/projects/alpha.worktrees/task", "task/feature"))).toBeUndefined()
    expect(taskContainerOf(worktree("/projects/alpha.worktrees/alpha.worktrees", "task/feature"))).toBeUndefined()
    // The repository's own working tree is never a task.
    expect(taskContainerOf({ ...worktree(`${root}\\${project}\\antest\\api`, "feat/antest"), isMain: true })).toBeUndefined()
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
      path: `${root}\\${project}\\antest`,
      // Both coordinates read back from the path's depth, so a finish names the
      // same task space the create wrote.
      project,
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

  it("keeps two projects' same-named tasks apart", () => {
    // One container root, two projects, a task called `login` in each: without the
    // project layer these would be a single task holding two repositories.
    const tasks = groupTasks([
      repository("/projects/api", [worktree(`${root}\\kratos-admin\\login\\api`, "task/login")]),
      repository("/projects/web", [worktree(`${root}\\kratos-api\\login\\web`, "task/login")]),
    ])

    expect(tasks.map((task) => `${task.project}/${task.name}`)).toEqual(["kratos-admin/login", "kratos-api/login"])
    expect(tasks.map((task) => task.tasksRoot)).toEqual([root, root])
    expect(tasks[0].repositories.map((entry) => entry.name)).toEqual(["api"])
    expect(tasks[1].repositories.map((entry) => entry.name)).toEqual(["web"])
  })

  it("counts a task once when two scans surface the same worktree", () => {
    const row = worktree(taskPath("antest", "api"), "feat/antest", { changedFiles: 2 })
    const tasks = groupTasks([repository("/projects/api", [row]), repository(`${root}\\${project}\\antest\\api`, [row])])

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

  it("tells a status still being read from one that could not be read", () => {
    // The flag is set while the read is in flight, so the same field can carry a
    // real failure without the two being told apart by comparing the text.
    const row = worktree(taskPath("antest", "api"), "feat/antest", { checking: true })
    expect(groupTasks([repository("/projects/api", [row])])[0]).toMatchObject({ checkingRepositories: 1, unknownRepositories: 0 })
    expect(groupTasks([repository("/projects/api", [row])])[0].repositories[0]).toMatchObject({ checking: true, unknown: false })

    // The same word in `statusError` with no flag is a failure, which is what the
    // page used to report for every row of every refresh.
    const mislabelled = worktree(taskPath("antest", "api"), "feat/antest", { statusError: "Checking status…" })
    expect(groupTasks([repository("/projects/api", [mislabelled])])[0].unknownRepositories).toBe(1)

    // A real failure is still a failure while other reads are in flight.
    const failed = worktree(taskPath("antest", "web"), "feat/antest", { statusError: "worktree-unavailable" })
    const [mixed] = groupTasks([repository("/projects/api", [row]), repository("/projects/web", [failed])])
    expect(mixed).toMatchObject({ checkingRepositories: 1, unknownRepositories: 1 })
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

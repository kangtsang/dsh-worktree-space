import { describe, expect, it } from "vitest"
import { cleanPath, commonAncestor, nameOf, parentOf, slugOf, taskDirectory } from "../src/client/lib/paths"

describe("worktree path helpers", () => {
  it("normalizes trailing separators without changing root paths", () => {
    expect(cleanPath("/repo///")).toBe("/repo")
    expect(cleanPath("C:\\repo\\\\")).toBe("C:\\repo")
    expect(cleanPath("/")).toBe("/")
  })

  it("creates safe stable slugs", () => {
    expect(slugOf(" Login fix ")).toBe("login-fix")
    expect(slugOf("タスク")).toBe("task")
    expect(slugOf("")).toBe("task")
  })

  it("places the task directory inside the container, matching its separator style", () => {
    expect(taskDirectory("/tasks", "login-fix")).toBe("/tasks/login-fix")
    expect(taskDirectory("C:\\worktree-space", "login-fix")).toBe("C:\\worktree-space\\login-fix")
    expect(taskDirectory("/tasks/", "login-fix")).toBe("/tasks/login-fix")
  })

  it("splits a path into its parent and name in either separator style", () => {
    expect(parentOf("C:\\worktree-space\\antest\\repo")).toBe("C:\\worktree-space\\antest")
    expect(nameOf("C:\\worktree-space\\antest\\repo")).toBe("repo")
    expect(parentOf("/tasks/antest/repo/")).toBe("/tasks/antest")
    expect(nameOf("/tasks/antest/repo/")).toBe("repo")
    // A bare name has no parent, and a root keeps itself as its own parent.
    expect(parentOf("repo")).toBe("repo")
    expect(nameOf("repo")).toBe("repo")
    expect(parentOf("/tasks")).toBe("/tasks")
  })

  it("finds the deepest directory that holds both paths", () => {
    // A task space beside its repositories: the worktree and the repository meet one
    // level up, which is the directory a handoff session has to be opened on.
    expect(commonAncestor("C:\\wt\\spaces\\demo\\alpha", "C:\\wt\\repos\\alpha")).toBe("C:/wt")
    expect(commonAncestor("/home/u/tasks/a", "/home/u/repos/a")).toBe("/home/u")
    // Compared without case, and reported in the first path's own style: the two paths
    // arrive from different sources.
    expect(commonAncestor("C:\\WT\\repos\\a", "c:\\wt\\spaces\\a")).toBe("C:/WT")
    // A path is its own ancestor, so nothing widens when there is nothing to reach.
    expect(commonAncestor("C:\\wt\\spaces\\a", "C:\\wt\\spaces\\a")).toBe("C:/wt/spaces/a")
    expect(commonAncestor("C:\\wt\\spaces\\a\\", "C:\\wt\\spaces\\a")).toBe("C:/wt/spaces/a")
    // A volume root, a filesystem root, or another volume is no boundary to hand a
    // session: the whole disk is worse than the approval it would avoid.
    expect(commonAncestor("C:\\wt\\a", "C:\\other\\b")).toBeUndefined()
    expect(commonAncestor("C:\\wt\\a", "D:\\wt\\b")).toBeUndefined()
    expect(commonAncestor("/x", "/y")).toBeUndefined()
    // Segment-wise, not by prefix: `wt` and `wtx` share nothing.
    expect(commonAncestor("C:\\wt\\a", "C:\\wtx\\a")).toBeUndefined()
  })
})

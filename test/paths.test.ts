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
})

describe("the directory a worktree and its repository share", () => {
  it("finds the narrowest directory reaching both, in forward slashes", () => {
    // The demo's layout: a task space beside the repositories it was checked out from.
    // A linked worktree keeps its git metadata in the repository, so a commit has to
    // write into both - and this is the narrowest boundary that lets it.
    expect(commonAncestor("E:\\wt-demo\\spaces\\demo\\alpha", "E:\\wt-demo\\repos\\alpha")).toBe("E:/wt-demo")
    // Deeper down, only the shared part comes back, and neither path's extra segments.
    expect(commonAncestor("/work/api.worktrees/spike", "/work/api")).toBe("/work")
  })

  it("keeps the left path's own spelling of the shared part", () => {
    // The two paths reach here from different sources - the Host's answer and a git
    // command's output - so the comparison ignores case while the answer keeps the
    // spelling the caller already had on screen.
    expect(commonAncestor("E:\\Work\\task\\alpha", "e:\\work\\repos\\alpha")).toBe("E:/Work")
  })

  it("answers with nothing when only a volume root is shared", () => {
    // A boundary that wide would make a whole disk writable, which is worse than the
    // approval it saves: the caller falls back to the worktree itself.
    expect(commonAncestor("E:\\wt-demo\\spaces\\demo\\alpha", "D:\\repos\\alpha")).toBeUndefined()
    expect(commonAncestor("/work/task/alpha", "D:/repos/alpha")).toBeUndefined()
  })
})

import { describe, expect, it } from "vitest"
import { cleanPath, nameOf, parentOf, slugOf, taskDirectory } from "../src/client/lib/paths"

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

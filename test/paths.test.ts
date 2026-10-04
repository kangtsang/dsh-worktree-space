import { describe, expect, it } from "vitest"
import { cleanPath, commonAncestor, isInsideDirectory, nameOf, normalizedSlugOf, parentOf, slugOf, taskDirectory } from "../src/client/lib/paths"

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

  it("normalizes a name once, so the slug and the emptiness check cannot drift", () => {
    // The two used to spell the same rule out separately: the form validated against
    // one and asked the other whether anything was left, and a change to one was not a
    // change to the other - which is how a field comes to show a name as valid and
    // send a different one. The rule is stated once here and the placeholder is the
    // only thing added to it.
    for (const value of [" Login fix ", "タスク", "", "   ", "!!!", "a..b", "task.", "-x-", 0, false, null, undefined]) {
      expect(slugOf(value)).toBe(normalizedSlugOf(value) || "task")
    }
    expect(normalizedSlugOf("")).toBe("")
    expect(normalizedSlugOf("   ")).toBe("")
    // The emptiness check is the rule too, so a name it cannot reduce is refused
    // rather than turned into the placeholder.
    expect(normalizedSlugOf("タスク")).toBe("")
    expect(normalizedSlugOf("!!!")).toBe("")
    expect(normalizedSlugOf(" Login fix ")).toBe("login-fix")
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
    // spelling the caller already had on screen. Both carry a drive letter, which is
    // what says they are Windows paths where one directory has one spelling.
    expect(commonAncestor("E:\\Work\\task\\alpha", "e:\\work\\repos\\alpha")).toBe("E:/Work")
  })

  it("finds no shared directory between two POSIX paths that differ only in case", () => {
    // `/Work` and `/work` are two directories, so there is no directory above both of
    // them but `/` - and `/` is exactly the boundary `commonAncestor` refuses to hand
    // back, because a write boundary that wide would make the whole disk writable.
    //
    // These two cases run on every platform, including a Windows one: the client does
    // not read `process.platform` - it is a browser bundle and that value would
    // describe the browser - it decides from the path shape. So a POSIX path is treated
    // as case-sensitive whether or not the machine running the test is.
    expect(commonAncestor("/Work/task/alpha", "/work/repos/alpha")).toBeUndefined()
    expect(commonAncestor("/Work/task/alpha", "/Work/repos/alpha")).toBe("/Work")
  })

  it("does not place a POSIX path inside another that differs only in case", () => {
    // The layout rules ask this of two directories that have to stay outside one
    // another. Answering from spelling alone rejected a container for no reason.
    expect(isInsideDirectory("/workspace", "/WORKSPACE/public")).toBe(false)
    expect(isInsideDirectory("/workspace", "/workspace/public")).toBe(true)
    // A drive letter is the other end of the same rule, in the other direction.
    expect(isInsideDirectory("e:\\workspace", "E:\\WORKSPACE\\public")).toBe(true)
  })

  it("answers with nothing when only a volume root is shared", () => {
    // A boundary that wide would make a whole disk writable, which is worse than the
    // approval it saves: the caller falls back to the worktree itself.
    expect(commonAncestor("E:\\wt-demo\\spaces\\demo\\alpha", "D:\\repos\\alpha")).toBeUndefined()
    expect(commonAncestor("/work/task/alpha", "D:/repos/alpha")).toBeUndefined()
  })
})

import { describe, expect, it } from "vitest"
import { dirname, join, parse, resolve } from "node:path"
import {
  assertIsolated,
  canonicalPath,
  containerIn,
  isInside,
  IsolationError,
  recommendTasksRoot,
  samePathLocation,
} from "../src/host/task/paths.js"

describe("canonicalPath", () => {
  it("unifies separator style so Git and filesystem paths compare equal", () => {
    expect(canonicalPath("E:\\work\\repo")).toBe(canonicalPath("E:/work/repo"))
  })

  it("drops trailing separators", () => {
    expect(canonicalPath("/a/b/")).toBe(canonicalPath("/a/b"))
    expect(canonicalPath("E:\\")).toBe(canonicalPath("E:"))
  })

  it("keeps a bare root distinguishable from an empty path", () => {
    expect(canonicalPath("/")).toBe("/")
  })
})

describe("samePathLocation", () => {
  it("folds case only where the platform does", () => {
    const expected = process.platform === "win32"
    expect(samePathLocation("E:\\Work\\Repo", "E:/work/repo")).toBe(expected)
  })

  it("matches identical paths on every platform", () => {
    expect(samePathLocation("/a/b", "/a/b/")).toBe(true)
  })
})

describe("isInside", () => {
  it("treats a path as not inside itself", () => {
    expect(isInside("/a/b", "/a/b")).toBe(false)
    expect(isInside("/a/b", "/a/b/")).toBe(false)
  })

  it("detects real descendants without matching a shared prefix", () => {
    expect(isInside("/a/b", "/a/b/c")).toBe(true)
    expect(isInside("/a/b", "/a/bc")).toBe(false)
  })

  it("treats a drive root as containing its paths", () => {
    expect(isInside("E:\\", "E:\\worktree-space\\task")).toBe(true)
  })
})

describe("assertIsolated", () => {
  it("rejects the source root used as its own container", () => {
    expect(() => assertIsolated("/src", "/src")).toThrow(IsolationError)
  })

  it("rejects a container inside the source tree", () => {
    expect(() => assertIsolated("/src", "/src/tasks")).toThrow(/inside the source root/)
  })

  it("rejects a source root inside the container", () => {
    expect(() => assertIsolated("/src/projects", "/src")).toThrow(/source root is inside/)
  })

  it("accepts a layout beside the source root", () => {
    expect(() => assertIsolated("/src/projects", "/tasks")).not.toThrow()
  })

  it("sees through separator and trailing-slash differences", () => {
    expect(() => assertIsolated("E:\\work\\projects", "E:/work/projects/tasks/")).toThrow(/inside the source root/)
  })
})

describe("containerIn", () => {
  it("names the container worktree-space under any parent", () => {
    expect(containerIn("E:\\", "E:\\repo")).toBe(join("E:\\", "worktree-space"))
    expect(containerIn("/home/me/projects", "/home/me/projects/repo")).toBe(
      join("/home/me/projects", "worktree-space"),
    )
  })

  it("takes dsh-worktree-space only where its own name would land on the source root", () => {
    expect(containerIn("E:\\", join("E:\\", "worktree-space"))).toBe(join("E:\\", "dsh-worktree-space"))
    expect(containerIn("E:\\", join("E:\\", "worktree-space", "public", "repo"))).toBe(
      join("E:\\", "dsh-worktree-space"),
    )
  })

  it("keeps worktree-space for a source root that merely sits beside it", () => {
    expect(containerIn("E:\\", join("E:\\", "worktree-space-notes"))).toBe(join("E:\\", "worktree-space"))
    expect(containerIn("E:\\", join("E:\\", "repo"))).toBe(join("E:\\", "worktree-space"))
  })
})

describe("recommendTasksRoot", () => {
  it("never recommends a location that nests with the source root", () => {
    const sourceRoot = join(process.cwd(), "scratch-source")
    const recommended = recommendTasksRoot(sourceRoot)
    expect(recommended.length).toBeGreaterThan(0)
    expect(isInside(sourceRoot, recommended)).toBe(false)
    expect(isInside(recommended, sourceRoot)).toBe(false)
    expect(() => assertIsolated(sourceRoot, recommended)).not.toThrow()
  })

  it("shares the source root's first directory below the volume root", () => {
    // Both the source root and the container sit under one directory that is
    // still below the volume root, which is the common ancestor a session needs
    // to commit in a linked worktree. A path without a drive has no such
    // directory to share, and stays beside the source root instead.
    const sourceRoot = join(process.cwd(), "nested", "source-root")
    const absolute = resolve(sourceRoot)
    const { root } = parse(absolute)
    const first = /^[A-Za-z]:[\\/]$/.test(root)
      ? join(root, absolute.slice(root.length).split(/[\\/]+/)[0])
      : undefined
    const recommended = recommendTasksRoot(sourceRoot)
    expect(recommended).toBe(first === undefined ? join(dirname(absolute), "worktree-space") : join(first, "worktree-space"))
    expect(() => assertIsolated(absolute, recommended)).not.toThrow()
  })

  it("falls back when the source root is itself that first directory", () => {
    // Nothing sits beside `<drive>:\repo` below the volume root, so the volume root
    // answers, and the container keeps the name every other scenario uses.
    const { root } = parse(resolve(process.cwd()))
    const sourceRoot = join(root, "repo")
    const recommended = recommendTasksRoot(sourceRoot)
    const drive = /^[A-Za-z]:[\\/]$/.test(root)
    expect(recommended).toBe(drive ? join(root, "worktree-space") : join(dirname(sourceRoot), "worktree-space"))
    expect(() => assertIsolated(sourceRoot, recommended)).not.toThrow()
  })

  it("uses the backup name only when the container's own path is the source root", () => {
    // `<parent>\worktree-space` is the answer everywhere else; this is the one
    // layout where that name would be the source root itself.
    const { root } = parse(resolve(process.cwd()))
    const drive = /^[A-Za-z]:[\\/]$/.test(root)
    const parent = drive ? root : dirname(join(root, "worktree-space"))
    const sourceRoot = join(parent, "worktree-space")
    const recommended = recommendTasksRoot(sourceRoot)
    expect(recommended).toBe(join(parent, "dsh-worktree-space"))
    expect(() => assertIsolated(sourceRoot, recommended)).not.toThrow()
  })
})

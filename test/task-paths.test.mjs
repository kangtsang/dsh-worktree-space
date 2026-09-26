import { describe, expect, it } from "vitest"
import { dirname, join, parse, resolve } from "node:path"
import {
  assertIsolated,
  canonicalPath,
  chooseTasksRoot,
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

describe("chooseTasksRoot", () => {
  it("prefers <drive>:\\workspace while that name is free", () => {
    expect(chooseTasksRoot("E:\\", "E:\\fallback", () => false)).toBe(join("E:\\", "workspace"))
  })

  it("falls back to <drive>:\\worktree-space once the name is taken", () => {
    expect(chooseTasksRoot("E:\\", "E:\\fallback", () => true)).toBe(join("E:\\", "worktree-space"))
  })

  it("falls back to a sibling when the path has no drive", () => {
    expect(chooseTasksRoot(undefined, "/home/me/projects", () => false)).toBe(
      join("/home/me/projects", "worktree-space"),
    )
  })
})

describe("recommendTasksRoot", () => {
  it("never recommends a location that nests with the source root", () => {
    const sourceRoot = join(process.cwd(), "scratch-source")
    const recommended = recommendTasksRoot(sourceRoot, { exists: () => false })
    expect(recommended.length).toBeGreaterThan(0)
    expect(isInside(sourceRoot, recommended)).toBe(false)
    expect(isInside(recommended, sourceRoot)).toBe(false)
    expect(() => assertIsolated(sourceRoot, recommended)).not.toThrow()
  })

  it("hands back the drive candidate, or a sibling when that candidate would contain the source root", () => {
    // A checkout that already lives under `<drive>:\workspace` — this
    // repository's own layout on Windows — must not be handed a container that
    // contains it, so the sibling fallback answers instead.
    const sourceRoot = join(process.cwd(), "nested", "source-root")
    const absolute = resolve(sourceRoot)
    const sibling = join(dirname(absolute), "worktree-space")
    const { root } = parse(absolute)
    const driveCandidate = /^[A-Za-z]:[\\/]$/.test(root) ? join(root, "workspace") : sibling
    const recommended = recommendTasksRoot(sourceRoot, { exists: () => false })
    expect([driveCandidate, sibling]).toContain(recommended)
    expect(() => assertIsolated(absolute, recommended)).not.toThrow()
  })

  it("keeps <drive>:\\worktree-space once the drive already has a workspace folder", () => {
    // The drive branch only engages on a path that carries one, so assert the
    // decision itself; the wrapper's guard is covered above.
    expect(chooseTasksRoot("E:\\", "unused", () => true).endsWith("worktree-space")).toBe(true)
  })
})

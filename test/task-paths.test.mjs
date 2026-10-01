import { describe, expect, it } from "vitest"
import { dirname, join, parse, resolve } from "node:path"
import {
  assertIsolated,
  canonicalPath,
  containerIn,
  containerParentFor,
  isInside,
  IsolationError,
  recommendTasksRoot,
  samePathLocation,
} from "../src/host/task/paths.js"

/**
 * The first directory below a path's volume root — the level the rule puts the
 * container under, worked out here the plain way so the test does not simply
 * restate the implementation it is checking.
 * @param path - an absolute path.
 * @returns that directory, or the volume root itself when the path is that level.
 */
function rootWorkspaceOf(path) {
  const { root } = parse(path)
  const [first] = path.slice(root.length).split(/[\\/]+/).filter(Boolean)
  return first === undefined ? root : join(root, first)
}

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

  it("rejects a container inside the repositories' directory", () => {
    expect(() => assertIsolated("/src", "/src/tasks")).toThrow(
      /the tasks root \/src\/tasks is inside the repositories' directory \/src[\s\S]*put the container beside that directory/,
    )
  })

  it("rejects a container that would hold the repositories' directory", () => {
    expect(() => assertIsolated("/src/projects", "/src")).toThrow(
      /the tasks root \/src contains the repositories' directory \/src\/projects/,
    )
  })

  it("accepts a layout beside the source root", () => {
    expect(() => assertIsolated("/src/projects", "/tasks")).not.toThrow()
  })

  it("sees through separator and trailing-slash differences", () => {
    expect(() => assertIsolated("E:\\work\\projects", "E:/work/projects/tasks/")).toThrow(/inside the repositories' directory/)
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

  it("gives every project under one root workspace the same container", () => {
    // The point of the rule. A project sitting directly under the root workspace
    // and one sitting three levels deeper both reach one container, so a deep
    // project does not get a second copy of it beside itself.
    //
    // Asked of the decision itself, with the paths spelled out: the rule is about
    // a drive-letter path, and recommendTasksRoot resolves its argument first —
    // resolving one of those is Windows-only, so on any other runner the same
    // assertion would be made about a path the platform had already rewritten.
    const rootWorkspace = join("E:\\", "workspace")
    expect(containerParentFor(join(rootWorkspace, "project1"), "E:\\")).toBe(rootWorkspace)
    expect(containerParentFor(join(rootWorkspace, "deep-path", "nested", "project2"), "E:\\")).toBe(rootWorkspace)

    // Through the real entry point too, on whatever platform this runs: neither
    // project ends up nested with the container recommended for it.
    const shallow = join(process.cwd(), "project1")
    const deep = join(process.cwd(), "deep-path", "nested", "project2")
    for (const sourceRoot of [shallow, deep]) {
      expect(() => assertIsolated(resolve(sourceRoot), recommendTasksRoot(sourceRoot))).not.toThrow()
    }
  })

  it("falls back to the volume root for a source root that sits directly in it", () => {
    // `E:\repo` has nothing beside it that is still below the volume root, so the
    // volume root answers. A POSIX path has no level below its root at all, and its
    // own parent answers instead — which is the same directory.
    const { root } = parse(resolve(process.cwd()))
    const sourceRoot = join(root, "source-root")
    const recommended = recommendTasksRoot(sourceRoot)
    expect(recommended).toBe(join(dirname(resolve(sourceRoot)), "worktree-space"))
    expect(() => assertIsolated(resolve(sourceRoot), recommended)).not.toThrow()
  })

  it("uses the backup name only when the container's own path is the source root", () => {
    // `<root workspace>\worktree-space` is the answer everywhere else; this is the
    // one layout where that name would be the source root itself.
    const rootWorkspace = rootWorkspaceOf(resolve(process.cwd()))
    const sourceRoot = join(rootWorkspace, "worktree-space")
    const recommended = recommendTasksRoot(sourceRoot)
    expect(recommended).toBe(join(rootWorkspace, "dsh-worktree-space"))
    expect(() => assertIsolated(sourceRoot, recommended)).not.toThrow()
  })
})

import { describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, parse, resolve } from "node:path"
import {
  absolutePath,
  assertIsolated,
  canonicalPath,
  containerIn,
  containerParentFor,
  isInside,
  IsolationError,
  recommendTasksRoot,
  samePathLocation,
} from "../src/host/task/paths.js"
import { resolveTasksRoot } from "../src/host/task/shared.js"

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

describe("a path from outside is resolved before it is compared", () => {
  /**
   * A scratch root, removed when the test that made it is done.
   *
   * Built from `mkdtemp(join(tmpdir(), ...))` rather than written as a drive-letter
   * path: `..` resolution and absoluteness are the subjects here, and `E:\...` is not
   * absolute on the Linux runner CI uses. A hardcoded Windows path would pass on this
   * machine and assert nothing on the one that matters.
   * @returns the directory and a cleanup for it.
   */
  async function scratch() {
    const dir = await mkdtemp(join(tmpdir(), "dsh-paths-"))
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
  }

  it("sees through a `..` that hides a root inside the source tree", async () => {
    // The whole defect: this pair is not lexically nested, so the comparison that
    // exists to keep work out of the source tree reports itself satisfied - while
    // `resolve()` puts the container at `<dir>/a/b/c/wt`, inside `<dir>/a/b/c`.
    //
    // The two paths are spelled out as strings rather than built with `join`, because
    // `join` normalises a `..` segment away as it assembles the path: the shape being
    // tested only exists in the text a caller actually sends.
    const { dir, cleanup } = await scratch()
    try {
      const base = dir.replace(/\\/g, "/")
      const sourceRoot = `${base}/a/b/c`
      const sneaky = `${base}/a/x/../b/c/wt`
      // The lexical comparison really does let it through: that is why the boundary
      // has to resolve, and asserting it here is what keeps this test from passing
      // for the wrong reason if the helper is ever changed.
      expect(() => assertIsolated(sourceRoot, sneaky)).not.toThrow()
      // Resolved, the same two paths are what they always were on disk, and the
      // invariant holds: a container inside the source root is refused.
      expect(resolve(sneaky)).toBe(join(dir, "a", "b", "c", "wt"))
      expect(() => assertIsolated(sourceRoot, resolve(sneaky))).toThrow(IsolationError)
      expect(() => assertIsolated(sourceRoot, resolve(sneaky))).toThrow(/inside the repositories' directory/)
      // And the boundary `resolveTasksRoot` is where that resolution happens, so a
      // caller that goes through it never holds the unresolved spelling at all.
      const chosen = resolveTasksRoot(sourceRoot, sneaky, "")
      expect(chosen).toBe(resolve(sneaky))
      expect(() => assertIsolated(sourceRoot, chosen)).toThrow(/inside the repositories' directory/)
    } finally {
      await cleanup()
    }
  })

  it("still accepts an ordinary container beside the source root", async () => {
    // The negative control: a root that is genuinely outside must keep passing, or a
    // fix that simply refused everything would satisfy the test above.
    const { dir, cleanup } = await scratch()
    try {
      const sourceRoot = join(dir, "public", "repo")
      const tasksRoot = join(dir, "worktree-space")
      expect(() => assertIsolated(sourceRoot, resolveTasksRoot(sourceRoot, tasksRoot, ""))).not.toThrow()
      // A `..` that stays outside is resolved to something still outside, and is
      // accepted on that account rather than on its spelling. Spelled as text for the
      // same reason as above: `join` would normalise the `..` away before it is tested.
      const outside = `${dir.replace(/\\/g, "/")}/worktree-space/../worktree-space`
      expect(() => assertIsolated(sourceRoot, resolveTasksRoot(sourceRoot, outside, ""))).not.toThrow()
      expect(resolveTasksRoot(sourceRoot, outside, "")).toBe(tasksRoot)
    } finally {
      await cleanup()
    }
  })

  it("resolves the configured root as well as the requested one", async () => {
    // The configuration is the other way a root arrives from outside, and a default
    // that is only resolved when a caller names one would leave the same hole in the
    // path the dialog and the create both fall back to.
    const { dir, cleanup } = await scratch()
    try {
      const sourceRoot = join(dir, "public", "repo")
      const configured = join(dir, "public", "x", "..", "worktree-space")
      expect(resolveTasksRoot(sourceRoot, "", configured)).toBe(join(dir, "public", "worktree-space"))
    } finally {
      await cleanup()
    }
  })

  it("leaves an empty path empty rather than turning it into the working directory", async () => {
    // "No path was given" is a case every caller answers in its own words (E1004,
    // E4005). Resolving it would quietly turn a missing argument into a real one -
    // the process's own working directory - which is the opposite of what those
    // refusals are for.
    expect(absolutePath("")).toBe("")
    expect(absolutePath("   ")).toBe("")
    expect(absolutePath(undefined)).toBe("")
    expect(absolutePath(null)).toBe("")
    expect(absolutePath(42)).toBe("")
    // A path that is already absolute comes back as itself, and a relative one is
    // made absolute against the process's own directory - the only place a relative
    // path can mean anything.
    const { dir, cleanup } = await scratch()
    try {
      expect(absolutePath(dir)).toBe(dir)
      expect(absolutePath(join(dir, "a", "..", "b"))).toBe(join(dir, "b"))
    } finally {
      await cleanup()
    }
  })
})

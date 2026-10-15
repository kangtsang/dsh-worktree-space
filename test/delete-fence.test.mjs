import { afterEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, parse, resolve } from "node:path"
import { validateProjectName, validateTaskName } from "../src/host/task/naming.js"
import { assertTaskSpaceShape, isInside, refuseDelete } from "../src/host/task/paths.js"
import { taskSpacePath } from "../src/host/task/shared.js"

// A container root for the tests that only need a path. Built from `tmpdir()` rather
// than written as a Windows path: `taskSpacePath` now refuses a root that is not
// absolute, and `E:\wt-demo` is not absolute on the Linux runner CI uses - so a
// hardcoded drive letter would assert Windows semantics on a POSIX filesystem.
const ROOT = join(tmpdir(), "wt-demo")
const PROJECT = "dsh-worktree-space"
const cleaners = []
afterEach(async () => { while (cleaners.length > 0) await cleaners.pop()() })

/** A container with a task space in it, and whatever else a test asks for. */
async function container(...names) {
  const root = await mkdtemp(join(tmpdir(), "dws-fence-"))
  cleaners.push(() => rm(root, { recursive: true, force: true }))
  for (const name of names) await mkdir(join(root, PROJECT, name), { recursive: true })
  return root
}

describe("a task name cannot be a way out of the container", () => {
  // The fence is only worth anything if the names that build a path cannot walk
  // out of it. `.` and `..` carry neither a separator nor a space, so the
  // character rule that stops `a/b` does not stop them - and `<root>/<project>/..`
  // is the container root itself, which a finish then empties.
  it("refuses the two relative names, which the separator rule cannot catch", () => {
    expect(() => validateTaskName("..")).toThrow(/must not be '\.' or '\.\.'/)
    expect(() => validateTaskName(".")).toThrow(/must not be '\.' or '\.\.'/)
    // The project layer already refused these; the task layer now says the same.
    expect(() => validateProjectName("..")).toThrow(/must not be '\.' or '\.\.'/)
    expect(() => validateTaskName("a/../b")).toThrow(/must not contain/)
    expect(validateTaskName("login")).toBe("login")
  })

  it("puts the task space exactly two levels below the root, whatever it is handed", () => {
    expect(taskSpacePath(ROOT, PROJECT, "login")).toBe(join(ROOT, PROJECT, "login"))
    // Both relative names land on a layer the plugin owns, not on a task space,
    // and both are refused at the name before the path is ever joined.
    expect(isInside(ROOT, taskSpacePath(ROOT, PROJECT, "login"))).toBe(true)
    expect(() => taskSpacePath(ROOT, PROJECT, "..")).toThrow()
    expect(() => taskSpacePath(ROOT, PROJECT, ".")).toThrow()
  })

  it("states the shape on the joined path, so relaxing a validator cannot widen a delete", () => {
    expect(() => assertTaskSpaceShape(ROOT, join(ROOT, PROJECT, "login"))).not.toThrow()
    for (const path of [ROOT, join(ROOT, PROJECT), join(ROOT, PROJECT, "a", "b"), join(ROOT, "..", "escape")]) {
      expect(() => assertTaskSpaceShape(ROOT, path)).toThrow(/<container root>\/<project>\/<task>/)
    }
  })

  it("refuses a container root that is not an absolute directory", () => {
    // The root the two checks above reason about has to be a real container first. An
    // empty or relative root joins to a path below whatever directory the host process
    // happens to be in, and a volume root joins to one level below the volume - neither
    // is a task space, and both would put a finish's delete somewhere nobody named.
    const volumeRoot = parse(ROOT).root
    for (const root of ["", ".", "..", "relative/root", volumeRoot]) {
      expect(() => taskSpacePath(root, PROJECT, "login"), `root ${JSON.stringify(root)}`).toThrow(/E1004|absolute directory/)
    }
    expect(() => taskSpacePath("", PROJECT, "login")).toThrow(/absolute directory that is not a volume root/)
    // The refusal is the code that already means "a tasks root is required", rather than
    // a new one: the caller fixes it the same way - name a root that is one.
    expect(() => taskSpacePath("", PROJECT, "login")).toThrow(expect.objectContaining({ code: "E1004" }))
    // And an ordinary absolute root still builds the path it always did.
    expect(taskSpacePath(ROOT, PROJECT, "login")).toBe(join(ROOT, PROJECT, "login"))
  })
})

describe("every delete is asked whether it is inside the fence first", () => {
  it("lets through a path under the root and refuses one that is not", async () => {
    const root = await container("login")
    const worktree = join(root, PROJECT, "login", "alpha")
    await mkdir(worktree, { recursive: true })
    expect(refuseDelete(root, worktree)).toBe("")
    // The root itself is not a descendant of the root: deleting it would take the
    // fence with it, which is the one outcome the fence cannot survive.
    expect(refuseDelete(root, root)).toMatch(/outside the container root/)
    expect(refuseDelete(root, join(root, "..", "elsewhere"))).toMatch(/outside the container root/)
    // A sibling container is a different container, and this one has no claim on it.
    expect(refuseDelete(root, join(tmpdir(), "somebody-elses-task"))).toMatch(/outside the container root/)
  })

  it("refuses a worktree path that is a link, so git cannot delete through it", async () => {
    const root = await container("login")
    const outside = await container("someone-elses-work")
    await writeFile(join(outside, "precious.txt"), "not yours")
    const link = join(root, PROJECT, "login", "alpha")
    // A junction is a directory to readdir and a link to lstat, which is exactly
    // the gap: the scan and the fence have to ask about that difference.
    await symlink(outside, link, "junction")
    expect(refuseDelete(root, link)).toMatch(/is a link, not a directory/)
    // And the thing on the other side of it is untouched.
    expect(await readFile(join(outside, "precious.txt"), "utf8")).toBe("not yours")
  })

  it("asks nothing of a directory that is already gone", async () => {
    const root = await container("login")
    expect(refuseDelete(root, join(root, PROJECT, "login", "vanished"))).toBe("")
  })

  // A lexical `startsWith` is the whole historical fence, and a junction on the
  // *parent chain* is what defeats it: `<root>/<project>/<task>/link` reads as a
  // descendant, while a recursive delete through it reaches the target. The check
  // is now answered on real locations as well, and these two pin that: the escape
  // is refused, and an ordinary delete is still allowed - a fence that refused
  // everything would satisfy only the first.
  it("refuses a path that only reads as inside, because a parent is a link out", async () => {
    const root = await container("login")
    const outside = await container("someone-elses-task")
    await writeFile(join(outside, "precious.txt"), "not yours")
    // The link is the *project* layer here, so the target below it is spelled as
    // an ordinary descendant of the root and the lexical check passes it.
    const project = join(root, PROJECT)
    await rm(project, { recursive: true, force: true })
    await symlink(outside, project, "junction")
    const target = join(project, "login", "alpha")
    await mkdir(target, { recursive: true })
    expect(refuseDelete(root, target)).toMatch(/outside the container root/)
    // And the thing on the other side of the junction is untouched: the refusal is
    // the whole of what happened.
    expect(await readFile(join(outside, "precious.txt"), "utf8")).toBe("not yours")
  })

  it("still lets an ordinary path through, resolved or not", async () => {
    // The negative control for the check above: a fix that refused everything it
    // could not resolve would pass the escape case and break every real delete.
    const root = await container("login")
    const worktree = join(root, PROJECT, "login", "alpha")
    await mkdir(worktree, { recursive: true })
    expect(refuseDelete(root, worktree)).toBe("")
    // A path that is already gone still resolves through its existing ancestors.
    expect(refuseDelete(root, join(root, PROJECT, "login", "gone", "deeper"))).toBe("")
    // And a `..` that stays inside stays inside.
    expect(refuseDelete(root, join(root, PROJECT, "login", "alpha", "..", "alpha"))).toBe("")
  })
})
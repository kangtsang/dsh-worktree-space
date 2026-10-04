import { afterEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validateProjectName, validateTaskName } from "../src/host/task/naming.js"
import { assertTaskSpaceShape, isInside, refuseDelete } from "../src/host/task/paths.js"
import { taskSpacePath } from "../src/host/task/shared.js"

const ROOT = "E:\\wt-demo"
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
})
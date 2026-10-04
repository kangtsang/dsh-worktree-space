import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { classifySourceRoot, classifySourceRoots } from "../src/host/task/inspect.js"

/** A source root holding `count` repositories, each a real `.git` directory. */
async function rootWith(name, count) {
  const base = await mkdtemp(join(tmpdir(), `dsh-classify-${name}-`))
  for (let index = 0; index < count; index++) {
    await mkdir(join(base, `repo-${index}`, ".git"), { recursive: true })
  }
  return { base, cleanup: () => rm(base, { recursive: true, force: true }) }
}

/** A source root that is itself one repository. */
async function rootThatIsRepository(name) {
  const base = await mkdtemp(join(tmpdir(), `dsh-classify-${name}-`))
  await mkdir(join(base, ".git"), { recursive: true })
  return { base, cleanup: () => rm(base, { recursive: true, force: true }) }
}

describe("classifySourceRoots", () => {
  it("answers every path asked, in the order asked", async () => {
    const two = await rootWith("two", 2)
    const none = await rootWith("none", 0)
    const one = await rootThatIsRepository("one")
    try {
      const answered = await classifySourceRoots([two.base, none.base, one.base])
      expect(answered.map((entry) => entry.path)).toEqual([two.base, none.base, one.base])
      expect(answered.map((entry) => entry.repositoryCount)).toEqual([2, 0, 1])
      // A root that is itself a repository is a source root: the count is one, and
      // it is a single-repository task that needs no company.
      expect(answered[2].isSourceRoot).toBe(true)
      expect(answered[2].isRepository).toBe(true)
      expect(answered[1].isSourceRoot).toBe(false)
      // A directory the Host could read but that holds nothing is not unreadable.
      // The two are different claims and a row that cannot be read must not be
      // drawn as one that has nothing.
      expect(answered[1].isDirectory).toBe(true)
    } finally {
      await Promise.all([two.cleanup(), none.cleanup(), one.cleanup()])
    }
  })

  it("walks each path once when the same one is named twice", async () => {
    const one = await rootWith("dup", 1)
    try {
      const answered = await classifySourceRoots([one.base, `${one.base}${sep()}`, one.base])
      expect(answered).toHaveLength(1)
    } finally {
      await one.cleanup()
    }
  })

  it("answers a path that is not there, rather than dropping it", async () => {
    const real = await rootWith("real", 2)
    const missing = join(tmpdir(), "dsh-classify-absent-nothing-here")
    try {
      const answered = await classifySourceRoots([real.base, missing])
      // Both come back. A path that is not a directory is an answer the two
      // callers that go on to register it need: they have to be able to say "that
      // is not a folder" instead of reporting it unreadable.
      expect(answered.map((entry) => entry.path)).toEqual([real.base, missing])
      expect(answered[0].repositoryCount).toBe(2)
      expect(answered[1].isDirectory).toBe(false)
      expect(answered[1].isSourceRoot).toBe(false)
      expect(answered[1].repositoryCount).toBe(0)
    } finally {
      await real.cleanup()
    }
  })

  it("answers from the disk every time, never from a previous answer", async () => {
    const root = await rootWith("fresh", 0)
    try {
      expect((await classifySourceRoot(root.base)).repositoryCount).toBe(0)
      // The user makes a repository and asks again. Nothing is remembered - the
      // whole reason the panel can be re-read is that an answer describes one
      // moment - so the second answer is the one that has the repository in it.
      await mkdir(join(root.base, "repo-late", ".git"), { recursive: true })
      const second = await classifySourceRoot(root.base)
      expect(second.repositoryCount).toBe(1)
      expect(second.repositories.map((entry) => entry.name)).toEqual(["repo-late"])
      expect(second.isSourceRoot).toBe(true)
    } finally {
      await root.cleanup()
    }
  })
})

/** A separator that is the platform's, since the tests run on either. */
function sep() {
  return process.platform === "win32" ? "\\" : "/"
}

import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import {
  discoverSourceRepos,
  isSourceRepository,
  resolveSourceRepos,
} from "../src/host/task/discover.js"

/**
 * Build a source root exercising every case the discovery rules care about: two
 * real repositories, a linked worktree checkout, a hidden directory, a
 * `*.worktrees` container, a plain directory and a loose file.
 * @returns the fixture paths and its cleanup.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "multi-worktree-discover-"))
  const repository = async (name) => {
    const directory = join(root, name)
    await mkdir(join(directory, ".git"), { recursive: true })
    return directory
  }
  const alpha = await repository("alpha")
  const beta = await repository("beta")
  // A linked worktree checkout: `.git` is a file, so it is not a source repository.
  const linked = join(root, "linked")
  await mkdir(linked, { recursive: true })
  await writeFile(join(linked, ".git"), "gitdir: ../alpha/.git/worktrees/linked\n")
  await repository(".hidden")
  await repository("alpha.worktrees")
  await mkdir(join(root, "notes"), { recursive: true })
  await writeFile(join(root, "loose.txt"), "not a directory")
  return { root, alpha, beta, linked, cleanup: () => rm(root, { recursive: true, force: true }) }
}

describe("isSourceRepository", () => {
  it("requires .git to be a directory", async () => {
    const { alpha, linked, root, cleanup } = await fixture()
    try {
      expect(await isSourceRepository(alpha)).toBe(true)
      expect(await isSourceRepository(linked)).toBe(false)
      expect(await isSourceRepository(join(root, "notes"))).toBe(false)
      expect(await isSourceRepository(join(root, "missing"))).toBe(false)
    } finally {
      await cleanup()
    }
  })
})

describe("discoverSourceRepos", () => {
  it("finds top-level repositories and skips worktrees, hidden and non-repository children", async () => {
    const { alpha, beta, root, cleanup } = await fixture()
    try {
      expect(await discoverSourceRepos(root)).toEqual([alpha, beta].sort())
    } finally {
      await cleanup()
    }
  })

  it("uses the root itself when the root is a repository", async () => {
    const { alpha, cleanup } = await fixture()
    try {
      expect(await discoverSourceRepos(alpha)).toEqual([alpha])
    } finally {
      await cleanup()
    }
  })

  it("answers empty for a directory that does not exist", async () => {
    expect(await discoverSourceRepos(join(tmpdir(), "multi-worktree-absent-root"))).toEqual([])
  })
})

describe("resolveSourceRepos", () => {
  it("resolves named repositories in the order given", async () => {
    const { root, cleanup } = await fixture()
    try {
      expect(await resolveSourceRepos(root, ["beta", "alpha"])).toEqual([
        join(root, "beta"),
        join(root, "alpha"),
      ])
    } finally {
      await cleanup()
    }
  })

  it("refuses a name that is not a source repository", async () => {
    const { root, cleanup } = await fixture()
    try {
      await expect(resolveSourceRepos(root, ["linked"])).rejects.toThrow(/not a source repository: linked/)
      await expect(resolveSourceRepos(root, ["notes"])).rejects.toThrow(/not a source repository: notes/)
    } finally {
      await cleanup()
    }
  })

  it("resolves the root's own name when the root is a repository", async () => {
    const { alpha, cleanup } = await fixture()
    try {
      expect(await resolveSourceRepos(alpha, [basename(alpha)])).toEqual([alpha])
    } finally {
      await cleanup()
    }
  })
})

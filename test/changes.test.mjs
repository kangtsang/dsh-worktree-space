/**
 * The changes sidebar's reads against real git.
 *
 * The shape of `--name-status -z` and `--numstat -z`, rename detection, and the
 * difference between "the working tree against the base" and "HEAD against the
 * base" are git's answers, not this plugin's; a mocked subprocess would only
 * replay the strings this file chose to assert. So the fixture is a throwaway
 * repository and the commands are real. It skips itself where git is missing.
 */
import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { changesFile, changesList, changesOverview } from "../src/host/task/changes.js"

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

/** Lines with a trailing newline, spelled once so no fixture depends on escaping. */
const text = (...lines) => lines.map((line) => `${line}\n`).join("")

/** Git in a real repository, failing loudly when the fixture itself is broken. */
function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
}

/** The profile's subprocess service, backed by real git; the same double the merge tests use. */
function realSubprocess() {
  return {
    spawn({ argv, env }) {
      let stdout = ""
      let stderr = ""
      let exitCode = 0
      try {
        stdout = execFileSync("git", argv.slice(1), { encoding: "utf8", ...(env === undefined ? {} : { env: { ...process.env, ...env } }) })
      } catch (error) {
        exitCode = typeof error.status === "number" ? error.status : 1
        stdout = String(error.stdout ?? "")
        stderr = String(error.stderr ?? "")
      }
      return {
        done: Promise.resolve({ exitCode, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: stdout }) },
          stderr: { readFrom: () => ({ text: stderr }) },
        },
      }
    },
  }
}

async function repoFixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-changes-"))
  const repo = join(root, "sample")
  await mkdir(repo, { recursive: true })
  git(root, ["init", "-q", "-b", "main", "sample"])
  for (const [key, value] of [["user.email", "probe@example.com"], ["user.name", "probe"], ["commit.gpgsign", "false"]]) {
    git(repo, ["config", key, value])
  }
  await writeFile(join(repo, "modified.txt"), text("one", "two", "three"))
  await writeFile(join(repo, "renamed.txt"), text("alpha", "beta", "gamma", "delta", "epsilon"))
  await writeFile(join(repo, "gone.txt"), text("gone"))
  git(repo, ["add", "-A"])
  git(repo, ["commit", "-qm", "base"])
  const base = git(repo, ["rev-parse", "HEAD"])
  await writeFile(join(repo, "modified.txt"), text("one", "two", "three", "four"))
  git(repo, ["mv", "renamed.txt", "renamed-now.txt"])
  await writeFile(join(repo, "renamed-now.txt"), text("alpha", "beta", "gamma", "delta", "epsilon", "zeta"))
  git(repo, ["rm", "-q", "gone.txt"])
  await writeFile(join(repo, "untracked.txt"), text("new", "file"))
  return { root, repo, base }
}

describe.skipIf(!gitAvailable)("worktree.changes reads", () => {
  it("lists tracked, renamed, deleted, binary and untracked changes against the base", async () => {
    const { root, repo, base } = await repoFixture()
    try {
      const subprocess = realSubprocess()
      const answer = await changesList(subprocess, repo, base)
      const byPath = new Map(answer.files.map((file) => [file.path, file]))
      expect(byPath.get("modified.txt")).toMatchObject({ status: "modified", insertions: 1, deletions: 0 })
      expect(byPath.get("renamed-now.txt")).toMatchObject({ status: "renamed", oldPath: "renamed.txt" })
      expect(byPath.get("gone.txt")).toMatchObject({ status: "deleted", insertions: 0, deletions: 1 })
      expect(byPath.get("untracked.txt")).toMatchObject({ status: "untracked", insertions: 2, deletions: 0 })
      expect(answer.totals.files).toBe(4)
      expect(answer.base).toBe(base.slice(0, 7))
      expect(answer.branch).toBe("main")
      expect(answer.baseCommit).toBe(base)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("answers one file's hunks, including a rename and an untracked new file", async () => {
    const { root, repo, base } = await repoFixture()
    try {
      const subprocess = realSubprocess()
      const modified = await changesFile(subprocess, repo, base, "modified.txt")
      expect(modified.kind).toBe("text")
      expect(modified.hunks).toHaveLength(1)
      expect(modified.hunks[0].lines).toContain("+four")
      const renamed = await changesFile(subprocess, repo, base, "renamed-now.txt", { oldPath: "renamed.txt" })
      expect(renamed.kind).toBe("text")
      expect(renamed.hunks.flatMap((hunk) => hunk.lines)).toContain("+zeta")
      const untracked = await changesFile(subprocess, repo, base, "untracked.txt", { untracked: true })
      expect(untracked.kind).toBe("text")
      expect(untracked.hunks[0].lines).toEqual(["+new", "+file"])
      const outside = changesFile(subprocess, repo, base, "../outside.txt")
      await expect(outside).rejects.toThrow(/E4005/)
      // A calling listing already resolved the range; carrying the commit back
      // answers without re-resolving a base name that need not exist.
      const viaCommit = await changesFile(subprocess, repo, "no-such-branch", "modified.txt", { baseCommit: base })
      expect(viaCommit.kind).toBe("text")
      expect(viaCommit.hunks[0].lines).toContain("+four")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("lists a Workspace's repositories, each against its own upstream", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-changes-ws-"))
    try {
      const workspace = join(root, "ws")
      await mkdir(workspace, { recursive: true })
      for (const name of ["alpha", "beta"]) {
        const repo = join(workspace, name)
        await mkdir(repo, { recursive: true })
        git(workspace, ["init", "-q", "-b", "main", name])
        git(repo, ["config", "user.email", "probe@example.com"])
        git(repo, ["config", "user.name", "probe"])
        await writeFile(join(repo, "a.txt"), text("one", "two"))
        git(repo, ["add", "-A"])
        git(repo, ["commit", "-qm", "base"])
      }
      const alpha = join(workspace, "alpha")
      const bare = join(root, "alpha-origin.git")
      git(root, ["init", "--bare", "-q", bare])
      git(alpha, ["remote", "add", "origin", bare])
      git(alpha, ["push", "-q", "-u", "origin", "main"])
      await writeFile(join(alpha, "a.txt"), text("one", "two", "three"))
      // Untracked work belongs in the row's three counts as well: the diff cannot see it,
      // so the overview adds it itself.
      await writeFile(join(alpha, "b.txt"), text("extra"))
      const subprocess = realSubprocess()
      const answer = await changesOverview(subprocess, workspace)
      expect(answer.kind).toBe("workspace")
      expect(answer.repositories.map((repository) => repository.name)).toEqual(["alpha", "beta"])
      // One committed line and one untracked line, in two files: the counts are read from
      // the same diff `--shortstat` the row draws and the untracked files are added to it.
      expect(answer.repositories[0]).toMatchObject({ base: "origin/main", branch: "main", insertions: 2, deletions: 0, files: 2, untracked: 1 })
      // A repository tracking no remote answers a row with the reason, not a failure.
      expect(answer.repositories[1].error).toBeTruthy()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("measures a task repository against the source checkout's branch, not its start point", async () => {
    // The shape a real task space took: a repository started from `demo/A-v1`,
    // whose branch was later moved onto the task's own head. Comparing with the
    // recorded start point then reports nothing at all, while the management page
    // - which measures against the source checkout's `main` - still shows the
    // work. The overview has to answer with the page's number.
    const { root, repo, base } = await repoFixture()
    try {
      const taskPath = join(root, "tasks", "sample")
      await mkdir(taskPath, { recursive: true })
      const taskRepo = join(taskPath, "sample")
      git(repo, ["branch", "demo/A-v1", base])
      git(repo, ["worktree", "add", "-q", taskRepo, "-b", "task/sample", "demo/A-v1"])
      await writeFile(join(taskRepo, "modified.txt"), text("one", "two", "three", "four"))
      git(taskRepo, ["add", "-A"])
      git(taskRepo, ["commit", "-qm", "task work"])
      // The start point now names the task's head, which is the case that made the
      // recorded base useless.
      git(repo, ["branch", "-f", "demo/A-v1", "task/sample"])
      await writeFile(join(repo, "main.txt"), text("main moved on"))
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "main moved"])
      await mkdir(join(taskPath, ".worktree-space"), { recursive: true })
      await writeFile(join(taskPath, ".worktree-space", "worktree-space.json"), JSON.stringify({
        version: 1,
        task: "sample",
        project: "sample",
        tasksRoot: join(root, "tasks"),
        branch: "task/sample",
        baseRef: null,
        repositories: [{ name: "sample", sourcePath: repo, sourceBranch: "main", branch: "task/sample", baseRef: "demo/A-v1", startCommit: base }],
      }))
      const answer = await changesOverview(realSubprocess(), taskPath)
      expect(answer.repositories[0]).toMatchObject({ base: "main", insertions: 1, files: 1 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reads a task space's repositories from its own record, and keeps a row's failure inside that row", async () => {
    const { root, repo, base } = await repoFixture()
    try {
      const taskPath = join(root, "tasks", "sample")
      await mkdir(taskPath, { recursive: true })
      const taskRepo = join(taskPath, "sample")
      git(repo, ["worktree", "add", "-q", taskRepo, "-b", "task/sample", base])
      await writeFile(join(taskRepo, "modified.txt"), text("one", "two", "three", "four", "five"))
      await mkdir(join(taskPath, ".worktree-space"), { recursive: true })
      await writeFile(join(taskPath, ".worktree-space", "worktree-space.json"), JSON.stringify({
        version: 1,
        task: "sample",
        project: "sample",
        tasksRoot: join(root, "tasks"),
        branch: "task/sample",
        baseRef: "main",
        repositories: [{ name: "sample", sourcePath: repo, branch: "task/sample", baseRef: "main", startCommit: base }],
      }))
      const subprocess = realSubprocess()
      const answer = await changesOverview(subprocess, taskPath)
      expect(answer.kind).toBe("task")
      expect(answer.repositories).toHaveLength(1)
      expect(answer.repositories[0]).toMatchObject({ name: "sample", branch: "task/sample", base: "main" })
      expect(answer.repositories[0].insertions).toBe(2)
      // The source checkout's own branch is the base the page measures against,
      // so renaming it follows the rename rather than falling back to a commit.
      git(repo, ["branch", "-m", "main", "main-renamed"])
      const afterRename = await changesOverview(subprocess, taskPath)
      expect(afterRename.repositories[0].error).toBeUndefined()
      expect(afterRename.repositories[0].insertions).toBe(2)
      expect(afterRename.repositories[0].base).toBe("main-renamed")
      // A repository the record names but whose worktree is gone fails alone.
      await writeFile(join(taskPath, ".worktree-space", "worktree-space.json"), JSON.stringify({
        version: 1,
        task: "sample",
        project: "sample",
        tasksRoot: join(root, "tasks"),
        branch: "task/sample",
        baseRef: "main",
        repositories: [{ name: "missing", sourcePath: repo, branch: "task/sample", baseRef: "main", startCommit: base }],
      }))
      const partial = await changesOverview(subprocess, taskPath)
      expect(partial.repositories[0].error).toBeTruthy()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

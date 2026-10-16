import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SOURCE_TASKS_ARCHIVE_DIR,
  SOURCE_TASKS_KEEP,
  archiveSourceTaskIndex,
  pruneSourceTaskArchive,
  readArchivedTaskSession,
  readSourceTaskIndex,
  removeSourceTaskIndex,
  sourceTaskIndexPath,
} from "../src/host/task/source-index.js"
import { PLUGIN_ROOT, markSessionReported, normalizeSessions, readTaskMetadata, recordTaskSession, taskMetadata, taskSessionsOf, writeTaskMetadata } from "../src/host/task/shared.js"

/**
 * A source root with one repository, and a task space of the task being recorded.
 *
 * The two directories are siblings on purpose: that is the layout the plugin makes
 * (`<container root>/<project>/<task>` beside the repositories' own root), so the index
 * path and the task path are both real rather than assembled from the other.
 * @param record - extra fields for the task's record, such as an empty `sourceRoot`.
 * @returns the directories, the record, and a cleanup.
 */
async function fixture(record = {}) {
  const base = await mkdtemp(join(tmpdir(), "wts-source-index-"))
  const sourceRoot = join(base, "somewhere", "src")
  const tasksRoot = join(base, "somewhere", "worktree-space")
  const repo = join(sourceRoot, "alpha")
  await mkdir(join(repo, ".git"), { recursive: true })
  // A real repository at the root (`git init`, not an empty `.git` directory), because
  // the plugin's decision is "is this root a repository" and a directory named `.git` is
  // not evidence of one. The tests that check the non-repository cases remove this.
  execFileSync("git", ["init", "-q", "."], { cwd: sourceRoot })
  const taskPath = join(tasksRoot, "alpha-root", "cr20-24-fixes")
  await mkdir(taskPath, { recursive: true })
  const metadata = taskMetadata({
    task: "cr20-24-fixes",
    project: "alpha-root",
    tasksRoot,
    sourceRoot,
    branch: "task/cr20-24-fixes",
    repositories: [{ name: "alpha", sourcePath: repo, branch: "task/cr20-24-fixes" }],
    ...record,
  })
  await writeTaskMetadata(taskPath, metadata)
  return {
    base,
    sourceRoot,
    tasksRoot,
    repo,
    taskPath,
    metadata,
    indexFile: sourceTaskIndexPath(sourceRoot, "alpha-root", "cr20-24-fixes"),
    cleanup: () => rm(base, { recursive: true, force: true }),
  }
}

describe("the task index a source root keeps", () => {
  it("writes the task's basics and its sessions beside the deploy root, not inside it", async () => {
    const f = await fixture()
    try {
      // A deploy root the workspace maintains, as a real one would be. The index must
      // not land inside it: `create` copies that directory whole into every task space,
      // so an index there would travel into every task as plugin state.
      await mkdir(join(f.sourceRoot, ".worktree-space", "deploy"), { recursive: true })
      await writeFile(join(f.sourceRoot, ".worktree-space", "deploy", "deploy.sh"), "#!/bin/sh\n")

      expect(await recordTaskSession(f.taskPath, f.metadata, "s-member", "task")).toBe(true)

      expect(f.indexFile).toBe(join(f.sourceRoot, ".worktree-space", "tasks", "alpha-root", "cr20-24-fixes.json"))
      expect(existsSync(f.indexFile)).toBe(true)
      // The directory meant for scripts is untouched by the index.
      expect(existsSync(join(f.sourceRoot, ".worktree-space", "deploy", "deploy.sh"))).toBe(true)
      expect(existsSync(join(f.sourceRoot, ".worktree-space", "deploy", "tasks"))).toBe(false)

      const index = JSON.parse(await readFile(f.indexFile, "utf8"))
      expect(index).toMatchObject({
        version: 1,
        task: "cr20-24-fixes",
        project: "alpha-root",
        taskPath: f.taskPath,
        tasksRoot: f.tasksRoot,
        sourceRoot: f.sourceRoot,
        branch: "task/cr20-24-fixes",
      })
      expect(index.sessions).toHaveLength(1)
      expect(index.sessions[0]).toMatchObject({ sessionId: "s-member", role: "task" })
      expect(typeof index.updatedAt).toBe("string")
    } finally {
      await f.cleanup()
    }
  })

  it("adds every session that opens in the task space, whichever role it has", async () => {
    const f = await fixture()
    try {
      const member = await recordTaskSession(f.taskPath, f.metadata, "s-member", "task")
      const leader = await recordTaskSession(f.taskPath, await readTask(f.taskPath), "s-leader", "leader")
      const handoff = await recordTaskSession(f.taskPath, await readTask(f.taskPath), "s-handoff", "handoff")

      expect([member, leader, handoff]).toEqual([true, true, true])
      const index = JSON.parse(await readFile(f.indexFile, "utf8"))
      expect(index.sessions.map((entry) => entry.sessionId)).toEqual(["s-member", "s-leader", "s-handoff"])
      expect(index.sessions.map((entry) => entry.role)).toEqual(["task", "leader", "handoff"])
      expect(existsSync(f.indexFile)).toBe(true)
    } finally {
      await f.cleanup()
    }
  })

  it("writes no index when the record names no source root to write one under", async () => {
    // `add-repositories` and a moved task space both produce a record whose source root
    // is absent or blank. There is then no directory this plugin may claim, and guessing
    // one - the task's own parent, say - would put plugin state somewhere nobody named.
    const f = await fixture({ sourceRoot: "" })
    try {
      // A real path the writer could have used if it guessed: the task's parent has a
      // `.worktree-space` all its own.
      await mkdir(join(f.tasksRoot, ".worktree-space"), { recursive: true })

      expect(await recordTaskSession(f.taskPath, f.metadata, "s-member", "task")).toBe(true)
      expect(existsSync(join(f.tasksRoot, ".worktree-space", "tasks"))).toBe(false)
      // Nothing under the checkout either, which is where a guess would most likely land.
      expect(existsSync(join(f.tasksRoot, "alpha-root", ".worktree-space", "tasks"))).toBe(false)
    } finally {
      await f.cleanup()
    }
  })

  it("does not fail the recording when the index cannot be written", async () => {
    // The record inside the task space is the authority; the index is a convenience a
    // reader can rebuild by walking the container. A full disk, a read-only checkout or
    // a source root that is a file must not turn "the session was recorded" into "the
    // dispatch failed" - that would lose the work to save the note about it.
    const f = await fixture()
    try {
      // A *file* where the index needs a directory: `mkdir("<source root>/.worktree-space")`
      // fails with ENOTDIR, which is the shape a read-only or otherwise unusable checkout
      // takes here.
      const blocked = join(f.sourceRoot, ".worktree-space")
      await writeFile(blocked, "not a directory", "utf8")

      expect(await recordTaskSession(f.taskPath, f.metadata, "s-member", "task")).toBe(true)
      // And the task-space record itself still holds the session, which is what matters.
      const record = await readTask(f.taskPath)
      expect(record.sessions.map((entry) => entry.sessionId)).toEqual(["s-member"])
    } finally {
      await f.cleanup()
    }
  })

  it("files a finished task into the archive with both stamps, and drops the live entry", async () => {
    // The index is not deleted at the end of a task: it is filed, so a finished task
    // leaves a trace. The archived copy has to answer the two questions a later reader
    // asks - when did this task appear, and when did it end - in the readable form the
    // plugin uses everywhere else (`YYYY-MM-DD HH:MM:SS`, local).
    const f = await fixture()
    try {
      await recordTaskSession(f.taskPath, f.metadata, "s-member", "task")
      const live = JSON.parse(await readFile(f.indexFile, "utf8"))
      expect(live.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

      expect(await archiveSourceTaskIndex(f.taskPath, f.metadata)).toBe(true)

      const archiveDir = join(f.sourceRoot, ".worktree-space", SOURCE_TASKS_ARCHIVE_DIR, "alpha-root")
      const names = await readdir(archiveDir)
      expect(names).toHaveLength(1)
      // `<stamp>-<task>.json`, the same shape the task-space archive uses.
      expect(names[0]).toMatch(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-cr20-24-fixes\.json$/)
      const archived = JSON.parse(await readFile(join(archiveDir, names[0]), "utf8"))
      expect(archived.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      expect(archived.createdAt).toBe(live.createdAt)
      expect(archived.sessions.map((entry) => entry.sessionId)).toEqual(["s-member"])
      expect(archived.taskPath).toBe(f.taskPath)
      // The live index is gone: the task is over, and a second entry would be a claim
      // that it is still on disk.
      expect(existsSync(f.indexFile)).toBe(false)
    } finally {
      await f.cleanup()
    }
  })

  it("has nothing to file when the index was never written", async () => {
    // `writeSourceTaskIndex` is best-effort, so a task can be finished without an index
    // ever existing. That is an ordinary state, not a failure - and it must not create an
    // archive entry describing a task nobody recorded.
    const f = await fixture()
    try {
      expect(await archiveSourceTaskIndex(f.taskPath, f.metadata)).toBe(false)
      expect(existsSync(join(f.sourceRoot, ".worktree-space", SOURCE_TASKS_ARCHIVE_DIR))).toBe(false)
    } finally {
      await f.cleanup()
    }
  })

  it("keeps the ten most recently finished, dropping the oldest", async () => {
    // The cap, and the reason it is pruned by modification time rather than by name: two
    // tasks finished in the same second differ in their names only after the stamp, so
    // name order between them is the alphabet's, and pruning on it drops the wrong file.
    // The names here are chosen so that an alphabetical prune keeps exactly the wrong
    // half - `a-oldest` sorts first and `z-newest` sorts last.
    const f = await fixture()
    try {
      const archiveDir = join(f.sourceRoot, ".worktree-space", SOURCE_TASKS_ARCHIVE_DIR, "alpha-root")
      await mkdir(archiveDir, { recursive: true })
      const planted = []
      for (let index = 0; index < 12; index += 1) {
        const label = index === 0 ? "a-oldest" : index === 11 ? "z-newest" : `m-${String(index).padStart(2, "0")}`
        const name = `${label}-2026-01-01-00-00-00.json`
        const file = join(archiveDir, name)
        await writeFile(file, "{}\n", "utf8")
        // Oldest first: index 0 is the oldest, index 11 the newest, and all of them are
        // older than the file the archive is about to write.
        const at = new Date(Date.now() - (12 - index) * 60_000)
        await utimes(file, at, at)
        planted.push(name)
      }

      await recordTaskSession(f.taskPath, f.metadata, "s-member", "task")
      expect(await archiveSourceTaskIndex(f.taskPath, f.metadata)).toBe(true)

      const left = (await readdir(archiveDir)).sort()
      expect(left).toHaveLength(SOURCE_TASKS_KEEP)
      // The two oldest planted files are the ones dropped, and they are the two whose
      // names would have been kept by an alphabetical prune.
      expect(left).not.toContain(planted[0])
      expect(left).not.toContain(planted[1])
      expect(left).toContain(planted[11])
      expect(left.some((name) => name.endsWith("-cr20-24-fixes.json"))).toBe(true)
    } finally {
      await f.cleanup()
    }
  })

  it("prunes to a caller-chosen cap, and answers the names it dropped", async () => {
    const f = await fixture()
    try {
      const archiveDir = join(f.sourceRoot, ".worktree-space", SOURCE_TASKS_ARCHIVE_DIR, "alpha-root")
      await mkdir(archiveDir, { recursive: true })
      for (let index = 0; index < 4; index += 1) {
        const file = join(archiveDir, `entry-${index}.json`)
        await writeFile(file, "{}\n", "utf8")
        const at = new Date(Date.now() - (index + 1) * 60_000)
        await utimes(file, at, at)
      }
      const dropped = await pruneSourceTaskArchive(f.sourceRoot, "alpha-root", 2)
      expect(dropped.sort()).toEqual(["entry-2.json", "entry-3.json"])
      expect((await readdir(archiveDir)).sort()).toEqual(["entry-0.json", "entry-1.json"])
      // Nothing to do is not a failure, and a cap below one is refused rather than
      // emptying the archive.
      expect(await pruneSourceTaskArchive(f.sourceRoot, "alpha-root", 5)).toEqual([])
      expect(await pruneSourceTaskArchive(f.sourceRoot, "alpha-root", 0)).toEqual([])
      expect((await readdir(archiveDir)).sort()).toEqual(["entry-0.json", "entry-1.json"])
    } finally {
      await f.cleanup()
    }
  })

  it("removes only this task's index", async () => {
    const f = await fixture()
    try {
      await recordTaskSession(f.taskPath, f.metadata, "s-member", "task")
      const other = sourceTaskIndexPath(f.sourceRoot, "alpha-root", "another-task")
      await mkdir(join(f.sourceRoot, ".worktree-space", "tasks", "alpha-root"), { recursive: true })
      await writeFile(other, "{}\n", "utf8")

      expect(await removeSourceTaskIndex(f.sourceRoot, "alpha-root", "cr20-24-fixes")).toBe(true)
      expect(existsSync(f.indexFile)).toBe(false)
      expect(existsSync(other)).toBe(true)
      // Removing one that is already gone is not a failure: a finish may run twice.
      expect(await removeSourceTaskIndex(f.sourceRoot, "alpha-root", "cr20-24-fixes")).toBe(true)
    } finally {
      await f.cleanup()
    }
  })

  it("puts nothing into a task space through the deploy root it copies", async () => {
    // The two facts together: the index lives beside `deploy/`, and the directory a
    // create copies into a task space is `deploy/` alone. So a task space never carries
    // a sibling source root's index - which would name sessions that are not its own.
    const f = await fixture()
    try {
      await mkdir(join(f.sourceRoot, ".worktree-space", "deploy"), { recursive: true })
      await writeFile(join(f.sourceRoot, ".worktree-space", "deploy", "deploy.sh"), "#!/bin/sh\n")
      await recordTaskSession(f.taskPath, f.metadata, "s-member", "task")

      // What `create` copies, verbatim: `sourceDeployRootPath()` is `<source root>/.worktree-space/deploy`.
      const copied = join(f.taskPath, ".worktree-space", "deploy")
      const { cp } = await import("node:fs/promises")
      await cp(join(f.sourceRoot, ".worktree-space", "deploy"), copied, { recursive: true, force: true })

      expect(existsSync(join(copied, "deploy.sh"))).toBe(true)
      expect(existsSync(join(copied, "tasks"))).toBe(false)
      // The task space holds its own record and its index target is where it always was.
      expect(existsSync(join(f.taskPath, ".worktree-space", "tasks"))).toBe(false)
    } finally {
      await f.cleanup()
    }
  })

  it("ignores its own bookkeeping without touching the checkout's own .gitignore", async () => {
    // A workspace root that is a repository must not be dirtied by plugin state. The
    // ignore file lives inside the plugin's directory, so git applies it to that
    // directory and below and the repository's own `.gitignore` is never opened - which
    // is the whole point of not editing the user's file.
    const f = await fixture()
    try {
      await recordTaskSession(f.taskPath, f.metadata, "s-member", "task")
      const ignore = join(f.sourceRoot, ".worktree-space", ".gitignore")
      expect(existsSync(ignore)).toBe(true)
      expect(await readFile(ignore, "utf8")).toBe("tasks/\ntasks-archive/\n")
      // The workspace's own scripts are not ignored: whether they are versioned is the
      // workspace's decision, and the plugin's copy is a copy of the user's content.
      expect(await readFile(ignore, "utf8")).not.toMatch(/^deploy\/$/m)
      // And the repository's own ignore file was not created, let alone edited.
      expect(existsSync(join(f.sourceRoot, ".gitignore"))).toBe(false)
    } finally {
      await f.cleanup()
    }
  })

  it("writes no ignore file when the directory is not a repository of its own", async () => {
    // Two shapes, and the same answer for both. A root with no `.git` has no `git status`
    // for the file to influence, so it would be a file nobody reads. A root *inside* a
    // repository keeps the index untracked either way, because git applies the enclosing
    // repository's rules - so declaring an opinion here would be plugin state invented
    // for a directory that is not the repository's root.
    const plain = await fixture()
    const nested = await fixture()
    try {
      // Plain: not a repository at all.
      await rm(join(plain.sourceRoot, ".git"), { recursive: true, force: true })
      await recordTaskSession(plain.taskPath, plain.metadata, "s-member", "task")
      expect(existsSync(join(plain.sourceRoot, ".worktree-space", ".gitignore"))).toBe(false)

      // Nested: the parent is the repository, this root is not. It really is a
      // repository of its own, so this is the nested case rather than two non-repositories.
      await rm(join(nested.sourceRoot, ".git"), { recursive: true, force: true })
      const parent = join(nested.sourceRoot, "..")
      execFileSync("git", ["init", "-q", "."], { cwd: parent })
      await recordTaskSession(nested.taskPath, nested.metadata, "s-member", "task")
      expect(existsSync(join(nested.sourceRoot, ".worktree-space", ".gitignore"))).toBe(false)

      // In both cases the index itself was still written: the ignore file is a courtesy,
      // not a precondition.
      expect(existsSync(plain.indexFile)).toBe(true)
      expect(existsSync(nested.indexFile)).toBe(true)
    } finally {
      await plain.cleanup()
      await nested.cleanup()
    }
  })

  it("leaves an ignore file the workspace already wrote alone", async () => {
    // The file is written once. A workspace that has its own opinion - tracking the
    // index, ignoring something else - keeps it, because overwriting it would be this
    // plugin editing a user file by another route.
    const f = await fixture()
    try {
      const directory = join(f.sourceRoot, ".worktree-space")
      await mkdir(directory, { recursive: true })
      const ignore = join(directory, ".gitignore")
      await writeFile(ignore, "# mine\n*.json\n", "utf8")

      await recordTaskSession(f.taskPath, f.metadata, "s-member", "task")
      expect(await readFile(ignore, "utf8")).toBe("# mine\n*.json\n")
    } finally {
      await f.cleanup()
    }
  })

  it("is honoured by real git, for the index and the archive but not the deploy root", async () => {
    // The claim is about what git does, so it is checked against git rather than by
    // reading the pattern back: a file written to `.worktree-space/.gitignore` is only a
    // claim until a repository agrees with it. `-uall` lists untracked files one by one,
    // because the default output collapses a whole untracked directory into one line and
    // would not show whether the index is inside it.
    const f = await fixture()
    try {
      const git = (...args) => execFileSync("git", args, { cwd: f.sourceRoot, encoding: "utf8" })
      git("init", "-q", ".")
      git("config", "user.email", "test@example.invalid")
      git("config", "user.name", "test")
      await mkdir(join(f.sourceRoot, ".worktree-space", "deploy"), { recursive: true })
      await writeFile(join(f.sourceRoot, ".worktree-space", "deploy", "deploy.sh"), "#!/bin/sh\n", "utf8")
      // A `tasks/` directory somewhere else in the checkout, which the plugin's pattern
      // must not reach: a pattern inside `.worktree-space/` is relative to that directory.
      await mkdir(join(f.repo, "tasks"), { recursive: true })
      await writeFile(join(f.repo, "tasks", "kept.txt"), "x\n", "utf8")

      await recordTaskSession(f.taskPath, f.metadata, "s-member", "task")
      await archiveSourceTaskIndex(f.taskPath, f.metadata)

      const untracked = git("status", "--porcelain", "-uall")
      expect(untracked).toContain(".worktree-space/deploy/deploy.sh")
      expect(untracked).toContain("alpha/tasks/kept.txt")
      expect(untracked).not.toContain("tasks/alpha-root/")
      expect(untracked).not.toContain("tasks-archive/")
    } finally {
      await f.cleanup()
    }
  })

  it("reads back what it wrote, and answers undefined where nothing was written", async () => {
    const f = await fixture()
    try {
      expect(await readSourceTaskIndex(f.indexFile)).toBeUndefined()
      await recordTaskSession(f.taskPath, f.metadata, "s-member", "task")
      const read = await readSourceTaskIndex(f.indexFile)
      expect(read.task).toBe("cr20-24-fixes")
      // The point of carrying `taskPath`: the reader can check the space is still there,
      // because the file outlives nothing on its own.
      expect(existsSync(read.taskPath)).toBe(true)
    } finally {
      await f.cleanup()
    }
  })

})

/** The readable local stamp every one of these writes uses, not ISO. */
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

describe("a session's final report", () => {
  it("is stamped on the entry that reported, and no session is appended", async () => {
    const f = await fixture({
      sessions: [
        { sessionId: "s-member", at: "2026-01-01 00:00:00", role: "task" },
        { sessionId: "s-leader", at: "2026-01-01 00:00:01", role: "leader" },
      ],
    })
    try {
      const recordFile = join(f.taskPath, PLUGIN_ROOT, "worktree-space.json")
      const before = JSON.parse(await readFile(recordFile, "utf8"))

      // A session the record does not name: nothing is written, and in particular nothing is
      // appended. Growing the record a session because it reported would be the plugin claiming
      // it opened one it never opened, and appending is `recordTaskSession`'s job.
      expect(await markSessionReported(f.taskPath, "s-stranger")).toBe(false)
      expect(JSON.parse(await readFile(recordFile, "utf8")).sessions).toHaveLength(2)

      expect(await markSessionReported(f.taskPath, "s-member")).toBe(true)
      const after = JSON.parse(await readFile(recordFile, "utf8"))
      expect(after.sessions.map((entry) => entry.sessionId)).toEqual(["s-member", "s-leader"])
      expect(after.sessions[0].reportedAt).toMatch(STAMP)
      expect(after.sessions[1]).not.toHaveProperty("reportedAt")
      // Everything else in the record is untouched, field for field. `sessions` is the only
      // difference, which is why it is taken out of the comparison rather than asserted loosely.
      expect({ ...after, sessions: [] }).toEqual({ ...before, sessions: [] })
    } finally {
      await f.cleanup()
    }
  })

  it("survives normalization, so a reader gets back what was written", async () => {
    // The failure this pins is silent: the normalizer rebuilds each entry, so a field it does not
    // name is dropped on read - and a `reportedAt` that cannot be read is indistinguishable from
    // one that was never written.
    expect(normalizeSessions([{ sessionId: "s-1", reportedAt: "2026-01-02 03:04:05" }])[0].reportedAt)
      .toBe("2026-01-02 03:04:05")
    // Same shape rule as `at`: an empty or non-string value is absent, not an empty stamp.
    expect(normalizeSessions([{ sessionId: "s-1", reportedAt: "" }])[0]).not.toHaveProperty("reportedAt")
    expect(normalizeSessions([{ sessionId: "s-1", reportedAt: 7 }])[0]).not.toHaveProperty("reportedAt")

    const f = await fixture({ sessions: [{ sessionId: "s-member", at: "2026-01-01 00:00:00", role: "task" }] })
    try {
      expect(await markSessionReported(f.taskPath, "s-member")).toBe(true)
      const entry = taskSessionsOf(await readTaskMetadata(f.taskPath)).find((one) => one.sessionId === "s-member")
      expect(entry.reportedAt).toMatch(STAMP)
      expect(entry).toMatchObject({ sessionId: "s-member", at: "2026-01-01 00:00:00", role: "task" })
    } finally {
      await f.cleanup()
    }
  })

  it("is written into the source root's index too, which is the copy a finish archives", async () => {
    // Without this the report is recorded in a file a `done` removes, and the archived index -
    // the only copy left - still says the session never reported.
    const f = await fixture()
    try {
      expect(await recordTaskSession(f.taskPath, f.metadata, "s-member", "task")).toBe(true)
      expect(JSON.parse(await readFile(f.indexFile, "utf8")).sessions[0]).not.toHaveProperty("reportedAt")

      expect(await markSessionReported(f.taskPath, "s-member")).toBe(true)

      const entry = JSON.parse(await readFile(f.indexFile, "utf8")).sessions
        .find((one) => one.sessionId === "s-member")
      expect(entry.reportedAt).toMatch(STAMP)
    } finally {
      await f.cleanup()
    }
  })

  it("is read back out of an archived index, and its absence is too", async () => {
    // The archived pair is the watcher's only answer once the task space is gone, so both halves
    // are pinned: an archive that carries the stamp must not be read as unreported, and one that
    // does not must not be read as reported.
    const reported = await fixture()
    try {
      await recordTaskSession(reported.taskPath, reported.metadata, "s-member", "task")
      await markSessionReported(reported.taskPath, "s-member")
      expect(await archiveSourceTaskIndex(reported.taskPath, reported.metadata)).toBe(true)

      const entry = await readArchivedTaskSession(reported.sourceRoot, "alpha-root", "cr20-24-fixes", "s-member")
      expect(entry.reportedAt).toMatch(STAMP)
      // A session the archive does not name is no evidence either way, and says so.
      expect(await readArchivedTaskSession(reported.sourceRoot, "alpha-root", "cr20-24-fixes", "s-other"))
        .toBeUndefined()
    } finally {
      await reported.cleanup()
    }

    const silent = await fixture()
    try {
      await recordTaskSession(silent.taskPath, silent.metadata, "s-member", "task")
      expect(await archiveSourceTaskIndex(silent.taskPath, silent.metadata)).toBe(true)

      const entry = await readArchivedTaskSession(silent.sourceRoot, "alpha-root", "cr20-24-fixes", "s-member")
      expect(entry).toBeDefined()
      expect(entry).not.toHaveProperty("reportedAt")
    } finally {
      await silent.cleanup()
    }
  })
})

/** The task space's record, as the next call would read it. */
async function readTask(taskPath) {
  const { readTaskMetadata } = await import("../src/host/task/shared.js")
  return readTaskMetadata(taskPath)
}

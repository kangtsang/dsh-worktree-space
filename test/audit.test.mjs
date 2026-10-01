import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AUDIT_FILE,
  auditEnter,
  readAudit,
  recordError,
} from "../src/host/task/audit.js"
import { gitSucceeded, runGit, tryRunGit } from "../src/host/task/git.js"
import { listTasks } from "../src/host/task/operations.js"

/** The bound `audit.js` moves a log aside at, repeated here so the test cannot drift from it. */
const MAX_BYTES = 10 * 1024 * 1024

/**
 * Subprocess double answering every call the same way.
 * @param reply - the exit code, signal and streams the call ends with.
 * @returns the service double.
 */
function subprocessDouble(reply = {}) {
  return {
    spawn() {
      return {
        done: Promise.resolve({ exitCode: reply.exitCode ?? 0, signal: reply.signal ?? null }),
        collected: {
          stdout: { readFrom: () => ({ text: reply.stdout ?? "" }) },
          stderr: { readFrom: () => ({ text: reply.stderr ?? "" }) },
        },
      }
    },
  }
}

/** A container root that exists, as one a create would have prepared. */
async function containerFixture() {
  const base = await mkdtemp(join(tmpdir(), "audit-container-"))
  const root = join(base, "worktree-space")
  await mkdir(join(root, "alpha"), { recursive: true })
  return { base, root, cleanup: () => rm(base, { recursive: true, force: true }) }
}

/** A directory that is not there, and must stay that way. */
async function absentFixture() {
  const base = await mkdtemp(join(tmpdir(), "audit-absent-"))
  return { base, root: join(base, "never-created"), cleanup: () => rm(base, { recursive: true, force: true }) }
}

describe("the audit log", () => {
  it("records a failing git call with what ran, where, and what git said", async () => {
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.done", task: "login", project: "alpha", tasksRoot: container.root })
      await expect(
        runGit(subprocessDouble({ exitCode: 128, stderr: "fatal: not a git repository" }), "E:/src/alpha", ["merge", "task/login"]),
      ).rejects.toThrow(/not a git repository/)
      
      const records = await readAudit(container.root)
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        kind: "git",
        op: "task.done",
        task: "login",
        project: "alpha",
        cwd: "E:/src/alpha",
        argv: ["merge", "task/login"],
        exit: 128,
        stderr: "fatal: not a git repository",
      })
      expect(typeof records[0].ts).toBe("string")
    } finally {
      await container.cleanup()
    }
  })

  it("records the failure that a swallowing helper hid", async () => {
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.plan", task: "login", project: "alpha", tasksRoot: container.root })
      const subprocess = subprocessDouble({ exitCode: 128, stderr: "fatal: bad revision" })

      // Both of these answer an empty string or a false rather than throwing, so
      // without the record the exit code and its diagnostic simply disappear.
      await expect(tryRunGit(subprocess, "E:/src/alpha", ["rev-list", "--count", "gone..HEAD"])).resolves.toBe("")
      await expect(gitSucceeded(subprocess, "E:/src/alpha", ["merge-base", "--is-ancestor", "gone", "HEAD"])).resolves.toBe(false)
      
      const records = await readAudit(container.root)
      expect(records.map((entry) => entry.argv[0])).toEqual(["rev-list", "merge-base"])
      for (const entry of records) {
        expect(entry.kind).toBe("git")
        expect(entry.exit).toBe(128)
        expect(entry.stderr).toBe("fatal: bad revision")
      }
    } finally {
      await container.cleanup()
    }
  })

  it("leaves a read that answered alone, and records the write beside it", async () => {
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.create", task: "login", project: "alpha", tasksRoot: container.root })
      await runGit(subprocessDouble({ stdout: "## main...origin/main\n" }), "E:/src/alpha", ["status", "--short", "--branch"])
      await runGit(subprocessDouble(), "E:/src/alpha", ["worktree", "add", "E:/ws/login/alpha", "-b", "task/login"])
      
      const records = await readAudit(container.root)
      // The status read is noise in a file a person reads mid-incident; the
      // worktree it added is the story.
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ argv: ["worktree", "add", "E:/ws/login/alpha", "-b", "task/login"], exit: 0 })
      expect(records[0].stderr).toBeUndefined()
    } finally {
      await container.cleanup()
    }
  })

  it("records a read that failed even though a read normally is not recorded", async () => {
    const container = await containerFixture()
    try {
      auditEnter({ op: "worktree.scan", tasksRoot: container.root })
      await expect(runGit(subprocessDouble({ exitCode: 128, stderr: "fatal: not a repository" }), "E:/nowhere", ["rev-parse", "--show-toplevel"]))
        .rejects.toThrow()
      
      const records = await readAudit(container.root)
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ kind: "git", op: "worktree.scan", argv: ["rev-parse", "--show-toplevel"], exit: 128 })
    } finally {
      await container.cleanup()
    }
  })

  it("keeps what the caller is told and never sees", async () => {
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.done", task: "login", project: "alpha", tasksRoot: container.root })
      // `recover` reports this as one string under `bad-request`, and every
      // caller-facing field of it is gone by the time the request returns.
      const failure = Object.assign(new Error("merge failed"), { code: "ENOTEMPTY" })
      await recordError(failure, { phase: "done", repository: "alpha", conflict: true })

      const [record] = await readAudit(container.root)
      expect(record).toMatchObject({
        kind: "error",
        op: "task.done",
        task: "login",
        phase: "done",
        repository: "alpha",
        conflict: true,
        name: "Error",
        message: "merge failed",
        code: "ENOTEMPTY",
      })
      expect(record.stack).toContain("audit.test.mjs")
    } finally {
      await container.cleanup()
    }
  })

  it("hides credentials a URL carried", async () => {
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.create", task: "login", project: "alpha", tasksRoot: container.root })
      await expect(
        runGit(subprocessDouble({ exitCode: 128, stderr: "remote: https://bot:hunter2@git.example.com/x denied" }), "E:/src/alpha", [
          "fetch",
          "https://bot:hunter2@git.example.com/x",
        ]),
      ).rejects.toThrow()
      
      const [record] = await readAudit(container.root)
      const text = JSON.stringify(record)
      expect(text).not.toContain("hunter2")
      expect(text).not.toContain("bot:")
      expect(record.argv[1]).toBe("https://***@git.example.com/x")
      expect(record.stderr).toContain("https://***@git.example.com/x")
    } finally {
      await container.cleanup()
    }
  })

  it("writes nothing, and creates no container root, when there is no root yet", async () => {
    const absent = await absentFixture()
    try {
      // What `worktree.scan` looks like: an operation has not named a container
      // root, so there is nowhere to write and nothing to bring into being.
      auditEnter({ op: "worktree.scan" })
      await expect(runGit(subprocessDouble({ exitCode: 128, stderr: "fatal: not a repository" }), "E:/nowhere", ["rev-parse", "--show-toplevel"]))
        .rejects.toThrow()
      await recordError(new Error("scan failed"), { phase: "endpoint" })
      expect(existsSync(absent.root)).toBe(false)
    } finally {
      await absent.cleanup()
    }
  })

  it("is not a project: listTasks walks the root and skips everything that is not a directory", async () => {
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.create", task: "login", project: "alpha", tasksRoot: container.root })
      await runGit(subprocessDouble(), "E:/src/alpha", ["worktree", "add", "E:/ws/login/alpha", "-b", "task/login"])
            expect(existsSync(join(container.root, AUDIT_FILE))).toBe(true)

      // The one thing that has to be true of the log's placement: a file at the
      // container root is skipped, where an `audit/` directory would have been
      // listed as a project of its own.
      const listed = await listTasks(subprocessDouble(), { tasksRoot: container.root })
      expect(listed.tasks.map((task) => `${task.project}/${task.name}`)).toEqual([])
    } finally {
      await container.cleanup()
    }
  })

  it("moves a full log aside instead of growing past its bound", async () => {
    const container = await containerFixture()
    try {
      await writeFile(join(container.root, AUDIT_FILE), "x".repeat(MAX_BYTES), "utf8")
      auditEnter({ op: "task.plan", task: "login", project: "alpha", tasksRoot: container.root })
      await runGit(subprocessDouble(), "E:/src/alpha", ["worktree", "add", "E:/ws/login/alpha", "-b", "task/login"])
      
      const entries = (await readdir(container.root)).sort()
      // The moved file keeps its records, and the new one is the current log.
      // Its name is the log's own with a timestamp in the middle, so it is
      // derived rather than spelled out: a rename of the log must not leave
      // this test asserting the old name.
      const stem = AUDIT_FILE.replace(/\.jsonl$/, "")
      const moved = entries.find((name) => name.startsWith(`${stem}.`) && name !== AUDIT_FILE)
      expect(entries).toHaveLength(3) // alpha/, the new log, the moved log
      expect(entries).toContain("alpha")
      expect(entries).toContain(AUDIT_FILE)
      expect(moved).toMatch(new RegExp(`^${stem}\\.\\d{8}-\\d{6}\\.jsonl$`))

      const records = await readAudit(container.root)
      expect(records).toHaveLength(1)
      expect(records[0].argv[0]).toBe("worktree")
      expect((await readFile(join(container.root, moved), "utf8")).length).toBe(MAX_BYTES)
    } finally {
      await container.cleanup()
    }
  })

  it("stays readable when the last line is half-written", async () => {
    const container = await containerFixture()
    try {
      await writeFile(
        join(container.root, AUDIT_FILE),
        `${JSON.stringify({ kind: "git", argv: ["status"] })}\n{"kind":"git","argv":["me`,
        "utf8",
      )
      const records = await readAudit(container.root)
      expect(records).toEqual([{ kind: "git", argv: ["status"] }])
    } finally {
      await container.cleanup()
    }
  })
})

import { afterEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  AUDIT_FILE,
  auditEnabled,
  auditEnter,
  localStamp,
  readAudit,
  recordError,
  recordEvent,
  recordWarning,
  setAuditEnabled,
  setAuditEnabledReader,
} from "../src/host/task/audit-log.js"
import { gitSucceeded, runGit, tryRunGit } from "../src/host/task/git.js"
import { listTasks } from "../src/host/task/operations.js"

/** The bound in `auditLog.js` moves a log aside at, repeated here so the test cannot drift from it. */
const MAX_BYTES = 10 * 1024 * 1024

/**
 * Read a setting the way the entry does, for both shapes the Loader can hand over.
 *
 * Copied rather than imported: `settingValue` is private to `index.js`, and this
 * is the whole of what the log needs to know about how a setting arrives.
 * @param setting - the reference, or the value itself.
 * @returns the value, or undefined when there is none.
 */
function settingValueOf(setting) {
  if (setting !== null && typeof setting === "object" && typeof setting.get === "function") return setting.get()
  return setting
}

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
  it("stamps records with local wall-clock time, not UTC and not ISO", async () => {
    // The reason this is a test and not a comment: `toISOString()` is the obvious
    // one-liner, it is UTC, and it is what this used to be. A reader during an
    // incident then has to convert an offset to learn what time it was.
    const when = new Date(2026, 8, 28, 12, 0, 1) // 28 Sep 2026, 12:00:01 LOCAL
    expect(localStamp(when)).toBe("2026-09-28 12:00:01")
  })

  it("pads every field to two digits so the width never changes", () => {
    // March 9th, 06:07:08 - the single-digit month, day, hour, minute and second
    // are the whole reason padStart is here.
    expect(localStamp(new Date(2026, 2, 9, 6, 7, 8))).toBe("2026-03-09 06:07:08")
    expect(localStamp(new Date(2026, 11, 31, 23, 59, 59))).toBe("2026-12-31 23:59:59")
  })

  it("writes that stamp into the record", async () => {
    const container = await containerFixture()
    try {
      const before = localStamp()
      auditEnter({ op: "task.create", task: "a", project: "p", tasksRoot: container.root })
      await runGit(subprocessDouble(), "E:/src/p", ["worktree", "add", "E:/ws/a", "-b", "task/a"])
      const after = localStamp()

      const records = await readAudit(container.root)
      expect(records).toHaveLength(1)
      expect(records[0].ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      expect(records[0].level).toBe("info")
      // Fixed width means the strings sort as times do, so the stamp can simply
      // be pinned between the clock either side of the call. A UTC stamp would
      // sit eight hours out and fail this - which is the bug it guards.
      expect(records[0].ts >= before).toBe(true)
      expect(records[0].ts <= after).toBe(true)
    } finally {
      await rm(container.root, { recursive: true, force: true })
    }
  })

  it("says in a sentence what happened, and keeps the fields beside it", async () => {
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.create", task: "login", project: "alpha", tasksRoot: container.root })
      await recordEvent("info", "Created the task space.", { phase: "create", branch: "task/login", worktrees: ["api", "web"] })

      const records = await readAudit(container.root)
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        kind: "event",
        level: "info",
        msg: "Created the task space.",
        phase: "create",
        branch: "task/login",
      })
      // The sentence says the outcome, the fields say the particulars. Neither
      // is derived from the other, so a reader can filter on one or the other.
      expect(records[0].worktrees).toEqual(["api", "web"])
    } finally {
      await container.cleanup()
    }
  })

  it("levels an event by how it turned out", async () => {
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.done", task: "a", project: "p", tasksRoot: container.root })
      await recordEvent("info", "Fine.", {})
      await recordEvent("warn", "Odd.", {})
      await recordEvent("error", "Broken.", {})
      // A level nobody passes must not become a record nobody can filter on.
      await recordEvent("shouty", "Defaults to info.", {})

      const records = await readAudit(container.root)
      expect(records.map((entry) => entry.level)).toEqual(["info", "warn", "error", "info"])
    } finally {
      await container.cleanup()
    }
  })

  it("carries a msg on an error without displacing what error already said", async () => {
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.create", task: "a", project: "p", tasksRoot: container.root })
      const boom = Object.assign(new Error("worktree add failed: fatal: ..."), { code: "merge-conflict" })
      await recordError(boom, { phase: "create", msg: "Creating the task space failed. It was rolled back." })

      const records = await readAudit(container.root)
      expect(records).toHaveLength(1)
      // msg is what the operation means; message and code are still git's own and
      // this plugin's, so the record explains itself without hiding the detail.
      expect(records[0].msg).toBe("Creating the task space failed. It was rolled back.")
      expect(records[0].message).toBe("worktree add failed: fatal: ...")
      expect(records[0].code).toBe("merge-conflict")
      expect(records[0].level).toBe("error")
    } finally {
      await container.cleanup()
    }
  })

  it("puts a sentence on a failed git call, quoting git's own complaint", async () => {
    // Filtering for level == "error" has to land on lines that say what they are,
    // not on bare argv and exit codes the reader has to decode one by one.
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.done", task: "a", project: "p", tasksRoot: container.root })
      await expect(
        runGit(
          subprocessDouble({ exitCode: 128, stderr: "fatal: not a git repository: /ws/a/.git\n" }),
          "E:/ws/a",
          ["worktree", "list", "--porcelain"],
        ),
      ).rejects.toThrow()

      const records = await readAudit(container.root)
      expect(records).toHaveLength(1)
      expect(records[0].level).toBe("error")
      expect(records[0].msg).toContain("fatal: not a git repository")
      // The whole diagnostic is still there; msg is a summary, not a replacement.
      expect(records[0].stderr).toBe("fatal: not a git repository: /ws/a/.git\n")
    } finally {
      await container.cleanup()
    }
  })

  it("quotes only the first line, because the rest is git explaining itself", async () => {
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.create", task: "a", project: "p", tasksRoot: container.root })
      await expect(
        runGit(
          subprocessDouble({
            exitCode: 128,
            stderr: "fatal: not a git repository\n\nusage: git worktree list\n\n    list ...\n",
          }),
          "E:/ws/a",
          ["worktree", "list", "--porcelain"],
        ),
      ).rejects.toThrow()

      const records = await readAudit(container.root)
      expect(records[0].msg).toBe("This git command failed, so whatever it was for did not happen: fatal: not a git repository")
      expect(records[0].stderr).toContain("usage: git worktree list")
    } finally {
      await container.cleanup()
    }
  })

  it("names the failure with the same code the thrown error carries", async () => {
    // The record and the error have to agree, or `grep` for a code found in the
    // log misses the throw site and vice versa.
    const cases = [
      ["fatal: not a git repository: /ws/a/.git", "E3004"],
      ["fatal: /ws/a is not a working tree", "E3005"],
      ["error: No such file or directory", "E3005"],
      ["fatal: refusing to merge unrelated histories", "E3003"],
    ]
    for (const [stderr, code] of cases) {
      const container = await containerFixture()
      try {
        auditEnter({ op: "task.done", task: "a", project: "p", tasksRoot: container.root })
        const subprocess = subprocessDouble({ exitCode: 128, stderr })
        await expect(runGit(subprocess, "E:/ws/a", ["worktree", "list"])).rejects.toThrow()

        const records = await readAudit(container.root)
        expect(records[0].code).toBe(code)

        // And the code the caller receives is the same one, because runGit sets
        // it on the error it throws from the same stderr.
        const thrown = await runGit(subprocessDouble({ exitCode: 128, stderr }), "E:/ws/a", ["worktree", "list"])
          .then(() => undefined, (error) => error)
        expect(thrown.code).toBe(code)
      } finally {
        await container.cleanup()
      }
    }
  })

  it("leaves a successful call without a sentence or a code", async () => {
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.create", task: "a", project: "p", tasksRoot: container.root })
      await runGit(subprocessDouble(), "E:/src/p", ["worktree", "add", "E:/ws/a", "-b", "task/a"])

      const records = await readAudit(container.root)
      expect(records).toHaveLength(1)
      // argv already says what ran; a sentence or a code beside it is noise.
      expect(records[0].msg).toBeUndefined()
      expect(records[0].code).toBeUndefined()
    } finally {
      await container.cleanup()
    }
  })

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
        // Swallowed by the caller, but git said why, so it is still an error.
        // This is the case the level has to keep: a swallowed answer nobody can
        // distinguish from a broken one.
        expect(entry.level).toBe("error")
      }
    } finally {
      await container.cleanup()
    }
  })

  it("calls a silent non-zero exit an answer, not an error", async () => {
    // The record the acceptance produced for a create that plainly succeeded:
    // `show-ref --verify --quiet` exits 1 to say "no such branch", printing
    // nothing either way. Filed as an error it would put a red herring in the
    // log of every single successful create.
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.create", task: "audit-test", project: "audit-fixture", tasksRoot: container.root })
      const free = subprocessDouble({ exitCode: 1, stdout: "", stderr: "" })
      await expect(gitSucceeded(free, "E:/src/alpha", ["show-ref", "--verify", "--quiet", "refs/heads/task/audit-test"])).resolves.toBe(false)

      const records = await readAudit(container.root)
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        kind: "git",
        level: "info",
        op: "task.create",
        exit: 1,
        stderr: "",
      })
    } finally {
      await container.cleanup()
    }
  })

  it("calls it an error the moment git says anything", async () => {
    // Same exit code, same subcommand shape - and now it is a real failure.
    // Exit code alone cannot tell these apart; git's diagnostic can.
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.create", task: "audit-test", project: "alpha", tasksRoot: container.root })
      const loud = subprocessDouble({ exitCode: 1, stdout: "", stderr: "fatal: not a git repository" })
      await expect(tryRunGit(loud, "E:/nowhere", ["show-ref", "--verify", "--quiet", "refs/heads/task/x"])).resolves.toBe("")

      const records = await readAudit(container.root)
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ kind: "git", level: "error", exit: 1 })
    } finally {
      await container.cleanup()
    }
  })

  it("records a signal death as an error even when git printed nothing", async () => {
    // No exit code to judge and no diagnostic to read, so the default has to be
    // the loud one: a killed process is not an answer to a question.
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.done", task: "a", project: "p", tasksRoot: container.root })
      await expect(
        runGit(subprocessDouble({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" }),
          "E:/src/p", ["merge", "task/a"]),
      ).rejects.toThrow()

      const records = await readAudit(container.root)
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ kind: "git", level: "error", signal: "SIGTERM" })
    } finally {
      await container.cleanup()
    }
  })

  it("levels a plugin error and a warning as themselves", async () => {
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.done", task: "a", project: "p", tasksRoot: container.root })
      await recordError(Object.assign(new Error("boom"), { code: "merge-conflict" }), { phase: "done" })
      await recordWarning("worktree is prunable", { path: "E:/ws/a" })

      const records = await readAudit(container.root)
      expect(records.map((entry) => entry.level)).toEqual(["error", "warn"])
      expect(records.map((entry) => entry.kind)).toEqual(["error", "warning"])
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
      // The stack is where the code was raised, and it is recorded under whichever
      // file the raise happened in - this one, since the test raises it. Named
      // from `import.meta.url` so renaming this file does not quietly turn the
      // assertion into a check that never passes.
      expect(record.stack).toContain(basename(fileURLToPath(import.meta.url)))
    } finally {
      await container.cleanup()
    }
  })

  it("hides a credential handed over outside a URL", async () => {
      const container = await containerFixture()
      try {
        auditEnter({ op: "task.create", task: "login", project: "alpha", tasksRoot: container.root })
        // A header, a parameter and a bearer token are three of the ways a secret
        // reaches a command line without ever being a URL authority.
        await expect(
          runGit(subprocessDouble({ exitCode: 128, stderr: "Authorization: Bearer abc123 rejected" }), "E:/src/alpha", [
            "-c", "http.extraHeader=Authorization: Bearer abc123", "fetch",
          ]),
        ).rejects.toThrow()

        const [record] = await readAudit(container.root)
        const text = JSON.stringify(record)
        expect(text).not.toContain("abc123")
        // A word that is only a word is left alone.
        expect(text).toContain("fetch")
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
      expect(moved).toMatch(new RegExp(`^${stem}\\.\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-\\d{2}\\.jsonl$`))
      // The stamp a record carries is `2026-10-02 11:35:26`, and that is not a
      // legal filename on Windows - a rename that throws would take the rotation
      // with it and the log would then grow past its bound forever, silently.
      // This assertion is the reason the rotation is worth testing at all: a
      // format change to `ts` has to change this name too, and did not at first.
      expect(moved).not.toMatch(/[:*?"<>|]/)

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

describe("the log switch", () => {
  // The switch is a module-level cell, so every test above it has already left it
  // on. A test that turned it off and did not turn it back would silently stop
  // the records in whichever file ran next, which is the one failure mode a
  // global of this kind has.
  afterEach(() => setAuditEnabled(true))

  it("writes nothing while it is off, and everything again once it is on", async () => {
    const container = await containerFixture()
    try {
      setAuditEnabled(false)
      expect(auditEnabled()).toBe(false)
      auditEnter({ op: "task.create", task: "a", project: "p", tasksRoot: container.root })
      await recordEvent("info", "should not be written", { phase: "create" })
      await recordError(new Error("nor this"), { phase: "create" })
      await runGit(subprocessDouble(), "E:/src/p", ["worktree", "list"])
      expect(await readAudit(container.root)).toHaveLength(0)

      // No file at all, rather than an empty one: a log that was never on should
      // not leave a trace that looks like a log that recorded nothing.
      expect(existsSync(join(container.root, AUDIT_FILE))).toBe(false)

      setAuditEnabled(true)
      expect(auditEnabled()).toBe(true)
      auditEnter({ op: "task.create", task: "a", project: "p", tasksRoot: container.root })
      await recordEvent("info", "this one is written", { phase: "create" })
      expect(await readAudit(container.root)).toHaveLength(1)
    } finally {
      setAuditEnabled(true)
      await container.cleanup()
    }
  })

  it("leaves the log already on disk exactly where it was", async () => {
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.create", task: "a", project: "p", tasksRoot: container.root })
      await recordEvent("info", "written before the switch was turned", { phase: "create" })
      const before = await readFile(join(container.root, AUDIT_FILE), "utf8")

      setAuditEnabled(false)
      auditEnter({ op: "task.done", task: "a", project: "p", tasksRoot: container.root })
      await recordEvent("error", "written after it was turned off", { phase: "done" })

      // Turning a log off stops records; it does not remove the ones already
      // written, because they are often the only account of what happened to
      // work that is in nobody's history. Deleting on switch-off would make this
      // setting the one destructive thing the plugin can do.
      expect(await readFile(join(container.root, AUDIT_FILE), "utf8")).toBe(before)
      expect(await readAudit(container.root)).toHaveLength(1)
    } finally {
      setAuditEnabled(true)
      await container.cleanup()
    }
  })

  it("does not rename anything either, so an oversized log is not archived", async () => {
    const container = await containerFixture()
    try {
      await writeFile(join(container.root, AUDIT_FILE), "x".repeat(10 * 1024 * 1024 + 1), "utf8")
      const stem = AUDIT_FILE.replace(/\.jsonl$/, "")
      const before = (await readdir(container.root)).sort()

      setAuditEnabled(false)
      auditEnter({ op: "task.create", task: "a", project: "p", tasksRoot: container.root })
      await recordEvent("info", "should not trigger a rotation", { phase: "create" })

      // The rotation check sits behind the same gate as the append: a log
      // switched off is left completely alone, not partly tidied.
      expect((await readdir(container.root)).sort()).toEqual(before)
      // The current log's own name starts with the stem as well, so it has to be
      // excluded or this matches it and proves nothing at all.
      expect((await readdir(container.root)).filter((name) => name.startsWith(`${stem}.`) && name !== AUDIT_FILE)).toEqual([])
    } finally {
      setAuditEnabled(true)
      await container.cleanup()
    }
  })

  it("is on before anything has been configured", () => {
    // The default the Config schema also declares. A profile that has never been
    // configured has to behave like one that says `on`, or the log would be off
    // everywhere until someone found the setting - which is the opposite of what
    // a log is for.
    setAuditEnabled(true)
    expect(auditEnabled()).toBe(true)
  })

  describe("asked of the configuration rather than remembered", () => {
    // The Loader restarts a plugin when its configuration changes, so reading the
    // switch once per `apply` would have been correct and this accessor fixes no
    // reported failure - the switch reported not to work had been turned while the
    // turn only registered a session, which records nothing. What it pins is the
    // property the original code leaned on the Loader honouring: the current answer
    // is available at the moment of the record, not only when something remembered
    // to refresh it.
    afterEach(() => {
      setAuditEnabledReader(null)
      setAuditEnabled(true)
    })

    it("stops on the next record once the configuration says off", async () => {
      const container = await containerFixture()
      try {
        // The Loader's shape: a reference, asked for the value each time.
        let saved = "on"
        setAuditEnabledReader(() => saved !== "off")

        auditEnter({ op: "task.create", task: "a", project: "p", tasksRoot: container.root })
        await recordEvent("info", "written while on", { phase: "create" })
        expect(await readAudit(container.root)).toHaveLength(1)

        // The page writes the setting. Nothing else happens - no apply, no reload.
        saved = "off"
        expect(auditEnabled()).toBe(false)

        await recordEvent("info", "written while off", { phase: "create" })
        expect(await readAudit(container.root)).toHaveLength(1)

        saved = "on"
        await recordEvent("info", "written again", { phase: "create" })
        expect(await readAudit(container.root)).toHaveLength(2)
      } finally {
        await container.cleanup()
      }
    })

    it("reads a plain value as well as a reference", () => {
      // A caller passing a literal is legitimate, and the two shapes are read
      // differently: `'off'.get` is undefined, so a reference-only read treats a
      // plain 'off' as unset and the switch stays on - the opposite of the ask.
      // That is the failure this accessor exists beside, so it is pinned here.
      setAuditEnabledReader(() => settingValueOf("off") !== "off")
      expect(auditEnabled()).toBe(false)
      setAuditEnabledReader(() => settingValueOf("on") !== "off")
      expect(auditEnabled()).toBe(true)
    })

    it("outranks the remembered value, which is what a caller without a profile gets", () => {
      // No configuration installed: the cell answers, so a caller that has only
      // ever called setAuditEnabled keeps working.
      setAuditEnabledReader(null)
      setAuditEnabled(false)
      expect(auditEnabled()).toBe(false)
      setAuditEnabled(true)
      expect(auditEnabled()).toBe(true)

      // With one installed, the configuration is the thing the user changed from
      // the page, so it decides.
      setAuditEnabledReader(() => false)
      setAuditEnabled(true)
      expect(auditEnabled()).toBe(false)
    })
  })
})

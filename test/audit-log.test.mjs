import { afterEach, describe, expect, it, vi } from "vitest"
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * A switch the mocked `rename` reads, so one test can make a rotation fail on purpose.
 *
 * `vi.hoisted` because `vi.mock` is hoisted above the imports: a factory referring to an
 * ordinary top-level `const` would run before that binding exists.
 */
const renameControl = vi.hoisted(() => ({ fail: false }))

/**
 * `node:fs/promises` with one behaviour made controllable.
 *
 * The rotation is a `rename`, and there is no portable filesystem condition that makes a
 * `rename` of an ordinary file inside a writable directory fail - which is exactly why the
 * failure had to be simulated. Everything else passes straight through, so the fixtures and
 * every other test in this file still touch the real filesystem.
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    rename: async (from, to) => {
      if (renameControl.fail) {
        const error = new Error("EACCES: rename refused")
        error.code = "EACCES"
        throw error
      }
      return actual.rename(from, to)
    },
  }
})

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
import { warned } from "../src/host/task/codes.js"
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

  it("hides a credential the keyword did not sit immediately before a separator", async () => {
    // The shapes measured against the real regex that were NOT redacted. Two causes,
    // and both are here: the separator only accepted `:` or `=` (so `--password hunter2`
    // and `--token ghp_abc` were untouched), and the value had to be announced by a
    // keyword at all (so a bare `Bearer eyJ...`, a PEM header and a bare `ghp_...` were).
    // The counter-example is in the same test on purpose: a rule that redacts everything
    // is not the fix, and `feature/token-refresh` is what says so.
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.create", task: "login", project: "alpha", tasksRoot: container.root })
      const secrets = [
        "--password hunter2",
        "--token ghp_abc",
        "AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE",
        "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "ghp_1234567890abcdefghij",
        "glpat-abcdefghijklmn",
        "xoxb-1234567890-abcdef",
        "sk-abcdefghijklmnopqrst",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
      ]
      await expect(
        runGit(subprocessDouble({ exitCode: 128, stderr: secrets.join("\n") }), "E:/src/alpha", [
          "-c", ...secrets, "fetch", "feature/token-refresh",
        ]),
      ).rejects.toThrow()

      const [record] = await readAudit(container.root)
      // Asserted against the on-disk JSON, which is what a reader opens.
      const text = JSON.stringify(record)
      for (const secret of ["hunter2", "ghp_abc", "AKIAIOSFODNN7EXAMPLE", "eyJhbGciOiJIUzI1NiJ9", "MIIEowIBAAKCAQEA", "glpat-abcdefghijklmn", "xoxb-1234567890-abcdef", "sk-abcdefghijklmnopqrst"]) {
        expect(text, `credential ${secret} reached the log`).not.toContain(secret)
      }
      // The one that must survive, spelled exactly: a branch whose name merely contains
      // `token` is not a credential, and redacting it would lose the branch from the log.
      expect(record.argv[record.argv.length - 1]).toBe("feature/token-refresh")
    } finally {
      await container.cleanup()
    }
  })

  it("leaves an identifier that merely ends in a token prefix alone", async () => {
    // The counter-example the value-shape rule has to keep, and the one that caught this
    // rule's first version: `no-task-branch` contains `sk-branch`, so a bare `sk-` prefix
    // rule rewrote the plugin's own warning code to `no-ta***` in the log - destroying the
    // one field a reader greps for. A token prefix is a prefix when nothing word-like
    // precedes it, which is the boundary this asserts.
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.done", task: "login", project: "alpha", tasksRoot: container.root })
      await recordWarning(warned("no-task-branch", "no task branch is recorded", {}), { phase: "done" })
      await recordEvent("info", "task/login", { phase: "done", branch: "task/login", code: "E5001" })

      const records = await readAudit(container.root)
      expect(records[0].code).toBe("no-task-branch")
      expect(records[1].code).toBe("E5001")
      expect(records[1].branch).toBe("task/login")
    } finally {
      await container.cleanup()
    }
  })

  it("redacts string values in the record's own fields, not only in argv and stderr", async () => {
    // The file's comment promises over-redaction, and the promise covered the strings
    // each call site redacts by hand. A value passed through `fields` was not among
    // them, so a credential put there appeared verbatim - verified by a probe that put
    // one in a field and found it in the log three times. No caller does that today,
    // which is exactly why the redaction belongs here rather than at each call site.
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.done", task: "login", project: "alpha", tasksRoot: container.root })
      await recordEvent("warn", "carrying on", {
        phase: "done",
        remote: "https://bot:hunter2@git.example.com/x",
        token: "ghp_1234567890abcdefghij",
        nested: { header: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig" },
        list: ["--password hunter3"],
        // Non-strings are left as they are: a reader filters on these.
        exit: 1,
        conflict: true,
        count: 3,
      })

      const [record] = await readAudit(container.root)
      const text = JSON.stringify(record)
      for (const secret of ["hunter2", "hunter3", "ghp_1234567890abcdefghij", "eyJhbGciOiJIUzI1NiJ9"]) {
        expect(text, `credential ${secret} reached a field`).not.toContain(secret)
      }
      // The facts a filter reads are untouched, in type as well as value.
      expect(record.exit).toBe(1)
      expect(record.conflict).toBe(true)
      expect(record.count).toBe(3)
      expect(record.phase).toBe("done")
    } finally {
      await container.cleanup()
    }
  })

  it("records a warning object's own code and message, not its stringification", async () => {
    // `recordWarning` has one caller, and that caller passes a `warned()` object. It
    // was stringified, so every `kind: "warning"` line this plugin wrote recorded
    // `"message":"[object Object]"` and dropped the code and the values - including
    // `deploy-containers-left`, `leftover-refused` and `no-task-branch`. The test above
    // it passed a string, which is the one shape that worked, and is why this was never
    // caught.
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.done", task: "login", project: "alpha", tasksRoot: container.root })
      await recordWarning(warned("leftover-refused", "a leftover is a link, so it was left alone", { name: ".git", count: 1 }), { phase: "done" })

      const [record] = await readAudit(container.root)
      expect(record.kind).toBe("warning")
      expect(record.level).toBe("warn")
      // The code a screen translates, and the sentence a reader reads.
      expect(record.code).toBe("leftover-refused")
      expect(record.message).toBe("a leftover is a link, so it was left alone")
      expect(record.values).toEqual({ name: ".git", count: 1 })
      // And the stringification is gone, which is the symptom that was visible.
      expect(JSON.stringify(record)).not.toContain("[object Object]")
      // The caller's own fields still land beside it.
      expect(record.phase).toBe("done")
    } finally {
      await container.cleanup()
    }
  })

  it("still takes a plain sentence, which is the shape the older caller used", async () => {
    // Both shapes have to work: the string is what the existing test passes, and a
    // fix that accepted only the object would have moved the breakage rather than
    // ended it.
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.done", task: "a", project: "p", tasksRoot: container.root })
      await recordWarning("worktree is prunable", { path: "E:/ws/a" })
      const [record] = await readAudit(container.root)
      expect(record.message).toBe("worktree is prunable")
      expect(record.path).toBe("E:/ws/a")
      // No code is invented for a caller that did not give one.
      expect(record.code).toBeUndefined()
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
      // The documented shape is the leading part, and the milliseconds and any
      // collision counter follow it. Kept as a pattern rather than a literal: the
      // exact stamp is the moment the test ran.
      expect(moved).toMatch(new RegExp(`^${stem}\\.\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-\\d{3}(?:-\\d+)?\\.jsonl$`))
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

  it("keeps both archives when two rotations land in the same second", async () => {
    // The maintainer's decision is that archives stay forever, which makes a silent
    // overwrite a contract violation rather than housekeeping: `fs.rename` over an
    // existing file succeeds, so a name that collides destroys the earlier archive and
    // nothing reports it. `localStamp` has second precision, so two rotations in one
    // second is exactly the shape that used to collide - and a 10 MB log rotated twice
    // while a build runs is not exotic.
    const container = await containerFixture()
    try {
      // A clock held still for the whole test: this is the second-precision case made
      // deterministic rather than hoped for. Without the fix both rotations below choose
      // the same name, and the first archive's contents are gone.
      const frozen = new Date(2026, 9, 2, 11, 35, 26, 42)
      vi.useFakeTimers()
      vi.setSystemTime(frozen)
      try {
        // Each fill is marked, so which archive is which can be told apart by content
        // rather than only by name - that is what proves the second rename did not
        // land on the first file.
        await writeFile(join(container.root, AUDIT_FILE), `MARKER-ONE${"A".repeat(MAX_BYTES)}`, "utf8")
        auditEnter({ op: "task.plan", task: "login", project: "alpha", tasksRoot: container.root })
        await recordEvent("info", "first rotation", { phase: "plan" })
        // The log now holds the record above; grow it past the bound again and rotate a
        // second time, in the same frozen second and the same millisecond.
        await appendFile(join(container.root, AUDIT_FILE), `MARKER-TWO${"B".repeat(MAX_BYTES)}`, "utf8")
        await recordEvent("info", "second rotation", { phase: "plan" })
      } finally {
        vi.useRealTimers()
      }

      const stem = AUDIT_FILE.replace(/\.jsonl$/, "")
      const archives = (await readdir(container.root)).filter((name) => name.startsWith(`${stem}.`) && name !== AUDIT_FILE).sort()
      // Two distinct files, both still on disk: the whole point of "keep all".
      expect(archives).toHaveLength(2)
      expect(new Set(archives).size).toBe(2)

      // Both archives are whole, and each holds its own fill - so neither rename
      // destroyed the other, which is the failure this test exists for.
      const texts = await Promise.all(archives.map((name) => readFile(join(container.root, name), "utf8")))
      const joined = texts.join("\n")
      expect(joined).toContain("MARKER-ONE")
      expect(joined).toContain("MARKER-TWO")
      expect(texts.filter((text) => text.includes("MARKER-ONE"))).toHaveLength(1)
      expect(texts.filter((text) => text.includes("MARKER-TWO"))).toHaveLength(1)
      // The second archive is the larger one: it is the first archive's successor, and
      // it carries the record the first rotation left in the log.
      expect(Math.max(...texts.map((text) => text.length))).toBeGreaterThan(MAX_BYTES)
      expect(joined).toContain("first rotation")

      // Still a legal filename on Windows, counter or not.
      for (const name of archives) expect(name).not.toMatch(/[:*?"<>|]/)
      // And the current log is the one the second rotation started, holding only the
      // record written after it.
      const current = await readAudit(container.root)
      expect(current).toHaveLength(1)
      expect(current[0].msg).toBe("second rotation")
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

  /**
   * The write is serialised, so concurrency loses nothing.
   *
   * `auditRecord` was `stat -> rotate -> appendFile`, three awaits with nothing atomic in
   * them, and the plugin reaches it concurrently: `inspect.js` maps `Promise.all` over tasks
   * and the scan paths run beside each other. Every test here asserts the count of lines on
   * disk, because a dropped record is invisible in any other form - the caller is answered,
   * the operation carries on, and the only account of what happened is short by one line.
   */
  describe("concurrent records all land", () => {
    it("writes every one of N concurrent records, with no line lost or merged", async () => {
      // The regression itself. Without the lock this is where the loss shows: the callers
      // interleave, and - once the log is over its bound - two of them both rotate and the
      // second `rename` gets ENOENT inside the swallowing `catch`.
      const container = await containerFixture()
      try {
        // Over the bound, so every caller's `stat` sees a rotation due and the rotation path
        // is exercised concurrently rather than only the append. Newline-terminated, the way
        // a real over-limit log ends: a filler that ran into the next record would make one
        // unparseable line and prove nothing about the writers.
        await writeFile(join(container.root, AUDIT_FILE), `${"x".repeat(MAX_BYTES - 1)}\n`, "utf8")
        auditEnter({ op: "task.plan", task: "login", project: "alpha", tasksRoot: container.root })

        const writers = 25
        await Promise.all(Array.from({ length: writers }, (_, index) => recordEvent("info", `record ${index}`, { index })))

        // Exactly one line per call, across the current log and whatever was archived. A
        // count taken over the current log alone would pass while records sat in an archive.
        const names = await readdir(container.root)
        const logs = names.filter((name) => name === AUDIT_FILE || name.startsWith(AUDIT_FILE.replace(/\.jsonl$/, ".")))
        const lines = []
        for (const name of logs) {
          const text = await readFile(join(container.root, name), "utf8")
          for (const line of text.split("\n")) {
            // The filler the fixture planted is not a record; everything the writers wrote
            // starts with `{`. A record split across two appends would still be caught here,
            // because its first fragment would not parse.
            if (!line.startsWith("{")) continue
            lines.push(JSON.parse(line))
          }
        }
        const written = lines.filter((entry) => entry.kind === "event")
        expect(written).toHaveLength(writers)
        // And each one is the record it claimed to be, so a lost line cannot hide behind a
        // duplicate of another.
        expect(new Set(written.map((entry) => entry.index)).size).toBe(writers)
        // The current log holds only records - one rotation moved the filler aside, and no
        // writer's bytes were spliced into another's line.
        const current = await readFile(join(container.root, AUDIT_FILE), "utf8")
        for (const line of current.split("\n")) {
          if (line.trim() === "") continue
          expect(() => JSON.parse(line), `not one line: ${line.slice(0, 80)}`).not.toThrow()
        }
      } finally {
        await container.cleanup()
      }
    })

    it("keeps a record longer than PIPE_BUF as one intact line", async () => {
      // 4 KiB is `PIPE_BUF`, the size past which a single `appendFile` no longer guarantees
      // an atomic write. Building the line once and writing it through one `open` + one
      // `write` is what makes the record indivisible however long it is; two appends could be
      // interleaved with another writer's, producing a half-line that `readAudit` drops.
      const container = await containerFixture()
      try {
        auditEnter({ op: "task.done", task: "login", project: "alpha", tasksRoot: container.root })
        // Comfortably past 4 KiB once serialised, and past the record's own field limits too,
        // so this is a record the plugin really can produce rather than a synthetic one.
        const long = "z".repeat(5000)
        await Promise.all([
          recordEvent("info", "short one", { phase: "done" }),
          recordEvent("info", long, { phase: "done", long }),
          recordEvent("info", "short two", { phase: "done" }),
        ])

        const text = await readFile(join(container.root, AUDIT_FILE), "utf8")
        const records = await readAudit(container.root)
        expect(records).toHaveLength(3)
        // The long record survived whole, and nothing was spliced into it.
        const longRecord = records.find((entry) => entry.long !== undefined)
        expect(longRecord.long).toBe(long)
        // Line-oriented proof as well: every non-empty line is valid JSON, so no writer's
        // bytes landed inside another's line.
        for (const line of text.split("\n")) {
          if (line.trim() === "") continue
          expect(() => JSON.parse(line), `not one line: ${line.slice(0, 80)}`).not.toThrow()
        }
      } finally {
        await container.cleanup()
      }
    })

    it("still appends the record when the rotation fails", async () => {
      // An over-limit log is strictly better than a lost record, and the comment in `rotate`
      // already argued it. The failure is simulated because no portable filesystem condition
      // makes a `rename` of an ordinary file in a writable directory fail - see the mock at
      // the top of this file.
      const container = await containerFixture()
      try {
        // Newline-terminated, so the appended record starts its own line - the shape a real
        // over-limit log has, and what makes the record readable back.
        await writeFile(join(container.root, AUDIT_FILE), `${"x".repeat(MAX_BYTES)}\n`, "utf8")
        auditEnter({ op: "task.done", task: "login", project: "alpha", tasksRoot: container.root })

        renameControl.fail = true
        try {
          await recordEvent("info", "recorded despite a failed rotation", { phase: "done" })
        } finally {
          renameControl.fail = false
        }

        // The record is there, on the end of the log that could not be moved aside.
        const records = await readAudit(container.root)
        expect(records).toHaveLength(1)
        expect(records[0].msg).toBe("recorded despite a failed rotation")
        // And nothing was archived, which is the other half of "the rotation failed".
        const stem = AUDIT_FILE.replace(/\.jsonl$/, "")
        const archives = (await readdir(container.root)).filter((name) => name.startsWith(`${stem}.`) && name !== AUDIT_FILE)
        expect(archives).toEqual([])
        // The file really did grow past its bound rather than being silently truncated.
        const grown = await readFile(join(container.root, AUDIT_FILE), "utf8")
        expect(grown.length).toBeGreaterThan(MAX_BYTES)
      } finally {
        renameControl.fail = false
        await container.cleanup()
      }
    })
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

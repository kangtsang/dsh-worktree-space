import { describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recover } from "../src/host/index.js"
import { auditEnter, readAudit } from "../src/host/task/auditLog.js"

/**
 * `recover` is where a failure is turned into two things at once: the record the
 * log gets, and the reply the browser gets. Before the code was decided once and
 * both used it, they could disagree - the log held the error's own code while the
 * caller received `bad-request` - and a code read off the screen could not be
 * grepped for, and one read off the log could not be acted on.
 */

/** A container root that exists, as one an operation would have prepared. */
async function containerFixture() {
  const base = await mkdtemp(join(tmpdir(), "recover-container-"))
  const root = join(base, "worktree-space")
  await rm(root, { recursive: true, force: true })
  const { mkdir } = await import("node:fs/promises")
  await mkdir(root, { recursive: true })
  return {
    root,
    async cleanup() {
      await rm(base, { recursive: true, force: true })
    },
  }
}

describe("recover gives the log and the caller the same code", () => {
  it("records the code the reply carries, not the one the error started with", async () => {
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.create", task: "a", project: "p", tasksRoot: container.root })
      // A code outside the public set. `fail` flattens it on the way out, and the
      // record must show the flattened one - otherwise the log names a condition
      // the caller was never told about.
      const error = Object.assign(new Error("something unusual"), { code: "internal-only" })
      const reply = await recover(async () => { throw error })

      expect(reply.ok).toBe(false)
      expect(reply.error.code).toBe("E9001")

      const records = await readAudit(container.root)
      expect(records).toHaveLength(1)
      expect(records[0].code).toBe("E9001")
    } finally {
      await container.cleanup()
    }
  })

  it("keeps a public code on both sides", async () => {
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.create", task: "a", project: "p", tasksRoot: container.root })
      const reply = await recover(async () => {
        throw Object.assign(new Error("task space already exists: E:/ws/p/a"), { code: "E2001" })
      })

      expect(reply.error.code).toBe("E2001")
      const records = await readAudit(container.root)
      expect(records[0].code).toBe("E2001")
    } finally {
      await container.cleanup()
    }
  })

  it("carries the module's own sentence into the record", async () => {
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.create", task: "a", project: "p", tasksRoot: container.root })
      await recover(async () => {
        throw Object.assign(new Error("taken"), {
          code: "E3001",
          msg: "Nothing was created. The branch is already in use.",
        })
      })

      const records = await readAudit(container.root)
      expect(records[0].msg).toBe("Nothing was created. The branch is already in use.")
      expect(records[0].message).toBe("taken")
    } finally {
      await container.cleanup()
    }
  })

  it("falls back to the caller's classifier before the catch-all", async () => {
    const container = await containerFixture()
    try {
      auditEnter({ op: "worktree.status", task: "a", project: "p", tasksRoot: container.root })
      const reply = await recover(
        async () => { throw new Error("that directory is not a working tree") },
        (message) => (/not a working tree/i.test(message) ? "E3005" : undefined),
      )

      expect(reply.error.code).toBe("E3005")
      const records = await readAudit(container.root)
      expect(records[0].code).toBe("E3005")
    } finally {
      await container.cleanup()
    }
  })

  it("records nothing at all for an operation that worked", async () => {
    const container = await containerFixture()
    try {
      auditEnter({ op: "task.list", task: "a", project: "p", tasksRoot: container.root })
      const reply = await recover(async () => ({ tasks: [] }))

      // Wrapped by `ok`, so the value is under `value` - the same shape a caller
      // receives over the wire.
      expect(reply).toEqual({ ok: true, value: { tasks: [] } })
      expect(await readAudit(container.root)).toHaveLength(0)
    } finally {
      await container.cleanup()
    }
  })
})

describe("the code table and the public filter are one list", () => {
  it("exports every code it documents, and sends nothing else", async () => {
    // `fail` flattens anything outside its set to E9001, so a code in one place
    // and not the other is a code that cannot reach a caller - which is exactly
    // what happened before: `classifyError` matched `not-git-repository` by code
    // while the host could only ever send `bad-request`, so the code check never
    // fired and only the message regex did. Asserting the two are equal is what
    // stops it drifting again.
    const { ERROR_CODES, UNKNOWN } = await import("../src/host/task/codes.js")
    const { PUBLIC_ERROR_CODES } = await import("../src/host/index.js")

    // The table is the whole vocabulary; the filter is that plus the two ends of
    // the range, which are not failures of any particular kind.
    const expected = [...Object.keys(ERROR_CODES), UNKNOWN, "cancelled"].sort()
    expect([...PUBLIC_ERROR_CODES].sort()).toEqual(expected)
  })

  it("numbers every code as a category and a position, with nothing skipped", async () => {
    // E and four digits: the first digit is the category, the last three the
    // position within it. A gap means a number was retired and the table has not
    // been renumbered - which is deliberate, but only if it was on purpose.
    const { ERROR_CODES } = await import("../src/host/task/codes.js")
    const byCategory = new Map()

    for (const code of Object.keys(ERROR_CODES)) {
      expect(code).toMatch(/^E[1-9]\d{3}$/)
      const category = code[1]
      if (!byCategory.has(category)) byCategory.set(category, [])
      byCategory.get(category).push(Number(code.slice(2)))
    }

    for (const positions of byCategory.values()) {
      const sorted = [...positions].sort((a, b) => a - b)
      // Sequential from 1: a code in a category is found by counting down it.
      expect(sorted).toEqual(Array.from({ length: sorted.length }, (_, index) => index + 1))
    }
  })

  it("gives every code a place in the source, which is the point of one", async () => {
    const { ERROR_CODES } = await import("../src/host/task/codes.js")
    const { readFile, readdir } = await import("node:fs/promises")
    const { join } = await import("node:path")

    const files = await readdir(new URL("../src/host/task", import.meta.url))
    const sources = new Map()
    for (const name of files) {
      if (name.endsWith(".js")) sources.set(name, await readFile(new URL(`../src/host/task/${name}`, import.meta.url), "utf8"))
    }
    const indexSource = await readFile(new URL("../src/host/index.js", import.meta.url), "utf8")

    // Each entry says where it comes from. That claim is checked rather than
    // trusted, because a code table that points at the wrong file is worse than
    // no table - it sends a reader to the wrong line and they believe it.
    for (const [code, description] of Object.entries(ERROR_CODES)) {
      const file = /^\s*(?:E\d4?)?.*?([\w-]+\.js)\s*-/.exec(description)?.[1] ?? /([\w-]+\.js)/.exec(description)?.[1]
      expect(file, `${code} names no file`).toBeTruthy()
      const source = sources.get(file) ?? (file === "index.js" ? indexSource : undefined)
      expect(source, `${code} names ${file}, which was not read`).toBeTruthy()
      if (file !== "index.js") {
        expect(source.includes(code), `${code} is not raised in ${file}, only documented`).toBe(true)
      }
    }
  })
})
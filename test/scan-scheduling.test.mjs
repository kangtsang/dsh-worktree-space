import { afterEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { apply, SCAN_CONCURRENCY } from "../src/host/index.js"
import { setAuditEnabled } from "../src/host/task/audit-log.js"

afterEach(() => setAuditEnabled(true))

/** A root holding `count` repositories, each a real `.git` directory. */
async function rootWith(count) {
  const root = await mkdtemp(join(tmpdir(), "dsh-scan-concurrency-"))
  for (let index = 0; index < count; index++) {
    await mkdir(join(root, `repo-${String(index).padStart(2, "0")}`, ".git"), { recursive: true })
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/**
 * The scan driven through its real route, with a subprocess that is genuinely
 * slow.
 *
 * The point of the test is the scheduling, and a subprocess double that answers
 * in the same tick hides it: every call would be finished before the next was
 * asked for, and a serial loop and a parallel one would look identical. So every
 * call takes real time, and the double counts what is in flight while it does.
 */
function slowHandler(porcelain) {
  const routes = new Map()
  const counters = { calls: [], peak: 0, active: 0 }
  const subprocess = {
    spawn({ argv, cwd }) {
      const key = argv.slice(3).join(" ")
      counters.calls.push({ key, cwd })
      counters.active++
      counters.peak = Math.max(counters.peak, counters.active)
      let stdout = ""
      if (key === "worktree list --porcelain") stdout = porcelain(cwd)
      else if (key === "rev-parse --show-toplevel") stdout = cwd
      else if (key === "rev-parse --git-common-dir") stdout = ".git"
      return {
        done: new Promise((resolve) => setTimeout(() => {
          counters.active--
          resolve({ exitCode: 0, signal: null })
        }, 5)),
        collected: {
          stdout: { readFrom: () => ({ text: stdout }) },
          stderr: { readFrom: () => ({ text: "" }) },
        },
      }
    },
  }
  apply({
    subprocess,
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } },
    effect(effect) { return effect() },
  }, undefined)
  const handler = async (endpoint, payload = {}) => {
    const route = routes.get(`/api/dsh-worktree-space/${endpoint}`)
    expect(route, `missing route: ${endpoint}`).toBeDefined()
    const response = await route.fetch(new Request(`http://localhost/api/dsh-worktree-space/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "test", method: `dsh-worktree-space/${endpoint}`, payload }),
    }))
    const message = await response.json()
    expect(message.result.ok, JSON.stringify(message)).toBe(true)
    return message.result.value
  }
  return { handler, counters }
}

/** `git worktree list --porcelain`, naming the checkout the call was made in. */
const porcelainFor = (cwd) => `worktree ${cwd}\nHEAD abc123\nbranch refs/heads/develop\n`

describe("worktree.scan scheduling", () => {
  it("asks about several repositories at once, and no more than it says it will", async () => {
    const fixture = await rootWith(12)
    try {
      const { handler, counters } = slowHandler(porcelainFor)
      const { lists: scanned } = await handler("worktree.scan", { paths: [fixture.root] })
      expect(scanned, "every repository the walk found").toHaveLength(12)

      // More than one in flight is the whole change: this loop used to wait for
      // each repository before asking the next, and with five git processes per
      // repository that wait was the entire refresh.
      expect(counters.peak).toBeGreaterThan(1)
      // And a ceiling, so "ask more at once" did not become "ask for all at
      // once".
      expect(counters.peak).toBeLessThanOrEqual(SCAN_CONCURRENCY)

      // Every repository, once. The scheduling changed; the work did not.
      const listed = counters.calls.filter((call) => call.key === "worktree list --porcelain")
      expect(listed).toHaveLength(12)
      expect(new Set(listed.map((call) => call.cwd)).size).toBe(12)
      // One process each, and the count is the assertion. This was five, and on
      // Windows nearly all of a git call is process creation rather than git work,
      // so this line is what took a ninety-four repository scan from about 3.9
      // seconds to about 0.9. Every command added back here costs every
      // repository on every refresh of every Workspace - which is why the test
      // counts all of them rather than only the ones it happens to expect.
      expect(counters.calls).toHaveLength(12)
    } finally {
      await fixture.cleanup()
    }
  })

  it("returns the repositories in a stable order, not the one the disk answered in", async () => {
    const fixture = await rootWith(9)
    try {
      const { handler } = slowHandler(porcelainFor)
      const { lists: first } = await handler("worktree.scan", { paths: [fixture.root] })
      const { lists: second } = await handler("worktree.scan", { paths: [fixture.root] })
      // The walk fills its list from inside a Promise.all, so the order it produces
      // depends on which directory read returned first. That is not something a
      // reader should ever see twice: a panel that reshuffles its rows on refresh
      // looks like the repositories are moving, which is the one thing this plugin
      // exists to stop happening.
      expect(first.map((entry) => entry.repoPath)).toEqual(second.map((entry) => entry.repoPath))
      expect(first.map((entry) => entry.repoPath)).toEqual(
        Array.from({ length: 9 }, (_, index) => join(fixture.root, `repo-${String(index).padStart(2, "0")}`)),
      )
    } finally {
      await fixture.cleanup()
    }
  })

  it("walks a path named with and without its trailing separator once", async () => {
    const fixture = await rootWith(2)
    try {
      const { handler, counters } = slowHandler(porcelainFor)
      const { lists: scanned } = await handler("worktree.scan", {
        paths: [fixture.root, `${fixture.root}${process.platform === "win32" ? "\\" : "/"}`, fixture.root],
      })
      // One directory, one answer: the dedup is by identity, so two spellings of
      // the same path are not walked twice and do not collide on the way out.
      expect(scanned).toHaveLength(2)
      expect(counters.calls.filter((call) => call.key === "worktree list --porcelain")).toHaveLength(2)
    } finally {
      await fixture.cleanup()
    }
  })
})

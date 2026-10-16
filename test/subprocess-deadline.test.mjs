/**
 * Every subprocess this plugin starts runs under a deadline.
 *
 * The defect these tests exist for is not that a parameter was missing: `runProcess`
 * implemented `timeoutMs` from the start, and no caller ever passed it. So the tests
 * here are about the wiring as much as about the mechanism - a deadline that is
 * implemented and never handed over is the same as no deadline at all, and that is
 * exactly the state this was in.
 *
 * The doubles are faithful to the seam in the one way that matters: the real subprocess
 * service reacts to the abort it is handed by stopping the process tree, which settles
 * `done`. A mock that ignored the signal would hang the test rather than exercise the
 * deadline, so each one below settles when its signal aborts.
 *
 * A rejected call is captured through `.then(onFulfilled, onRejected)` rather than by
 * handing the pending promise to `expect(...).rejects` and advancing the clock before
 * awaiting it. The second shape leaves the rejection unobserved for a tick, and Vitest
 * reports that as an unhandled rejection - noise that would hide a real one.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { GIT_TIMEOUT_MS, runGit } from "../src/host/task/git.js"
import { deployEnvironment, deploymentStatus, destroyDeployment, smokeEnvironment } from "../src/host/task/deploy.js"
import { PLUGIN_ROOT, taskMetadata, writeTaskMetadata } from "../src/host/task/shared.js"

afterEach(() => vi.useRealTimers())

/**
 * Fake only the clock the deadlines are built from.
 *
 * `setTimeout` is what a deadline is, so it has to be faked for a ten-minute one to be
 * testable at all. `setImmediate` deliberately is not: the deploy path reads the
 * filesystem before it spawns anything, and those reads are real I/O that a fully
 * faked clock cannot drive - so a test that advanced the clock first would advance it
 * before the spawn existed and then wait forever on a deadline that was never armed.
 * Leaving `setImmediate` real keeps the I/O that runs underneath the faked clock real.
 */
const fakeDeadlineClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })

/**
 * A subprocess double that hangs unless it is told to answer.
 *
 * The default is a call that never finishes on its own and settles only when the abort
 * it was handed fires - which is what the real seam does when a deadline stops it.
 * `answers` names the calls that should instead come back immediately, so a test whose
 * subject is one hanging command can still let the ordinary reads around it finish.
 * @param options - `stdout` for a call that answers, and `answers` to pick which do.
 * @returns the service and the spawn options each call was given.
 */
function hangingSubprocess({ stdout = "", answers = () => false } = {}) {
  const spawns = []
  // A test waits on these rather than on a number of event-loop turns, so the wait
  // lasts as long as this machine needs instead of as long as a fast one needed.
  const waiting = new Set()
  const subprocess = {
    spawn(options) {
      spawns.push(options)
      for (const waiter of [...waiting]) waiter(options)
      let settle
      const done = new Promise((resolve) => { settle = resolve })
      const stop = () => settle({ exitCode: null, signal: "SIGTERM" })
      if (answers(options.argv)) {
        // An ordinary answer, delivered on the next tick rather than synchronously: the
        // real seam never settles a call in the same turn it was spawned, and a caller
        // that leaned on that would be leaning on the mock.
        setImmediate(() => settle({ exitCode: 0, signal: null }))
      } else if (options.signal === undefined) {
        // No deadline and no caller signal: nothing can stop it. Settled on the next
        // tick anyway, so a test that expects a hang fails on its own assertion rather
        // than on the runner's timeout.
        setImmediate(() => settle({ exitCode: 0, signal: null }))
      } else if (options.signal.aborted) {
        stop()
      } else {
        options.signal.addEventListener("abort", stop, { once: true })
      }
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: answers(options.argv) ? stdout : "" }) },
          stderr: { readFrom: () => ({ text: "" }) },
        },
      }
    },
  }
  /**
   * Wait until a call matching `matches` has been spawned.
   *
   * Bounded by the clock rather than by a count of turns. The path up to a spawn runs
   * real filesystem I/O, so a fixed number of yields is a claim about how fast the
   * machine answers it: under a loaded runner the yields run out before the read has
   * been answered, and a test that is merely slow fails saying the spawn never
   * happened. `delay` comes from `node:timers/promises`, which the fake clock above
   * does not replace, so it is a real pause.
   * @param matches - which spawn to wait for.
   * @param what - named in the failure, so a broken precondition says which one.
   */
  async function waitForSpawn(matches, what, budgetMs = 10_000) {
    const already = spawns.find(matches)
    if (already !== undefined) return already
    let waiter
    const matched = new Promise((resolve) => {
      waiter = (options) => {
        if (matches(options)) {
          waiting.delete(waiter)
          resolve(options)
        }
      }
      waiting.add(waiter)
    })
    try {
      return await Promise.race([
        matched,
        delay(budgetMs).then(() => { throw new Error(`waited for ${what} and it never happened`) }),
      ])
    } finally {
      waiting.delete(waiter)
    }
  }
  return { subprocess, spawns, waitForSpawn }
}

/**
 * Await a call that is expected to fail, without leaving the rejection unobserved.
 * @param promise - the call under test.
 * @returns whether it failed, and the error it failed with.
 */
async function outcomeOf(promise) {
  try {
    return { ok: true, value: await promise }
  } catch (error) {
    return { ok: false, error }
  }
}

/** A task space carrying a record and a deploy entry, as the deploy side reads it. */
async function deployableTaskSpace(entry = `${PLUGIN_ROOT}/deploy/deploy.sh`) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-deadline-"))
  const script = join(dir, ...entry.split("/"))
  await mkdir(join(script, ".."), { recursive: true })
  await writeFile(script, "echo entry\n", "utf8")
  await writeTaskMetadata(dir, taskMetadata({
    task: "login", project: "public", tasksRoot: join(dir, ".."), sourceRoot: "/repo",
    branch: "task/login", delivery: { deploy: { target: "docker" } },
  }))
  return dir
}

describe("runGit's deadline", () => {
  it("stops a git command that never settles, and names the command and the deadline", async () => {
    // A hung `rev-parse` - a network drive, or any command waiting on an `index.lock`
    // another process holds - used to hang the HTTP handler that awaited it, with no
    // way out for the panel. The deadline is what turns that into an answer.
    fakeDeadlineClock()
    const { subprocess, spawns, waitForSpawn } = hangingSubprocess()
    const call = outcomeOf(runGit(subprocess, "E:/repo", ["rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 50 }))
    await waitForSpawn(() => true, "the git call to spawn")
    await vi.advanceTimersByTimeAsync(50)
    const { ok, error } = await call
    expect(ok).toBe(false)
    // The sentence says which command ran out of time, because "something timed out"
    // is not actionable and the argv is the only part of a reader can act on.
    expect(error.message).toMatch(/git rev-parse --abbrev-ref HEAD exceeded its deadline of 50ms/)
    // And it is a git failure, not a new code: a caller retries or gives up the same
    // way it would for any other failed git command.
    expect(error.code).toBe("E3003")
    // The code leads the sentence, because this message is all a tool failure carries to
    // the model - see `coded` in codes.js.
    expect(error.message).toMatch(/^E3003: /)
    // The working directory is not appended. It was, and it is an absolute path for a
    // failure whose caller already knows which task and repository it asked about; the
    // argv above is what makes the sentence actionable.
    expect(error.message).not.toContain("E:/repo")
    expect(spawns.every((options) => options.signal !== undefined)).toBe(true)
  })

  it("carries a default deadline, so a caller that names none is still bounded", async () => {
    // The whole point of a default: `runGit` has many call sites, and the ones that
    // never think about deadlines are exactly the ones that need one.
    expect(GIT_TIMEOUT_MS).toBe(30_000)
    fakeDeadlineClock()
    const { subprocess, spawns, waitForSpawn } = hangingSubprocess()
    const call = outcomeOf(runGit(subprocess, "E:/repo", ["rev-parse", "HEAD"]))
    await waitForSpawn(() => true, "the git call to spawn")
    await vi.advanceTimersByTimeAsync(GIT_TIMEOUT_MS)
    const { ok, error } = await call
    expect(ok).toBe(false)
    expect(error.message).toMatch(/exceeded its deadline of 30000ms/)
    expect(spawns[0].signal).toBeDefined()
  })

  it("stops the command when the caller's own signal aborts", async () => {
    // Closing the panel cancels work in flight rather than only the work that had not
    // started: without this the git process outlives the request that asked for it.
    const { subprocess } = hangingSubprocess()
    const controller = new AbortController()
    const call = outcomeOf(runGit(subprocess, "E:/repo", ["status"], { signal: controller.signal }))
    controller.abort()
    const { ok, error } = await call
    expect(ok).toBe(false)
    // A caller's cancellation is not this side's deadline, so it reports as the signal
    // that stopped it rather than as a timeout.
    expect(error.message).toMatch(/\(SIGTERM\)/)
    expect(error.message).not.toMatch(/exceeded its deadline/)
  })

  it("returns the output of a command that answers in time", async () => {
    // The negative control: the deadline must not turn an ordinary call into a failure.
    const { subprocess } = hangingSubprocess({ stdout: "  task/login \n", answers: () => true })
    await expect(runGit(subprocess, "E:/repo", ["rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 5000 }))
      .resolves.toBe("task/login")
  })
})

describe("the hardening every git call carries", () => {
  it("passes the hardening settings before -C, and a minimal environment", async () => {
    const { subprocess, spawns } = hangingSubprocess({ stdout: "ok\n", answers: () => true })
    await runGit(subprocess, "E:/repo", ["status", "--porcelain"], { timeoutMs: 5000 })

    const { argv, env } = spawns[0]
    // The settings have to come BEFORE `-C`: `-c` is applied in the order it is written,
    // and `-C` changes the repository the rest of the command line is read against.
    expect(argv.slice(0, 2)).toEqual(["git", "-c"])
    expect(argv.indexOf("-C")).toBeGreaterThan(argv.lastIndexOf("-c"))
    // Read by name rather than by position, so a setting can be added without this
    // test silently asserting about the wrong pair.
    const settings = new Map()
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] !== "-c") continue
      const [key, ...rest] = argv[index + 1].split("=")
      settings.set(key, rest.join("="))
      index += 1
    }
    expect(settings.get("core.fsmonitor")).toBe("false")
    expect(settings.get("protocol.file.allow")).toBe("never")
    expect(settings.get("protocol.ext.allow")).toBe("never")
    // Hooks are switched off by pointing them at a path that does not exist. The value
    // is asserted to be an absent path rather than a fixed string, because the exact
    // spelling is a platform detail and the property that matters is that git finds no
    // hook there.
    const hooks = settings.get("core.hooksPath")
    expect(hooks).toBeTruthy()
    expect(existsSync(hooks)).toBe(false)
    // `LC_ALL=C` is what keeps `gitFailureCode`'s English matching working under another
    // locale - without it a user's own git would answer in their language and every
    // failure would flatten to E3003.
    expect(env).toMatchObject({ LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" })
  })

  it("still reports the code git's own words select, under the hardened environment", async () => {
    // The control for the settings above: hardening must not change what a failure means.
    const subprocess = {
      spawn: () => ({
        done: Promise.resolve({ exitCode: 128, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: "" }) },
          stderr: { readFrom: () => ({ text: "fatal: not a git repository (or any of the parent directories): .git\n" }) },
        },
      }),
    }
    const { ok, error } = await outcomeOf(runGit(subprocess, "E:/repo", ["status"], { timeoutMs: 5000 }))

    expect(ok).toBe(false)
    expect(error.code).toBe("E3004")
  })
})

describe("the deadlines the deploy side hands to runProcess", () => {
  it("stops an `up` that does not finish, and says it did not finish", async () => {
    // A rebuild that never returns is the one that leaves the panel spinning with no
    // way out, and it is the slowest call here - so it gets the longest deadline and
    // still a deadline. It is reported apart from a non-zero exit: the script did not
    // fail, it did not finish, and what it left behind is unknown.
    fakeDeadlineClock()
    const dir = await deployableTaskSpace()
    try {
      const { subprocess, spawns, waitForSpawn } = hangingSubprocess()
      const call = outcomeOf(deployEnvironment(subprocess, dir))
      // The record and the script are read from disk before anything spawns, and that
      // read is real I/O: wait for the spawn, then advance the deadline it armed.
      await waitForSpawn(() => true, "the `up` script to spawn")
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
      const { ok, error } = await call
      expect(ok).toBe(false)
      expect(error.code).toBe("E5008")
      expect(error.message).toMatch(/did not finish within 10 minutes/)
      // A deadline really was handed over, which is the half that was missing.
      expect(spawns[0].signal).toBeDefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("reports a smoke that ran out of time as timed out, and never as ok", async () => {
    // A stopped smoke has no exit code to read. Folding it into `ok: false` alone
    // would let the card paint the red badge over this side's own timeout, which
    // reads as a verdict on the environment rather than on the deadline.
    fakeDeadlineClock()
    const dir = await deployableTaskSpace()
    try {
      // The smoke script hangs; the docker status read that follows it answers, so the
      // test is about the script's deadline rather than about a second one behind it.
      const { subprocess, spawns, waitForSpawn } = hangingSubprocess({ answers: (argv) => argv[0] === "docker" })
      const call = smokeEnvironment(subprocess, dir)
      await waitForSpawn((options) => options.argv[0] === "bash", "the `smoke` script to spawn")
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
      const outcome = await call
      expect(outcome.timedOut).toBe(true)
      expect(outcome.exitCode).toBeNull()
      // The status read that follows still answers, so the card has something to show.
      expect(outcome.status).toBeDefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("carries a deadline on every docker query, not only on the scripts", async () => {
    // The queries are the ones the panel runs on every refresh, so an unresponsive
    // daemon used to hang each repaint. Asserted on the spawn options rather than on
    // the constant: what the defect was, and what this protects, is that a call site
    // actually handed the deadline over.
    fakeDeadlineClock()
    const dir = await deployableTaskSpace()
    try {
      const { subprocess, spawns, waitForSpawn } = hangingSubprocess()
      const call = deploymentStatus(subprocess, dir)
      await waitForSpawn(() => true, "the docker query to spawn")
      // The query deadline is 15s; the containers it finds are none, because a stopped
      // query reports absence. Nothing here needs a caller signal to be bounded.
      await vi.advanceTimersByTimeAsync(15_000)
      const status = await call
      expect(status.containers).toEqual([])
      expect(spawns.length).toBeGreaterThan(0)
      expect(spawns.every((options) => options.signal !== undefined)).toBe(true)
      // Every one of them was a docker call: nothing else runs here.
      expect(spawns.every((options) => options.argv[0] === "docker")).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("carries a deadline on the teardown's docker calls too", async () => {
    // Teardown is the other place an unresponsive daemon strands a request, and it is
    // the one the user reaches for when they want the machine back - so a hang here is
    // the most annoying place for one.
    fakeDeadlineClock()
    const dir = await deployableTaskSpace()
    try {
      // The first query finds a container, so teardown goes on to inspect and remove it;
      // everything after that answers empty, which is what an emptied environment says.
      let queries = 0
      const { subprocess, spawns, waitForSpawn } = hangingSubprocess({
        answers: (argv) => {
          if (argv[0] !== "docker") return true
          queries += 1
          return queries > 1
        },
      })
      const call = destroyDeployment(subprocess, dir, "dsh-public-login")
      await waitForSpawn(() => true, "the first docker query to spawn")
      // Long enough for every query this teardown makes to hit its own deadline, so no
      // call is left hanging when the assertions run.
      await vi.advanceTimersByTimeAsync(60_000)
      await call
      expect(spawns.every((options) => options.signal !== undefined)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

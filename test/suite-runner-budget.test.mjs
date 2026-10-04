import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { stopTree } from "../scripts/test/run-tests.mjs"

/**
 * The budget has to stop the process tree, not just the one process it can see.
 *
 * `run-tests.mjs` exists for one reason: a suite that overruns gets stopped
 * instead of being waited on. It used to stop it with `child.kill("SIGTERM")`
 * under a comment claiming the kill was "scoped to this one process tree". On
 * Windows a signal is `TerminateProcess` on a single handle, vitest's workers are
 * separate `node --conditions node` processes, and the comment was the opposite
 * of the truth on the one platform where the runaway happens: the vitest parent
 * died and four jsdom-carrying workers kept burning CPU and memory with nothing
 * left to reap them.
 *
 * These tests drive the real timeout path with a fixture that hangs the way a
 * runaway does, and read what the runner says about the processes it stopped.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const RUNNER = join(ROOT, "scripts", "test", "run-tests.mjs")

/**
 * The whole file is Windows-only, and not because the assertions are fragile.
 *
 * The behaviour under test is the Windows branch: `taskkill /PID /T /F` and the
 * verification that follows it. On POSIX the runner still signals one pid, which
 * is the documented limit rather than a bug - a worker is not in the target's
 * process group, so it is out of reach of a signal either way. Asserting a tree
 * kill there would be asserting something the runner deliberately does not do.
 */
const WINDOWS = process.platform === "win32"

/**
 * Short enough to keep the file inside the suite's own budget, long enough that
 * the fixture has certainly forked its worker before the clock runs out.
 */
const BUDGET_MS = 1500

/**
 * A stand-in for vitest: fork one worker exactly the way the real pool does,
 * then hang forever.
 *
 * The pid file is how the test gets hold of that tree from outside. Without it
 * the test could only assert on prose, and prose is what was wrong before.
 */
const HANGING_FIXTURE = `
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"

const worker = spawn(process.execPath, ["--conditions", "node", "-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
writeFileSync(process.env.DSH_TEST_PID_FILE, JSON.stringify({ project: process.pid, worker: worker.pid }))
setInterval(() => {}, 1000)
`

/** Is this pid still running? The same oracle the runner checks its own kill with. */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== "ESRCH"
  }
}

/** Wait for a pid to go away, so a slow termination is not read as a leak. */
async function goneWithin(pid, ms) {
  const deadline = Date.now() + ms
  while (alive(pid) && Date.now() < deadline) {
    await new Promise((wait) => setTimeout(wait, 100))
  }
  return !alive(pid)
}

/**
 * Run the runner to completion, with a ceiling of its own.
 *
 * The ceiling uses the runner's own stop rather than a bare `kill`, because a
 * failure here means a process tree is still hanging around - exactly the thing
 * the file under test is about - and a failed test must not be the reason one is
 * left behind.
 */
function runRunner(args, env) {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [RUNNER, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })

    const ceiling = setTimeout(() => {
      stopTree(child)
      settle({ code: null, stdout, stderr, timedOutByTest: true })
    }, 15_000)

    child.on("close", (code) => {
      clearTimeout(ceiling)
      settle({ code, stdout, stderr, timedOutByTest: false })
    })
  })
}

describe.skipIf(!WINDOWS)("the suite runner's budget", () => {
  let workdir = null
  let run = null
  let pids = null

  beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), "dsh-suite-runner-"))
    const pidFile = join(workdir, "pids.json")
    await writeFile(join(workdir, "hanging-vitest.mjs"), HANGING_FIXTURE, "utf8")

    run = await runRunner(["unit"], {
      DSH_TEST_VITEST: join(workdir, "hanging-vitest.mjs"),
      DSH_TEST_BUDGET_MS: String(BUDGET_MS),
      DSH_TEST_PID_FILE: pidFile,
    })
    pids = JSON.parse(await readFile(pidFile, "utf8"))
  }, 30_000)

  afterAll(async () => {
    if (workdir) await rm(workdir, { recursive: true, force: true })
  })

  it("fails the run and names the project that overran", () => {
    expect(run.timedOutByTest).toBe(false)
    expect(run.code).toBe(1)
    expect(run.stdout).toContain(`OVER BUDGET: exceeded ${BUDGET_MS / 1000}s and was stopped.`)
  })

  it("stops the workers, not only the vitest process", () => {
    // The evidence that the kill was a TREE kill. `taskkill /T` reports one
    // process per line and names the parent it reached it through; a
    // single-process kill has one process and no parent to name. Asserting the
    // worker's own pid is in that report is what makes this fail against the old
    // `child.kill("SIGTERM")`, which never mentioned a worker at all.
    //
    // Matched on pids rather than on wording on purpose: taskkill writes in the
    // console codepage, and this machine's Windows is localized - it answers
    // `成功: 已终止 PID 22436 (属于 PID 42872 的进程) 的进程。`, where an English
    // assertion would have passed on the reviewer's machine and failed here.
    expect(run.stdout).toContain("taskkill /T /F")
    expect(run.stdout).toContain(String(pids.worker))
    expect(run.stdout).toContain(String(pids.project))
  })

  it("leaves nothing from the stopped project running", async () => {
    // Both pids, not just the one the runner held a handle on: the fork is the
    // leak, and checking only the parent would pass while four workers lived on.
    expect(await goneWithin(pids.project, 5000)).toBe(true)
    expect(await goneWithin(pids.worker, 5000)).toBe(true)
  })

  it("does not claim a stop it could not confirm", () => {
    // The runner now checks its own kill. Saying "was stopped" about a tree it
    // never verified is the claim that was wrong in the first place, so the
    // failure line has to exist for this test to mean anything - and it must be
    // absent here, where the kill worked.
    expect(run.stdout).not.toContain("KILL FAILED")
  })
})

describe.skipIf(!WINDOWS)("stopTree", () => {
  it("reads a tree that had already gone as stopped, not as a failure", async () => {
    // `taskkill` exits 128 with `ERROR: The process "..." not found.` for a pid
    // that exited on its own a moment earlier. That is a race, not a failure, and
    // it arrives on the timeout path routinely - vitest finishing as the budget
    // trips is the ordinary case, not the exotic one. Treating it as a failed
    // kill is how a checked kill becomes an unchecked one.
    const exited = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" })
    await new Promise((settle) => exited.on("close", settle))
    expect(alive(exited.pid)).toBe(false)

    const result = await stopTree({
      pid: exited.pid,
      // A Windows stop must not reach for a signal at all. If this ever runs, the
      // tree kill has been replaced by the thing it replaced, and a test that
      // hangs is a slower way of finding out than this.
      kill: () => {
        throw new Error("the Windows branch must not send a signal")
      },
    })

    expect(result.verified).toBe(true)
    expect(result.survivors).toEqual([])
    expect(result.stopped).toEqual([])
  })
})

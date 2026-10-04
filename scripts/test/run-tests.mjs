// Runs every test project at once and reports one answer for all of them.
//
//   node scripts/test/run-tests.mjs          both projects, concurrently
//   node scripts/test/run-tests.mjs unit     one project, same budget
//   node scripts/test/run-tests.mjs git
//
// Why this exists: the suite used to be one `vitest run` with whatever worker count
// the machine had. On twenty logical CPUs that is twenty forks, each `.tsx` file
// bringing a jsdom with it, which exhausted RAM - the collector thrashed, the run
// crawled for sixteen minutes and then died of `JavaScript heap out of memory`. A
// run that dies never prints its summary, so what came back was a wall-clock time
// and no reason. Measured over all: forty-four seconds of actual test work.
//
// Two things are wrong with "run it all and wait", and this fixes both:
//
//   - One long wait with nothing to read. Each project here has its own budget and
//     is reported the moment it settles, so the answer arrives in the order the
//     work finished rather than after the slowest thing on the machine.
//   - A run that takes sixteen minutes does not say which part took sixteen
//     minutes. Overrunning the budget is reported by name, so a test that grows
//     expensive is named on the run that first goes over rather than discovered
//     later by somebody assuming the suite is just slow.
//
// The projects run concurrently, because a full run should cost the slowest part
// and not the sum of them. The slow one is the real-git project, at about twenty
// seconds, and that number is the floor for any full run.
//
// A budget is only worth having if stopping the project actually works, so the
// timeout path is the part that gets the most care - see `stopTree`.
//
// Plain JavaScript on purpose: this is run by `node` directly, before anything is
// built, and a build step in front of the test step would be a bootstrap problem.
//
// Nothing runs at import time, so the timeout test can import `stopTree` without
// starting a suite from inside a suite. Two environment variables back that up:
// `DSH_TEST_VITEST` points the runner at a fixture instead of real vitest, and
// `DSH_TEST_BUDGET_MS` shortens the budget. Both are opt-in and unset in normal
// use; without them a hung process tree cannot be produced on demand, and testing
// the thing that stops a runaway by waiting out the real 60s budget is not a test
// anybody runs twice.

import { execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const execFileAsync = promisify(execFile)

const IS_WINDOWS = process.platform === "win32"
const SELF = fileURLToPath(import.meta.url)
const ROOT = join(dirname(SELF), "..", "..")

/** Every project the config declares. The names must match `vitest.config.ts`. */
const ALL = ["unit", "git"]

/**
 * Which projects this run covers.
 *
 * Named on the command line so the short entries - `test:unit:fast`,
 * `test:unit:git` - go through the same budget as the full run. They used to be a
 * bare `vitest run --project X`, which meant the one moment a developer most needs
 * a guardrail was the moment there wasn't one: a full run stops at the budget and
 * says which project overran, while a single project ran until it was killed by
 * hand. `testTimeout` does not cover that gap either - it stops a test that takes
 * too long, not a worker that has stopped answering.
 *
 * @returns {string[]} the requested projects, or all of them when none are named.
 */
function requested() {
  const named = process.argv.slice(2)
  if (named.length === 0) return ALL
  const unknown = named.filter((name) => !ALL.includes(name))
  if (unknown.length > 0) {
    console.error(`Unknown project(s): ${unknown.join(", ")}. Known: ${ALL.join(", ")}.`)
    process.exit(2)
  }
  return named
}

/**
 * How long one project may take before it is stopped and named.
 *
 * A minute is chosen so that every project fits inside it with room to spare -
 * the slowest measures about twenty seconds - which means crossing it is a real
 * signal rather than ordinary machine noise. Raising this to accommodate a slow
 * test is exactly the thing it exists to notice.
 */
const BUDGET_MS = Number(process.env.DSH_TEST_BUDGET_MS) > 0 ? Number(process.env.DSH_TEST_BUDGET_MS) : 60_000

/**
 * How long a stopped tree gets to actually be gone before the runner says it was
 * not.
 *
 * This is a ceiling rather than a wait: the poll returns the moment the last pid
 * has exited, so the ordinary case costs one check. Ten seconds is chosen so a
 * machine busy enough to overrun the budget still has room, and short enough that
 * a kill which did not work is reported long before it reads like a hang.
 */
const VERIFY_MS = 10_000

const VITEST = process.env.DSH_TEST_VITEST || join(ROOT, "node_modules", "vitest", "vitest.mjs")

/** Everything vitest prints on one line, so a summary can be lifted out of it. */
const SUMMARY = /Test Files\s+.*|Tests\s+.*|Duration\s+.*/

/**
 * Is this pid still running?
 *
 * `process.kill(pid, 0)` is the cheapest oracle available: it asks the kernel
 * for a handle and does nothing with it, and reports ESRCH for a pid that is
 * gone. It is what the kill is checked against rather than the kill's exit code,
 * because `taskkill` exits 128 with `ERROR: The process "1234" not found.` for a
 * process that had already exited on its own - a race, not a failure, and reading
 * it as one turns a checked kill back into an unchecked one.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it is alive and belongs to somebody else, which is the same
    // answer this function owes the caller. Anything else is a broken oracle and
    // is treated as "still there", so a kill is never declared done on an error.
    if (error.code === "EPERM") return true
    return error.code !== "ESRCH"
  }
}

/**
 * Which processes a `taskkill` run reports having terminated, and through whom.
 *
 * `taskkill /T` prints one line per process it reached, and that list is the only
 * record of how far the tree kill actually got - without it a tree kill and a
 * single-process kill produce exactly the same silence.
 *
 * Two things about the lines are load-bearing.
 *
 * Each one names the process it terminated and, in parentheses, the parent it
 * reached it through. Only the first is part of the tree that got stopped: the
 * parent is whoever held the handle, which for the top of the tree is this
 * runner. Verifying the parent for survival is how a working kill reports itself
 * as a failed one.
 *
 * And the wording is localized - this machine's taskkill says
 * `成功: 已终止 PID 22436 (属于 PID 42872 的进程) 的进程。` - so nothing here may
 * match on the English sentence. `PID` is spelled the same in every locale
 * taskkill ships in, and the numbers are digits. It also separates the failure
 * line, which quotes its number (`The process "44936" not found`), so the race
 * described in `alive` does not arrive here as a process that was stopped.
 *
 * @param {string} taskkillOutput
 * @returns {{pid: number, parent: number|null}[]}
 */
function terminatedTree(taskkillOutput) {
  const terminated = []
  for (const line of taskkillOutput.split(/\r?\n/)) {
    const pids = [...line.matchAll(/PID\s+(\d+)/gi)].map((match) => Number(match[1]))
    if (pids.length > 0) terminated.push({ pid: pids[0], parent: pids[1] ?? null })
  }
  return terminated
}

/**
 * Stop one project, and everything it started, then say whether it worked.
 *
 * Why this is not `child.kill()`: on Windows a signal is `TerminateProcess` on
 * one handle. Vitest's workers are separate processes - `node --conditions node`,
 * four of them - so killing the vitest parent leaves them running, re-parented to
 * nothing, each still holding a jsdom. The runner exists to stop precisely that
 * runaway, so the one leak it cannot afford is leaking there. (The comment this
 * replaces claimed the kill was "scoped to this one process tree", which was
 * true on every platform except the one where the runaway happens.)
 *
 * `taskkill /PID <pid> /T /F` is the tree kill, and the approach the acceptance
 * scripts already settled on: the managed equivalent, `Process.Kill($true)`, is a
 * .NET Core overload that does not exist on the .NET Framework Windows
 * PowerShell 5.1 runs on, so there is no way to ask for a tree from here - see
 * scripts/acceptance/README.md.
 *
 * The kill is then VERIFIED, because an unverified kill is the same silent
 * failure as a swallowed error. Every pid taskkill reported terminating is
 * polled until it is gone, and a survivor is named in the report rather than
 * left for the next person to meet on `tasklist`.
 *
 * @param {{pid?: number, kill: (signal?: string) => boolean}} child
 * @returns {Promise<{verified: boolean, stopped: {pid: number, parent: number|null}[], pids: number[], survivors: number[]}>}
 */
export async function stopTree(child) {
  const pid = child.pid
  if (!pid) return { verified: false, stopped: [], pids: [], survivors: [] }

  if (!IS_WINDOWS) {
    // SIGTERM first so vitest can tear its workers down; SIGKILL is for a child
    // that ignores it. Both address one pid, and that is the honest limit of a
    // signal: a worker is not in the target's process group, so a fork that
    // outlives its parent outlives this too. Left as it was, because a signal the
    // process can act on is worth more here than a tree kill that gives it no
    // chance to - and `verified: false` stops the report claiming otherwise.
    child.kill("SIGTERM")
    setTimeout(() => child.kill("SIGKILL"), 3000).unref()
    return { verified: false, stopped: [], pids: [pid], survivors: [] }
  }

  const output = await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
    windowsHide: true,
  })
    .then(({ stdout }) => String(stdout ?? ""))
    // A tree that is already gone is not a failure and taskkill reports it as
    // one, so its message is read here and its exit code is not.
    .catch((error) => String(error?.stdout ?? ""))

  const stopped = terminatedTree(output)
  // Only what was terminated, plus the target itself, and never this runner. The
  // message is not kept or reprinted: taskkill writes it in the console codepage,
  // which on a localized Windows is not UTF-8, so passing it through would put
  // replacement characters in the one report that has to be readable.
  const pids = [...new Set([pid, ...stopped.map((entry) => entry.pid)])].filter(
    (candidate) => candidate !== process.pid,
  )

  const deadline = Date.now() + VERIFY_MS
  let survivors = pids.filter(alive)
  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise((wait) => setTimeout(wait, 250))
    survivors = survivors.filter(alive)
  }

  return { verified: true, stopped, pids, survivors }
}

/**
 * Run one project to completion, or until it overruns its budget.
 * @param {string} name - the vitest project name.
 * @returns {Promise<{name: string, code: number|null, timedOut: boolean, elapsed: number, kill: object|null, output: string}>}
 */
function runProject(name) {
  const startedAt = Date.now()
  return new Promise((settle) => {
    const child = spawn(process.execPath, [VITEST, "run", "--project", name], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    let timedOut = false
    let settled = false
    /** Non-null once the budget has tripped; `finish` waits on it. */
    let stop = null

    const finish = async (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // The stop is part of the answer, not bookkeeping around it. Waiting here
      // is what lets the report name the processes that went down, and it is the
      // only thing standing between a kill that failed and a promise that never
      // settles.
      const kill = stop ? await stop : null
      settle({ name, code, timedOut, elapsed: Date.now() - startedAt, kill, output })
    }

    const timer = setTimeout(() => {
      timedOut = true
      stop = stopTree(child)
      // A kill that failed is still an answer. Without this line `finish` waits
      // for a `close` event that is never coming, and the runner written to stop
      // a runaway suite becomes the hang.
      stop.then((result) => {
        if (result.survivors.length > 0) finish(1)
      })
    }, BUDGET_MS)

    const collect = (chunk) => {
      output += chunk.toString()
    }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    child.on("error", (error) => {
      output += `\n${error.message}\n`
      finish(1)
    })
    child.on("close", (code) => finish(code))
  })
}

async function main() {
  if (!existsSync(VITEST)) {
    console.error("vitest is not installed. Run `pnpm install` first.")
    process.exit(1)
  }

  const projects = requested()
  const results = await Promise.all(projects.map(runProject))

  let failed = false
  console.log("\n" + "=".repeat(72))
  for (const result of results) {
    const seconds = (result.elapsed / 1000).toFixed(1)
    console.log(`\n--- ${result.name} --- ${seconds}s`)

    if (result.timedOut) {
      failed = true
      console.log(`OVER BUDGET: exceeded ${BUDGET_MS / 1000}s and was stopped.`)
      console.log("Whatever grew is in this project. The slowest cases below say how far it got.")
      // What was stopped, not only that something was. Without this the one
      // moment the budget fires reports "stopped" about a process it never
      // checked, which is the exact claim that was wrong before.
      const stopped = result.kill?.stopped ?? []
      const detail = stopped.map((entry) => (entry.parent === null ? `${entry.pid}` : `${entry.pid} under ${entry.parent}`))
      console.log(`  stopped by taskkill /T /F: ${detail.length === 0 ? "nothing left running, it had already exited" : detail.join(", ")}`)
      if (result.kill?.survivors.length > 0) {
        failed = true
        console.log(
          `KILL FAILED: pid ${result.kill.survivors.join(", ")} survived the tree kill. ` +
            "It is still running - find it with tasklist and end it by hand.",
        )
      }
    }

    // Failures first, because they are the reason to read any of this.
    for (const line of result.output.split(/\r?\n/)) {
      if (/^\s*[×✗]|FAIL|AssertionError|heap out of memory|mark-compacts/.test(line)) console.log(line)
    }
    const summary = result.output.split(/\r?\n/).filter((line) => SUMMARY.test(line.trim()))
    for (const line of summary.slice(-3)) console.log(line.trim())

    if (!result.timedOut && result.code !== 0) failed = true
  }

  // Every project's cases in one place, so "did the full run cover everything" is a
  // question with an answer rather than a sum somebody does in their head.
  const totals = results.map((result) => {
    const line = result.output.split(/\r?\n/).find((text) => /^\s*Tests\s+/.test(text.trim()))
    return { name: result.name, line: line?.trim() ?? "no summary" }
  })
  console.log("\n" + "-".repeat(72))
  for (const total of totals) console.log(`${total.name}: ${total.line}`)
  console.log("=".repeat(72))

  process.exit(failed ? 1 : 0)
}

/**
 * Whether this file was run rather than imported.
 *
 * Windows paths are compared case-insensitively because the filesystem is, and a
 * runner that silently did nothing would look exactly like a runner whose
 * `console.log` nobody can find.
 */
function invokedAsScript() {
  if (!process.argv[1]) return false
  const entry = resolve(process.argv[1])
  return IS_WINDOWS ? entry.toLowerCase() === SELF.toLowerCase() : entry === SELF
}

if (invokedAsScript()) await main()
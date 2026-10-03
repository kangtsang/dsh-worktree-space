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
// Plain JavaScript on purpose: this is run by `node` directly, before anything is
// built, and a build step in front of the test step would be a bootstrap problem.

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

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
const BUDGET_MS = 60_000

const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs")
if (!existsSync(VITEST)) {
  console.error("vitest is not installed. Run `pnpm install` first.")
  process.exit(1)
}

/** Everything vitest prints on one line, so a summary can be lifted out of it. */
const SUMMARY = /Test Files\s+.*|Tests\s+.*|Duration\s+.*/

/**
 * Run one project to completion, or until it overruns its budget.
 * @param {string} name - the vitest project name.
 * @returns {Promise<{name: string, code: number|null, timedOut: boolean, elapsed: number, output: string}>}
 */
function runProject(name) {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VITEST, "run", "--project", name], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    let timedOut = false
    let settled = false

    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ name, code, timedOut, elapsed: Date.now() - startedAt, output })
    }

    // SIGTERM first so vitest can tear its workers down; the kill is for a child
    // that ignores it. Both are scoped to this one process tree.
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      setTimeout(() => child.kill("SIGKILL"), 3000).unref()
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
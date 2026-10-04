import { defineConfig } from "vitest/config"

/**
 * Tests that drive real git against real repositories on disk.
 *
 * They are separated not because they are less important - they cover the merge
 * and worktree paths that nothing else can reach without a real repository - but
 * because they are slow in a way that has nothing to do with what is being tested.
 * `task-merge-worktree.test.mjs` builds a repository, four commits and two
 * worktrees per test with `execFileSync`, and on Windows each `git.exe` launch is
 * almost entirely process creation. Serial, and not reducible without rewriting the
 * fixture to be asynchronous.
 *
 * Separating them means the files that do not need a process can be run on their own
 * in seconds, which is the loop a change actually gets checked in, while
 * `pnpm test:unit` still runs all of it.
 *
 * Nothing here counts files, tests or seconds. Those numbers go stale on the next
 * addition, and the next person to check them finds a mismatch, spends time working
 * out whether the number is old or something broke, and only then looks at the thing
 * that actually matters. The invariants worth writing down are elsewhere: the two
 * layers do not overlap and their union is the full enumeration.
 */
const REAL_GIT = [
  "test/task-merge-worktree.test.mjs",
  "test/encoding.test.ts",
  // Not git, but it earns the same place: it forks a real node worker that hangs and
  // a real copy of the runner, so what it checks is process-tree behaviour. Same
  // reason for the layer - the assertion only means something against real processes.
  "test/suite-runner-budget.test.mjs",
]

/**
 * Worker count, and this is the whole reason the suite used to take sixteen
 * minutes and then die.
 *
 * Left at the default, vitest starts one fork per CPU - twenty on this machine -
 * and every `.tsx` file brings up a jsdom with it. Twenty of those exhausts RAM,
 * the collector thrashes instead of collecting, every file crawls, and the run
 * eventually dies of `JavaScript heap out of memory` partway through. The worst
 * part is not the slowness: a run that dies never prints its summary, so what is
 * left is a wall-clock time and no reason.
 *
 * The measurements that set the number: all forty-two files together account for
 * forty-four seconds of test time, and one of them alone accounts for twenty of
 * those. So the floor for any wall clock is that single file, and workers beyond
 * a handful only shorten work that is already short. Four fits the job in about
 * twenty-five seconds, keeps memory flat, and leaves the machine usable while it
 * runs.
 */
const WORKERS = 4

/** Settings each project needs for itself; the pool settings live on the root. */
const shared = {
  globals: true,
  environment: "node" as const,
}

export default defineConfig({
  test: {
    // These four belong at the ROOT, not inside a project, and putting them in a
    // project is the mistake that made this whole thing not work.
    //
    // Under `projects`, vitest builds the worker pool from the root config and
    // only reads `name`, `environment`, `include` and `exclude` from each project.
    // A `maxWorkers` set inside a project is read by nobody: the root has no
    // `maxWorkers`, so the pool falls back to `numCpus - 1`, which on a
    // twenty-core machine is nineteen forks - the exact arrangement that exhausted
    // RAM and turned a forty-four second suite into a sixteen minute one. It looks
    // configured, it type-checks, and it is ignored.
    //
    // The same goes for `poolOptions`, which is why the per-fork heap ceiling has
    // to be here too.
    //
    // How to tell it took: watch the fork count while a run is going. Nineteen
    // `node --conditions node` children means this was missed.
    maxWorkers: WORKERS,
    minWorkers: 1,
    // A test that hangs should say so, and say which one. The budget in
    // scripts/test/run-tests.mjs stops a whole project that overruns; this is the
    // finer grain underneath it, and the number is deliberately well under that
    // budget - a case that runs longer than this is the one that would have taken
    // the project over, so naming it here is the answer rather than a lead.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    poolOptions: { forks: { execArgv: ["--max-old-space-size=1536"] } },

    projects: [
      {
        test: {
          name: "unit",
          globals: true,
          environment: "node",
          include: ["test/**/*.{test,spec}.{ts,tsx,mts,mjs}"],
          exclude: REAL_GIT,
        },
      },
      {
        test: {
          name: "git",
          globals: true,
          environment: "node",
          include: REAL_GIT,
        },
      },
    ],
  },
})
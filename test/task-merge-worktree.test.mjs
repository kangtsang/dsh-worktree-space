/**
 * The merge mechanism against real git.
 *
 * The rest of the suite answers a mocked subprocess, which can only prove the
 * commands a finish asks for. What a merge actually does to a repository — which
 * branch moves, which one stays put, what a scratch checkout leaves behind — is
 * git's business, so this file runs the real thing on a throwaway repository. It
 * skips itself where git is not installed.
 */
import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { finishTask, planTask } from "../src/host/task/operations.js"
import { PLUGIN_ROOT, taskMetadata, writeTaskMetadata } from "../src/host/task/shared.js"

/**
 * Where the record sits inside a task space: the plugin's own directory. These tests drive
 * real git, so the record they assert about is the one `writeTaskMetadata` wrote.
 * @param taskPath - the task space directory.
 * @returns the record's absolute path.
 */
const recordAt = (taskPath) => join(taskPath, PLUGIN_ROOT, "worktree-space.json")

/**
 * A file name git will C-quote by default, which is the whole point of the `-z` reads.
 *
 * `git diff --name-only` prints `"\346\226\207.txt"` for the pure-ASCII spelling of this
 * name - a string that does not name a file on disk. The plugin opens every path that
 * listing reports to look for conflict markers, so a quoted one throws, lands in the
 * handler written for submodules, and the merge is reported resolved while its markers
 * are still in the file.
 */
const NON_ASCII_FILE = "文.txt"

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

/** Git in a real repository, failing loudly so a broken fixture is not a mystery. */
function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
}

/** Whether a git command exits zero — for the questions git answers silently. */
function succeeded(repo, args) {
  try {
    git(repo, args)
    return true
  } catch {
    return false
  }
}

/** The profile's subprocess service, backed by real git. */
function realSubprocess() {
  return {
    spawn({ argv, env }) {
      // The real command line is passed through as it stands, minus the program name:
      // this double exists to run real git, so dropping the hardening `-c` settings
      // would make it run a different command than the one under test. The environment
      // is passed the same way, for the same reason - `LC_ALL=C` in particular is what
      // keeps git's diagnostics in the language `gitFailureCode` matches on.
      const args = argv.slice(1)
      let stdout = ""
      let stderr = ""
      let exitCode = 0
      try {
        stdout = execFileSync("git", args, { encoding: "utf8", ...(env === undefined ? {} : { env: { ...process.env, ...env } }) })
      } catch (error) {
        exitCode = typeof error.status === "number" ? error.status : 1
        stdout = String(error.stdout ?? "")
        stderr = String(error.stderr ?? "")
      }
      return {
        done: Promise.resolve({ exitCode, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: stdout }) },
          stderr: { readFrom: () => ({ text: stderr }) },
        },
      }
    },
  }
}

/**
 * One repository on `develop` with a `main` beside it, and a task space holding a
 * linked worktree of it on `feat/sample` — the layout createTask writes.
 *
 * `conflict: true` moves the same line on `main`, so merging the task branch there
 * cannot apply; `held: true` checks `main` out in a second worktree, which is what
 * makes a scratch checkout impossible. `nonAscii: true` does the same as `conflict`
 * but for a file whose name is not pure ASCII, which is the shape git C-quotes.
 */
async function fixture({ conflict = false, held = false, second = false, nonAscii = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "dsh-task-merge-"))
  const source = join(root, "source")
  const tasksRoot = join(root, "tasks")
  // The project layer a create derives from its source root's own directory name;
  // this fixture builds the task space by hand, so it names the layer itself.
  const project = "source"
  const taskPath = join(tasksRoot, project, "sample")
  const taskRepo = join(taskPath, "source")

  git(root, ["init", "-q", "-b", "develop", "source"])
  for (const [key, value] of [["user.email", "probe@example.com"], ["user.name", "probe"], ["commit.gpgsign", "false"], ["core.hooksPath", join(root, "no-hooks")]]) {
    git(source, ["config", key, value])
  }
  await writeFile(join(source, "shared.txt"), "base\n")
  git(source, ["add", "-A"])
  git(source, ["commit", "-qm", "base"])
  git(source, ["branch", "main"])

  await mkdir(taskPath, { recursive: true })
  // A finish refuses a task space that carries no record of being one, so a
  // fixture that builds the layout by hand has to write the record a create
  // would have written - not a stand-in for it, the same one.
  await writeTaskMetadata(taskPath, taskMetadata({
    task: "sample",
    project,
    tasksRoot,
    sourceRoot: source,
    branch: "feat/sample",
    repositories: [{ name: "source", sourcePath: source, sourceBranch: "develop" }],
  }))
  git(source, ["worktree", "add", "-q", "-b", "feat/sample", taskRepo])
  await writeFile(join(taskRepo, "shared.txt"), "task\n")
  git(taskRepo, ["commit", "-qam", "task work"])

  if (nonAscii) {
    // The task side of the same file, so the merge on `main` has two edits to the same
    // line and cannot apply - the conflict this test needs, on a path git will quote.
    await writeFile(join(taskRepo, NON_ASCII_FILE), "base\ntask\n")
    git(taskRepo, ["add", "-A"])
    git(taskRepo, ["commit", "-qm", "task edit to the non-ASCII file"])
  }

  if (conflict || nonAscii) {
    git(source, ["checkout", "-q", "main"])
    // The same edit on `main`, in a file whose name git will C-quote. `conflict` uses
    // the plain name and `nonAscii` the quoted one, so the two shapes can be told apart:
    // a bug in the reading of the path shows up only in the second.
    const name = nonAscii ? NON_ASCII_FILE : "shared.txt"
    if (nonAscii) {
      await writeFile(join(source, name), "base\n")
      git(source, ["add", "-A"])
      git(source, ["commit", "-qm", "add a file with a non-ASCII name"])
    }
    await writeFile(join(source, name), "main\n")
    git(source, ["commit", "-qam", "main edit"])
    git(source, ["checkout", "-q", "develop"])
  }
  if (held) git(source, ["worktree", "add", "-q", join(root, "elsewhere"), "main"])

  // A second repository, on the same shape and always clean to merge: what a task
  // looks like when one repository stops and the rest go through. Only the first
  // takes `conflict`, so with both flags the finish is partly done by construction.
  let secondSource = ""
  let secondTaskRepo = ""
  if (second) {
    secondSource = join(root, "source2")
    secondTaskRepo = join(taskPath, "source2")
    git(root, ["init", "-q", "-b", "develop", "source2"])
    for (const [key, value] of [["user.email", "probe@example.com"], ["user.name", "probe"], ["commit.gpgsign", "false"], ["core.hooksPath", join(root, "no-hooks")]]) {
      git(secondSource, ["config", key, value])
    }
    await writeFile(join(secondSource, "shared.txt"), "base\n")
    git(secondSource, ["add", "-A"])
    git(secondSource, ["commit", "-qm", "base"])
    await writeTaskMetadata(taskPath, taskMetadata({
      task: "sample",
      project,
      tasksRoot,
      sourceRoot: source,
      branch: "feat/sample",
      repositories: [
        { name: "source", sourcePath: source, sourceBranch: "develop" },
        { name: "source2", sourcePath: secondSource, sourceBranch: "develop" },
      ],
    }))
    git(secondSource, ["worktree", "add", "-q", "-b", "feat/sample", secondTaskRepo])
    await writeFile(join(secondTaskRepo, "shared.txt"), "task\n")
    git(secondTaskRepo, ["commit", "-qam", "task work"])
  }

  return { root, source, tasksRoot, project, taskPath, taskRepo, secondSource, secondTaskRepo, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** The source repository's own registered worktrees, the main one included. */
const registrations = (source) => git(source, ["worktree", "list"]).split("\n").filter(Boolean)

/**
 * These tests build real repositories and move real branches: seconds of work rather
 * than milliseconds. The suite runs its files in parallel, so the default five seconds
 * is a coin toss on a loaded machine and on a CI runner — and a release that publishes
 * on a tag fails with it. The timeout is stated once, here.
 */
const GIT_TIMEOUT = 30_000

describe.skipIf(!gitAvailable)("merging a task into a branch of its own choosing", () => {
  it("moves the named branch, and leaves the source checkout where it was", async () => {
    const fixtureUnderTest = await fixture()
    const subprocess = realSubprocess()
    try {
      const { source, tasksRoot, project } = fixtureUnderTest
      // What the dialog shows before anything is chosen: the branch the source
      // repository is on, and the alternatives beside it.
      const plan = await planTask(subprocess, { task: "sample", project, tasksRoot })
      expect(plan.repositories[0]).toMatchObject({ target: "develop", checkedOut: "develop", branches: ["develop", "main"] })

      const result = await finishTask(subprocess, { task: "sample", project, tasksRoot, merge: true, targets: { source: "main" } })

      expect(result.failed).toBe(false)
      expect(result.mergeTarget).toBe("main")
      // A repository that merged is not a conflicted one - and none of the three stops
      // is set, so a caller reading the flags sees a clean row.
      expect(result.repositories[0].conflict).toBe(false)
      expect(result.repositories[0].needsCommit).toBe(false)
      expect(result.repositories[0].dirtyCheckout).toBe(false)
      // The named branch took the merge…
      expect(succeeded(source, ["merge-base", "--is-ancestor", "feat/sample", "main"])).toBe(true)
      // …the checkout was never switched to it…
      expect(git(source, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("develop")
      expect(succeeded(source, ["merge-base", "--is-ancestor", "feat/sample", "develop"])).toBe(false)
      // …and the checkout the merge happened in is gone.
      expect(registrations(source)).toHaveLength(1)
      expect(existsSync(fixtureUnderTest.taskRepo)).toBe(false)
    } finally {
      await fixtureUnderTest.cleanup()
    }
  }, GIT_TIMEOUT)

  it("leaves the target exactly where it was when that merge conflicts", async () => {
    const fixtureUnderTest = await fixture({ conflict: true })
    const subprocess = realSubprocess()
    try {
      const { source, tasksRoot, project } = fixtureUnderTest
      const before = git(source, ["rev-parse", "main"])

      const result = await finishTask(subprocess, { task: "sample", project, tasksRoot, merge: true, targets: { source: "main" } })

      expect(result.failed).toBe(true)
      expect(result.repositories[0].error).toMatch(/CONFLICT/)
      // git's own words only: the page says the rest in the user's language, and the
      // answer's flags say it to a caller, so the plugin appends nothing here.
      expect(result.repositories[0].error).not.toContain("kept")
      // The flag is what lets the page say all of this in the user's own language,
      // instead of printing git's English next to a Chinese dialog.
      expect(result.repositories[0].conflict).toBe(true)
      // The merge commit that would have moved `main` was never made…
      expect(git(source, ["rev-parse", "main"])).toBe(before)
      expect(git(source, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("develop")
      // …the conflicted scratch checkout was dropped rather than left registered…
      expect(registrations(source).filter((line) => line.includes("dsh-worktree-space-merge-"))).toEqual([])
      // …and the task's own worktree is still there to be handled by hand, as reported.
      expect(registrations(source)).toHaveLength(2)
      expect(existsSync(fixtureUnderTest.taskRepo)).toBe(true)
    } finally {
      await fixtureUnderTest.cleanup()
    }
  }, GIT_TIMEOUT)

  // The review's item 10, end to end and against real git. A conflicted file whose name
  // is not pure ASCII is C-quoted by `git diff --name-only`, and the quoted string does
  // not name anything on disk - so the marker scan skipped it and the conflict was
  // reported as resolved. Read with `-z` the path arrives verbatim.
  it("reads a conflicted path git would have quoted, so the markers are found", async () => {
    const fixtureUnderTest = await fixture({ nonAscii: true })
    const subprocess = realSubprocess()
    try {
      const { source, tasksRoot, project } = fixtureUnderTest

      // The premise, asserted rather than assumed: this name really is one git quotes,
      // and the quoted spelling really does not exist. If a future git stops quoting, the
      // test should say so rather than quietly stop exercising anything.
      const quoted = execFileSync("git", ["-C", source, "diff", "--name-only", "HEAD"], { encoding: "utf8" }).trim()
      if (quoted !== "" && quoted !== NON_ASCII_FILE) {
        expect(quoted).toMatch(/^"/)
        expect(existsSync(join(source, quoted))).toBe(false)
      }

      const result = await finishTask(subprocess, { task: "sample", project, tasksRoot, merge: true, targets: { source: "main" } })

      // The conflict is seen, so the flags tell the caller there is a merge to conclude
      // and nothing was removed...
      expect(result.failed).toBe(true)
      expect(result.repositories[0].conflict).toBe(true)
      expect(result.repositories[0].removed).toBe(false)
      // ...and the file is still there with its markers, which is what a reader is told to
      // go and reconcile.
      expect(existsSync(join(fixtureUnderTest.taskRepo, NON_ASCII_FILE))).toBe(true)
      expect(readFileSync(join(fixtureUnderTest.taskRepo, NON_ASCII_FILE), "utf8")).toContain("<<<<<<<")

      // What this assertion holds, and what it does not, measured by reverting each `-z`
      // read in turn:
      //
      //   - `conflictedFiles` (the `--diff-filter=U` listing) IS held here: reverting it
      //     fails this test, because `conflictedFiles` is what the `pending.length > 0`
      //     branch consults and the file has to be named for the sentence to be right.
      //   - `conflictMarkers`' own listing (`--name-only -z HEAD`) is NOT held here:
      //     reverting just that one leaves this test green, and no other end-to-end test
      //     covers it either. It is held only by the unit stubs in
      //     `task-operations.test.mjs`, whose payloads are the NUL-separated bytes real
      //     git emits under `-z`.
      //
      // `conflict` itself is not the instrument: it comes from `MERGE_HEAD`, so it is true
      // whether or not the marker scan could open the file. That is why the assertion below
      // is on the file being named, not on the flag.
      expect(result.repositories[0].conflictedFiles ?? []).toContain(NON_ASCII_FILE)
    } finally {
      await fixtureUnderTest.cleanup()
    }
  }, GIT_TIMEOUT)

  it("merges into the checked-out branch where it stands when none is named", async () => {    const fixtureUnderTest = await fixture()
    const subprocess = realSubprocess()
    try {
      const { source, tasksRoot, project } = fixtureUnderTest

      const result = await finishTask(subprocess, { task: "sample", project, tasksRoot, merge: true })

      expect(result.failed).toBe(false)
      expect(result.mergeTarget).toBe("develop")
      expect(succeeded(source, ["merge-base", "--is-ancestor", "feat/sample", "develop"])).toBe(true)
      expect(succeeded(source, ["merge-base", "--is-ancestor", "feat/sample", "main"])).toBe(false)
      expect(git(source, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("develop")
    } finally {
      await fixtureUnderTest.cleanup()
    }
  }, GIT_TIMEOUT)

  it("reports the checkout in the way when another worktree holds the branch", async () => {
    const fixtureUnderTest = await fixture({ held: true })
    const subprocess = realSubprocess()
    try {
      const { source, tasksRoot, project } = fixtureUnderTest

      const result = await finishTask(subprocess, { task: "sample", project, tasksRoot, merge: true, targets: { source: "main" } })

      expect(result.failed).toBe(true)
      // Git's own refusal, which names the checkout holding the branch. The wording
      // moved with git's versions — "already checked out at" became "already used by
      // worktree at" — so both are accepted, and only the path's name is asserted
      // besides: git prints paths in its own separator style.
      expect(result.repositories[0].error).toMatch(/already (?:checked out|used by worktree) at/)
      expect(result.repositories[0].error).toContain("elsewhere")
      expect(succeeded(source, ["merge-base", "--is-ancestor", "feat/sample", "main"])).toBe(false)
      expect(existsSync(fixtureUnderTest.taskRepo)).toBe(true)
    } finally {
      await fixtureUnderTest.cleanup()
    }
  }, GIT_TIMEOUT)

  it("names uncommitted work in the source checkout instead of calling it a conflict", async () => {
    // A merge into the branch the source repository has checked out runs in that
    // checkout, and git refuses it when the checkout holds changes the merge would
    // overwrite. Git says so in words that name a conflict nobody created, so the
    // refusal used to arrive as `conflict: true` - which sends the reader after
    // conflict markers and a merge to conclude, in a repository where no merge was
    // ever started.
    const fixtureUnderTest = await fixture()
    const subprocess = realSubprocess()
    try {
      const { source, tasksRoot, project } = fixtureUnderTest
      // The file the task branch also changed, so the merge really would overwrite it.
      writeFileSync(join(source, "shared.txt"), "uncommitted work in the source checkout\n")

      const result = await finishTask(subprocess, { task: "sample", project, tasksRoot, merge: true })

      expect(result.failed).toBe(true)
      // Not a conflict: nothing was reconciled and nothing is waiting to be.
      expect(result.repositories[0].conflict).toBeFalsy()
      // Named as what it is, with the path, so the reader knows where to look.
      expect(result.repositories[0].error).toContain("shared.txt")
      expect(result.repositories[0].error).toMatch(/uncommitted/i)
      // The work is still there - refusing is the whole point.
      expect(readFileSync(join(source, "shared.txt"), "utf8")).toBe("uncommitted work in the source checkout\n")
      // And the branch did not move.
      expect(succeeded(source, ["merge-base", "--is-ancestor", "feat/sample", "develop"])).toBe(false)
      expect(existsSync(fixtureUnderTest.taskRepo)).toBe(true)
    } finally {
      await fixtureUnderTest.cleanup()
    }
  }, GIT_TIMEOUT)

  it("leaves a merge the user has of their own in the source checkout alone", async () => {
    // The one irreversible loss this file used to have. A finish that failed for any
    // reason ran `git merge --abort` in the source checkout unconditionally - including
    // on the failure paths where this call never started a merge there at all. A user in
    // the middle of their own merge, with the conflict already resolved by hand and
    // staged, lost that resolution: no reflog entry, no stash, nothing to recover.
    //
    // This is that failure path: an unusable merge target (E4008) is refused before
    // anything is started, in either checkout. The user's merge is not this call's, so
    // the refusal must not touch it.
    const fixtureUnderTest = await fixture()
    const subprocess = realSubprocess()
    try {
      const { source, tasksRoot, project } = fixtureUnderTest
      // A conflict of the user's own on `shared.txt`: two branches off the same base
      // that both rewrote it.
      git(source, ["branch", "userwork"])
      git(source, ["checkout", "-q", "userwork"])
      await writeFile(join(source, "shared.txt"), "the user's side\n")
      git(source, ["commit", "-qam", "user side"])
      git(source, ["checkout", "-q", "develop"])
      await writeFile(join(source, "shared.txt"), "develop side\n")
      git(source, ["commit", "-qam", "develop side"])
      expect(succeeded(source, ["merge", "userwork"])).toBe(false)
      expect(existsSync(join(source, ".git", "MERGE_HEAD"))).toBe(true)
      // Resolved by hand and staged: work that exists nowhere but in this checkout.
      await writeFile(join(source, "shared.txt"), "RESOLVED BY HAND\n")
      git(source, ["add", "shared.txt"])

      const result = await finishTask(subprocess, {
        task: "sample", project, tasksRoot, merge: true,
        // Not a local branch, so the finish refuses before it starts any merge.
        targets: { source: "nope" },
      })

      expect(result.failed).toBe(true)
      expect(result.repositories[0].error).toMatch(/not a local branch/)
      expect(result.repositories[0].merged).toBe(false)
      // The resolution and the merge standing behind it are exactly as they were.
      expect(readFileSync(join(source, "shared.txt"), "utf8")).toBe("RESOLVED BY HAND\n")
      expect(existsSync(join(source, ".git", "MERGE_HEAD"))).toBe(true)
      // The task's own worktree is untouched too, so the finish can be tried again.
      expect(existsSync(fixtureUnderTest.taskRepo)).toBe(true)
    } finally {
      await fixtureUnderTest.cleanup()
    }
  }, GIT_TIMEOUT)

  it("refuses to merge over a merge of the user's that touches a path the task never did", async () => {
    // The same loss by the other door, and the one the dirty-path guard cannot see: that
    // guard only refuses over paths this merge writes, so a user's merge standing on some
    // other file passes it. Git then refuses the merge itself - "You have not concluded
    // your merge" - and the abort that followed that refusal was the one that discarded
    // the resolution. `mergeIntoBranch` asks for MERGE_HEAD before it starts anything,
    // which is what this pins.
    const fixtureUnderTest = await fixture()
    const subprocess = realSubprocess()
    try {
      const { source, tasksRoot, project } = fixtureUnderTest
      // A conflict on a path the task branch never touches: the task only ever wrote
      // `shared.txt`, so no dirty path of this one is in the merge's way.
      git(source, ["branch", "userwork"])
      git(source, ["checkout", "-q", "userwork"])
      await writeFile(join(source, "notes.txt"), "the user's side\n")
      git(source, ["add", "-A"])
      git(source, ["commit", "-qm", "user notes"])
      git(source, ["checkout", "-q", "develop"])
      await writeFile(join(source, "notes.txt"), "develop side\n")
      git(source, ["add", "-A"])
      git(source, ["commit", "-qm", "develop notes"])
      expect(succeeded(source, ["merge", "userwork"])).toBe(false)
      await writeFile(join(source, "notes.txt"), "RESOLVED BY HAND\n")
      git(source, ["add", "notes.txt"])

      const result = await finishTask(subprocess, { task: "sample", project, tasksRoot, merge: true })

      expect(result.failed).toBe(true)
      // Refused as the user's own checkout, not as a conflict: there is nothing here for
      // a caller to reconcile, and nothing was started for one to conclude.
      expect(result.repositories[0].conflict).toBe(false)
      expect(result.repositories[0].dirtyCheckout).toBe(true)
      expect(result.repositories[0].merged).toBe(false)
      // Named for what it is, and by the path, rather than left as git's refusal.
      expect(result.repositories[0].error).toMatch(/merge of its own in progress/)
      // The hand resolution survived, which is the whole of the test.
      expect(readFileSync(join(source, "notes.txt"), "utf8")).toBe("RESOLVED BY HAND\n")
      expect(existsSync(join(source, ".git", "MERGE_HEAD"))).toBe(true)
      expect(succeeded(source, ["merge-base", "--is-ancestor", "feat/sample", "develop"])).toBe(false)
    } finally {
      await fixtureUnderTest.cleanup()
    }
  }, GIT_TIMEOUT)

  it("merges past untracked files, which a merge does not overwrite", async () => {
    // The guard above refuses on tracked paths. An untracked file is the one kind of
    // dirt a merge writes straight past, so refusing on it would send someone to
    // commit a build output that was never in the way.
    const fixtureUnderTest = await fixture()
    const subprocess = realSubprocess()
    try {
      const { source, tasksRoot, project } = fixtureUnderTest
      writeFileSync(join(source, "scratch.log"), "not tracked\n")

      const result = await finishTask(subprocess, { task: "sample", project, tasksRoot, merge: true })

      expect(result.failed).toBe(false)
      expect(succeeded(source, ["merge-base", "--is-ancestor", "feat/sample", "develop"])).toBe(true)
      expect(existsSync(join(source, "scratch.log"))).toBe(true)
    } finally {
      await fixtureUnderTest.cleanup()
    }
  }, GIT_TIMEOUT)

  it("merges past a tracked file the merge does not write", async () => {
    // The one that bit: a repository holding work in progress, in a file the task
    // never touched, could not finish a task that had nothing to do with that work.
    // Git carries such a change through a merge untouched. Refusing on every dirty
    // path meant the reader was told to commit or stash work that was never in the
    // way - and a repository with anything uncommitted could finish nothing at all.
    //
    // So the guard asks what the merge writes: the paths differing from the merge
    // base on either side. Only the dirty paths among those can block it.
    const fixtureUnderTest = await fixture()
    const subprocess = realSubprocess()
    try {
      const { source, tasksRoot, project } = fixtureUnderTest
      // Tracked, and dirty - but the task branch only ever wrote shared.txt.
      await writeFile(join(source, "notes.txt"), "base\n")
      git(source, ["add", "-A"])
      git(source, ["commit", "-qm", "add notes"])
      writeFileSync(join(source, "notes.txt"), "work in progress, unrelated to the task\n")

      const result = await finishTask(subprocess, { task: "sample", project, tasksRoot, merge: true })

      expect(result.failed).toBe(false)
      expect(result.repositories[0].merged).toBe(true)
      expect(succeeded(source, ["merge-base", "--is-ancestor", "feat/sample", "develop"])).toBe(true)
      // The unrelated work is still uncommitted, exactly as it was.
      expect(readFileSync(join(source, "notes.txt"), "utf8")).toBe("work in progress, unrelated to the task\n")
      expect(git(source, ["status", "--short"])).toMatch(/notes\.txt/)
    } finally {
      await fixtureUnderTest.cleanup()
    }
  }, GIT_TIMEOUT)

  it("keeps the record when one repository stopped, so the task can be finished again", async () => {
    // A partly done finish is the ordinary way one ends badly, and the answer says
    // so: the repositories that stopped are as they were, the rest are finished, and
    // the reader is expected to come back. Coming back means finishing a second
    // time, which reads the record this plugin wrote.
    //
    // The record was cleared unconditionally, on the assumption that finishing takes
    // the task space down. A finish that stopped part way does not take it down: the
    // worktree of the repository that stopped is still inside it. So the record went,
    // the second attempt refused to start, and the worktree was stranded - with the
    // page having just invited the reader to return to it.
    const fixtureUnderTest = await fixture({ conflict: true, second: true })
    const subprocess = realSubprocess()
    try {
      const { tasksRoot, project, taskPath, secondSource, secondTaskRepo } = fixtureUnderTest

      // `conflict` puts the competing edit on `main`, so that repository is told to merge
      // there. Without that it would merge into the branch it has checked out, which
      // the fixture leaves clean, and nothing would stop.
      const first = await finishTask(subprocess, { task: "sample", project, tasksRoot, merge: true, targets: { source: "main" } })

      expect(first.failed).toBe(true)
      // One went, one did not - that is the shape this is about.
      expect(first.repositories.find((row) => row.name === "source")?.merged).toBe(false)
      expect(first.repositories.find((row) => row.name === "source2")?.merged).toBe(true)
      expect(existsSync(secondTaskRepo)).toBe(false)
      // The one that stopped keeps its worktree, so the record must stay with it.
      expect(existsSync(fixtureUnderTest.taskRepo)).toBe(true)
      expect(existsSync(recordAt(taskPath))).toBe(true)

      // And a second attempt starts, rather than refusing for want of a record. It
      // still fails, because the conflict is still standing - what it must not do is
      // refuse to begin. The repository that already went is simply absent now, so
      // the loop does not see it.
      const second = await finishTask(subprocess, { task: "sample", project, tasksRoot, merge: true, targets: { source: "main" } })

      expect(second.failed).toBe(true)
      expect(second.repositories.map((row) => row.name)).toEqual(["source"])
      expect(succeeded(secondSource, ["merge-base", "--is-ancestor", "feat/sample", "develop"])).toBe(true)
    } finally {
      await fixtureUnderTest.cleanup()
    }
  }, GIT_TIMEOUT)

  it("keeps the record when a partly done finish is asked to file documents", async () => {
    // The same shape as the test above, with the one option that changed what
    // happened. Naming a documents directory turns on the disposal that files
    // content out of the task space, and the record - which `strayKind` cannot tell
    // from a document, being a plain file in the same directory - went with it.
    //
    // This is the version that reached a user: the finish reported that the task
    // space was kept, listed the repository that stopped, and deleted the very
    // record needed to come back to it. A test without a destination named never
    // saw it, because that disposal only runs when one is named.
    const fixtureUnderTest = await fixture({ conflict: true, second: true })
    const subprocess = realSubprocess()
    try {
      const { tasksRoot, project, taskPath, root } = fixtureUnderTest
      const destination = join(root, "documents")

      const result = await finishTask(subprocess, {
        task: "sample", project, tasksRoot, merge: true,
        targets: { source: "main" },
        documentsDirectory: destination,
      })

      expect(result.failed).toBe(true)
      expect(existsSync(recordAt(taskPath))).toBe(true)
      // And it was not filed into the documents directory on its way out: the plugin's
      // whole directory is its own bookkeeping, so nothing of it goes to the archive.
      expect(existsSync(join(destination, PLUGIN_ROOT))).toBe(false)
    } finally {
      await fixtureUnderTest.cleanup()
    }
  }, GIT_TIMEOUT)

  it("refuses to merge a worktree left on a detached HEAD", async () => {
    // The one that loses commits rather than reporting an error. `git merge HEAD`
    // inside the target's checkout resolves `HEAD` against that checkout, so the
    // merge target is merged into itself: "Already up to date", exit 0. The finish
    // then reported `merged: true`, removed a worktree that was clean only because
    // nothing had been merged into it, and left the task's commits behind as objects
    // nothing points at - which a gc collects.
    //
    // A mid-flight rebase and a `git checkout <sha>` both leave a worktree here, so
    // this is a state a user reaches rather than one that has to be built.
    const fixtureUnderTest = await fixture()
    const subprocess = realSubprocess()
    try {
      const { source, tasksRoot, project } = fixtureUnderTest
      const before = git(source, ["rev-parse", "develop"])
      // The worktree's own commits are only reachable through this SHA once it is off
      // the branch, which is exactly why they must not be thrown away.
      const work = git(fixtureUnderTest.taskRepo, ["rev-parse", "feat/sample"])
      git(fixtureUnderTest.taskRepo, ["checkout", "-q", work])

      expect(git(fixtureUnderTest.taskRepo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD")

      const result = await finishTask(subprocess, { task: "sample", project, tasksRoot, merge: true })

      expect(result.failed).toBe(true)
      expect(result.repositories[0]).toMatchObject({ merged: false, removed: false, branchDeleted: false })
      // Not a conflict: nothing was reconciled and there is no merge to conclude.
      expect(result.repositories[0].conflict).toBeFalsy()
      expect(result.repositories[0].error).toMatch(/detached HEAD/)
      // The branch did not move, and the worktree is still on disk with the record
      // beside it, so the task can be finished again once a branch is checked out.
      expect(git(source, ["rev-parse", "develop"])).toBe(before)
      expect(existsSync(fixtureUnderTest.taskRepo)).toBe(true)
      expect(existsSync(recordAt(fixtureUnderTest.taskPath))).toBe(true)
      // And the commits are still there, reachable from the worktree.
      expect(git(fixtureUnderTest.taskRepo, ["rev-parse", "HEAD"])).toBe(work)
    } finally {
      await fixtureUnderTest.cleanup()
    }
  }, GIT_TIMEOUT)

  it("names an untracked file the merge would overwrite, instead of calling it a conflict", async () => {
    // An untracked file is the one kind of dirt a merge writes straight past - unless
    // the merge happens to write it, which git then refuses. That refusal arrives in
    // the branch's own words, and git words it differently for the tracked case:
    // "Your local changes to the following files would be overwritten by merge"
    // against "The following untracked working tree files would be overwritten by
    // merge". Only the first was recognised, so the second was reported as a
    // conflict: a merge to settle and markers to go and read, in a checkout where
    // nothing was ever reconciled.
    const fixtureUnderTest = await fixture()
    const subprocess = realSubprocess()
    try {
      const { source, tasksRoot, project } = fixtureUnderTest
      // The task branch writes a path the source checkout holds untracked.
      await writeFile(join(fixtureUnderTest.taskRepo, "collided.txt"), "written by the task\n")
      git(fixtureUnderTest.taskRepo, ["add", "-A"])
      git(fixtureUnderTest.taskRepo, ["commit", "-qm", "task adds collided.txt"])
      await writeFile(join(source, "collided.txt"), "the user's own untracked file\n")

      const result = await finishTask(subprocess, { task: "sample", project, tasksRoot, merge: true })

      expect(result.failed).toBe(true)
      // Nothing was reconciled, so it is not a conflict and no merge is standing.
      expect(result.repositories[0].conflict).toBeFalsy()
      expect(result.repositories[0].mergeInProgress).toBeFalsy()
      // Flagged as the user's own checkout rather than as work-to-commit: a caller that
      // acted on either would be committing or stashing the user's file on their behalf.
      expect(result.repositories[0].dirtyCheckout).toBe(true)
      expect(result.repositories[0].needsCommit).toBeFalsy()
      expect(result.repositories[0].merged).toBe(false)
      // Git's own message, which names the file - and the file is still there, which
      // is the whole point of refusing.
      expect(result.repositories[0].error).toMatch(/would be overwritten by merge/)
      expect(result.repositories[0].error).toContain("collided.txt")
      expect(readFileSync(join(source, "collided.txt"), "utf8")).toBe("the user's own untracked file\n")
      expect(existsSync(fixtureUnderTest.taskRepo)).toBe(true)
    } finally {
      await fixtureUnderTest.cleanup()
    }
  }, GIT_TIMEOUT)

  it("names a renamed file by the path the merge would write", async () => {
    // `git status --short` writes a rename as `R  shared.txt -> renamed.txt`, which
    // is not a path: the file is at `renamed.txt`, and the string matches nothing a
    // merge writes. A non-ASCII path arrives C-quoted for the same reason. Both made
    // the pre-check miss work it should have named, and left git to refuse the merge
    // instead - which it does, but only after the finish has let the merge start.
    const fixtureUnderTest = await fixture()
    const subprocess = realSubprocess()
    try {
      const { source, tasksRoot, project } = fixtureUnderTest
      // The task branch moves the file...
      git(fixtureUnderTest.taskRepo, ["mv", "shared.txt", "renamed.txt"])
      git(fixtureUnderTest.taskRepo, ["commit", "-qam", "rename the file"])
      // ...and the source checkout has the same rename half-made, with work on top of
      // it, so the path the merge writes is dirty there.
      git(source, ["mv", "shared.txt", "renamed.txt"])
      await writeFile(join(source, "renamed.txt"), "work in progress under the new name\n")

      const result = await finishTask(subprocess, { task: "sample", project, tasksRoot, merge: true })

      expect(result.failed).toBe(true)
      expect(result.repositories[0]).toMatchObject({ merged: false, removed: false })
      expect(result.repositories[0].conflict).toBeFalsy()
      // Named by the path the filesystem has, not as `shared.txt -> renamed.txt`.
      expect(result.repositories[0].error).toContain("renamed.txt")
      expect(result.repositories[0].error).not.toContain("->")
      // The refusal is this side's own, which is the difference: the merge was never
      // attempted against a checkout git would have stopped anyway.
      expect(result.repositories[0].error).toMatch(/Commit or stash it/)
      // The work is still there.
      expect(readFileSync(join(source, "renamed.txt"), "utf8")).toBe("work in progress under the new name\n")
      expect(existsSync(fixtureUnderTest.taskRepo)).toBe(true)
    } finally {
      await fixtureUnderTest.cleanup()
    }
  }, GIT_TIMEOUT)

  it("clears the record when every repository finished and the space is empty", async () => {
    // The other half of the same rule: with no worktree left there is nothing left to
    // describe, and the record would be a claim about a directory this plugin no
    // longer accounts for.
    const fixtureUnderTest = await fixture({ second: true })
    const subprocess = realSubprocess()
    try {
      const { tasksRoot, project, taskPath } = fixtureUnderTest

      const result = await finishTask(subprocess, { task: "sample", project, tasksRoot, merge: true })

      expect(result.failed).toBe(false)
      expect(existsSync(recordAt(taskPath))).toBe(false)
      expect(existsSync(taskPath)).toBe(false)
    } finally {
      await fixtureUnderTest.cleanup()
    }
  }, GIT_TIMEOUT)
})

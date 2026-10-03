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
    spawn({ argv, cwd }) {
      const args = argv.slice(3)
      let stdout = ""
      let stderr = ""
      let exitCode = 0
      try {
        stdout = execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
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
 * makes a scratch checkout impossible.
 */
async function fixture({ conflict = false, held = false } = {}) {
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
  await writeFile(join(taskPath, "README.en.md"), "# Task: sample\n")
  git(source, ["worktree", "add", "-q", "-b", "feat/sample", taskRepo])
  await writeFile(join(taskRepo, "shared.txt"), "task\n")
  git(taskRepo, ["commit", "-qam", "task work"])

  if (conflict) {
    git(source, ["checkout", "-q", "main"])
    await writeFile(join(source, "shared.txt"), "main\n")
    git(source, ["commit", "-qam", "main edit"])
    git(source, ["checkout", "-q", "develop"])
  }
  if (held) git(source, ["worktree", "add", "-q", join(root, "elsewhere"), "main"])

  return { root, source, tasksRoot, project, taskPath, taskRepo, cleanup: () => rm(root, { recursive: true, force: true }) }
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
      // A repository that merged is not a conflicted one.
      expect(result.repositories[0].conflict).toBeUndefined()
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

  it("merges into the checked-out branch where it stands when none is named", async () => {
    const fixtureUnderTest = await fixture()
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
})

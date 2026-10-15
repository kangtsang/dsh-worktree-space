import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { addTaskRepositories } from "../src/host/task/add.js"
import { readAudit } from "../src/host/task/audit-log.js"
import { parseGitArgv } from "../src/host/task/git.js"
import { PLUGIN_ROOT } from "../src/host/task/shared.js"

/**
 * The record, from the task space directory: the plugin keeps it in its own directory.
 * @param taskPath - the task space directory.
 * @returns the record's absolute path.
 */
const recordAt = (taskPath) => join(taskPath, PLUGIN_ROOT, "worktree-space.json")

/** The note rendered from the record, beside it. */
const noteAt = (taskPath) => join(taskPath, PLUGIN_ROOT, "worktree-space.md")

/**
 * Adding a repository to a task that already exists.
 *
 * The fixtures build a task space by hand rather than by running a create, because
 * what is being tested is the difference between that create and this one: the task
 * is already full of somebody's work, and only what this call makes may be taken
 * back when it fails.
 */

const PROJECT = "kratos-admin"
const TASK = "login"
const BRANCH = "task/login"

/**
 * Subprocess double: keys replies by the git arguments after the implicit
 * `-C <cwd>`, and lets a reply run a side effect so a mocked `worktree add` still
 * puts a checkout on disk — the rollback and the listing both read the filesystem,
 * not the calls.
 * @param handlers - reply per argument key: a result, or a function of the call.
 * @returns the service double and the calls it recorded.
 */
function subprocessMock(handlers = {}) {
  const calls = []
  const replyFor = (key) => {
    if (Object.hasOwn(handlers, key)) return handlers[key]
    let best
    for (const candidate of Object.keys(handlers)) {
      if (!key.startsWith(candidate)) continue
      if (best === undefined || candidate.length > best.length) best = candidate
    }
    return best === undefined ? undefined : handlers[best]
  }
  const subprocess = {
    spawn({ argv }) {
      // Parsed by name, not by position: the git command line carries hardening `-c`
      // settings before `-C`, so `argv[2]` is no longer the directory. See
      // `parseGitArgv`.
      const { cwd, args } = parseGitArgv(argv)
      const key = args.join(" ")
      calls.push({ cwd, args, key })
      const handler = replyFor(key)
      // A handler's side effects have to finish before this call is answered, not
      // merely before the test that made them returns.
      //
      // The code under test reads the filesystem the moment a git call reports back:
      // `worktree add` returns, and the very next thing it does is write the task
      // metadata. A reply that puts a checkout on disk is only meaningful if that
      // checkout is there when the metadata is written, so the reply cannot resolve
      // while its own side effect is still running.
      //
      // A promise is an object, so `typeof reply === "object"` was true for an async
      // handler and the branch below read `.exitCode` off the promise itself - which
      // is undefined, so it answered `exitCode: 0` at once and let the side effects
      // run unwatched in the background. The test still passed on Windows, where the
      // three awaited filesystem calls inside a handler happened to finish first,
      // and failed on the CI runner, where they did not. A test whose outcome is a
      // scheduling race is not a test.
      const text = { stdout: '', stderr: '' }
      const done = Promise.resolve(typeof handler === "function" ? handler({ cwd, args }) : handler)
        .then((reply) => {
          const object = typeof reply === "object" && reply !== null
          text.stdout = object ? reply.stdout ?? "" : reply ?? ""
          text.stderr = object ? reply.stderr ?? "" : ""
          return { exitCode: object ? reply.exitCode ?? 0 : 0, signal: null }
        })
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: text.stdout }) },
          stderr: { readFrom: () => ({ text: text.stderr }) },
        },
      }
    },
  }
  return { subprocess, calls, keys: () => calls.map((call) => call.key) }
}

/**
 * A task space that already holds `alpha`, plus source repositories nowhere near it.
 *
 * The container and the repositories are separate temporary directories rather
 * than two levels of one, which is the arrangement this feature has to survive: a
 * repository added here need not share a directory with the ones the task began
 * with, and in production it may not even share a volume.
 * @param names - the source repositories to make, each a real `.git` directory.
 * @returns the paths, the metadata file, and a cleanup.
 */
async function taskFixture(names = ["gamma"]) {
  const base = await mkdtemp(join(tmpdir(), "multi-worktree-add-"))
  const container = join(base, "worktree-space")
  const taskPath = join(container, PROJECT, TASK)
  const sources = join(base, "elsewhere")
  await mkdir(join(taskPath, "alpha"), { recursive: true })
  // A linked worktree's `.git` is a file pointing back at its source repository.
  await writeFile(join(taskPath, "alpha", ".git"), "gitdir: /elsewhere/.git/worktrees/alpha\n")
  const metadata = {
    version: 1,
    task: TASK,
    project: PROJECT,
    tasksRoot: container,
    sourceRoot: join(base, "source"),
    branch: BRANCH,
    baseRef: null,
    createdAt: "2026-10-01T04:00:00.000Z",
    repositories: [{ name: "alpha", sourcePath: join(sources, "alpha"), sourceBranch: "main", startCommit: "a1", branch: BRANCH }],
  }
  await mkdir(join(taskPath, PLUGIN_ROOT), { recursive: true })
  await writeFile(recordAt(taskPath), `${JSON.stringify(metadata, null, 2)}\n`, "utf8")
  await writeFile(noteAt(taskPath), `# Task: ${TASK}\n`, "utf8")

  const repo = {}
  for (const name of names) {
    repo[name] = join(sources, name)
    await mkdir(join(repo[name], ".git"), { recursive: true })
  }
  return {
    base,
    container,
    taskPath,
    sources,
    repo,
    alpha: metadata.repositories[0].sourcePath,
    metadataPath: recordAt(taskPath),
    readMetadata: async () => JSON.parse(await readFile(recordAt(taskPath), "utf8")),
    /** The arguments of every `worktree add` this mock saw. */
    adds: (calls) => calls.filter((call) => call.args[0] === "worktree" && call.args[1] === "add").map((call) => call.args),
    cleanup: () => rm(base, { recursive: true, force: true }),
  }
}

/**
 * Replies that make adding to a task whose branch is `task/login` succeed: the
 * branch is free in the repository being added, its HEAD is a branch of its own,
 * and `worktree add` leaves a real linked worktree behind for the listing and the
 * rollback to find.
 *
 * `taskPath` says where the task's own worktrees are: the listing runs in those
 * and reads the branch off them, which is how a task without a record is still
 * known to be on `task/login`.
 * @param taskPath - the task space directory.
 * @returns the mock and the calls it recorded.
 */
function addSucceeds(taskPath) {
  return subprocessMock({
    "show-ref --verify --quiet refs/heads/task/login": { exitCode: 1 },
    "rev-parse --abbrev-ref HEAD": ({ cwd }) => (cwd.startsWith(taskPath) ? BRANCH : "main"),
    "rev-parse HEAD": "deadbeef",
    "status --porcelain": "",
    "worktree add": async ({ args }) => {
      await mkdir(args[2], { recursive: true })
      await writeFile(join(args[2], ".git"), "gitdir: /elsewhere/.git/worktrees/new\n", "utf8")
      return ""
    },
    // Removal is what a rollback is made of, so the mock has to really take the
    // checkout away — a `worktree remove` that only reported success would leave
    // the directory behind and the test would prove nothing. It also has to refuse a
    // path that is not a checkout, with the exit and sentence real git uses (measured
    // on 2.39.1: exit 128, "is not a working tree"): the rollback reads that answer to
    // tell a worktree git really made from one it never reached, and a double that
    // answered "ok" for both would hide the half-made case CR-13 is about.
    "worktree remove": async ({ args }) => {
      const target = args[args.length - 1]
      if (!existsSync(join(target, ".git"))) return { exitCode: 128, stderr: "fatal: not a working tree\n" }
      await rm(target, { recursive: true, force: true })
      return ""
    },
  })
}

describe("addTaskRepositories", () => {
  // A repository contributes its own directory name to the task space, so a name the
  // plugin has taken is refused before any worktree is cut - the same rule `create`
  // applies, which is what stops a repository refused at create from being added here
  // afterwards. End to end rather than on the validator alone: the point is that the
  // refusal reaches the caller as a request error, before anything is made.
  it("refuses a repository whose directory name the plugin itself uses", async () => {
    const fixture = await taskFixture()
    try {
      // A real repository on disk, named after the plugin's own directory, so the
      // refusal cannot be explained by the path being bogus.
      const collision = join(fixture.sources, PLUGIN_ROOT)
      await mkdir(join(collision, ".git"), { recursive: true })
      const { subprocess, calls } = addSucceeds(fixture.taskPath)

      await expect(addTaskRepositories(subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [collision],
      })).rejects.toThrow(/belongs to this plugin/)

      // Negative control: nothing was cut. A guard that refused after the worktree
      // existed would satisfy the assertion above and still have made the mess.
      expect(fixture.adds(calls)).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  it("refuses a repository path whose last segment is the relative name `..`", async () => {
    const fixture = await taskFixture()
    try {
      // The raw spelling a caller can send: `basename` answers `..` for it, and
      // `join(taskPath, '..')` is the project layer - one level above the task space,
      // and inside the container, so the delete fence allows it. Today only git's own
      // "destination directory is not empty" stops a worktree landing there; this
      // refuses it as the request error it is.
      const { subprocess, calls } = addSucceeds(fixture.taskPath)
      await expect(addTaskRepositories(subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [`${fixture.sources}/alpha/..`],
      })).rejects.toThrow(/must not be '\.' or '\.\.'/)
      expect(fixture.adds(calls)).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  it("gives the new repository a worktree on the branch the task is already on", async () => {
    const fixture = await taskFixture()
    const { subprocess, calls } = addSucceeds(fixture.taskPath)
    try {
      const result = await addTaskRepositories(subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [fixture.repo.gamma],
      })

      expect(result.branch).toBe(BRANCH)
      expect(result.path).toBe(fixture.taskPath)
      expect(result.repositories).toEqual([
        { name: "gamma", path: join(fixture.taskPath, "gamma"), sourcePath: fixture.repo.gamma },
      ])
      // The branch is the task's own, so the commits of both repositories hang
      // together the way the task's original ones do.
      expect(fixture.adds(calls)).toEqual([["worktree", "add", join(fixture.taskPath, "gamma"), "-b", BRANCH]])
      expect(existsSync(join(fixture.taskPath, "gamma"))).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  it("records where each source repository lives, without disturbing the ones already there", async () => {
    const fixture = await taskFixture()
    try {
      const before = await fixture.readMetadata()
      await addTaskRepositories(addSucceeds(fixture.taskPath).subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [fixture.repo.gamma],
      })
      const after = await fixture.readMetadata()

      expect(after.repositories.map((entry) => entry.name)).toEqual(["alpha", "gamma"])
      // What a task began from stays what it was; where it began from is still
      // where it began from, even though `gamma` sits somewhere else entirely.
      expect(after.sourceRoot).toBe(before.sourceRoot)
      expect(after.createdAt).toBe(before.createdAt)
      expect(after.repositories[0]).toEqual(before.repositories[0])
      expect(after.repositories[1]).toMatchObject({ name: "gamma", sourcePath: fixture.repo.gamma, branch: BRANCH, sourceBranch: "main" })
      // The note a session reads is rendered from that record, so it lists it too.
      expect(await readFile(noteAt(fixture.taskPath), "utf8")).toContain("gamma")
    } finally {
      await fixture.cleanup()
    }
  })

  it("starts from a named base when one is asked for", async () => {
    const fixture = await taskFixture()
    const { subprocess, calls } = subprocessMock({
      "show-ref --verify --quiet refs/heads/task/login": { exitCode: 1 },
      "rev-parse --abbrev-ref HEAD": ({ cwd }) => (cwd.startsWith(fixture.taskPath) ? BRANCH : "main"),
      "rev-parse HEAD": "deadbeef",
      "status --porcelain": "",
      "worktree add": async ({ args }) => {
        await mkdir(args[2], { recursive: true })
        await writeFile(join(args[2], ".git"), "gitdir: /elsewhere/.git/worktrees/new\n", "utf8")
        return ""
      },
    })
    try {
      await addTaskRepositories(subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [fixture.repo.gamma],
        baseRef: "release",
      })
      expect(fixture.adds(calls)).toEqual([
        ["worktree", "add", join(fixture.taskPath, "gamma"), "-b", BRANCH, "release"],
      ])
    } finally {
      await fixture.cleanup()
    }
  })

  // The task's `baseRef` answers one question - where did this task start - and an add
  // does not change the answer. It used to be rewritten by any add that named a base, so
  // a task created from `main` and later extended from `release` had its record claim it
  // began at `release`, and the repositories cut at create time were described by a base
  // they were never taken from. The note a session reads is rendered from that same
  // field, so the wrong answer reached the reader too.
  it("does not rewrite the task's own base when this call names one", async () => {
    const fixture = await taskFixture()
    const recorded = await fixture.readMetadata()
    await writeFile(fixture.metadataPath, `${JSON.stringify({ ...recorded, baseRef: "main" }, null, 2)}\n`, "utf8")
    try {
      const result = await addTaskRepositories(addSucceeds(fixture.taskPath).subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [fixture.repo.gamma],
        baseRef: "release",
      })
      const after = await fixture.readMetadata()

      // The task's identity is untouched by the add...
      expect(after.baseRef).toBe("main")
      // ...the note rendered from it still says `main`, so the reader is not misled...
      expect(await readFile(noteAt(fixture.taskPath), "utf8")).toContain("- Base: `main`")
      // ...and the base this call actually used is reported to its caller rather than
      // dropped, so the fact is not lost - it is just not written into the identity.
      expect(result.baseRef).toBe("release")
      // The repository this call added still records the commit it was cut from, which
      // is the stronger statement about where it started.
      expect(after.repositories.find((entry) => entry.name === "gamma")).toMatchObject({ name: "gamma", startCommit: "deadbeef" })
    } finally {
      await fixture.cleanup()
    }
  })

  it("leaves the task's base alone when the add names none, and reports none", async () => {
    // The negative control for the case above: a create that named no base has `null`
    // in the record, and an add without one must leave that `null` rather than turn it
    // into an empty string or a fabricated ref.
    const fixture = await taskFixture()
    try {
      const before = await fixture.readMetadata()
      expect(before.baseRef).toBe(null)
      const result = await addTaskRepositories(addSucceeds(fixture.taskPath).subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [fixture.repo.gamma],
      })
      const after = await fixture.readMetadata()
      expect(after.baseRef).toBe(null)
      expect(result.baseRef).toBeUndefined()
    } finally {
      await fixture.cleanup()
    }
  })

  it("refuses a repository the task already holds a worktree of", async () => {
    const fixture = await taskFixture(["alpha"])
    const { subprocess, calls } = addSucceeds(fixture.taskPath)
    try {
      // Every worktree is named after its source repository's directory, so a
      // second one called `alpha` could not be told apart from the first.
      await expect(addTaskRepositories(subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [fixture.repo.alpha],
      })).rejects.toThrow(/already holds a repository named 'alpha'/)
      expect(fixture.adds(calls)).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  it("refuses two repositories that would take the same worktree name", async () => {
    const fixture = await taskFixture()
    // Same directory name, two different places: which one is refused is not the
    // point, that neither could be is.
    const other = join(fixture.base, "second-source", "gamma")
    await mkdir(join(other, ".git"), { recursive: true })
    const { subprocess, calls } = addSucceeds(fixture.taskPath)
    try {
      await expect(addTaskRepositories(subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [fixture.repo.gamma, other],
      })).rejects.toThrow(/both named 'gamma'/)
      expect(fixture.adds(calls)).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  it("refuses a repository inside the task space, and one that holds it", async () => {
    const fixture = await taskFixture()
    const inside = join(fixture.taskPath, "nested")
    await mkdir(join(inside, ".git"), { recursive: true })
    try {
      // Its worktree would be written inside the repository it is meant to be a
      // checkout of.
      await expect(addTaskRepositories(addSucceeds(fixture.taskPath).subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [inside],
      })).rejects.toThrow(/sits inside the task space/)

      // And the container root itself, whose `.git` makes it a repository holding
      // every task space filed under it.
      await mkdir(join(fixture.container, ".git"), { recursive: true })
      await expect(addTaskRepositories(addSucceeds(fixture.taskPath).subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [fixture.container],
      })).rejects.toThrow(/holds the task space/)
    } finally {
      await fixture.cleanup()
    }
  })

  it("refuses a path that is not a source repository", async () => {
    const fixture = await taskFixture()
    await mkdir(join(fixture.base, "notes"), { recursive: true })
    try {
      await expect(addTaskRepositories(addSucceeds(fixture.taskPath).subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [join(fixture.base, "notes")],
      })).rejects.toThrow(/not a source repository/)
    } finally {
      await fixture.cleanup()
    }
  })

  it("refuses a repository that already has the task's branch", async () => {
    const fixture = await taskFixture()
    const { subprocess } = subprocessMock({
      "show-ref --verify --quiet refs/heads/task/login": "",
      "rev-parse --abbrev-ref HEAD": ({ cwd }) => (cwd.startsWith(fixture.taskPath) ? BRANCH : "main"),
      "status --porcelain": "",
    })
    try {
      await expect(addTaskRepositories(subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [fixture.repo.gamma],
      })).rejects.toThrow(/branch 'task\/login' already exists in 'gamma'/)
    } finally {
      await fixture.cleanup()
    }
  })

  it("refuses a base one of the repositories does not have, before making anything", async () => {
    const fixture = await taskFixture()
    // The base is resolved in every repository before the first worktree is cut,
    // so a ref one of them does not have costs nothing rather than half the work.
    const { subprocess, keys } = subprocessMock({
      "show-ref --verify --quiet refs/heads/task/login": { exitCode: 1 },
      "rev-parse --verify --quiet": { exitCode: 1 },
      "rev-parse --abbrev-ref HEAD": ({ cwd }) => (cwd.startsWith(fixture.taskPath) ? BRANCH : "main"),
      "status --porcelain": "",
    })
    try {
      await expect(addTaskRepositories(subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [fixture.repo.gamma],
        baseRef: "no-such-ref",
      })).rejects.toThrow(/base 'no-such-ref' not found in 'gamma'/)
      expect(keys().some((key) => key.startsWith("worktree add"))).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  it("accepts a base every repository has", async () => {
    const fixture = await taskFixture()
    // The base resolves in the repository and then names the commit the new branch
    // starts from — the last argument of `worktree add`, after the branch.
    const { subprocess, calls } = addSucceeds(fixture.taskPath)
    try {
      await addTaskRepositories(subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [fixture.repo.gamma],
        baseRef: "release",
      })
      expect(fixture.adds(calls)).toEqual([
        ["worktree", "add", join(fixture.taskPath, "gamma"), "-b", BRANCH, "release"],
      ])
    } finally {
      await fixture.cleanup()
    }
  })

  it("takes back only what this call made, and leaves the task's own record alone", async () => {
    const fixture = await taskFixture(["gamma", "beta"])
    const base = addSucceeds(fixture.taskPath)
    const subprocess = {
      spawn(request) {
        const key = parseGitArgv(request.argv).args.join(" ")
        // The first repository goes in; the second is refused by git, which is
        // the only failure that can arrive after validation has passed.
        if (key.startsWith("worktree add") && key.includes("beta")) {
          return {
            done: Promise.resolve({ exitCode: 1, signal: null }),
            collected: {
              stdout: { readFrom: () => ({ text: "" }) },
              stderr: { readFrom: () => ({ text: "fatal: could not add worktree\n" }) },
            },
          }
        }
        return base.subprocess.spawn(request)
      },
    }
    try {
      const before = await fixture.readMetadata()
      await expect(addTaskRepositories(subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [fixture.repo.gamma, fixture.repo.beta],
      })).rejects.toThrow(/could not add worktree/)

      // The repository that went in was made by this call, so it is gone again;
      // the task's own worktree was not touched and is still on disk.
      expect(existsSync(join(fixture.taskPath, "alpha"))).toBe(true)
      expect(existsSync(join(fixture.taskPath, "gamma"))).toBe(false)
      // And the record still says what it said: the worktrees are written to it
      // only once every one of them exists.
      expect(await fixture.readMetadata()).toEqual(before)
    } finally {
      await fixture.cleanup()
    }
  })

  it("takes the branch back with the worktree it made, so the task name is usable again", async () => {
    const fixture = await taskFixture(["gamma", "beta"])
    const base = addSucceeds(fixture.taskPath)
    const subprocess = {
      spawn(request) {
        const key = parseGitArgv(request.argv).args.join(" ")
        // The first repository goes in; the second is refused by git, which is the
        // only failure that can arrive after validation has passed.
        if (key.startsWith("worktree add") && key.includes("beta")) {
          return {
            done: Promise.resolve({ exitCode: 1, signal: null }),
            collected: {
              stdout: { readFrom: () => ({ text: "" }) },
              stderr: { readFrom: () => ({ text: "fatal: could not add worktree\n" }) },
            },
          }
        }
        return base.subprocess.spawn(request)
      },
    }
    try {
      const failure = await addTaskRepositories(subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [fixture.repo.gamma, fixture.repo.beta],
      }).then(() => undefined, (error) => error)

      // `worktree add -b` makes the branch, and `worktree remove` never deletes it.
      // Left behind it takes the name for good: the next create or add of this task
      // is refused with E3001 in the repository that still carries it, and nothing
      // in the plugin can clear it.
      const removed = base.calls.findIndex((call) => call.key === `worktree remove --force ${join(fixture.taskPath, "gamma")}`)
      const deleted = base.calls.findIndex((call) => call.key === "branch -D -- task/login")
      expect(removed).toBeGreaterThanOrEqual(0)
      // After the removal, never before: the worktree is holding the branch until it
      // is gone, and git refuses to delete a branch a checkout still has.
      expect(deleted).toBeGreaterThan(removed)
      // In the repository whose worktree was holding it, and in no other.
      expect(base.calls.filter((call) => call.key === "branch -D -- task/login").map((call) => call.cwd)).toEqual([fixture.repo.gamma])

      // The caller still reads the failure git reported, not a rollback outcome:
      // taking the branch back is what makes that message true again.
      expect(failure.message).toMatch(/could not add worktree/)
      expect(existsSync(join(fixture.taskPath, "gamma"))).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  it("names a branch it could not take back instead of saying it left nothing", async () => {
    const fixture = await taskFixture(["gamma", "beta"])
    const base = addSucceeds(fixture.taskPath)
    const subprocess = {
      spawn(request) {
        const key = parseGitArgv(request.argv).args.join(" ")
        if (key.startsWith("worktree add") && key.includes("beta")) {
          return {
            done: Promise.resolve({ exitCode: 1, signal: null }),
            collected: {
              stdout: { readFrom: () => ({ text: "" }) },
              stderr: { readFrom: () => ({ text: "fatal: could not add worktree\n" }) },
            },
          }
        }
        if (key === "branch -D -- task/login") {
          return {
            done: Promise.resolve({ exitCode: 1, signal: null }),
            collected: {
              stdout: { readFrom: () => ({ text: "" }) },
              stderr: { readFrom: () => ({ text: "error: cannot delete branch\n" }) },
            },
          }
        }
        return base.subprocess.spawn(request)
      },
    }
    try {
      // A branch still on disk is exactly what the record must not deny, so it is
      // named to the caller instead of hiding behind "rolled back".
      await expect(addTaskRepositories(subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [fixture.repo.gamma, fixture.repo.beta],
      })).rejects.toThrow(/could not roll back: gamma's branch task\/login/)
    } finally {
      await fixture.cleanup()
    }
  })

  it("takes back a worktree git made and then failed on, so nothing half-made is left", async () => {
    const fixture = await taskFixture()
    // `worktree add` can create the branch and the checkout and *then* fail - a failed
    // checkout, a hook, a lock, a full disk. The mock reproduces exactly that: the
    // checkout is made and git still reports a non-zero exit.
    const { subprocess, calls } = subprocessMock({
      "show-ref --verify --quiet refs/heads/task/login": { exitCode: 1 },
      "rev-parse --abbrev-ref HEAD": ({ cwd }) => (cwd.startsWith(fixture.taskPath) ? BRANCH : "main"),
      "rev-parse HEAD": "deadbeef",
      "status --porcelain": "",
      "worktree add": async ({ args }) => {
        await mkdir(args[2], { recursive: true })
        await writeFile(join(args[2], ".git"), "gitdir: /elsewhere/.git/worktrees/new\n", "utf8")
        return { exitCode: 1, stderr: "fatal: could not check out" }
      },
      "worktree remove": async ({ args }) => {
        await rm(args[args.length - 1], { recursive: true, force: true })
        return ""
      },
    })
    try {
      const before = await fixture.readMetadata()
      await expect(addTaskRepositories(subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [fixture.repo.gamma],
      })).rejects.toThrow(/could not check out/)

      // The half-made checkout was inside the rollback's scope, and the branch it was
      // holding went with it. Left behind, that branch is what no later add or create
      // of this task can work around.
      expect(existsSync(join(fixture.taskPath, "gamma"))).toBe(false)
      expect(calls.some((call) => call.key === "branch -D -- task/login")).toBe(true)
      // And the task's own record is exactly as it was: the worktrees are written to it
      // only once every one of them exists.
      expect(await fixture.readMetadata()).toEqual(before)
    } finally {
      await fixture.cleanup()
    }
  })

  it("takes back the record it wrote when the container had none, so the repository can be added again", async () => {
    const fixture = await taskFixture()
    // A space made before the JSON existed carries no record of its own, only the
    // note - so whatever this call writes is the only record there will be.
    await rm(fixture.metadataPath)
    const halfWritten = subprocessMock({
      "show-ref --verify --quiet refs/heads/task/login": { exitCode: 1 },
      "rev-parse --abbrev-ref HEAD": ({ cwd }) => (cwd.startsWith(fixture.taskPath) ? BRANCH : "main"),
      "rev-parse HEAD": "deadbeef",
      "status --porcelain": "",
      // The worktree goes in, and so does a directory where the note belongs: the
      // record is written first and the note second, so this is the half-written
      // state - a record on disk naming a repository whose worktree is about to go.
      "worktree add": async ({ args }) => {
        await mkdir(args[2], { recursive: true })
        await rm(noteAt(fixture.taskPath), { force: true })
        await mkdir(noteAt(fixture.taskPath))
        return ""
      },
      "worktree remove": async ({ args }) => {
        await rm(args[args.length - 1], { recursive: true, force: true })
        return ""
      },
    })
    try {
      await expect(addTaskRepositories(halfWritten.subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [fixture.repo.gamma],
      })).rejects.toThrow()

      // Left behind, that record is the only thing naming 'gamma', so the next
      // request to add it is refused as a name this task already holds.
      expect(existsSync(recordAt(fixture.taskPath))).toBe(false)
      const retry = subprocessMock({
        "show-ref --verify --quiet refs/heads/task/login": { exitCode: 1 },
        "rev-parse --abbrev-ref HEAD": ({ cwd }) => (cwd.startsWith(fixture.taskPath) ? BRANCH : "main"),
        "rev-parse HEAD": "deadbeef",
        "status --porcelain": "",
        "worktree add": { exitCode: 128, stderr: "fatal: could not add worktree" },
      })
      await expect(addTaskRepositories(retry.subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [fixture.repo.gamma],
      })).rejects.toThrow(/could not add worktree/)
    } finally {
      await fixture.cleanup()
    }
  })

  it("gives the caller the code git put on the failure, and records the same one", async () => {
    const fixture = await taskFixture(["gamma", "beta"])
    const base = addSucceeds(fixture.taskPath)
    const subprocess = {
      spawn(request) {
        const key = parseGitArgv(request.argv).args.join(" ")
        // The first repository goes in; the second fails on something git names,
        // which is the code the caller has to be told rather than a catch-all.
        if (key.startsWith("worktree add") && key.includes("beta")) {
          return {
            done: Promise.resolve({ exitCode: 128, signal: null }),
            collected: {
              stdout: { readFrom: () => ({ text: "" }) },
              stderr: { readFrom: () => ({ text: "fatal: not a git repository\n" }) },
            },
          }
        }
        return base.subprocess.spawn(request)
      },
    }
    try {
      const failure = await addTaskRepositories(subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [fixture.repo.gamma, fixture.repo.beta],
      }).then(() => undefined, (error) => error)

      // The error is rebuilt, to carry the rollback's outcome in its message, and
      // `recover` reads the code off it with no classifier to fall back on.
      expect(failure.code).toBe("E3004")
      // And the record says the same thing: a code read off either end has to be
      // the one to grep for.
      const written = (await readAudit(fixture.container)).filter((record) => record.kind === "error")
      expect(written.map((record) => record.code)).toEqual(["E3004"])
    } finally {
      await fixture.cleanup()
    }
  })

  it("refuses an empty request and a task space that is not there", async () => {
    const fixture = await taskFixture()
    const { subprocess } = addSucceeds(fixture.taskPath)
    try {
      await expect(addTaskRepositories(subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [],
      })).rejects.toThrow(/name at least one repository/)
      await expect(addTaskRepositories(subprocess, {
        task: "absent",
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [fixture.repo.gamma],
      })).rejects.toThrow(/no such task space/)
    } finally {
      await fixture.cleanup()
    }
  })

  it("takes the branch from the worktrees when the record does not name one", async () => {
    const fixture = await taskFixture()
    // A space made before the JSON existed answers with its Markdown note; one
    // whose note was lost has only its worktrees left to say what it is.
    await rm(fixture.metadataPath)
    const { subprocess, calls } = subprocessMock({
      "show-ref --verify --quiet refs/heads/task/login": { exitCode: 1 },
      "rev-parse --abbrev-ref HEAD": ({ cwd }) => (cwd.startsWith(fixture.taskPath) ? BRANCH : "main"),
      "rev-parse HEAD": "deadbeef",
      "status --porcelain": "",
      "worktree list --porcelain": `worktree ${fixture.alpha}\nHEAD a1\nbranch refs/heads/main\n`,
      "worktree add": "",
    })
    try {
      const result = await addTaskRepositories(subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [fixture.repo.gamma],
      })
      expect(result.branch).toBe(BRANCH)
      expect(fixture.adds(calls)).toEqual([["worktree", "add", join(fixture.taskPath, "gamma"), "-b", BRANCH]])
      // The thin record is rebuilt from the disk rather than written back thin, so
      // the repository that was already there is not dropped from it.
      const after = await fixture.readMetadata()
      expect(after.repositories.map((entry) => entry.name)).toEqual(["alpha", "gamma"])
      // And it is a current record, not the old shape with a list added to it.
      expect(after.version).toBe(1)
    } finally {
      await fixture.cleanup()
    }
  })

  it("refuses a task whose worktrees do not agree on a branch", async () => {
    const fixture = await taskFixture()
    await rm(fixture.metadataPath)
    // Two worktrees, on two branches: a container that names no branch of its own
    // has to say which one this task is, and this cannot.
    await mkdir(join(fixture.taskPath, "delta"), { recursive: true })
    await writeFile(join(fixture.taskPath, "delta", ".git"), "gitdir: /elsewhere/.git/worktrees/delta\n", "utf8")
    const { subprocess } = subprocessMock({
      "rev-parse --abbrev-ref HEAD": ({ cwd }) => (basename(cwd) === "delta" ? "task/other" : BRANCH),
      "status --porcelain": "",
    })
    try {
      await expect(addTaskRepositories(subprocess, {
        task: TASK,
        project: PROJECT,
        tasksRoot: fixture.container,
        repositories: [fixture.repo.gamma],
      })).rejects.toThrow(/do not agree on a branch/)
    } finally {
      await fixture.cleanup()
    }
  })
})
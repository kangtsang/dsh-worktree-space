import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { addTaskRepositories } from "../src/host/task/add.js"
import { readAudit } from "../src/host/task/audit-log.js"

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
      const cwd = argv[2]
      const args = argv.slice(3)
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
  await writeFile(join(taskPath, "worktree-space.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8")
  await writeFile(join(taskPath, "worktree-space.md"), `# Task: ${TASK}\n`, "utf8")

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
    metadataPath: join(taskPath, "worktree-space.json"),
    readMetadata: async () => JSON.parse(await readFile(join(taskPath, "worktree-space.json"), "utf8")),
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
    // the directory behind and the test would prove nothing.
    "worktree remove": async ({ args }) => {
      await rm(args[args.length - 1], { recursive: true, force: true })
      return ""
    },
  })
}

describe("addTaskRepositories", () => {
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
      expect(await readFile(join(fixture.taskPath, "worktree-space.md"), "utf8")).toContain("gamma")
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
        const key = request.argv.slice(3).join(" ")
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
        await rm(join(fixture.taskPath, "worktree-space.md"), { force: true })
        await mkdir(join(fixture.taskPath, "worktree-space.md"))
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
      expect(existsSync(join(fixture.taskPath, "worktree-space.json"))).toBe(false)
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
        const key = request.argv.slice(3).join(" ")
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
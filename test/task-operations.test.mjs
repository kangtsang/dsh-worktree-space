import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import {
  BREADCRUMB,
  classifySourceRoot,
  createTask,
  finishTask,
  inspectTask,
  listTasks,
  planTask,
  readTaskMetadata,
  resolveMergeTarget,
  suggestTaskRoot,
} from "../src/host/task/operations.js"
import { readAudit } from "../src/host/task/audit-log.js"

/**
 * What a finish said, as one string.
 *
 * A warning is reported as the sentence the Host wrote plus the values a screen needs to
 * say it in another language; an assertion about the wording wants the sentence, and this
 * is where it says so.
 * @param result - a finish result.
 * @returns the warnings' sentences, joined.
 */
const warningText = (result) => result.warnings.map((entry) => entry.message).join(" ")

/**
 * Whether this process may create a symbolic link.
 *
 * The one thing the archive's link handling turns on, and the reason that test branches
 * instead of asserting one platform's answer: `fs.cp` recreates a link rather than
 * copying what it points at, so a machine that refuses to create one cannot file a
 * stray holding one at all. Probed here the way the plugin probes it.
 */
const CAN_CREATE_SYMLINKS = (() => {
  const probe = mkdtempSync(join(tmpdir(), "multi-worktree-link-probe-"))
  try {
    symlinkSync(join(probe, "target"), join(probe, "link"))
    return true
  } catch {
    return false
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
})()

/**
 * The metadata record a task space carries: the JSON `createTask` writes and
 * the note rendered from it. Fixtures use this so a hand-built container looks
 * like one the plugin made, rather than like one from before the JSON existed.
 * @param task - the task's name.
 * @returns the two file contents, keyed by file name.
 */
function metadataFiles(task) {
  const metadata = {
    version: 1,
    task,
    tasksRoot: "E:/worktree-space",
    sourceRoot: "E:/source",
    branch: "task/" + task,
    baseRef: null,
    createdAt: "2026-09-28T04:00:00.000Z",
    repositories: [],
  }
  return {
    "worktree-space.json": JSON.stringify(metadata, null, 2) + "\n",
    "worktree-space.md": "# Task: " + task + "\n",
  }
}

/**
 * Subprocess double: keys replies by the git arguments after the implicit
 * `-C <cwd>`, records every call, and lets one reply run a side effect so a
 * mocked removal can still change the filesystem. An exact key wins; otherwise
 * the longest key the call starts with applies, so a reply can cover every
 * worktree path without naming each one.
 * @param handlers - reply per argument key: a result, or a function of the call.
 * @returns the service double, its recorded calls, and their argument keys.
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
      // A reply that puts something on disk is only meaningful once it is there.
      // The code under test reads the filesystem the moment a git call reports
      // back, so an async handler's side effects belong inside the reply.
      //
      // A promise is an object, so `typeof reply === "object"` was true for one and
      // the branch below read `.exitCode` off the promise itself - undefined, so it
      // answered 0 at once and left the side effects running unwatched. It passed
      // because the filesystem calls inside a handler happened to finish first, and
      // that is a scheduling race rather than a guarantee.
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
 * The project layer a hand-built task space is filed under.
 *
 * A real create derives it from the source root's own directory name; the
 * fixtures below build their container by hand and name it instead.
 */
const PROJECT = "kratos-admin"

/**
 * A source root holding two repositories, as real `.git` directories.
 *
 * The root is a named directory inside the temporary one rather than the
 * temporary directory itself: a create files the task space under the source
 * root's own name, so a random name would make every expected path random too.
 */
async function sourceFixture() {
  const base = await mkdtemp(join(tmpdir(), "multi-worktree-ops-"))
  const root = join(base, PROJECT)
  for (const name of ["alpha", "beta"]) await mkdir(join(root, name, ".git"), { recursive: true })
  return {
    root,
    base,
    project: PROJECT,
    alpha: join(root, "alpha"),
    beta: join(root, "beta"),
    cleanup: () => rm(base, { recursive: true, force: true }),
  }
}

/** A container root outside any source tree. */
async function containerFixture() {
  const root = await mkdtemp(join(tmpdir(), "multi-worktree-container-"))
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** Replies that make a create of `task/<task>` succeed across both repositories. */
const branchIsNew = (branch) => ({ [`show-ref --verify --quiet refs/heads/${branch}`]: { exitCode: 1 } })

describe("classifySourceRoot", () => {
  it("accepts a directory whose top-level children are repositories", async () => {
    const source = await sourceFixture()
    try {
      const result = await classifySourceRoot(source.root)
      // The multi-repository case the Web UI entry has to recognise: the
      // workspace is a container, not a repository itself.
      expect(result).toMatchObject({ isSourceRoot: true, isRepository: false, repositoryCount: 2 })
      expect(result.repositories.map((entry) => entry.name)).toEqual(["alpha", "beta"])
    } finally {
      await source.cleanup()
    }
  })

  it("accepts a single repository as its own source root", async () => {
    const source = await sourceFixture()
    try {
      const result = await classifySourceRoot(source.alpha)
      expect(result).toMatchObject({ isSourceRoot: true, isRepository: true, repositoryCount: 1 })
      expect(result.repositories.map((entry) => entry.name)).toEqual(["alpha"])
    } finally {
      await source.cleanup()
    }
  })

  it("refuses a linked worktree, which is a checkout rather than a source", async () => {
    const root = await mkdtemp(join(tmpdir(), "multi-worktree-linked-"))
    const linked = join(root, "linked")
    await mkdir(linked, { recursive: true })
    await writeFile(join(linked, ".git"), "gitdir: /elsewhere/.git/worktrees/linked\n")
    try {
      const result = await classifySourceRoot(linked)
      expect(result).toMatchObject({ isSourceRoot: false, isRepository: false, repositoryCount: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reports a directory with no repositories, and a missing one, as unusable", async () => {
    const root = await mkdtemp(join(tmpdir(), "multi-worktree-plain-"))
    try {
      await mkdir(join(root, "notes"), { recursive: true })
      expect(await classifySourceRoot(root)).toMatchObject({ isSourceRoot: false, repositoryCount: 0 })
      expect(await classifySourceRoot(join(root, "absent"))).toMatchObject({ isSourceRoot: false, repositoryCount: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("suggestTaskRoot", () => {
  it("reports the discovered repositories alongside the suggested container", async () => {
    const source = await sourceFixture()
    // The dialog names each repository's current branch, so the suggestion asks git.
    const { subprocess } = subprocessMock({ "rev-parse --abbrev-ref HEAD": ({ cwd }) => (basename(cwd) === "alpha" ? "main" : "develop") })
    try {
      const result = await suggestTaskRoot(subprocess, source.root)
      expect(result.sourceRoot).toBe(source.root)
      expect(result.explicit).toBe(false)
      expect(result.suggested.length).toBeGreaterThan(0)
      expect(result.repositories).toEqual([
        { name: "alpha", path: source.alpha, branch: "main" },
        { name: "beta", path: source.beta, branch: "develop" },
      ])
    } finally {
      await source.cleanup()
    }
  })

  it("names no branch for a detached HEAD, which is on none", async () => {
    const source = await sourceFixture()
    const { subprocess } = subprocessMock({ "rev-parse --abbrev-ref HEAD": "HEAD" })
    try {
      const result = await suggestTaskRoot(subprocess, source.root)
      expect(result.repositories.map((entry) => entry.branch)).toEqual([undefined, undefined])
    } finally {
      await source.cleanup()
    }
  })

  it("marks a caller-supplied container as explicit", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    try {
      const result = await suggestTaskRoot(subprocessMock().subprocess, source.root, { tasksRoot: container.root })
      expect(result).toMatchObject({ suggested: container.root, explicit: true })
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("refuses a container inside the repositories' directory", async () => {
    const source = await sourceFixture()
    try {
      await expect(suggestTaskRoot(subprocessMock().subprocess, source.root, { tasksRoot: join(source.root, "tasks") })).rejects.toThrow(
        /is inside the repositories' directory/,
      )
    } finally {
      await source.cleanup()
    }
  })

  it("opens on the configured container root when the caller names none", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    try {
      // The suggestion is what the create dialog shows, so a configured location
      // the suggestion ignored would make the dialog show one root and create
      // under another.
      const configured = await suggestTaskRoot(subprocessMock().subprocess, source.root, { configuredRoot: container.root })
      expect(configured).toMatchObject({ suggested: container.root, explicit: false })

      // A caller who names one still wins: the setting is a default, not a rule.
      const named = join(container.root, "named")
      const asked = await suggestTaskRoot(subprocessMock().subprocess, source.root, { tasksRoot: named, configuredRoot: container.root })
      expect(asked).toMatchObject({ suggested: named, explicit: true })
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("refuses a configured container that sits inside the repositories' directory", async () => {
    const source = await sourceFixture()
    try {
      // The configured location is judged by the same rule as a typed-in one, so a
      // setting that would nest task spaces inside the source is refused rather
      // than quietly overridden.
      await expect(suggestTaskRoot(subprocessMock().subprocess, source.root, { configuredRoot: join(source.root, "tasks") }))
        .rejects.toThrow(/is inside the repositories' directory/)
    } finally {
      await source.cleanup()
    }
  })
})

describe("createTask", () => {
  it("makes one worktree per repository on one shared branch and records the task", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    const { subprocess, keys } = subprocessMock(branchIsNew("task/fix-login"))
    try {
      const result = await createTask(subprocess, {
        sourceRoot: source.root,
        task: "fix-login",
        tasksRoot: container.root,
      })

      expect(result.branch).toBe("task/fix-login")
      // The project layer is the source root's own directory name, so the task
      // space is `<container root>/<project>/<task>`.
      expect(result.project).toBe(source.project)
      expect(result.path).toBe(join(container.root, source.project, "fix-login"))
      expect(result.repositories.map((entry) => entry.name)).toEqual(["alpha", "beta"])

      const adds = keys().filter((key) => key.startsWith("worktree add"))
      expect(adds).toEqual([
        `worktree add ${join(container.root, source.project, "fix-login", "alpha")} -b task/fix-login`,
        `worktree add ${join(container.root, source.project, "fix-login", "beta")} -b task/fix-login`,
      ])

      const metadata = JSON.parse(await readFile(join(result.path, "worktree-space.json"), "utf8"))
      expect(metadata.task).toBe("fix-login")
      expect(metadata.project).toBe(source.project)
      expect(metadata.branch).toBe("task/fix-login")
      expect(metadata.baseRef).toBe(null)
      expect(metadata.sourceRoot).toBe(source.root)
      expect(metadata.repositories.map((entry) => entry.name)).toEqual(["alpha", "beta"])
      expect(typeof metadata.createdAt).toBe("string")
      // The note a session reads is generated from that record, so the two cannot
      // disagree; it says where its own facts come from.
      const note = await readFile(join(result.path, "worktree-space.md"), "utf8")
      expect(note).toContain("# Task: fix-login")
      expect(note).toContain(`- Project: \`${source.project}\``)
      expect(note).toContain("- Branch: `task/fix-login` (one branch per repository below)")
      expect(note).toContain("each repository's current HEAD")
      expect(note).toContain("- `alpha`")
      expect(note).toContain("Source repositories are read-only")
      expect(note).toContain("worktree-space.json")
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("starts every repository from a named base and honours a branch prefix", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    const { subprocess, keys } = subprocessMock({
      ...branchIsNew("hotfix/login"),
      "rev-parse --verify --quiet main^{commit}": "",
    })
    try {
      const result = await createTask(subprocess, {
        sourceRoot: source.root,
        task: "login",
        tasksRoot: container.root,
        baseRef: "main",
        branchPrefix: "hotfix/",
      })
      expect(result.branch).toBe("hotfix/login")
      expect(result.baseRef).toBe("main")
      expect(keys().filter((key) => key.startsWith("worktree add"))).toEqual([
        `worktree add ${join(container.root, source.project, "login", "alpha")} -b hotfix/login main`,
        `worktree add ${join(container.root, source.project, "login", "beta")} -b hotfix/login main`,
      ])
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("refuses a branch prefix Git would not accept, before touching a repository", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    const { subprocess, keys } = subprocessMock()
    try {
      await expect(createTask(subprocess, { sourceRoot: source.root, task: "login", tasksRoot: container.root, branchPrefix: "task /" }))
        .rejects.toThrow(/branch prefix must not contain/)
      expect(keys()).toEqual([])
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("creates only the selected repositories", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    const { subprocess, keys } = subprocessMock(branchIsNew("task/login"))
    try {
      const result = await createTask(subprocess, {
        sourceRoot: source.root,
        task: "login",
        tasksRoot: container.root,
        repos: ["beta"],
      })
      expect(result.repositories.map((entry) => entry.name)).toEqual(["beta"])
      expect(keys().filter((key) => key.startsWith("worktree add"))).toHaveLength(1)
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("refuses a task name that would change the layout", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    const { subprocess } = subprocessMock()
    try {
      await expect(createTask(subprocess, { sourceRoot: source.root, task: "fix login", tasksRoot: container.root }))
        .rejects.toThrow(/must not contain/)
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("refuses a branch that already exists in any repository", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    const { subprocess } = subprocessMock({ "show-ref --verify --quiet refs/heads/task/login": "" })
    try {
      await expect(createTask(subprocess, { sourceRoot: source.root, task: "login", tasksRoot: container.root }))
        .rejects.toThrow(/already exists in 'alpha'/)
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("refuses a base that a repository does not have", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    const { subprocess } = subprocessMock({
      ...branchIsNew("task/login"),
      "rev-parse --verify --quiet release^{commit}": { exitCode: 128, stderr: "unknown revision" },
    })
    try {
      await expect(createTask(subprocess, { sourceRoot: source.root, task: "login", tasksRoot: container.root, baseRef: "release" }))
        .rejects.toThrow(/base 'release' not found in 'alpha'/)
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("refuses an existing task directory", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    await mkdir(join(container.root, source.project, "login"), { recursive: true })
    const { subprocess } = subprocessMock(branchIsNew("task/login"))
    try {
      await expect(createTask(subprocess, { sourceRoot: source.root, task: "login", tasksRoot: container.root }))
        .rejects.toThrow(/already exists/)
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("refuses an explicitly empty repository selection instead of creating every one", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    const { subprocess, keys } = subprocessMock(branchIsNew("task/login"))
    try {
      await expect(createTask(subprocess, { sourceRoot: source.root, task: "login", tasksRoot: container.root, repos: [] }))
        .rejects.toThrow(/select at least one repository/)
      expect(keys()).toEqual([])
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("refuses a source root with no repositories", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    const empty = await mkdtemp(join(tmpdir(), "multi-worktree-empty-"))
    const { subprocess } = subprocessMock()
    try {
      await expect(createTask(subprocess, { sourceRoot: empty, task: "login", tasksRoot: container.root }))
        .rejects.toThrow(/no source repositories found/)
    } finally {
      await source.cleanup()
      await container.cleanup()
      await rm(empty, { recursive: true, force: true })
    }
  })

  it("rolls the partial create back when a later repository fails", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    const { subprocess, keys } = subprocessMock({
      ...branchIsNew("task/login"),
      [`worktree add ${join(container.root, source.project, "login", "beta")} -b task/login`]: { exitCode: 128, stderr: "fatal: cannot create" },
    })
    try {
      await expect(createTask(subprocess, { sourceRoot: source.root, task: "login", tasksRoot: container.root }))
        .rejects.toThrow(/cannot create/)

      expect(keys()).toContain(`worktree remove --force ${join(container.root, source.project, "login", "alpha")}`)
      expect(existsSync(join(container.root, source.project, "login"))).toBe(false)
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("takes the branch it made back with the worktrees, so the name is free again", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    const taskPath = join(container.root, source.project, "login")
    const { subprocess, calls } = subprocessMock({
      ...branchIsNew("task/login"),
      [`worktree add ${join(taskPath, "beta")} -b task/login`]: { exitCode: 128, stderr: "fatal: cannot create" },
    })
    try {
      await expect(createTask(subprocess, { sourceRoot: source.root, task: "login", tasksRoot: container.root }))
        .rejects.toThrow(/cannot create/)

      // Removing the worktree is half of what has to go back: the branch came
      // from `worktree add -b`, and git does not delete it with the checkout that
      // held it. Left behind it takes the name, and the same task cannot be
      // created again - which is what the record this rollback writes says.
      const removed = calls.findIndex((call) => call.key === `worktree remove --force ${join(taskPath, "alpha")}`)
      const deleted = calls.findIndex((call) => call.key === "branch -D -- task/login")
      expect(removed).toBeGreaterThanOrEqual(0)
      // After, not before: the branch is held by the worktree until that is gone.
      expect(deleted).toBeGreaterThan(removed)
      // In the repository whose worktree was holding it, and in no other: the
      // repository that failed never got a branch to take back.
      expect(calls.filter((call) => call.key === "branch -D -- task/login").map((call) => call.cwd)).toEqual([source.alpha])
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("names a branch it could not take back instead of saying it left nothing", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    const taskPath = join(container.root, source.project, "login")
    const { subprocess } = subprocessMock({
      ...branchIsNew("task/login"),
      [`worktree add ${join(taskPath, "beta")} -b task/login`]: { exitCode: 128, stderr: "fatal: cannot create" },
      "branch -D -- task/login": { exitCode: 1, stderr: "error: cannot delete branch" },
    })
    try {
      // A branch still on disk is exactly what the record must not deny, so it is
      // named to the caller instead of hiding behind "rolled back".
      await expect(createTask(subprocess, { sourceRoot: source.root, task: "login", tasksRoot: container.root }))
        .rejects.toThrow(/could not roll back: alpha's branch task\/login/)
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("gives the caller the code git put on the failure, and records the same one", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    const taskPath = join(container.root, source.project, "login")
    const { subprocess } = subprocessMock({
      ...branchIsNew("task/login"),
      [`worktree add ${join(taskPath, "beta")} -b task/login`]: { exitCode: 128, stderr: "fatal: not a git repository" },
    })
    try {
      const failure = await createTask(subprocess, { sourceRoot: source.root, task: "login", tasksRoot: container.root })
        .then(() => undefined, (error) => error)

      // The error is rebuilt, to carry the rollback's outcome in its message, and
      // `recover` reads the code off it with no classifier to fall back on: one
      // rebuilt without a code reaches the caller as E9001, which names nothing.
      expect(failure.code).toBe("E3004")
      // And the record says the same thing, because a code read off either end
      // has to be the one to grep for.
      const written = (await readAudit(container.root)).filter((record) => record.kind === "error")
      expect(written.map((record) => record.code)).toEqual(["E3004"])
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("answers E2005 for a failure with no code of its own, once everything is back", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    const taskPath = join(container.root, source.project, "login")
    const { subprocess } = subprocessMock({
      ...branchIsNew("task/login"),
      // The worktrees are really made, and so is a directory where the record
      // belongs: every worktree exists, and then the write that follows them
      // fails - the one failure in a create that carries no code of its own.
      "worktree add": async ({ args }) => {
        await mkdir(args[2], { recursive: true })
        await mkdir(join(taskPath, "worktree-space.json"), { recursive: true })
        return ""
      },
    })
    try {
      const failure = await createTask(subprocess, { sourceRoot: source.root, task: "login", tasksRoot: container.root })
        .then(() => undefined, (error) => error)

      expect(failure.code).toBe("E2005")
      const written = (await readAudit(container.root)).filter((record) => record.kind === "error")
      expect(written.map((record) => record.code)).toEqual(["E2005"])
      // Nothing was left behind, so the record says so - and E2005 rather than
      // E2006 is that claim as a code.
      expect(written[0].stranded).toBeUndefined()
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("says the task space was left behind when the container holds something it did not put there", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    const taskPath = join(container.root, source.project, "login")
    // The worktree git is mocked, so the directory it would have created is made
    // here - together with one entry this call did not put there, which is what a
    // user or another process dropping a file in mid-create looks like. The
    // container is then left alone on purpose, so the name is still taken.
    const makeWorktree = () => ({ exitCode: 0 })
    const { subprocess } = subprocessMock({
      ...branchIsNew("task/login"),
      [`worktree add ${join(taskPath, "alpha")} -b task/login`]: () => {
        mkdirSync(join(taskPath, "alpha"), { recursive: true })
        mkdirSync(join(taskPath, "not-ours"), { recursive: true })
        return makeWorktree()
      },
      [`worktree add ${join(taskPath, "beta")} -b task/login`]: { exitCode: 128, stderr: "fatal: cannot create" },
    })
    try {
      const failure = await createTask(subprocess, { sourceRoot: source.root, task: "login", tasksRoot: container.root })
        .then(() => undefined, (error) => error)

      // git's own code is the one that reaches the caller - the rollback outcome is
      // carried by `stranded`, not by overwriting it.
      expect(failure.code).toBe("E3003")
      expect(failure.message).toMatch(/could not roll back: the task space login/)
      expect(existsSync(taskPath)).toBe(true)

      const written = (await readAudit(container.root)).filter((record) => record.kind === "error")
      expect(written.map((record) => record.code)).toEqual(["E3003"])
      // The claim E2005 makes is that nothing is left, so naming the container here
      // is what keeps that claim true for every other failure that reaches it.
      expect(written[0].stranded).toEqual(["the task space login"])
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  })

describe("the container root", () => {
  it("writes its own note the first time, and never over one already there", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    const notice = join(container.root, "README.md")
    try {
      await createTask(subprocessMock(branchIsNew("task/login")).subprocess, {
        sourceRoot: source.root,
        task: "login",
        tasksRoot: container.root,
      })
      const written = await readFile(notice, "utf8")
      expect(written).toContain("git init")
      expect(written).toContain("Worktree Space")

      // A `README.md` in the container root is as likely to be the user's own, so
      // the note is written only where there is nothing to overwrite.
      await writeFile(notice, "# my own notes\n")
      await createTask(subprocessMock(branchIsNew("task/second")).subprocess, {
        sourceRoot: source.root,
        task: "second",
        tasksRoot: container.root,
      })
      expect(await readFile(notice, "utf8")).toBe("# my own notes\n")
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("lands in the configured root when the request names none, and in the named one when it does", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    try {
      // The request the dialog sends carries whatever root its field holds, so the
      // configured location has to be reachable through the request alone.
      const configured = await createTask(subprocessMock(branchIsNew("task/login")).subprocess, {
        sourceRoot: source.root,
        task: "login",
        configuredRoot: container.root,
      })
      expect(configured.path).toBe(join(container.root, source.project, "login"))

      // A root the request does name wins, and a configured one is not a rule: an
      // agent or a user who points a task somewhere else is obeyed.
      const elsewhere = join(container.root, "elsewhere")
      const named = await createTask(subprocessMock(branchIsNew("task/second")).subprocess, {
        sourceRoot: source.root,
        task: "second",
        tasksRoot: elsewhere,
        configuredRoot: container.root,
      })
      expect(named.path).toBe(join(elsewhere, source.project, "second"))
      expect(existsSync(join(container.root, source.project, "second"))).toBe(false)
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("refuses a configured root that nests inside the source, before touching anything", async () => {
    const source = await sourceFixture()
    const { subprocess, keys } = subprocessMock(branchIsNew("task/login"))
    try {
      await expect(createTask(subprocess, {
        sourceRoot: source.root,
        task: "login",
        configuredRoot: join(source.root, "tasks"),
      })).rejects.toThrow(/is inside the repositories' directory/)
      expect(keys().filter((key) => key.startsWith("worktree add"))).toEqual([])
    } finally {
      await source.cleanup()
    }
  })

  it("refuses a container root that is a git repository, before touching anything", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    // The one mistake this layout invites: a checkout at the root would make every
    // task space below it part of one.
    await mkdir(join(container.root, ".git"), { recursive: true })
    const { subprocess, keys } = subprocessMock(branchIsNew("task/login"))
    try {
      await expect(createTask(subprocess, { sourceRoot: source.root, task: "login", tasksRoot: container.root }))
        .rejects.toThrow(/is a git repository/)
      // The two git reads a create makes before it writes anything are the branch
      // and base checks, and they come first; what the check prevents is every
      // write, so a refusal leaves the user's filesystem as it was - no project
      // directory, no worktree, and no note either.
      expect(keys().filter((key) => key.startsWith("worktree add"))).toEqual([])
      expect(existsSync(join(container.root, source.project))).toBe(false)
      expect(existsSync(join(container.root, "README.md"))).toBe(false)
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("files two projects under one root without mixing their same-named tasks", async () => {
    const source = await sourceFixture()
    const other = join(source.base, "kratos-api")
    // A second source root, so both projects file a task called `login` into the
    // same container root: the project layer is what keeps them apart.
    await mkdir(join(other, "alpha", ".git"), { recursive: true })
    const container = await containerFixture()
    try {
      const first = await createTask(subprocessMock(branchIsNew("task/login")).subprocess, {
        sourceRoot: source.root,
        task: "login",
        tasksRoot: container.root,
      })
      const second = await createTask(subprocessMock(branchIsNew("task/login")).subprocess, {
        sourceRoot: other,
        task: "login",
        tasksRoot: container.root,
      })

      expect(first.project).toBe("kratos-admin")
      expect(second.project).toBe("kratos-api")
      expect(first.path).toBe(join(container.root, "kratos-admin", "login"))
      expect(second.path).toBe(join(container.root, "kratos-api", "login"))
      expect(existsSync(first.path)).toBe(true)
      expect(existsSync(second.path)).toBe(true)

      const listed = await listTasks(subprocessMock({
        "rev-parse --abbrev-ref HEAD": () => "task/login",
        "status --porcelain": "",
      }).subprocess, { tasksRoot: container.root })
      expect(listed.tasks.map((task) => `${task.project}/${task.name}`)).toEqual(["kratos-admin/login", "kratos-api/login"])
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("files a source root that is itself a repository under its own name", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    const { subprocess, keys } = subprocessMock(branchIsNew("task/login"))
    try {
      // `alpha` is a repository root rather than a directory of repositories, so it
      // is both the project and the one repository inside it - the name repeats,
      // which is what one directory being both things honestly looks like.
      const result = await createTask(subprocess, { sourceRoot: source.alpha, task: "login", tasksRoot: container.root })
      expect(result.project).toBe("alpha")
      expect(result.path).toBe(join(container.root, "alpha", "login"))
      expect(result.repositories.map((entry) => entry.name)).toEqual(["alpha"])
      expect(keys().filter((key) => key.startsWith("worktree add")))
        .toEqual([`worktree add ${join(container.root, "alpha", "login", "alpha")} -b task/login`])
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })
})

describe("listTasks", () => {
  it("reports each task's worktrees with branch and dirty count, skipping strays", async () => {
    const container = await containerFixture()
    const taskPath = join(container.root, PROJECT, "login")
    for (const name of ["alpha", "beta"]) {
      await mkdir(join(taskPath, name), { recursive: true })
      await writeFile(join(taskPath, name, ".git"), "gitdir: /elsewhere\n")
    }
    await writeFile(join(taskPath, "notes.md"), "stray")
    const { subprocess } = subprocessMock({
      "rev-parse --abbrev-ref HEAD": () => "task/login",
      "status --porcelain": ({ cwd }) => (basename(cwd) === "alpha" ? " M a.ts\n?? b.ts" : ""),
    })
    try {
      const result = await listTasks(subprocess, { tasksRoot: container.root })
      expect(result.tasks).toHaveLength(1)
      expect(result.tasks[0].name).toBe("login")
      expect(result.tasks[0].project).toBe(PROJECT)
      expect(result.tasks[0].repositories).toEqual([
        { name: "alpha", path: join(taskPath, "alpha"), branch: "task/login", changedFiles: 2 },
        { name: "beta", path: join(taskPath, "beta"), branch: "task/login", changedFiles: 0 },
      ])
    } finally {
      await container.cleanup()
    }
  })

  it("walks one level per project and leaves the archive folder out", async () => {
    const container = await containerFixture()
    const taskPath = join(container.root, "kratos-admin", "login")
    await mkdir(join(taskPath, "alpha"), { recursive: true })
    await writeFile(join(taskPath, "alpha", ".git"), "gitdir: /elsewhere\n")
    // A project whose tasks have all been finished: it holds no task, so it holds
    // no row. The project directory itself stays on disk.
    await mkdir(join(container.root, "kratos-api"), { recursive: true })
    // The `container` archive strategy files documents here, and names each folder
    // after the task it came from - so this directory would otherwise read as a
    // project holding one task per archived document folder.
    await mkdir(join(container.root, "archived-docs", "login-2026-09-26-14-30-05"), { recursive: true })
    // A loose file at the root is not a project either.
    await writeFile(join(container.root, "README.md"), "# Worktree Space\n")
    const { subprocess } = subprocessMock({
      "rev-parse --abbrev-ref HEAD": () => "task/login",
      "status --porcelain": "",
    })
    try {
      const result = await listTasks(subprocess, { tasksRoot: container.root })
      expect(result.tasks.map((task) => `${task.project}/${task.name}`)).toEqual(["kratos-admin/login"])
      expect(result.tasks[0].path).toBe(taskPath)
    } finally {
      await container.cleanup()
    }
  })

  it("answers empty for a container root that does not exist", async () => {
    const { subprocess } = subprocessMock()
    const result = await listTasks(subprocess, { tasksRoot: join(tmpdir(), "multi-worktree-absent-container") })
    expect(result.tasks).toEqual([])
  })

  it("requires a container root", async () => {
    const { subprocess } = subprocessMock()
    await expect(listTasks(subprocess, {})).rejects.toThrow(/tasks root is required/)
  })
})

describe("finishTask", () => {
  /** A task container holding two worktrees, plus replies for their git reads. */
  async function taskFixture() {
    const container = await containerFixture()
    const taskPath = join(container.root, PROJECT, "login")
    const mainRepos = {}
    const worktrees = new Set()
    for (const name of ["alpha", "beta"]) {
      await mkdir(join(taskPath, name), { recursive: true })
      await writeFile(join(taskPath, name, ".git"), "gitdir: /elsewhere\n")
      mainRepos[name] = join(tmpdir(), `multi-worktree-main-${name}`)
      worktrees.add(join(taskPath, name))
    }
    // The record a create leaves behind, and the only thing that says which branch
    // this task made. A finish deletes no branch without it: `git branch -D` runs
    // in the source repository, outside the container, so the name to delete comes
    // from here rather than from whatever a worktree has checked out now.
    await writeFile(join(taskPath, "worktree-space.json"), JSON.stringify({
      task: "login", project: PROJECT, branch: "task/login",
      // What a create records about the repositories it made worktrees of. A finish
      // reads it to recognise a repository whose directory git has stopped calling a
      // worktree, so a fixture without it is not the state the plugin leaves behind.
      repositories: ["alpha", "beta"].map((name) => ({ name, sourcePath: mainRepos[name], branch: "task/login" })),
    }, null, 2) + "\n")
    const porcelain = (name) =>
      `worktree ${mainRepos[name]}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${join(taskPath, name)}\nHEAD bbb\nbranch refs/heads/task/login\n`
    // Which repository a question is about. git answers the same from the source
    // repository and from any of its worktrees, and this double has to as well: a
    // finish asks from the source repository, because the worktree it is asking
    // about may have lost its `.git` by then.
    const repositoryAt = (cwd) => {
      if (worktrees.has(cwd)) return basename(cwd)
      return Object.keys(mainRepos).find((candidate) => mainRepos[candidate] === cwd) ?? basename(cwd)
    }
    const handlers = {
      // The worktrees carry the task branch; each source repository is on `main`,
      // which is the branch its merge therefore lands on.
      "rev-parse --abbrev-ref HEAD": ({ cwd }) => (worktrees.has(cwd) ? "task/login" : "main"),
      "worktree list --porcelain": ({ cwd }) => porcelain(repositoryAt(cwd)),
      "show-ref --verify --quiet refs/heads/main": "",
      // No merge is standing in these worktrees, which is what Git answers too: the
      // command succeeds only while `MERGE_HEAD` exists. Tests that leave a merge
      // behind answer for themselves, per working directory.
      "rev-parse --verify --quiet MERGE_HEAD": { exitCode: 1 },
    }
    return {
      container,
      taskPath,
      handlers,
      worktrees,
      mainRepos,
      /**
       * `finishTask` with the two coordinates this fixture filed the task under,
       * so each test states only the options it is actually about.
       */
      finish: (subprocess, options = {}) => finishTask(subprocess, { project: PROJECT, tasksRoot: container.root, ...options }),
      cleanup: () => container.cleanup(),
    }
  }

  it("merges, removes every worktree, deletes the branches and clears the container", async () => {
    const fixture = await taskFixture()
    const { subprocess, keys } = subprocessMock({
      ...fixture.handlers,
      // The mocked removal has to change the filesystem, or the container can
      // never become empty.
      "worktree remove": ({ args }) => {
        rmSync(args[2], { recursive: true, force: true })
        return ""
      },
    })
    try {
      const result = await fixture.finish(subprocess, {
        task: "login",
        merge: true,
        target: "main",
        deleteBranch: true,
      })

      expect(result.failed).toBe(false)
      expect(result.mergeTarget).toBe("main")
      expect(result.repositories.map((entry) => ({ merged: entry.merged, removed: entry.removed, branchDeleted: entry.branchDeleted })))
        .toEqual([
          { merged: true, removed: true, branchDeleted: true },
          { merged: true, removed: true, branchDeleted: true },
        ])
      expect(keys().filter((key) => key === "merge --no-ff --no-edit task/login")).toHaveLength(2)
      expect(keys().filter((key) => key === "branch -d -- task/login")).toHaveLength(2)
      expect(result.containerRemoved).toBe(true)
      expect(existsSync(fixture.taskPath)).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  it("merges into a named branch in a worktree of its own, leaving the source checkout alone", async () => {
    const fixture = await taskFixture()
    const { subprocess, calls, keys } = subprocessMock({
      ...fixture.handlers,
      "show-ref --verify --quiet refs/heads/develop": "",
      "worktree add": "",
      "worktree remove": "",
      // A merge only lands on a branch that is checked out, so the merge has to be
      // the one run inside the worktree this plugin created for it.
      "merge --no-ff --no-edit task/login": ({ cwd }) => (cwd.includes("dsh-worktree-space-merge") ? "" : { exitCode: 1, stderr: "fatal: refusing to merge here\n" }),
    })
    try {
      const result = await fixture.finish(subprocess, {
        task: "login",
        merge: true,
        targets: { alpha: "develop", beta: "develop" },
      })

      expect(result.failed).toBe(false)
      expect(result.mergeTarget).toBe("develop")
      expect(result.repositories.map((entry) => entry.target)).toEqual(["develop", "develop"])
      // The branch is checked out in a temporary worktree, merged there, and that
      // worktree is dropped again — the source repositories are never switched.
      const added = calls.filter((call) => call.args[1] === "add")
      expect(added).toHaveLength(2)
      expect(added.map((call) => call.args[3])).toEqual(["develop", "develop"])
      // `--force` is what dropping the scratch checkout looks like; the task's own
      // worktrees are removed without it, so this picks out the temporary ones.
      const dropped = calls.filter((call) => call.args[1] === "remove" && call.args[2] === "--force")
      expect(dropped.map((call) => call.args[3])).toEqual(added.map((call) => call.args[2]))
      expect(keys().filter((key) => key.startsWith("checkout") || key.startsWith("switch"))).toEqual([])
      expect(added.every((call) => call.args[2].includes("dsh-worktree-space-merge"))).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  it("leaves the target branch untouched when the merge in that worktree conflicts", async () => {
    const fixture = await taskFixture()
    const { subprocess, calls, keys } = subprocessMock({
      ...fixture.handlers,
      "show-ref --verify --quiet refs/heads/develop": "",
      "worktree add": "",
      "worktree remove": "",
      "merge --abort": "",
      "merge --no-ff --no-edit task/login": ({ cwd }) =>
        cwd.endsWith("alpha") || cwd.includes("dsh-worktree-space-merge")
          ? { exitCode: 1, stderr: "CONFLICT (content): merge conflict\n" }
          : "",
    })
    try {
      const result = await fixture.finish(subprocess, {
        task: "login",
        merge: true,
        targets: { alpha: "develop", beta: "develop" },
      })

      expect(result.failed).toBe(true)
      expect(result.repositories.every((entry) => entry.merged === false)).toBe(true)
      expect(result.repositories[0].error).toMatch(/CONFLICT/)
      // Aborted and dropped: the merge commit that would move `develop` was never
      // made, so the branch is where it was and no scratch checkout is left behind.
      expect(keys()).toContain("merge --abort")
      expect(calls.filter((call) => call.args[1] === "remove")).toHaveLength(2)
    } finally {
      await fixture.cleanup()
    }
  })

  it("stops at a worktree holding work nobody committed, and names it", async () => {
    const fixture = await taskFixture()
    const { subprocess, keys } = subprocessMock({
      ...fixture.handlers,
      "worktree remove": ({ args }) => {
        rmSync(args[2], { recursive: true, force: true })
        return ""
      },
      // alpha has work sitting in it and beta has none, so exactly one repository is
      // stopped: the commit is per worktree, and this side does not make it.
      "status --short": ({ cwd }) => (basename(cwd) === "alpha" ? " M a.ts\n?? b.ts\n" : ""),
      // No merge is standing in either worktree, so the uncommitted work is what stops
      // alpha - not a resolution somebody was in the middle of.
      "rev-parse --verify --quiet MERGE_HEAD": { exitCode: 1 },
    })
    try {
      const result = await fixture.finish(subprocess, {
        task: "login",
        merge: true,
      })

      expect(result.failed).toBe(true)
      const alpha = result.repositories.find((entry) => entry.name === "alpha")
      expect(alpha.error).toContain("uncommitted work is waiting")
      expect(alpha.error).toContain(join(fixture.taskPath, "alpha"))
      // The refusal says what clears it, not who does it: the commit may be the caller's own
      // or a session's they authorised, and the panel is where that is settled.
      expect(alpha.error).toContain("commit it before the task can be finished")
      expect(alpha.error).not.toContain("agent")
      expect(alpha.merged).toBe(false)
      expect(alpha.removed).toBe(false)
      // Nothing was committed here: the message whoever commits writes after reading the work
      // is the point, and a commit now would be swept away with the worktree.
      expect(keys()).not.toContain("add -A")
      expect(keys()).not.toContain("commit -m chore(task): commit work in progress before finishing the task space")
      // beta held nothing back, so it went through in the same pass.
      const beta = result.repositories.find((entry) => entry.name === "beta")
      expect(beta.error ?? "").toBe("")
      expect(beta.merged).toBe(true)
      expect(keys().filter((key) => key === "merge --no-ff --no-edit task/login")).toHaveLength(1)
    } finally {
      await fixture.cleanup()
    }
  })

  it("leaves a conflicting merge standing in the task's own worktree, with its files", async () => {
    const fixture = await taskFixture()
    // A merge only starts to exist when the rehearsal runs and fails, which is why each
    // answer is keyed to the worktree instead of fixed up front: every worktree has to
    // look ordinary going in, and carry a standing merge coming out of its own rehearsal.
    const standing = new Set()
    const { subprocess, keys } = subprocessMock({
      ...fixture.handlers,
      "show-ref --verify --quiet refs/heads/develop": "",
      // The rehearsal runs because the target is not contained in the task branch,
      // and it is the rehearsal - inside the worktree being finished - that conflicts.
      "merge-base --is-ancestor develop task/login": { exitCode: 1 },
      "merge --no-ff --no-edit develop": ({ cwd }) => {
        if (!fixture.worktrees.has(cwd)) return ""
        standing.add(cwd)
        return { exitCode: 1, stderr: "CONFLICT (content): merge conflict\n" }
      },
      // The merge is still standing: git says so, and names what it could not settle.
      "rev-parse --verify --quiet MERGE_HEAD": ({ cwd }) => (standing.has(cwd) ? "" : { exitCode: 1 }),
      "diff --name-only --diff-filter=U": ({ cwd }) => (standing.has(cwd) ? "src/a.ts\nsrc/b.ts\n" : ""),
      "worktree remove": "",
    })
    try {
      const result = await fixture.finish(subprocess, {
        task: "login",
        merge: true,
        targets: { alpha: "develop", beta: "develop" },
      })

      expect(result.failed).toBe(true)
      // Nothing was thrown away for the agent to redo: the conflict is where it was left.
      expect(keys()).not.toContain("merge --abort")
      // And the real merge never ran: the conflict stopped the finish before it.
      expect(keys()).not.toContain("merge --no-ff --no-edit task/login")
      for (const entry of result.repositories) {
        expect(entry.mergeInProgress).toBe(true)
        // The checkout this plugin owns - the worktree being finished - rather than the
        // user's own source checkout or a scratch one.
        expect(entry.mergeSite).toBe(join(fixture.taskPath, entry.name))
        // The repository's own git directory is named too: a commit writes there, so the
        // session an agent is opened in has to reach it.
        expect(entry.mainRepo).toBe(join(tmpdir(), `multi-worktree-main-${entry.name}`))
        // Nothing was concluded either: the merge commit is the agent's, made after it
        // has resolved the files, and a later finish reads it.
        expect(keys()).not.toContain("add -A")
        expect(keys()).not.toContain("commit --no-edit")
        expect(entry.conflictedFiles).toEqual(["src/a.ts", "src/b.ts"])
        // The worktree and branch stay, because the merge still has to land.
        expect(entry.removed).toBe(false)
        expect(entry.branchDeleted).toBe(false)
      }
    } finally {
      await fixture.cleanup()
    }
  })

  it("merges a branch whose conflicted merge an agent resolved and committed", async () => {
    const fixture = await taskFixture()
    const { subprocess, keys } = subprocessMock({
      ...fixture.handlers,
      // alpha was handed on with a merge standing in it, and the agent that resolved the
      // files committed the merge itself: no merge is in progress any more, and the task
      // branch now contains what the target had - which is what lets the real merge run.
      "rev-parse --verify --quiet MERGE_HEAD": { exitCode: 1 },
      "worktree remove": "",
    })
    try {
      const result = await fixture.finish(subprocess, {
        task: "login",
        merge: true,
      })

      expect(result.failed).toBe(false)
      const alpha = result.repositories.find((entry) => entry.name === "alpha")
      expect(alpha.merged).toBe(true)
      expect(alpha.mergeInProgress).toBe(false)
      // Read, not written: the commit that concluded the merge was the agent's, and this
      // pass only carried the branch into its target.
      expect(keys()).not.toContain("add -A")
      expect(keys()).not.toContain("commit --no-edit")
      expect(keys()).toContain("merge --no-ff --no-edit task/login")
    } finally {
      await fixture.cleanup()
    }
  })

  it("refuses a merge that was resolved but never committed, instead of committing it here", async () => {
    const fixture = await taskFixture()
    const { subprocess, calls, keys } = subprocessMock({
      ...fixture.handlers,
      // The files were edited - no markers left - but the merge was never committed, and
      // writing that commit is the agent's job rather than something guessed at here.
      "rev-parse --verify --quiet MERGE_HEAD": ({ cwd }) => (basename(cwd) === "alpha" ? "" : { exitCode: 1 }),
      "diff --name-only HEAD": ({ cwd }) => (basename(cwd) === "alpha" ? "src/app.ts\n" : ""),
      "diff --name-only --diff-filter=U": ({ cwd }) => (basename(cwd) === "alpha" ? "src/app.ts\n" : ""),
      "add -A": "",
      "commit --no-edit": "",
      "worktree remove": "",
    })
    try {
      await mkdir(join(fixture.taskPath, "alpha", "src"), { recursive: true })
      await writeFile(join(fixture.taskPath, "alpha", "src", "app.ts"), 'export const version = "1.0.0-task+main"\n')

      const result = await fixture.finish(subprocess, {
        task: "login",
        merge: true,
      })

      expect(result.failed).toBe(true)
      const alpha = result.repositories.find((entry) => entry.name === "alpha")
      expect(alpha.mergeInProgress).toBe(true)
      expect(alpha.mergeSite).toBe(join(fixture.taskPath, "alpha"))
      expect(alpha.conflictedFiles).toEqual(["src/app.ts"])
      expect(alpha.error).toContain("resolved but not committed")
      // Read by working directory: the other repository merges normally, so what matters
      // is that nothing wrote inside the one whose merge nobody committed. The index and
      // the merge commit stay untouched there, and its branch does not move.
      const inAlpha = calls.filter((call) => call.cwd === join(fixture.taskPath, "alpha")).map((call) => call.key)
      expect(inAlpha).not.toContain("add -A")
      expect(inAlpha).not.toContain("commit --no-edit")
      expect(inAlpha).not.toContain("merge --no-ff --no-edit task/login")
    } finally {
      await fixture.cleanup()
    }
  })

  it("refuses to conclude a merge whose files still carry conflict markers", async () => {
    const fixture = await taskFixture()
    const { subprocess, calls, keys } = subprocessMock({
      ...fixture.handlers,
      "rev-parse --verify --quiet MERGE_HEAD": ({ cwd }) => (basename(cwd) === "alpha" ? "" : { exitCode: 1 }),
      "diff --name-only HEAD": ({ cwd }) => (basename(cwd) === "alpha" ? "src/app.ts\n" : ""),
      "diff --name-only --diff-filter=U": ({ cwd }) => (basename(cwd) === "alpha" ? "src/app.ts\n" : ""),
      "add -A": "",
      "commit --no-edit": "",
      "worktree remove": "",
    })
    try {
      await mkdir(join(fixture.taskPath, "alpha", "src"), { recursive: true })
      await writeFile(join(fixture.taskPath, "alpha", "src", "app.ts"), 'export const version = "1.0.0"\n<<<<<<< HEAD\n')

      const result = await fixture.finish(subprocess, {
        task: "login",
        merge: true,
      })

      expect(result.failed).toBe(true)
      const alpha = result.repositories.find((entry) => entry.name === "alpha")
      expect(alpha.mergeInProgress).toBe(true)
      expect(alpha.conflictedFiles).toEqual(["src/app.ts"])
      expect(alpha.error).toContain("conflict markers")
      // An unfinished resolution is not committed on top of: the markers are the work.
      // Scoped to that worktree, since the clean repository still merges its own branch.
      const inAlpha = calls.filter((call) => call.cwd === join(fixture.taskPath, "alpha")).map((call) => call.key)
      expect(inAlpha).not.toContain("add -A")
      expect(inAlpha).not.toContain("commit --no-edit")
      expect(inAlpha).not.toContain("merge --no-ff --no-edit task/login")
    } finally {
      await fixture.cleanup()
    }
  })

  it("refuses to merge a worktree that is on no branch", async () => {
    // The one that loses commits. `git merge HEAD` inside the target's checkout does
    // not merge anything: git resolves `HEAD` against the checkout running it, so the
    // target is merged into itself, answers "Already up to date" and exits 0. The
    // finish then reported `merged: true`, removed a worktree that was clean only
    // because nothing had been merged into it, and left the task's commits behind as
    // objects nothing points at. Verified against real git; this pins the refusal.
    //
    // Both answers the branch read can give are refused, for one reason: neither is a
    // branch. `HEAD` is what a detached checkout reports - a rebase left mid-flight,
    // a `git checkout <sha>` by hand - and an empty answer is a worktree git could
    // not be asked at all.
    const fixture = await taskFixture()
    const { subprocess, calls, keys } = subprocessMock({
      ...fixture.handlers,
      "rev-parse --abbrev-ref HEAD": ({ cwd }) => (fixture.worktrees.has(cwd) ? "HEAD" : "main"),
      "worktree remove": "",
    })
    try {
      const result = await fixture.finish(subprocess, { task: "login", merge: true, target: "main", deleteBranch: true })

      expect(result.failed).toBe(true)
      for (const entry of result.repositories) {
        // Nothing moved, nothing went, and nothing was deleted: the answer cannot be
        // read as a finish, because none of the three flags a caller renders from is
        // set.
        expect(entry).toMatchObject({ merged: false, removed: false, branchDeleted: false })
        expect(entry.error).toMatch(/detached HEAD/)
        // Not a conflict either: nothing was reconciled, so there are no markers to
        // go and settle and no merge to conclude.
        expect(entry.conflict).toBeUndefined()
        // The worktree and the record stay, so the task can be finished again once
        // somebody has put the work back on a branch.
        expect(existsSync(entry.path)).toBe(true)
      }
      expect(existsSync(join(fixture.taskPath, "worktree-space.json"))).toBe(true)
      // No merge was attempted at all - not even the one that would have reported
      // itself as having succeeded.
      expect(keys().filter((key) => key.startsWith("merge "))).toEqual([])
      expect(calls.filter((call) => call.args[1] === "remove")).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  it("names a worktree whose branch git would not answer for", async () => {
    // The other of the two answers: git could not say what the worktree is on, which
    // is a different fault from a worktree deliberately on no branch, and says so.
    const fixture = await taskFixture()
    const { subprocess } = subprocessMock({
      ...fixture.handlers,
      "rev-parse --abbrev-ref HEAD": ({ cwd }) => (fixture.worktrees.has(cwd) ? "" : "main"),
      "worktree remove": "",
    })
    try {
      const result = await fixture.finish(subprocess, { task: "login", merge: true, target: "main" })

      expect(result.failed).toBe(true)
      expect(result.repositories[0]).toMatchObject({ merged: false, removed: false })
      expect(result.repositories[0].conflict).toBeUndefined()
      expect(result.repositories[0].error).toMatch(/reports no branch/)
    } finally {
      await fixture.cleanup()
    }
  })

  it("reads a file past the marker window as far as the window goes", async () => {
    // Every read of a changed file used to be sized by the file. This one is not:
    // `readFile` takes what it is given, so a merge standing in a checkout holding a
    // large generated file was decided by how big that file was. The window is the
    // whole point, so it is asserted: what is past it is not searched, and what is
    // inside it still is.
    const fixture = await taskFixture()
    const { subprocess } = subprocessMock({
      ...fixture.handlers,
      "rev-parse --verify --quiet MERGE_HEAD": ({ cwd }) => (basename(cwd) === "alpha" ? "" : { exitCode: 1 }),
      "diff --name-only HEAD": ({ cwd }) => (basename(cwd) === "alpha" ? "huge.bin\nearly.bin\n" : ""),
      "diff --name-only --diff-filter=U": ({ cwd }) => (basename(cwd) === "alpha" ? "huge.bin\n" : ""),
      "add -A": "",
      "commit --no-edit": "",
      "worktree remove": "",
    })
    try {
      // Markers right at the top of a small file: found, as they always were.
      await writeFile(join(fixture.taskPath, "alpha", "early.bin"), "<<<<<<< HEAD\ntheirs\n=======\nours\n>>>>>>> task/login\n")
      // Markers at the end of a file larger than the window: not searched for.
      const huge = join(fixture.taskPath, "alpha", "huge.bin")
      await writeFile(huge, Buffer.concat([
        Buffer.alloc(2 * 1024 * 1024, 0x61),
        Buffer.from("\n<<<<<<< HEAD\ntheirs\n=======\nours\n>>>>>>> task/login\n"),
      ]))
      expect((await stat(huge)).size).toBeGreaterThan(1024 * 1024)

      const result = await fixture.finish(subprocess, { task: "login", merge: true })

      // The merge is refused either way - this only chooses which of the two answers
      // a reader gets, and the specific one is the one still inside the window.
      expect(result.failed).toBe(true)
      const alpha = result.repositories.find((entry) => entry.name === "alpha")
      expect(alpha.mergeInProgress).toBe(true)
      expect(alpha.conflictedFiles).toEqual(["early.bin"])
      expect(alpha.error).toContain("conflict markers in early.bin")
      expect(alpha.error).not.toContain("huge.bin")
    } finally {
      await fixture.cleanup()
    }
  })

  it("reads the dirty paths git writes verbatim, so a rename and a non-ASCII name are paths again", async () => {
    // `git status --short` is not a list of paths. A rename reads `R  old -> new`,
    // which is neither of them - the file is at `new` - and a non-ASCII path arrives
    // C-quoted as `"\346\226\207.txt"`, so the pre-check compared a string against a
    // path for as long as it ran and matched nothing. Both under-reported, and the
    // merge was attempted against work git would refuse.
    const fixture = await taskFixture()
    const inAlpha = (cwd) => basename(cwd).endsWith("-alpha")
    const { subprocess, keys } = subprocessMock({
      ...fixture.handlers,
      // The untracked file is in the same stream and must stay out of the answer: an
      // untracked file is only in the way when the merge writes it, and this one the
      // merge does not.
      "status --porcelain=v1 -z": ({ cwd }) => (inAlpha(cwd)
        ? " M staged-and-dirty.txt\0 M café.txt\0RM renamed.txt\0shared.txt\0?? scratch.log\0"
        : ""),
      "merge-base main task/login": "abc123",
      "diff --name-only abc123 task/login": "staged-and-dirty.txt\ncafé.txt\nrenamed.txt\n",
      "merge --no-ff --no-edit task/login": "",
      "worktree remove": "",
    })
    try {
      const result = await fixture.finish(subprocess, { task: "login", merge: true, target: "main" })

      expect(result.failed).toBe(true)
      const alpha = result.repositories.find((entry) => entry.name === "alpha")
      expect(alpha.merged).toBe(false)
      expect(alpha.removed).toBe(false)
      expect(alpha.conflict).toBeFalsy()
      // Every one of them, by the name the filesystem has, and not the untracked one.
      expect(alpha.error).toContain("staged-and-dirty.txt, café.txt, renamed.txt")
      expect(alpha.error).not.toContain("scratch.log")
      // So the refusal came from this side's own guard rather than from git noticing
      // afterwards - the merge never ran.
      expect(alpha.error).toMatch(/Commit or stash it/)
      expect(keys().filter((key) => key === "merge --no-ff --no-edit task/login")).toHaveLength(1)
      // The repository that had nothing pending still went through: the refusal is
      // per repository, and one dirty checkout does not strand the rest.
      expect(result.repositories.find((entry) => entry.name === "beta")).toMatchObject({ merged: true, removed: true })
    } finally {
      await fixture.cleanup()
    }
  })

  it("reports the path holding a branch when the worktree cannot take it", async () => {
    const fixture = await taskFixture()
    const { subprocess } = subprocessMock({
      ...fixture.handlers,
      "show-ref --verify --quiet refs/heads/develop": "",
      // Git's own refusal, which names the checkout in the way.
      "worktree add": { exitCode: 128, stderr: "fatal: 'develop' is already checked out at 'E:/elsewhere'\n" },
      "worktree remove": "",
    })
    try {
      const result = await fixture.finish(subprocess, {
        task: "login",
        merge: true,
        targets: { alpha: "develop", beta: "develop" },
      })

      expect(result.failed).toBe(true)
      expect(result.repositories[0].error).toMatch(/already checked out at 'E:\/elsewhere'/)
      expect(result.repositories.every((entry) => entry.merged === false)).toBe(true)
      expect(existsSync(fixture.taskPath)).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  it("keeps the worktree and branch of a repository whose merge conflicts, and still finishes the rest", async () => {
    const fixture = await taskFixture()
    const { subprocess, keys } = subprocessMock({
      ...fixture.handlers,
      "merge --no-ff --no-edit task/login": ({ cwd }) =>
        cwd.endsWith("alpha")
          ? { exitCode: 1, stderr: "CONFLICT (content): merge conflict" }
          : "",
      "merge --abort": "",
      "worktree remove": ({ args }) => {
        rmSync(args[2], { recursive: true, force: true })
        return ""
      },
    })
    try {
      const result = await fixture.finish(subprocess, { task: "login", merge: true, target: "main" })

      expect(result.failed).toBe(true)
      const conflicted = result.repositories.find((entry) => entry.name === "alpha")
      expect(conflicted).toMatchObject({ merged: false, removed: false })
      expect(conflicted.error).toMatch(/CONFLICT/)
      const completed = result.repositories.find((entry) => entry.name === "beta")
      expect(completed).toMatchObject({ merged: true, removed: true })
      expect(keys()).toContain("merge --abort")
    } finally {
      await fixture.cleanup()
    }
  })

  it("keeps stray files unless asked to clean them, and honours the keep list", async () => {
    const fixture = await taskFixture()
    await writeFile(join(fixture.taskPath, "notes.md"), "agent notes")
    await writeFile(join(fixture.taskPath, "plan.md"), "keep me")
    const { subprocess } = subprocessMock({
      ...fixture.handlers,
      "worktree remove": ({ args }) => {
        rmSync(args[2], { recursive: true, force: true })
        return ""
      },
    })
    try {
      const result = await fixture.finish(subprocess, {
        task: "login",
        cleanStray: true,
        keep: ["plan.md"],
      })
      expect(result.removedStrays).toEqual(["notes.md"])
      expect(result.strays).toEqual(["plan.md"])
      expect(existsSync(join(fixture.taskPath, "plan.md"))).toBe(true)
      expect(existsSync(join(fixture.taskPath, "notes.md"))).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  it("refuses to delete a branch that was never merged unless the caller forces it", async () => {
    const fixture = await taskFixture()
    const { subprocess, keys } = subprocessMock(fixture.handlers)
    try {
      await expect(fixture.finish(subprocess, { task: "login", deleteBranch: true }))
        .rejects.toThrow(/requires force/)

      // Forced, and still not merging: this is how a task space is abandoned rather
      // than finished - the worktrees go, and the branches go with their commits.
      const result = await fixture.finish(subprocess, { task: "login", deleteBranch: true, force: true })
      expect(result.failed).toBe(false)
      expect(result.repositories.map((entry) => ({ merged: entry.merged, removed: entry.removed, branchDeleted: entry.branchDeleted })))
        .toEqual([
          { merged: false, removed: true, branchDeleted: true },
          { merged: false, removed: true, branchDeleted: true },
        ])
      expect(keys().filter((key) => key === "branch -D -- task/login")).toHaveLength(2)
      expect(keys().filter((key) => key.startsWith("merge "))).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  it("keeps a worktree it could not remove instead of reporting it gone", async () => {
    const fixture = await taskFixture()
    const { subprocess } = subprocessMock({
      ...fixture.handlers,
      // What git says when the worktree still holds modified or untracked files and
      // the caller did not force the removal.
      "worktree remove": ({ args }) => args[2].endsWith("alpha")
        ? { exitCode: 1, stderr: "fatal: 'alpha' contains modified or untracked files" }
        : "",
    })
    try {
      const result = await fixture.finish(subprocess, { task: "login" })

      expect(result.failed).toBe(true)
      const kept = result.repositories.find((entry) => entry.name === "alpha")
      expect(kept).toMatchObject({ merged: false, removed: false, branchDeleted: false })
      expect(kept.error).toMatch(/uncommitted changes\? force/)
      // The rest of the task still finishes, and the container stays because this
      // worktree is still in it.
      expect(result.repositories.find((entry) => entry.name === "beta")).toMatchObject({ removed: true })
      expect(result.containerRemoved).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  it("refuses a task space that carries no record of being one", async () => {
    const fixture = await taskFixture()
    const { subprocess } = subprocessMock(fixture.handlers)
    try {
      // The layout alone - two levels down, a linked worktree inside - is a fact
      // about a path the caller named, not a claim on it. The record is the claim,
      // and it lives in the directory, so it cannot be stale the way a registry
      // can. Removed here, the finish refuses and names what is missing.
      await rm(join(fixture.taskPath, "worktree-space.json"), { force: true })
      await expect(fixture.finish(subprocess, { task: "login", merge: true, deleteBranch: true }))
        .rejects.toThrow(/holds no worktree-space\.json/)
      // Named, because a user reading the refusal has to be able to tell which
      // file to put back.
      await expect(fixture.finish(subprocess, { task: "login", merge: true }))
        .rejects.toThrow(/What is missing: .*worktree-space\.json/)
      // Nothing was removed on the way to the refusal.
      expect(existsSync(fixture.taskPath)).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  it("finishes a removal git unregistered but could not delete", async () => {
    const fixture = await taskFixture()
    const { subprocess, keys } = subprocessMock({
      ...fixture.handlers,
      // What git does when its own delete fails: measured on 2.28.0.windows.1 it has
      // already unregistered the worktree by then and removed its `.git` file, so the
      // answer to "do you still know this path" is no - which is the case that used to
      // leave a checkout nobody would ever remove again.
      "worktree remove": ({ args }) => {
        if (args[2].endsWith("alpha")) return { exitCode: 255, stderr: "error: failed to delete 'alpha': Invalid argument" }
        // A removal that reports success has to have happened: the container only
        // empties once the directory it held is really gone.
        rmSync(args[2], { recursive: true, force: true })
        return ""
      },
      // Asked about alpha's repository, git answers with the source repository alone:
      // alpha is not in the list any more.
      "worktree list --porcelain": ({ cwd }) => (cwd === fixture.mainRepos.alpha
        ? `worktree ${fixture.mainRepos.alpha}\nHEAD aaa\nbranch refs/heads/main\n`
        : fixture.handlers["worktree list --porcelain"]({ cwd })),
    })
    try {
      const result = await fixture.finish(subprocess, { task: "login" })

      // git got past its own checks and only the delete failed, so the delete is
      // finished here rather than reported as a worktree left behind.
      expect(result.repositories.find((entry) => entry.name === "alpha")).toMatchObject({ removed: true })
      expect(existsSync(join(fixture.taskPath, "alpha"))).toBe(false)
      // Whatever git left of its bookkeeping goes with it.
      expect(keys()).toContain("worktree prune --expire now")
      // And the repository the mocked git did remove is untouched by any of this.
      expect(result.repositories.find((entry) => entry.name === "beta")).toMatchObject({ removed: true })
      expect(result.failed).toBe(false)
      expect(result.containerRemoved).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  it("refuses before touching anything when a worktree cannot be removed", async () => {
    const fixture = await taskFixture()
    const { subprocess, keys } = subprocessMock(fixture.handlers)
    // A handle held on a file inside the worktree, which is what a dev server, a browser
    // or an editor amounts to. Node does not share delete on its own opens, so this is
    // the same blocker those are - measured: the rename the check makes fails with EPERM,
    // exactly as the delete does.
    const handle = openSync(join(fixture.taskPath, "alpha", ".git"), "r")
    try {
      if (process.platform === "win32") {
        // Asked and answered before the merge, so the merge that would have run first
        // never ran and nothing was removed.
        await expect(fixture.finish(subprocess, { task: "login", merge: true, deleteBranch: true }))
          .rejects.toMatchObject({ code: "E5011" })
        await expect(fixture.finish(subprocess, { task: "login", merge: true, deleteBranch: true }))
          .rejects.toThrow(/cannot be\s+removed, so nothing has been merged, removed or filed/)
        expect(keys()).not.toContain("merge --no-ff --no-edit main")
        expect(keys().filter((key) => key.startsWith("worktree remove"))).toEqual([])
        // And it is still where it was: the check renames the directory and puts the name
        // back, so a refusal leaves the task space exactly as it found it.
        expect(existsSync(join(fixture.taskPath, "alpha"))).toBe(true)
        expect(existsSync(join(fixture.taskPath, "alpha.dsh-removal-probe"))).toBe(false)
      } else {
        // On POSIX an open handle blocks neither a rename nor a delete, so there is
        // nothing to warn about and the finish does what it always did. Asserted rather
        // than skipped: the branch is the answer, not an absence of one.
        const result = await fixture.finish(subprocess, { task: "login", merge: true, deleteBranch: true })
        expect(result.failed).toBe(false)
        expect(result.repositories.map((entry) => entry.removed)).toEqual([true, true])
      }
    } finally {
      closeSync(handle)
      await fixture.cleanup()
    }
  })

  it("does not file a repository git no longer knows as the user's documents", async () => {
    const fixture = await taskFixture()
    const { subprocess } = subprocessMock(fixture.handlers)
    const documents = join(fixture.container.root, "archived-docs", "login-2026-09-26-14-30-05")
    try {
      // The state a failed removal leaves: git has unregistered the worktree and taken
      // its `.git` file, the checkout is still on disk, and the record still names it.
      // Unrecognised, this reads as the user's own writing and gets filed away - a whole
      // checkout, `node_modules` and all - and no later finish would ever remove it.
      await rm(join(fixture.taskPath, "alpha", ".git"), { force: true })
      await writeFile(join(fixture.taskPath, "alpha", "notes.md"), "# left behind\n")

      const result = await fixture.finish(subprocess, { task: "login", documentsDirectory: documents, cleanStray: true })

      const stranded = result.repositories.find((entry) => entry.name === "alpha")
      expect(stranded).toMatchObject({ removed: false })
      expect(stranded.error).toMatch(/no longer registered/)
      expect(stranded.error).toMatch(/removed by hand/)
      expect(result.failed).toBe(true)
      // It is a repository of this task, not a leftover of it: nothing was filed, and
      // nothing was deleted either.
      expect(existsSync(join(documents, "alpha"))).toBe(false)
      expect(existsSync(join(fixture.taskPath, "alpha", "notes.md"))).toBe(true)
      expect(result.strays).not.toContain("alpha")
      // The record stays with it. It is the only thing left that says this directory is
      // this task's repository rather than the user's own files, so a later finish can
      // still tell - and the note it renders is not outlived by the directory it names.
      expect(existsSync(join(fixture.taskPath, "worktree-space.json"))).toBe(true)
      // The repository that could be removed went as usual, and the task space stays
      // because a repository of this task is still in it.
      expect(result.repositories.find((entry) => entry.name === "beta")).toMatchObject({ removed: true })
      expect(result.containerRemoved).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  it("refuses an unknown task", async () => {
    const fixture = await taskFixture()
    const { subprocess } = subprocessMock(fixture.handlers)
    try {
      await expect(fixture.finish(subprocess, { task: "absent" }))
        .rejects.toThrow(/no such task space/)
    } finally {
      await fixture.cleanup()
    }
  })
})

describe("finishTask documents", () => {
  /** A task with one worktree, writing of the user's own, and build output. */
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "dsh-task-documents-"))
    const taskPath = join(root, PROJECT, "login")
    await mkdir(join(taskPath, "alpha"), { recursive: true })
    await writeFile(join(taskPath, "alpha", ".git"), "gitdir: /elsewhere\n")
    await writeFile(join(taskPath, "README.en.md"), "# Task: login\n")
    for (const [name, contents] of Object.entries(metadataFiles("login"))) await writeFile(join(taskPath, name), contents)
    await writeFile(join(taskPath, "notes.md"), "# notes\n")
    await mkdir(join(taskPath, "docs"), { recursive: true })
    await writeFile(join(taskPath, "docs", "one.md"), "# one\n")
    await mkdir(join(taskPath, "dist"), { recursive: true })
    const handlers = {
      "worktree list --porcelain": ({ cwd }) => [
        "worktree E:/main-alpha", "HEAD aaa", "branch refs/heads/main", "",
        `worktree ${cwd}`, "HEAD bbb", "branch refs/heads/task/login", "",
      ].join("\n"),
      "worktree remove": ({ args }) => {
        rmSync(args[2], { recursive: true, force: true })
        return ""
      },
    }
    return { root, taskPath, handlers, cleanup: () => rm(root, { recursive: true, force: true }) }
  }

  it("files the user's content into the documents directory and leaves build output", async () => {
    const fixtureUnderTest = await fixture()
    const { subprocess } = subprocessMock(fixtureUnderTest.handlers)
    const documents = join(fixtureUnderTest.root, "archived-docs", "login-2026-09-26-14-30-05")
    try {
      const result = await finishTask(subprocess, {
        task: "login",
        project: PROJECT,
        tasksRoot: fixtureUnderTest.root,
        documentsDirectory: documents,
      })

      expect(result.archivedStrays.sort()).toEqual(["docs", "notes.md"])
      expect(result.removedStrays).toEqual([])
      expect(existsSync(join(documents, "notes.md"))).toBe(true)
      expect(existsSync(join(documents, "docs", "one.md"))).toBe(true)
      // The content left the container; the build output did not, so it stays and
      // is what the result still reports.
      expect(existsSync(join(fixtureUnderTest.taskPath, "notes.md"))).toBe(false)
      expect(existsSync(join(fixtureUnderTest.taskPath, "dist"))).toBe(true)
      expect(result.strays).toEqual(["dist"])
      expect(result.containerRemoved).toBe(false)
      // The breadcrumb this plugin wrote is cleared either way.
      expect(existsSync(join(fixtureUnderTest.taskPath, "README.en.md"))).toBe(false)
    } finally {
      await fixtureUnderTest.cleanup()
    }
  })

  it("keeps a stray holding a link where this machine cannot recreate one", async () => {
    const fixtureUnderTest = await fixture()
    const { subprocess } = subprocessMock(fixtureUnderTest.handlers)
    const documents = join(fixtureUnderTest.root, "archived-docs", "login-2026-09-26-14-30-05")
    try {
      // The shape the plugin's own users hit: a log or a dependency-store entry that is
      // a link to somewhere else, often somewhere outside the task space. A junction is
      // a link the platform reports as one and lets an ordinary user create, which is
      // what makes this testable on a machine that refuses plain symbolic links.
      const outside = join(fixtureUnderTest.root, "outside")
      await mkdir(outside, { recursive: true })
      await writeFile(join(outside, "gateway.log"), "gateway\n")
      symlinkSync(outside, join(fixtureUnderTest.taskPath, "docs", "logs"), "junction")
      // Something ordinary beside the link, so what "条-by-条" means is visible: the notes
      // are filed, the link is left.
      await writeFile(join(fixtureUnderTest.taskPath, "docs", "notes.md"), "notes\n")

      const result = await finishTask(subprocess, {
        task: "login",
        project: PROJECT,
        tasksRoot: fixtureUnderTest.root,
        documentsDirectory: documents,
        cleanStray: true,
      })

      if (CAN_CREATE_SYMLINKS) {
        // Nothing to refuse on this machine: the copy recreates the link and the stray
        // is filed as it always was.
        expect(existsSync(join(documents, "docs", "logs"))).toBe(true)
        expect(existsSync(join(fixtureUnderTest.taskPath, "docs"))).toBe(false)
      } else {
        // Filed what could be filed, and kept what could not: the notes are in the archive,
        // the link is not, and the link - with the directory holding it - stays where it
        // stands. Not deleting it is the point: a link is a name for somewhere else, often
        // outside the task space, so removing it is the user's to do - and the warning names
        // it so they know exactly what is in the way.
        expect(existsSync(join(documents, "docs", "notes.md"))).toBe(true)
        expect(existsSync(join(documents, "docs", "logs"))).toBe(false)
        expect(existsSync(join(fixtureUnderTest.taskPath, "docs", "logs"))).toBe(true)
        expect(existsSync(join(fixtureUnderTest.taskPath, "docs", "notes.md"))).toBe(false)
        expect(warningText(result)).toMatch(/except for a link \(logs\)/)
        expect(result.strays).toContain("docs")
      }
    } finally {
      await fixtureUnderTest.cleanup()
    }
  })

  it("discards the user's content when no documents directory is named", async () => {
    const fixtureUnderTest = await fixture()
    const { subprocess } = subprocessMock(fixtureUnderTest.handlers)
    try {
      const result = await finishTask(subprocess, {
        task: "login",
        project: PROJECT,
        tasksRoot: fixtureUnderTest.root,
        discardDocuments: true,
      })

      expect(result.archivedStrays).toEqual([])
      expect(result.removedStrays.sort()).toEqual(["docs", "notes.md"])
      expect(existsSync(join(fixtureUnderTest.taskPath, "notes.md"))).toBe(false)
      expect(existsSync(join(fixtureUnderTest.taskPath, "docs"))).toBe(false)
      expect(existsSync(join(fixtureUnderTest.taskPath, "dist"))).toBe(true)
    } finally {
      await fixtureUnderTest.cleanup()
    }
  })

  it("refuses a documents directory inside the container, before touching anything", async () => {
    const fixtureUnderTest = await fixture()
    const { subprocess } = subprocessMock(fixtureUnderTest.handlers)
    try {
      await expect(finishTask(subprocess, {
        task: "login",
        project: PROJECT,
        tasksRoot: fixtureUnderTest.root,
        documentsDirectory: join(fixtureUnderTest.taskPath, "archived-docs", "login"),
      })).rejects.toThrow()
      // Nothing was merged, removed or archived: the worktree is still there.
      expect(existsSync(join(fixtureUnderTest.taskPath, "alpha"))).toBe(true)
      expect(existsSync(join(fixtureUnderTest.taskPath, "notes.md"))).toBe(true)
      expect(existsSync(join(fixtureUnderTest.taskPath, "README.en.md"))).toBe(true)
    } finally {
      await fixtureUnderTest.cleanup()
    }
  })

  it("keeps a document whose copy failed, rather than cleaning it away", async () => {
    const fixtureUnderTest = await fixture()
    const { subprocess } = subprocessMock(fixtureUnderTest.handlers)
    const documents = join(fixtureUnderTest.root, "archived-docs", "login-2026-09-26-14-30-05")
    try {
      // `notes.md` is already there, so copying it over fails and only `docs` is
      // filed. The original must survive: the alternative is losing writing to a
      // copy that never happened.
      await mkdir(documents, { recursive: true })
      await writeFile(join(documents, "notes.md"), "already here\n")

      const result = await finishTask(subprocess, {
        task: "login",
        project: PROJECT,
        tasksRoot: fixtureUnderTest.root,
        documentsDirectory: documents,
        cleanStray: true,
      })

      expect(result.archivedStrays).toEqual(["docs"])
      expect(warningText(result)).toMatch(/could not archive 'notes\.md'/)
      expect(existsSync(join(fixtureUnderTest.taskPath, "notes.md"))).toBe(true)
      expect(result.strays).toEqual(["notes.md"])
      // The copy that did work is filed, and the build output is gone: the caller
      // asked for the container to be cleaned.
      expect(existsSync(join(documents, "docs", "one.md"))).toBe(true)
      expect(existsSync(join(fixtureUnderTest.taskPath, "dist"))).toBe(false)
      expect(result.removedStrays).toEqual(["dist"])
    } finally {
      await fixtureUnderTest.cleanup()
    }
  })
})

describe("resolveMergeTarget", () => {
  const sourceRepo = "E:/workspace/public/alpha"
  // The repository a task came from is on `develop`, while its remote's default is
  // `main` — the shape that used to make a finish announce the wrong branch.
  const handlers = {
    "rev-parse --abbrev-ref HEAD": "develop",
    "symbolic-ref --quiet refs/remotes/origin/HEAD": "refs/remotes/origin/main",
    "show-ref --verify --quiet refs/heads/main": "",
    "show-ref --verify --quiet refs/heads/develop": "",
    "show-ref --verify --quiet refs/heads/nope": { exitCode: 1, stderr: "fatal: 'nope' - not a valid ref\n" },
  }

  it("is the branch the source repository has checked out", async () => {
    const { subprocess, keys } = subprocessMock(handlers)
    expect(await resolveMergeTarget(subprocess, sourceRepo, undefined, "feat/login")).toBe("develop")
    // The mainline is never consulted: `git merge` writes into the checked-out
    // branch, so anything else would be a target that cannot be delivered.
    expect(keys().filter((key) => key.includes("origin/HEAD") || key.includes("refs/heads/main"))).toEqual([])
  })

  it("accepts a request that confirms that branch", async () => {
    const { subprocess } = subprocessMock(handlers)
    expect(await resolveMergeTarget(subprocess, sourceRepo, " develop ", "feat/login")).toBe("develop")
  })

  it("accepts a request for another local branch, which the merge handles elsewhere", async () => {
    const { subprocess, keys } = subprocessMock(handlers)
    expect(await resolveMergeTarget(subprocess, sourceRepo, "main", "feat/login")).toBe("main")
    // Resolving it moves nothing: the branch is only checked out where it is merged.
    expect(keys().filter((key) => key.startsWith("checkout") || key.startsWith("switch"))).toEqual([])
  })

  it("refuses the branch being merged, and a request that is not a local branch", async () => {
    const { subprocess } = subprocessMock(handlers)
    await expect(resolveMergeTarget(subprocess, sourceRepo, "feat/login", "feat/login"))
      .rejects.toThrow(/'feat\/login' is the branch being merged/)
    await expect(resolveMergeTarget(subprocess, sourceRepo, "nope", "feat/login"))
      .rejects.toThrow(/merge target 'nope' is not a local branch of 'alpha'/)
  })

  it("asks for a branch when the source repository has none checked out", async () => {
    // Git answers `HEAD` when nothing is checked out, and prints nothing at all in
    // a repository that has no commits yet: neither names a default target.
    for (const reply of ["HEAD", ""]) {
      const { subprocess } = subprocessMock({ ...handlers, "rev-parse --abbrev-ref HEAD": reply })
      await expect(resolveMergeTarget(subprocess, sourceRepo, undefined, "feat/login"))
        .rejects.toThrow(/'alpha' has no branch checked out; name the branch to merge into/)
      // Named anyway, it works: the merge checks the branch out in a worktree of
      // its own, so a detached source repository is not a dead end.
      expect(await resolveMergeTarget(subprocess, sourceRepo, "main", "feat/login")).toBe("main")
    }
  })
})

describe("planTask", () => {
  /** Two worktrees of one task, with git replies for everything a plan asks. */
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "dsh-task-plan-"))
    const taskPath = join(root, PROJECT, "login")
    for (const name of ["alpha", "beta"]) {
      await mkdir(join(taskPath, name), { recursive: true })
      await writeFile(join(taskPath, name, ".git"), "gitdir: /elsewhere\n")
    }
    // The leftovers a task directory collects: this plugin's own breadcrumb,
    // build output, editor state, and writing the user did themselves.
    await writeFile(join(taskPath, "README.en.md"), "# Task: login\n")
    for (const [name, contents] of Object.entries(metadataFiles("login"))) await writeFile(join(taskPath, name), contents)
    await mkdir(join(taskPath, "dist"), { recursive: true })
    await writeFile(join(taskPath, "dist", "app.js"), "")
    await mkdir(join(taskPath, ".idea"), { recursive: true })
    await writeFile(join(taskPath, "notes.md"), "# notes\n")
    await mkdir(join(taskPath, "docs"), { recursive: true })
    await writeFile(join(taskPath, "docs", "one.md"), "# one\n")
    await writeFile(join(taskPath, "docs", "two.txt"), "two\n")
    const handlers = {
      // The worktrees carry the task branch; the source repositories are the ones
      // that decide the merge target, and here they sit on `develop` while the
      // remote's default is `main` — the case that used to name the wrong branch.
      "rev-parse --abbrev-ref HEAD": ({ cwd }) => (basename(cwd).startsWith("main-") ? "develop" : "feat/login"),
      "worktree list --porcelain": ({ cwd }) => [
        `worktree E:/main-${basename(cwd)}`, "HEAD aaa", "branch refs/heads/develop", "",
        `worktree ${cwd}`, "HEAD bbb", "branch refs/heads/feat/login", "",
      ].join("\n"),
      // `alpha` has one modified and one untracked file; `beta` is clean.
      "status --short --branch": ({ cwd }) => basename(cwd) === "alpha" ? "## feat/login\n M a.ts\n?? b.ts\n" : "## feat/login\n",
      // Present, and deliberately never consulted: a merge target is the branch
      // the source repository is on, not the project's mainline.
      "symbolic-ref --quiet refs/remotes/origin/HEAD": "refs/remotes/origin/main\n",
      "show-ref --verify --quiet refs/heads/main": "",
      // What the dialog offers per repository: every local branch, minus the ones a
      // worktree already holds. `feat/login` is the task branch and is checked out
      // in the task's own worktree, so it can never be a target.
      "for-each-ref --format=%(refname:short) refs/heads": "other\nmain\nfeat/login\ndevelop\n",
      // `alpha` is three commits ahead of develop, `beta` one.
      "rev-list --count develop..HEAD": ({ cwd }) => basename(cwd) === "alpha" ? "3\n" : "1\n",
      "rev-list --count main..HEAD": "",
    }
    return { root, taskPath, handlers, cleanup: () => rm(root, { recursive: true, force: true }) }
  }

  it("reports each repository's branch, merge target, commits and uncommitted files", async () => {
    const fixtureUnderTest = await fixture()
    const { subprocess, keys } = subprocessMock(fixtureUnderTest.handlers)
    try {
      const plan = await planTask(subprocess, { task: "login", project: PROJECT, tasksRoot: fixtureUnderTest.root })

      // The target is the branch the source repository has checked out, even though
      // `origin/HEAD` and a local `main` both exist to be found.
      expect(plan).toMatchObject({ task: "login", project: PROJECT, path: fixtureUnderTest.taskPath, tasksRoot: fixtureUnderTest.root, mergeTarget: "develop", changedFiles: 2, commits: 4 })
      const byName = Object.fromEntries(plan.repositories.map((entry) => [entry.name, entry]))
      expect(byName.alpha).toEqual({
        name: "alpha",
        path: join(fixtureUnderTest.taskPath, "alpha"),
        // Where the source repository is: the dialog needs it to open a session whose
        // working directory reaches the git directory a commit has to write into.
        mainRepo: "E:/main-alpha",
        branch: "feat/login",
        target: "develop",
        checkedOut: "develop",
        // The task branch is not offered, and the branch the repository is on leads.
        branches: ["develop", "main", "other"],
        commits: 3,
        changedFiles: 2,
      })
      expect(byName.beta).toMatchObject({ branch: "feat/login", target: "develop", checkedOut: "develop", branches: ["develop", "main", "other"], commits: 1, changedFiles: 0 })
      // The mainline is never asked about: naming it is what made the dialog and
      // the merge disagree.
      expect(keys().filter((key) => key.includes("origin/HEAD") || key.includes("refs/heads/main"))).toEqual([])
    } finally {
      await fixtureUnderTest.cleanup()
    }
  })

  it("previews a branch the dialog chose instead of the default", async () => {
    const fixtureUnderTest = await fixture()
    const { subprocess } = subprocessMock({
      ...fixtureUnderTest.handlers,
      "rev-list --count main..HEAD": ({ cwd }) => basename(cwd) === "alpha" ? "7\n" : "2\n",
    })
    try {
      const plan = await planTask(subprocess, { task: "login", project: PROJECT, tasksRoot: fixtureUnderTest.root, targets: { alpha: "main" } })

      const byName = Object.fromEntries(plan.repositories.map((entry) => [entry.name, entry]))
      // The chosen branch, the count that goes with it, and the note that it is not
      // the branch the source repository is on — everything the second click needs.
      expect(byName.alpha).toMatchObject({ target: "main", checkedOut: "develop", commits: 7 })
      // A repository left alone keeps its own default.
      expect(byName.beta).toMatchObject({ target: "develop", commits: 1 })
    } finally {
      await fixtureUnderTest.cleanup()
    }
  })

  it("separates the user's own leftovers from build output and editor state", async () => {
    const fixtureUnderTest = await fixture()
    // A README.md is the user's: versions up to 1.0.4 wrote one themselves, so
    // the name cannot be claimed back without also claiming a file they wrote.
    await writeFile(join(fixtureUnderTest.taskPath, "README.md"), "# my own notes\n")
    const { subprocess } = subprocessMock(fixtureUnderTest.handlers)
    try {
      const plan = await planTask(subprocess, { task: "login", project: PROJECT, tasksRoot: fixtureUnderTest.root })
      const byName = Object.fromEntries(plan.strays.map((stray) => [stray.name, stray]))

      // The files this plugin writes are its own, always cleared, never a surprise.
      expect(byName["worktree-space.md"]).toBeUndefined()
      expect(byName["worktree-space.json"]).toBeUndefined()
      expect(byName["README.en.md"]).toBeUndefined()
      // A README.md is not among them, even though an older version wrote one.
      expect(byName["README.md"]).toEqual({ name: "README.md", directory: false, documents: 1, kind: "content" })
      // Build output and editor state are expected in a working directory.
      expect(byName.dist).toEqual({ name: "dist", directory: true, documents: 0, kind: "build" })
      expect(byName[".idea"]).toEqual({ name: ".idea", directory: true, documents: 0, kind: "editor" })
      // Anything else is the user's, and cleaning would delete it: a loose note
      // counts as one document, a folder as however many it holds.
      expect(byName["notes.md"]).toEqual({ name: "notes.md", directory: false, documents: 1, kind: "content" })
      expect(byName.docs).toEqual({ name: "docs", directory: true, documents: 2, kind: "content" })
    } finally {
      await fixtureUnderTest.cleanup()
    }
  })

  it("leaves the commit count out for a repository git would not answer for", async () => {
    const fixtureUnderTest = await fixture()
    const { subprocess } = subprocessMock({
      ...fixtureUnderTest.handlers,
      // `alpha` answers with nothing at all, which is what a failed `rev-list` looks
      // like: `tryRunGit` swallows the failure and hands back an empty string.
      "rev-list --count develop..HEAD": ({ cwd }) => (basename(cwd) === "alpha" ? "" : "1\n"),
    })
    try {
      const plan = await planTask(subprocess, { task: "login", project: PROJECT, tasksRoot: fixtureUnderTest.root })
      const byName = Object.fromEntries(plan.repositories.map((entry) => [entry.name, entry]))

      // Not zero. Zero is a fact about a branch - this one has commits - and a
      // repository that could not be asked is not one holding none. The rule the
      // status endpoint follows for the same number, and the dialog reads both.
      expect(byName.alpha.commits).toBeUndefined()
      expect("commits" in byName.alpha).toBe(false)
      // It is a number git would not give, not a failure of the plan: the target
      // still resolved, so the row is not an error row.
      expect(byName.alpha.error).toBeUndefined()
      expect(byName.alpha.target).toBe("develop")
      // The repository that did answer is counted, and the headline total is the sum
      // of what could be counted rather than a number that was never measured.
      expect(byName.beta.commits).toBe(1)
      expect(plan.commits).toBe(1)
    } finally {
      await fixtureUnderTest.cleanup()
    }
  })

  it("refuses a task that is not there, and a plan with no root", async () => {
    const fixtureUnderTest = await fixture()
    const { subprocess } = subprocessMock(fixtureUnderTest.handlers)
    try {
      await expect(planTask(subprocess, { task: "absent", project: PROJECT, tasksRoot: fixtureUnderTest.root }))
        .rejects.toThrow(/no such task space/)
      await expect(planTask(subprocess, { task: "login", project: PROJECT, tasksRoot: "" }))
        .rejects.toThrow(/tasks root is required/)
    } finally {
      await fixtureUnderTest.cleanup()
    }
  })
})

describe("inspectTask", () => {
  /** A container with two linked worktrees and the breadcrumb createTask writes. */
  async function fixture({ breadcrumb: keepBreadcrumb = true } = {}) {
    const root = await mkdtemp(join(tmpdir(), "dsh-task-inspect-"))
    const taskPath = join(root, PROJECT, "login")
    await mkdir(taskPath, { recursive: true })
    for (const name of ["alpha", "beta"]) {
      await mkdir(join(taskPath, name), { recursive: true })
      await writeFile(join(taskPath, name, ".git"), "gitdir: /elsewhere\n")
    }
    if (keepBreadcrumb) {
      await writeFile(join(taskPath, "README.en.md"), [
        "# Task: login",
        "",
        "- Branch: `task/login` (one branch per repository below)",
        "- Base: each repository's current HEAD",
        "- Created: 2026-01-01T00:00:00.000Z",
        "- Source root: `E:\\workspace\\public\\kratos-admin`",
        "- This folder is the agent session working directory.",
        "",
        "## Repositories",
        "- `alpha`",
        "- `beta`",
        "",
      ].join("\n"))
      await writeFile(join(taskPath, "worktree-space.json"), JSON.stringify({
        version: 1,
        task: "login",
        tasksRoot: root,
        sourceRoot: "E:\\workspace\\public\\kratos-admin",
        branch: "task/login",
        baseRef: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        repositories: [
          { name: "alpha", sourcePath: "E:\\workspace\\public\\kratos-admin\\alpha", branch: "task/login" },
          { name: "beta", sourcePath: "E:\\workspace\\public\\kratos-admin\\beta", branch: "task/login" },
        ],
      }, null, 2) + "\n")
      await writeFile(join(taskPath, "README.md"), "# Task: login\n")
    }
    return { root, taskPath, cleanup: () => rm(root, { recursive: true, force: true }) }
  }

  it("falls back to the legacy note when the record is absent or unusable", async () => {
    // A container written by a version before worktree-space.json existed is still
    // a task, and this is the path that keeps it one. Pinned here rather than on a
    // breadcrumb parser, because the parser is only reachable through this.
    const container = async (files) => {
      const root = await mkdtemp(join(tmpdir(), "dsh-legacy-"))
      const path = join(root, "task")
      await mkdir(path, { recursive: true })
      for (const [name, text] of Object.entries(files)) {
        await writeFile(join(path, name), text)
      }
      return { path, cleanup: () => rm(root, { recursive: true, force: true }) }
    }
    const note = [
      "# Task: login",
      "",
      "- Branch: `task/login` (one branch per repository below)",
      "- Base: each repository's current HEAD",
      "- Created: 2026-01-01T00:00:00.000Z",
      "- Source root: `E:\\src`",
      "",
      "## Repositories",
      "- `alpha`",
      "",
    ].join("\n")

    const legacy = await container({ [BREADCRUMB]: note })
    try {
      // version 0 is what marks it legacy, so a caller can tell the two apart.
      expect(await readTaskMetadata(legacy.path))
        .toEqual({ version: 0, task: "login", branch: "task/login", sourceRoot: "E:\\src" })
    } finally { await legacy.cleanup() }

    // Only the task name is required; the rest is optional detail.
    const bare = await container({ [BREADCRUMB]: "# Task: login\n" })
    try {
      expect(await readTaskMetadata(bare.path)).toEqual({ version: 0, task: "login" })
    } finally { await bare.cleanup() }

    // A half-written record falls through to the note rather than failing the read,
    // which is the case a crash mid-create leaves behind.
    const half = await container({ "worktree-space.json": "{ \"version\": 1", [BREADCRUMB]: note })
    try {
      expect((await readTaskMetadata(half.path))?.task).toBe("login")
    } finally { await half.cleanup() }

    // A real record wins over the note beside it.
    const both = await container({
      "worktree-space.json": JSON.stringify({ version: 1, task: "from-json" }),
      [BREADCRUMB]: "# Task: from-note\n",
    })
    try {
      expect((await readTaskMetadata(both.path))?.task).toBe("from-json")
    } finally { await both.cleanup() }

    // A note that names no task is not a task.
    const nothing = await container({ [BREADCRUMB]: "# Something else\n- Branch: `task/x`\n" })
    try {
      expect(await readTaskMetadata(nothing.path)).toBeUndefined()
    } finally { await nothing.cleanup() }

    const bare2 = await container({})
    try {
      expect(await readTaskMetadata(bare2.path)).toBeUndefined()
    } finally { await bare2.cleanup() }
  })

  it("describes a container from its worktrees and metadata", async () => {
    const fixtureUnderTest = await fixture()
    try {
      expect(await inspectTask(fixtureUnderTest.taskPath)).toEqual({
        path: fixtureUnderTest.taskPath,
        isTask: true,
        task: "login",
        project: PROJECT,
        tasksRoot: fixtureUnderTest.root,
        branch: "task/login",
        sourceRoot: "E:\\workspace\\public\\kratos-admin",
        createdAt: "2026-01-01T00:00:00.000Z",
        repositories: ["alpha", "beta"],
      })
    } finally {
      await fixtureUnderTest.cleanup()
    }
  })

  it("still recognizes and reads a container that only has the legacy note", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-task-legacy-"))
    const taskPath = join(root, PROJECT, "login")
    try {
      await mkdir(join(taskPath, "alpha"), { recursive: true })
      await writeFile(join(taskPath, "alpha", ".git"), "gitdir: /elsewhere\n")
      await writeFile(join(taskPath, "README.en.md"), [
        "# Task: login",
        "",
        "- Branch: `task/login` (one branch per repository below)",
        "- Source root: `E:\\workspace\\public\\kratos-admin`",
        "",
      ].join("\n"))
      // No worktree-space.json: an older space keeps its identity through the
      // note, and the fields the JSON would add are simply absent rather than
      // making the space a stranger. The two coordinates the JSON would carry are
      // read back from the path's depth instead.
      expect(await inspectTask(taskPath)).toEqual({
        path: taskPath,
        isTask: true,
        task: "login",
        project: PROJECT,
        tasksRoot: root,
        branch: "task/login",
        sourceRoot: "E:\\workspace\\public\\kratos-admin",
        repositories: ["alpha"],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reads a space filed flat by an earlier version by its depth, not by its note", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-task-flat-"))
    // `<container root>/<task>`, the layout used before the project layer. Nothing
    // migrates it: the reader takes the two levels the path is supposed to have, so
    // the task's own directory comes back as its project and the task is named
    // after the container root. Pinned here because it is a decision - a space
    // from an earlier version reads as coordinates that describe a layout this
    // plugin no longer writes - rather than something to be surprised by.
    const flat = join(root, "login")
    try {
      await mkdir(join(flat, "alpha"), { recursive: true })
      await writeFile(join(flat, "alpha", ".git"), "gitdir: /elsewhere\n")
      expect(await inspectTask(flat)).toMatchObject({
        isTask: true,
        task: "login",
        project: basename(root),
        tasksRoot: tmpdir(),
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("still recognizes a container whose breadcrumb is gone", async () => {
    const fixtureUnderTest = await fixture({ breadcrumb: false })
    try {
      expect(await inspectTask(fixtureUnderTest.taskPath)).toMatchObject({
        isTask: true,
        // Without the breadcrumb the folder name is all there is to go on.
        task: "login",
        project: PROJECT,
        tasksRoot: fixtureUnderTest.root,
        repositories: ["alpha", "beta"],
      })
    } finally {
      await fixtureUnderTest.cleanup()
    }
  })

  it("refuses anything that is not a container", async () => {
    const fixtureUnderTest = await fixture()
    try {
      // A source repository's own working tree is a directory inside a directory
      // with a `.git` DIRECTORY, which is not a linked worktree.
      const source = join(fixtureUnderTest.root, "source")
      await mkdir(join(source, "inner", ".git"), { recursive: true })
      expect(await inspectTask(source)).toMatchObject({ isTask: false, repositories: [] })
      // An empty directory, an absent one, and no path at all.
      const empty = join(fixtureUnderTest.root, "empty")
      await mkdir(empty, { recursive: true })
      expect(await inspectTask(empty)).toMatchObject({ isTask: false, task: "empty" })
      expect(await inspectTask(join(fixtureUnderTest.root, "absent"))).toMatchObject({ isTask: false, task: "absent" })
      expect(await inspectTask("")).toMatchObject({ path: "", isTask: false })
    } finally {
      await fixtureUnderTest.cleanup()
    }
  })
})

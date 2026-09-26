import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import {
  classifySourceRoot,
  createTask,
  finishTask,
  inspectTask,
  listTasks,
  parseBreadcrumb,
  planTask,
  suggestTaskRoot,
} from "../src/host/task/operations.js"

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
      const reply = typeof handler === "function" ? handler({ cwd, args }) : handler
      const object = typeof reply === "object" && reply !== null
      return {
        done: Promise.resolve({ exitCode: object ? reply.exitCode ?? 0 : 0, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: object ? reply.stdout ?? "" : reply ?? "" }) },
          stderr: { readFrom: () => ({ text: object ? reply.stderr ?? "" : "" }) },
        },
      }
    },
  }
  return { subprocess, calls, keys: () => calls.map((call) => call.key) }
}

/** A source root holding two repositories, as real `.git` directories. */
async function sourceFixture() {
  const root = await mkdtemp(join(tmpdir(), "multi-worktree-ops-"))
  for (const name of ["alpha", "beta"]) await mkdir(join(root, name, ".git"), { recursive: true })
  return { root, alpha: join(root, "alpha"), beta: join(root, "beta"), cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** A container root outside any source tree. */
async function containerFixture() {
  const root = await mkdtemp(join(tmpdir(), "multi-worktree-container-"))
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** Replies that make a create of `feat/<task>` succeed across both repositories. */
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
    try {
      const result = await suggestTaskRoot(source.root)
      expect(result.sourceRoot).toBe(source.root)
      expect(result.explicit).toBe(false)
      expect(result.suggested.length).toBeGreaterThan(0)
      expect(result.repositories).toEqual([
        { name: "alpha", path: source.alpha },
        { name: "beta", path: source.beta },
      ])
    } finally {
      await source.cleanup()
    }
  })

  it("marks a caller-supplied container as explicit", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    try {
      const result = await suggestTaskRoot(source.root, { tasksRoot: container.root })
      expect(result).toMatchObject({ suggested: container.root, explicit: true })
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("refuses a container inside the source tree", async () => {
    const source = await sourceFixture()
    try {
      await expect(suggestTaskRoot(source.root, { tasksRoot: join(source.root, "tasks") })).rejects.toThrow(
        /inside the source root/,
      )
    } finally {
      await source.cleanup()
    }
  })
})

describe("createTask", () => {
  it("makes one worktree per repository on one shared branch and records the task", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    const { subprocess, keys } = subprocessMock(branchIsNew("feat/fix-login"))
    try {
      const result = await createTask(subprocess, {
        sourceRoot: source.root,
        task: "fix-login",
        tasksRoot: container.root,
      })

      expect(result.branch).toBe("feat/fix-login")
      expect(result.path).toBe(join(container.root, "fix-login"))
      expect(result.repositories.map((entry) => entry.name)).toEqual(["alpha", "beta"])

      const adds = keys().filter((key) => key.startsWith("worktree add"))
      expect(adds).toEqual([
        `worktree add ${join(container.root, "fix-login", "alpha")} -b feat/fix-login`,
        `worktree add ${join(container.root, "fix-login", "beta")} -b feat/fix-login`,
      ])

      const breadcrumb = await readFile(join(result.path, "README.md"), "utf8")
      expect(breadcrumb).toContain("# Task: fix-login")
      expect(breadcrumb).toContain("- Branch: `feat/fix-login` (one branch per repository below)")
      expect(breadcrumb).toContain("each repository's current HEAD")
      expect(breadcrumb).toContain("- `alpha`")
      expect(breadcrumb).toContain("Source repositories are read-only")
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("starts every repository from a named base and honours a branch prefix", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    const { subprocess, keys } = subprocessMock({
      ...branchIsNew("task/login"),
      "rev-parse --verify --quiet main^{commit}": "",
    })
    try {
      const result = await createTask(subprocess, {
        sourceRoot: source.root,
        task: "login",
        tasksRoot: container.root,
        baseRef: "main",
        branchPrefix: "task/",
      })
      expect(result.branch).toBe("task/login")
      expect(result.baseRef).toBe("main")
      expect(keys().filter((key) => key.startsWith("worktree add"))).toEqual([
        `worktree add ${join(container.root, "login", "alpha")} -b task/login main`,
        `worktree add ${join(container.root, "login", "beta")} -b task/login main`,
      ])
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("creates only the selected repositories", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    const { subprocess, keys } = subprocessMock(branchIsNew("feat/login"))
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
    const { subprocess } = subprocessMock({ "show-ref --verify --quiet refs/heads/feat/login": "" })
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
      ...branchIsNew("feat/login"),
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
    await mkdir(join(container.root, "login"), { recursive: true })
    const { subprocess } = subprocessMock(branchIsNew("feat/login"))
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
    const { subprocess, keys } = subprocessMock(branchIsNew("feat/login"))
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
      ...branchIsNew("feat/login"),
      [`worktree add ${join(container.root, "login", "beta")} -b feat/login`]: { exitCode: 128, stderr: "fatal: cannot create" },
    })
    try {
      await expect(createTask(subprocess, { sourceRoot: source.root, task: "login", tasksRoot: container.root }))
        .rejects.toThrow(/cannot create/)

      expect(keys()).toContain(`worktree remove --force ${join(container.root, "login", "alpha")}`)
      expect(existsSync(join(container.root, "login"))).toBe(false)
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })

  it("keeps the task and warns when a push fails", async () => {
    const source = await sourceFixture()
    const container = await containerFixture()
    const { subprocess } = subprocessMock({
      ...branchIsNew("feat/login"),
      "push -u origin feat/login": { exitCode: 1, stderr: "no remote" },
    })
    try {
      const result = await createTask(subprocess, { sourceRoot: source.root, task: "login", tasksRoot: container.root, push: true })
      expect(result.warnings).toHaveLength(2)
      expect(result.warnings[0]).toMatch(/push to origin failed for 'alpha'/)
      expect(existsSync(result.path)).toBe(true)
    } finally {
      await source.cleanup()
      await container.cleanup()
    }
  })
})

describe("listTasks", () => {
  it("reports each task's worktrees with branch and dirty count, skipping strays", async () => {
    const container = await containerFixture()
    const taskPath = join(container.root, "login")
    for (const name of ["alpha", "beta"]) {
      await mkdir(join(taskPath, name), { recursive: true })
      await writeFile(join(taskPath, name, ".git"), "gitdir: /elsewhere\n")
    }
    await writeFile(join(taskPath, "notes.md"), "stray")
    const { subprocess } = subprocessMock({
      "rev-parse --abbrev-ref HEAD": () => "feat/login",
      "status --porcelain": ({ cwd }) => (basename(cwd) === "alpha" ? " M a.ts\n?? b.ts" : ""),
    })
    try {
      const result = await listTasks(subprocess, { tasksRoot: container.root })
      expect(result.tasks).toHaveLength(1)
      expect(result.tasks[0].name).toBe("login")
      expect(result.tasks[0].repositories).toEqual([
        { name: "alpha", path: join(taskPath, "alpha"), branch: "feat/login", changedFiles: 2 },
        { name: "beta", path: join(taskPath, "beta"), branch: "feat/login", changedFiles: 0 },
      ])
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
    const taskPath = join(container.root, "login")
    const mainRepos = {}
    for (const name of ["alpha", "beta"]) {
      await mkdir(join(taskPath, name), { recursive: true })
      await writeFile(join(taskPath, name, ".git"), "gitdir: /elsewhere\n")
      mainRepos[name] = join(tmpdir(), `multi-worktree-main-${name}`)
    }
    const porcelain = (name) =>
      `worktree ${mainRepos[name]}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${join(taskPath, name)}\nHEAD bbb\nbranch refs/heads/feat/login\n`
    const handlers = {
      "rev-parse --abbrev-ref HEAD": "feat/login",
      "worktree list --porcelain": ({ cwd }) => porcelain(basename(cwd)),
      "show-ref --verify --quiet refs/heads/main": "",
    }
    return { container, taskPath, handlers, cleanup: () => container.cleanup() }
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
      const result = await finishTask(subprocess, {
        task: "login",
        tasksRoot: fixture.container.root,
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
      expect(keys().filter((key) => key === "merge --no-ff --no-edit feat/login")).toHaveLength(2)
      expect(keys().filter((key) => key === "branch -d feat/login")).toHaveLength(2)
      expect(result.containerRemoved).toBe(true)
      expect(existsSync(fixture.taskPath)).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  it("keeps the worktree and branch of a repository whose merge conflicts, and still finishes the rest", async () => {
    const fixture = await taskFixture()
    const { subprocess, keys } = subprocessMock({
      ...fixture.handlers,
      "merge --no-ff --no-edit feat/login": ({ cwd }) =>
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
      const result = await finishTask(subprocess, { task: "login", tasksRoot: fixture.container.root, merge: true, target: "main" })

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
      const result = await finishTask(subprocess, {
        task: "login",
        tasksRoot: fixture.container.root,
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

  it("refuses to delete a branch that was not merged", async () => {
    const fixture = await taskFixture()
    const { subprocess } = subprocessMock(fixture.handlers)
    try {
      await expect(finishTask(subprocess, { task: "login", tasksRoot: fixture.container.root, deleteBranch: true }))
        .rejects.toThrow(/requires merging/)
    } finally {
      await fixture.cleanup()
    }
  })

  it("refuses an unknown task", async () => {
    const fixture = await taskFixture()
    const { subprocess } = subprocessMock(fixture.handlers)
    try {
      await expect(finishTask(subprocess, { task: "absent", tasksRoot: fixture.container.root }))
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
    const taskPath = join(root, "login")
    await mkdir(join(taskPath, "alpha"), { recursive: true })
    await writeFile(join(taskPath, "alpha", ".git"), "gitdir: /elsewhere\n")
    await writeFile(join(taskPath, "README.md"), "# Task: login\n")
    await writeFile(join(taskPath, "notes.md"), "# notes\n")
    await mkdir(join(taskPath, "docs"), { recursive: true })
    await writeFile(join(taskPath, "docs", "one.md"), "# one\n")
    await mkdir(join(taskPath, "dist"), { recursive: true })
    const handlers = {
      "worktree list --porcelain": ({ cwd }) => [
        "worktree E:/main-alpha", "HEAD aaa", "branch refs/heads/main", "",
        `worktree ${cwd}`, "HEAD bbb", "branch refs/heads/feat/login", "",
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
      expect(existsSync(join(fixtureUnderTest.taskPath, "README.md"))).toBe(false)
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
        tasksRoot: fixtureUnderTest.root,
        documentsDirectory: join(fixtureUnderTest.taskPath, "archived-docs", "login"),
      })).rejects.toThrow()
      // Nothing was merged, removed or archived: the worktree is still there.
      expect(existsSync(join(fixtureUnderTest.taskPath, "alpha"))).toBe(true)
      expect(existsSync(join(fixtureUnderTest.taskPath, "notes.md"))).toBe(true)
      expect(existsSync(join(fixtureUnderTest.taskPath, "README.md"))).toBe(true)
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
        tasksRoot: fixtureUnderTest.root,
        documentsDirectory: documents,
        cleanStray: true,
      })

      expect(result.archivedStrays).toEqual(["docs"])
      expect(result.warnings.join(" ")).toMatch(/could not archive 'notes\.md'/)
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

describe("planTask", () => {
  /** Two worktrees of one task, with git replies for everything a plan asks. */
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "dsh-task-plan-"))
    const taskPath = join(root, "login")
    for (const name of ["alpha", "beta"]) {
      await mkdir(join(taskPath, name), { recursive: true })
      await writeFile(join(taskPath, name, ".git"), "gitdir: /elsewhere\n")
    }
    // The leftovers a task directory collects: this plugin's own breadcrumb,
    // build output, editor state, and writing the user did themselves.
    await writeFile(join(taskPath, "README.md"), "# Task: login\n")
    await mkdir(join(taskPath, "dist"), { recursive: true })
    await writeFile(join(taskPath, "dist", "app.js"), "")
    await mkdir(join(taskPath, ".idea"), { recursive: true })
    await writeFile(join(taskPath, "notes.md"), "# notes\n")
    await mkdir(join(taskPath, "docs"), { recursive: true })
    await writeFile(join(taskPath, "docs", "one.md"), "# one\n")
    await writeFile(join(taskPath, "docs", "two.txt"), "two\n")
    const handlers = {
      "rev-parse --abbrev-ref HEAD": "feat/login",
      "worktree list --porcelain": ({ cwd }) => [
        `worktree E:/main-${basename(cwd)}`, "HEAD aaa", "branch refs/heads/main", "",
        `worktree ${cwd}`, "HEAD bbb", "branch refs/heads/feat/login", "",
      ].join("\n"),
      // `alpha` has one modified and one untracked file; `beta` is clean.
      "status --short --branch": ({ cwd }) => basename(cwd) === "alpha" ? "## feat/login\n M a.ts\n?? b.ts\n" : "## feat/login\n",
      "symbolic-ref --quiet refs/remotes/origin/HEAD": "refs/remotes/origin/main\n",
      "show-ref --verify --quiet refs/heads/main": "",
      // `alpha` is three commits ahead of main, `beta` one.
      "rev-list --count main..HEAD": ({ cwd }) => basename(cwd) === "alpha" ? "3\n" : "1\n",
    }
    return { root, taskPath, handlers, cleanup: () => rm(root, { recursive: true, force: true }) }
  }

  it("reports each repository's branch, merge target, commits and uncommitted files", async () => {
    const fixtureUnderTest = await fixture()
    const { subprocess } = subprocessMock(fixtureUnderTest.handlers)
    try {
      const plan = await planTask(subprocess, { task: "login", tasksRoot: fixtureUnderTest.root })

      expect(plan).toMatchObject({ task: "login", path: fixtureUnderTest.taskPath, tasksRoot: fixtureUnderTest.root, mergeTarget: "main", changedFiles: 2, commits: 4 })
      const byName = Object.fromEntries(plan.repositories.map((entry) => [entry.name, entry]))
      expect(byName.alpha).toEqual({ name: "alpha", path: join(fixtureUnderTest.taskPath, "alpha"), branch: "feat/login", target: "main", commits: 3, changedFiles: 2 })
      expect(byName.beta).toMatchObject({ branch: "feat/login", target: "main", commits: 1, changedFiles: 0 })
    } finally {
      await fixtureUnderTest.cleanup()
    }
  })

  it("separates the user's own leftovers from build output and editor state", async () => {
    const fixtureUnderTest = await fixture()
    const { subprocess } = subprocessMock(fixtureUnderTest.handlers)
    try {
      const plan = await planTask(subprocess, { task: "login", tasksRoot: fixtureUnderTest.root })
      const byName = Object.fromEntries(plan.strays.map((stray) => [stray.name, stray]))

      // The breadcrumb is this plugin's own, always cleared, never a surprise.
      expect(byName["README.md"]).toBeUndefined()
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

  it("refuses a task that is not there, and a plan with no root", async () => {
    const fixtureUnderTest = await fixture()
    const { subprocess } = subprocessMock(fixtureUnderTest.handlers)
    try {
      await expect(planTask(subprocess, { task: "absent", tasksRoot: fixtureUnderTest.root }))
        .rejects.toThrow(/no such task space/)
      await expect(planTask(subprocess, { task: "login", tasksRoot: "" }))
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
    const taskPath = join(root, "login")
    await mkdir(taskPath, { recursive: true })
    for (const name of ["alpha", "beta"]) {
      await mkdir(join(taskPath, name), { recursive: true })
      await writeFile(join(taskPath, name, ".git"), "gitdir: /elsewhere\n")
    }
    if (keepBreadcrumb) {
      await writeFile(join(taskPath, "README.md"), [
        "# Task: login",
        "",
        "- Branch: `feat/login` (one branch per repository below)",
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
    }
    return { root, taskPath, cleanup: () => rm(root, { recursive: true, force: true }) }
  }

  it("reads the identity a breadcrumb names", () => {
    expect(parseBreadcrumb("# Task: login\n\n- Branch: `feat/login` (one branch per repository below)\n- Source root: `E:\\src`\n"))
      .toEqual({ task: "login", branch: "feat/login", sourceRoot: "E:\\src" })
    // Only the task name is required; the rest is optional detail.
    expect(parseBreadcrumb("# Task: login\n")).toEqual({ task: "login" })
    expect(parseBreadcrumb("# Something else\n- Branch: `feat/x`\n")).toBeUndefined()
    expect(parseBreadcrumb("")).toBeUndefined()
    expect(parseBreadcrumb(undefined)).toBeUndefined()
  })

  it("describes a container from its worktrees and breadcrumb", async () => {
    const fixtureUnderTest = await fixture()
    try {
      expect(await inspectTask(fixtureUnderTest.taskPath)).toEqual({
        path: fixtureUnderTest.taskPath,
        isTask: true,
        task: "login",
        tasksRoot: fixtureUnderTest.root,
        branch: "feat/login",
        sourceRoot: "E:\\workspace\\public\\kratos-admin",
        repositories: ["alpha", "beta"],
      })
    } finally {
      await fixtureUnderTest.cleanup()
    }
  })

  it("still recognizes a container whose breadcrumb is gone", async () => {
    const fixtureUnderTest = await fixture({ breadcrumb: false })
    try {
      expect(await inspectTask(fixtureUnderTest.taskPath)).toMatchObject({
        isTask: true,
        // Without the breadcrumb the folder name is all there is to go on.
        task: "login",
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

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
  resolveMergeTarget,
  suggestTaskRoot,
} from "../src/host/task/operations.js"

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

  it("refuses a container inside the source tree", async () => {
    const source = await sourceFixture()
    try {
      await expect(suggestTaskRoot(subprocessMock().subprocess, source.root, { tasksRoot: join(source.root, "tasks") })).rejects.toThrow(
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
    const { subprocess, keys } = subprocessMock(branchIsNew("task/fix-login"))
    try {
      const result = await createTask(subprocess, {
        sourceRoot: source.root,
        task: "fix-login",
        tasksRoot: container.root,
      })

      expect(result.branch).toBe("task/fix-login")
      expect(result.path).toBe(join(container.root, "fix-login"))
      expect(result.repositories.map((entry) => entry.name)).toEqual(["alpha", "beta"])

      const adds = keys().filter((key) => key.startsWith("worktree add"))
      expect(adds).toEqual([
        `worktree add ${join(container.root, "fix-login", "alpha")} -b task/fix-login`,
        `worktree add ${join(container.root, "fix-login", "beta")} -b task/fix-login`,
      ])

      const metadata = JSON.parse(await readFile(join(result.path, "worktree-space.json"), "utf8"))
      expect(metadata.task).toBe("fix-login")
      expect(metadata.branch).toBe("task/fix-login")
      expect(metadata.baseRef).toBe(null)
      expect(metadata.sourceRoot).toBe(source.root)
      expect(metadata.repositories.map((entry) => entry.name)).toEqual(["alpha", "beta"])
      expect(typeof metadata.createdAt).toBe("string")
      // The note a session reads is generated from that record, so the two cannot
      // disagree; it says where its own facts come from.
      const note = await readFile(join(result.path, "worktree-space.md"), "utf8")
      expect(note).toContain("# Task: fix-login")
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
        `worktree add ${join(container.root, "login", "alpha")} -b hotfix/login main`,
        `worktree add ${join(container.root, "login", "beta")} -b hotfix/login main`,
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
    await mkdir(join(container.root, "login"), { recursive: true })
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
      [`worktree add ${join(container.root, "login", "beta")} -b task/login`]: { exitCode: 128, stderr: "fatal: cannot create" },
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
      ...branchIsNew("task/login"),
      "push -u origin task/login": { exitCode: 1, stderr: "no remote" },
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
      "rev-parse --abbrev-ref HEAD": () => "task/login",
      "status --porcelain": ({ cwd }) => (basename(cwd) === "alpha" ? " M a.ts\n?? b.ts" : ""),
    })
    try {
      const result = await listTasks(subprocess, { tasksRoot: container.root })
      expect(result.tasks).toHaveLength(1)
      expect(result.tasks[0].name).toBe("login")
      expect(result.tasks[0].repositories).toEqual([
        { name: "alpha", path: join(taskPath, "alpha"), branch: "task/login", changedFiles: 2 },
        { name: "beta", path: join(taskPath, "beta"), branch: "task/login", changedFiles: 0 },
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
    const worktrees = new Set()
    for (const name of ["alpha", "beta"]) {
      await mkdir(join(taskPath, name), { recursive: true })
      await writeFile(join(taskPath, name, ".git"), "gitdir: /elsewhere\n")
      mainRepos[name] = join(tmpdir(), `multi-worktree-main-${name}`)
      worktrees.add(join(taskPath, name))
    }
    const porcelain = (name) =>
      `worktree ${mainRepos[name]}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${join(taskPath, name)}\nHEAD bbb\nbranch refs/heads/task/login\n`
    const handlers = {
      // The worktrees carry the task branch; each source repository is on `main`,
      // which is the branch its merge therefore lands on.
      "rev-parse --abbrev-ref HEAD": ({ cwd }) => (worktrees.has(cwd) ? "task/login" : "main"),
      "worktree list --porcelain": ({ cwd }) => porcelain(basename(cwd)),
      "show-ref --verify --quiet refs/heads/main": "",
    }
    return { container, taskPath, handlers, worktrees, cleanup: () => container.cleanup() }
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
      expect(keys().filter((key) => key === "merge --no-ff --no-edit task/login")).toHaveLength(2)
      expect(keys().filter((key) => key === "branch -d task/login")).toHaveLength(2)
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
      const result = await finishTask(subprocess, {
        task: "login",
        tasksRoot: fixture.container.root,
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
      const result = await finishTask(subprocess, {
        task: "login",
        tasksRoot: fixture.container.root,
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

  it("commits a worktree's uncommitted changes before merging, and only where there are any", async () => {
    const fixture = await taskFixture()
    const { subprocess, keys } = subprocessMock({
      ...fixture.handlers,
      "worktree remove": ({ args }) => {
        rmSync(args[2], { recursive: true, force: true })
        return ""
      },
      // alpha has work sitting in it and beta has none, so exactly one task branch
      // gets a commit - the commit is per worktree, not a sweep of the container.
      "status --short": ({ cwd }) => (basename(cwd) === "alpha" ? " M a.ts\n?? b.ts\n" : ""),
      // No merge is standing in either worktree, which is what makes committing the
      // step that runs: with one in progress the conflicted files are not a commit.
      "rev-parse --verify --quiet MERGE_HEAD": { exitCode: 1 },
      "add -A": "",
      "commit -m chore(task): commit work in progress before finishing the task space": "",
    })
    try {
      const result = await finishTask(subprocess, {
        task: "login",
        tasksRoot: fixture.container.root,
        merge: true,
      })

      expect(result.failed).toBe(false)
      expect(result.repositories.map((entry) => entry.autoCommitted)).toEqual([true, false])
      expect(keys().filter((key) => key === "add -A")).toHaveLength(1)
      expect(keys().filter((key) => key.startsWith("commit -m chore(task)"))).toHaveLength(1)
      // The commit lands before the merge, which is the whole point of making it.
      expect(keys().indexOf("add -A")).toBeLessThan(keys().indexOf("merge --no-ff --no-edit task/login"))
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
      const result = await finishTask(subprocess, {
        task: "login",
        tasksRoot: fixture.container.root,
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
        // Nothing was concluded either: the finish is waiting on a person or an agent,
        // and only a later finish writes the merge commit.
        expect(entry.mergeCommitted).toBe(false)
        expect(entry.conflictedFiles).toEqual(["src/a.ts", "src/b.ts"])
        // The worktree and branch stay, because the merge still has to land.
        expect(entry.removed).toBe(false)
        expect(entry.branchDeleted).toBe(false)
      }
    } finally {
      await fixture.cleanup()
    }
  })

  it("concludes a merge someone resolved by committing it here, before the branch moves", async () => {
    const fixture = await taskFixture()
    const { subprocess, keys } = subprocessMock({
      ...fixture.handlers,
      // alpha was handed on with a merge standing in it, and whoever took it wrote the
      // resolution into the worktree: a merge is still in progress there, and the file
      // it changed has no markers left.
      "rev-parse --verify --quiet MERGE_HEAD": ({ cwd }) => (basename(cwd) === "alpha" ? "" : { exitCode: 1 }),
      "diff --name-only HEAD": ({ cwd }) => (basename(cwd) === "alpha" ? "src/app.ts\n" : ""),
      "add -A": "",
      "commit --no-edit": "",
      "worktree remove": "",
    })
    try {
      await mkdir(join(fixture.taskPath, "alpha", "src"), { recursive: true })
      await writeFile(join(fixture.taskPath, "alpha", "src", "app.ts"), 'export const version = "1.0.0-task+main"\n')

      const result = await finishTask(subprocess, {
        task: "login",
        tasksRoot: fixture.container.root,
        merge: true,
      })

      expect(result.failed).toBe(false)
      const alpha = result.repositories.find((entry) => entry.name === "alpha")
      // The resolution is committed by this side, in the worktree it was written in, and
      // reported as such - the task branch is what carries it into the target.
      expect(alpha.mergeCommitted).toBe(true)
      expect(alpha.mergeInProgress).toBe(false)
      expect(keys()).toContain("add -A")
      expect(keys()).toContain("commit --no-edit")
      expect(keys().indexOf("commit --no-edit")).toBeLessThan(keys().indexOf("merge --no-ff --no-edit task/login"))
    } finally {
      await fixture.cleanup()
    }
  })

  it("refuses to conclude a merge whose files still carry conflict markers", async () => {
    const fixture = await taskFixture()
    const { subprocess, keys } = subprocessMock({
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

      const result = await finishTask(subprocess, {
        task: "login",
        tasksRoot: fixture.container.root,
        merge: true,
      })

      expect(result.failed).toBe(true)
      const alpha = result.repositories.find((entry) => entry.name === "alpha")
      expect(alpha.mergeInProgress).toBe(true)
      expect(alpha.mergeCommitted).toBe(false)
      expect(alpha.conflictedFiles).toEqual(["src/app.ts"])
      expect(alpha.error).toContain("conflict markers")
      // An unfinished resolution is not committed on top of: the markers are the work.
      expect(keys()).not.toContain("add -A")
      expect(keys()).not.toContain("commit --no-edit")
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
      const result = await finishTask(subprocess, {
        task: "login",
        tasksRoot: fixture.container.root,
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

  it("refuses to delete a branch that was never merged unless the caller forces it", async () => {
    const fixture = await taskFixture()
    const { subprocess, keys } = subprocessMock(fixture.handlers)
    try {
      await expect(finishTask(subprocess, { task: "login", tasksRoot: fixture.container.root, deleteBranch: true }))
        .rejects.toThrow(/requires force/)

      // Forced, and still not merging: this is how a task space is abandoned rather
      // than finished - the worktrees go, and the branches go with their commits.
      const result = await finishTask(subprocess, { task: "login", tasksRoot: fixture.container.root, deleteBranch: true, force: true })
      expect(result.failed).toBe(false)
      expect(result.repositories.map((entry) => ({ merged: entry.merged, removed: entry.removed, branchDeleted: entry.branchDeleted })))
        .toEqual([
          { merged: false, removed: true, branchDeleted: true },
          { merged: false, removed: true, branchDeleted: true },
        ])
      expect(keys().filter((key) => key === "branch -D task/login")).toHaveLength(2)
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
      const result = await finishTask(subprocess, { task: "login", tasksRoot: fixture.container.root })

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
    const taskPath = join(root, "login")
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
      const plan = await planTask(subprocess, { task: "login", tasksRoot: fixtureUnderTest.root })

      // The target is the branch the source repository has checked out, even though
      // `origin/HEAD` and a local `main` both exist to be found.
      expect(plan).toMatchObject({ task: "login", path: fixtureUnderTest.taskPath, tasksRoot: fixtureUnderTest.root, mergeTarget: "develop", changedFiles: 2, commits: 4 })
      const byName = Object.fromEntries(plan.repositories.map((entry) => [entry.name, entry]))
      expect(byName.alpha).toEqual({
        name: "alpha",
        path: join(fixtureUnderTest.taskPath, "alpha"),
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
      const plan = await planTask(subprocess, { task: "login", tasksRoot: fixtureUnderTest.root, targets: { alpha: "main" } })

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
      const plan = await planTask(subprocess, { task: "login", tasksRoot: fixtureUnderTest.root })
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

  it("reads the identity a breadcrumb names", () => {
    expect(parseBreadcrumb("# Task: login\n\n- Branch: `task/login` (one branch per repository below)\n- Source root: `E:\\src`\n"))
      .toEqual({ task: "login", branch: "task/login", sourceRoot: "E:\\src" })
    // Only the task name is required; the rest is optional detail.
    expect(parseBreadcrumb("# Task: login\n")).toEqual({ task: "login" })
    expect(parseBreadcrumb("# Something else\n- Branch: `task/x`\n")).toBeUndefined()
    expect(parseBreadcrumb("")).toBeUndefined()
    expect(parseBreadcrumb(undefined)).toBeUndefined()
  })

  it("describes a container from its worktrees and metadata", async () => {
    const fixtureUnderTest = await fixture()
    try {
      expect(await inspectTask(fixtureUnderTest.taskPath)).toEqual({
        path: fixtureUnderTest.taskPath,
        isTask: true,
        task: "login",
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
    const taskPath = join(root, "login")
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
      // making the space a stranger.
      expect(await inspectTask(taskPath)).toEqual({
        path: taskPath,
        isTask: true,
        task: "login",
        tasksRoot: root,
        branch: "task/login",
        sourceRoot: "E:\\workspace\\public\\kratos-admin",
        repositories: ["alpha"],
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

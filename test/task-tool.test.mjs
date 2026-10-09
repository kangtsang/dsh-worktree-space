import { describe, expect, it } from "vitest"
import { rmSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { registerTaskTool } from "../src/host/task/tool.js"

/** Minimal subprocess double replying empty output to every git call. */
const quietSubprocess = {
  spawn: () => ({
    done: Promise.resolve({ exitCode: 0, signal: null }),
    collected: {
      stdout: { readFrom: () => ({ text: "" }) },
      stderr: { readFrom: () => ({ text: "" }) },
    },
  }),
}

/**
 * A context whose tool runtime captures what the plugin registers.
 * @param subprocess - the subprocess service the tool should use.
 * @param services - any further service the call under test looks up, by name.
 * @returns the context and the captured definitions.
 */
function toolContext(subprocess = quietSubprocess, services = {}) {
  const captured = []
  const ctx = {
    subprocess,
    get: (name) => (name === "tools" ? { register: (definition) => { captured.push(definition); return () => {} } } : services[name]),
  }
  return { ctx, captured }
}

/**
 * A subprocess double that answers like a repository with no task branch yet:
 * every git call succeeds except `show-ref --verify`, which is git's way of saying
 * the branch does not exist. `quietSubprocess` answers 0 to that too, which reads
 * as "this branch is already in use" and refuses every create.
 */
const creatingSubprocess = {
  spawn: ({ argv }) => ({
    done: Promise.resolve({ exitCode: argv.slice(3).join(" ").startsWith("show-ref") ? 1 : 0, signal: null }),
    collected: {
      stdout: { readFrom: () => ({ text: "" }) },
      stderr: { readFrom: () => ({ text: "" }) },
    },
  }),
}

/** A source root holding one repository. */
async function sourceFixture() {
  const root = await mkdtemp(join(tmpdir(), "multi-worktree-tool-"))
  await mkdir(join(root, "alpha", ".git"), { recursive: true })
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/**
 * Run one `create` through a freshly registered tool, then clean up after it.
 *
 * The directories go before this returns: what the callers assert on is the value
 * and whatever the service doubles recorded, both of which outlive the paths they
 * were made from. The container is a directory of its own rather than the source
 * root's recommendation, so what is removed here is only what this helper made.
 * @param services - the services the context serves beyond `tools`.
 * @returns the action's value and the captured tool definition.
 */
async function createOnce(services = {}, extra = {}, exec = {}) {
  const source = await sourceFixture()
  const container = await mkdtemp(join(tmpdir(), "multi-worktree-tool-register-"))
  try {
    const { ctx, captured } = toolContext(creatingSubprocess, services)
    registerTaskTool(ctx)
    const value = await captured[0].execute(
      { action: "create", sourceRoot: source.root, task: "login", tasksRoot: container, ...extra },
      exec,
    )
    return { value, captured }
  } finally {
    await source.cleanup()
    await rm(container, { recursive: true, force: true })
  }
}

/** The project layer the task-space fixtures file their task under. */
const PROJECT = "kratos-admin"

/**
 * A task space with one worktree on disk and the record a create leaves, plus the
 * subprocess double that answers for its git reads.
 *
 * `keepWorktree` leaves the worktree where it is, which is what a finish that
 * cannot empty the container looks like from the outside: the removal was asked
 * for and the directory is still there.
 * @param options - whether the mocked removal should leave the worktree alone.
 * @returns the container root, the task space, the double and a cleanup.
 */
async function taskSpaceFixture({ keepWorktree = false, delivery } = {}) {
  const container = await mkdtemp(join(tmpdir(), "multi-worktree-tool-done-"))
  const taskPath = join(container, PROJECT, "login")
  const worktree = join(taskPath, "alpha")
  await mkdir(worktree, { recursive: true })
  await writeFile(join(worktree, ".git"), "gitdir: /elsewhere\n")
  // The record a create leaves behind, and the only thing that says which branch
  // this task made.
  await writeFile(join(taskPath, "worktree-space.json"), JSON.stringify({
    task: "login", project: PROJECT, branch: "task/login",
    ...(delivery === undefined ? {} : { delivery }),
  }, null, 2) + "\n")
  const mainRepo = join(tmpdir(), "multi-worktree-tool-done-main-alpha")
  const porcelain = `worktree ${mainRepo}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${worktree}\nHEAD bbb\nbranch refs/heads/task/login\n`
  const subprocess = {
    spawn: ({ argv }) => {
      const key = argv.slice(3).join(" ")
      let exitCode = 0
      let stdout = ""
      if (key.startsWith("rev-parse --verify --quiet MERGE_HEAD")) exitCode = 1
      else if (key.startsWith("rev-parse --abbrev-ref HEAD")) stdout = argv[2] === worktree ? "task/login" : "main"
      else if (key.startsWith("worktree list --porcelain")) stdout = porcelain
      // The mocked removal has to change the filesystem: the container only becomes
      // removable once the directory it held is really gone.
      else if (key.startsWith("worktree remove") && !keepWorktree) rmSync(argv[5], { recursive: true, force: true })
      return {
        done: Promise.resolve({ exitCode, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: stdout }) },
          stderr: { readFrom: () => ({ text: "" }) },
        },
      }
    },
  }
  return { container, taskPath, subprocess, cleanup: () => rm(container, { recursive: true, force: true }) }
}

/**
 * Assert every property the declared object schema lists is present, so a value
 * the model receives can never miss a field the schema promises.
 * @param schema - the declared object schema.
 * @param value - the object an action returned.
 */
function expectObjectShape(schema, value) {
  for (const key of Object.keys(schema.properties)) {
    expect(value, `missing '${key}'`).toHaveProperty(key)
    expect(value[key], `'${key}' must not be undefined`).not.toBeUndefined()
  }
}

/**
 * Assert the shared envelope and every repository row match the declared shape.
 * @param schema - the tool's declared output schema.
 * @param value - the value an action returned.
 */
function expectEnvelopeShape(schema, value) {
  expectObjectShape(schema, value)
  const rowSchema = schema.properties.repositories.items
  for (const row of value.repositories) expectObjectShape(rowSchema, row)
}

describe("registerTaskTool", () => {
  it("registers exactly one task_worktree_space tool and returns its disposer", () => {
    const { ctx, captured } = toolContext()
    const dispose = registerTaskTool(ctx)
    expect(captured).toHaveLength(1)
    expect(captured[0].name).toBe("task_worktree_space")
    expect(captured[0].parameters.properties.action.enum).toEqual(["suggest-root", "create", "add", "list", "dispatch", "done"])
    expect(typeof captured[0].execute).toBe("function")
    expect(typeof dispose).toBe("function")
  })

  it("refuses force, which is the one request a model may not make for itself", async () => {
    const { ctx, captured } = toolContext()
    try {
      registerTaskTool(ctx)
      // Force is irreversible twice over - it discards uncommitted work and swaps
      // `branch -d` for `branch -D` - so it is not gated on a flag the model also
      // holds. It is refused outright, before the container root is even resolved.
      await expect(captured[0].execute({ action: "done", task: "login", force: true }, {}))
        .rejects.toMatchObject({ code: "E7007" })
      await expect(captured[0].execute({ action: "done", task: "login", force: true }, {}))
        .rejects.toThrow(/management page/)
      // Abandoning a task reaches the same refusal by the other route: deleting a
      // branch with no merge is exactly what needs force, and force is refused.
      await expect(captured[0].execute({ action: "done", task: "login", force: true, deleteBranch: true, merge: false }, {}))
        .rejects.toMatchObject({ code: "E7007" })
      // With no force at all it is not E7007 - it falls through to the host's own
      // rule, which needs a container to be resolved before it can even say so.
      await expect(captured[0].execute({ action: "done", task: "login", deleteBranch: true, merge: false }, {}))
        .rejects.toMatchObject({ code: "E7006" })
    } finally { /* nothing was written: the refusal comes first */ }
  })

  it("leaves the recoverable parts of finishing alone", async () => {
    const { ctx, captured } = toolContext()
    registerTaskTool(ctx)
    // Merging, and removing a branch once it has landed, are both available here:
    // `git branch -d` refuses an unmerged branch on its own, so neither loses a
    // commit. This asserts the refusal is scoped to `force` and nothing else.
    await expect(captured[0].execute({ action: "done", task: "login", merge: true, deleteBranch: true, cleanStray: true }, {}))
      .rejects.not.toMatchObject({ code: "E7007" })
  })

  it("describes force as unavailable, so the model is not asked to try it", () => {
    const { ctx, captured } = toolContext()
    registerTaskTool(ctx)
    expect(captured[0].parameters.properties.force.description).toMatch(/Refused here/)
    expect(captured[0].description).toMatch(/cannot do `force`/)
  })

  it("stays out of the way when the deployment serves no tool runtime", () => {
    expect(registerTaskTool({ get: () => undefined })).toBeUndefined()
  })

  it("survives a bare context double with no service lookup", () => {
    expect(() => registerTaskTool({})).not.toThrow()
    expect(registerTaskTool({})).toBeUndefined()
  })

  it("describes a task container and the repositories it would span", async () => {
    const source = await sourceFixture()
    const { ctx, captured } = toolContext()
    try {
      registerTaskTool(ctx)
      const value = await captured[0].execute({ action: "suggest-root", sourceRoot: source.root }, {})
      expect(value.action).toBe("suggest-root")
      expect(value.tasksRoot).toBe(source.root)
      expect(value.suggested.length).toBeGreaterThan(0)
      expect(value.repositories.map((row) => row.name)).toEqual(["alpha"])
      expect(value.summary).toContain("Recommended task space")
      expectEnvelopeShape(captured[0].output.schema, value)
    } finally {
      await source.cleanup()
    }
  })

  it("proposes the plugin's configured location over its own recommendation", async () => {
    const source = await sourceFixture()
    const configured = join(tmpdir(), "multi-worktree-tool-configured")
    const named = join(tmpdir(), "multi-worktree-tool-named")
    const { ctx, captured } = toolContext()
    try {
      // The plugin's own setting is the user's standing answer to where task spaces
      // go, so the model proposes the root a create would land in rather than a
      // second, different one of its own.
      registerTaskTool(ctx, { configuredRoot: () => configured })
      const value = await captured[0].execute({ action: "suggest-root", sourceRoot: source.root }, {})
      expect(value.suggested).toBe(configured)
      expect(value.summary).toContain(configured)

      // A caller who names one still wins: the setting is a default, not a rule.
      const asked = await captured[0].execute({ action: "suggest-root", sourceRoot: source.root, tasksRoot: named }, {})
      expect(asked.suggested).toBe(named)

      // And a read that answers "nothing configured" - which is what the accessor
      // returns under the derived default - leaves the recommendation in place.
      const derived = toolContext()
      registerTaskTool(derived.ctx, { configuredRoot: () => "" })
      const recommended = await derived.captured[0].execute({ action: "suggest-root", sourceRoot: source.root }, {})
      expect(recommended.suggested.endsWith("worktree-space")).toBe(true)
      expect(recommended.suggested).not.toBe(configured)
    } finally {
      await source.cleanup()
    }
  })

  it("reads the configured container when a list names only the source root", async () => {
    const source = await sourceFixture()
    const configured = await mkdtemp(join(tmpdir(), "multi-worktree-tool-configured-"))
    // `<container root>/<project>/<task>/<repository>`, as `create` writes it — and
    // the project layer is the source root's own directory name, as it derives it.
    const worktree = join(configured, basename(source.root), "login", "alpha")
    await mkdir(worktree, { recursive: true })
    await writeFile(join(worktree, ".git"), "gitdir: /elsewhere\n")
    const { ctx, captured } = toolContext()
    try {
      registerTaskTool(ctx, { configuredRoot: () => configured })
      // A list that names only a source root has to read the container the creates
      // have been landing in, or it would report on a directory nobody uses.
      const value = await captured[0].execute({ action: "list", sourceRoot: source.root }, {})
      expect(value.tasksRoot).toBe(configured)
      expect(value.repositories.map((row) => row.name)).toEqual([`${basename(source.root)}/login/alpha`])
    } finally {
      await source.cleanup()
      await rm(configured, { recursive: true, force: true })
    }
  })

  it("adds a repository to a task that already exists, by path", async () => {
    const container = await mkdtemp(join(tmpdir(), "multi-worktree-tool-add-"))
    // `<container root>/<project>/<task>/<repository>`, as `create` writes it, with
    // the record that says which branch the task is on.
    const taskPath = join(container, "kratos-admin", "login")
    const worktree = join(taskPath, "alpha")
    await mkdir(worktree, { recursive: true })
    await writeFile(join(worktree, ".git"), "gitdir: /elsewhere\n")
    await writeFile(join(taskPath, "worktree-space.json"), JSON.stringify({
      version: 1, task: "login", project: "kratos-admin", tasksRoot: container,
      sourceRoot: "E:/source", branch: "task/login", baseRef: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      repositories: [{ name: "alpha", sourcePath: "E:/source/alpha", branch: "task/login" }],
    }))
    // A repository somewhere else entirely — the arrangement the action exists for.
    const gamma = join(container, "..", "multi-worktree-tool-add-elsewhere", "gamma")
    await mkdir(join(gamma, ".git"), { recursive: true })
    const subprocess = {
      spawn: ({ argv }) => ({
        done: Promise.resolve({ exitCode: argv.slice(3).join(" ").startsWith("show-ref") ? 1 : 0, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: argv.slice(3).join(" ").includes("--abbrev-ref") ? "task/login" : "" }) },
          stderr: { readFrom: () => ({ text: "" }) },
        },
      }),
    }
    const { ctx, captured } = toolContext(subprocess)
    try {
      registerTaskTool(ctx, { configuredRoot: () => container })
      // The project layer is named rather than derived: the repository being added
      // need not live under the source root this task began from, so there may be
      // no source root to take a directory name from.
      const value = await captured[0].execute({ action: "add", task: "login", tasksRoot: container, project: "kratos-admin", repos: [gamma] }, {})
      expect(value.action).toBe("add")
      expect(value.container).toBe(taskPath)
      expect(value.branch).toBe("task/login")
      // The paths went through as given: nothing resolved a name against a source
      // root, because there may not be one they share.
      expect(value.repositories.map((row) => row.name)).toEqual(["gamma"])
      expect(value.summary).toContain("gamma")
      expectEnvelopeShape(captured[0].output.schema, value)
    } finally {
      await rm(container, { recursive: true, force: true })
      await rm(join(container, "..", "multi-worktree-tool-add-elsewhere"), { recursive: true, force: true })
    }
  })

  it("registers the task space it made as a DSH Workspace", async () => {
    const records = []
    const registry = {
      // The source root is a registered Workspace, as it is whenever a task is
      // started from the workspace list the user is looking at.
      resolveByPath: async () => ({ title: "kratos-admin" }),
      create: async (path, title) => { records.push({ path, title }); return { path, title } },
    }
    const { value, captured } = await createOnce({ workspaceRegistry: registry })
    // Made on disk *and* registered, with the dialog's own title rule, so a task
    // space created from a session reads in the workspace list exactly like one
    // created from the panel.
    expect(value.action).toBe("create")
    expect(records).toEqual([{ path: value.container, title: "kratos-admin/login" }])
    expect(value.warnings).toEqual([])
    expectEnvelopeShape(captured[0].output.schema, value)
  })

  it("makes the task space and leaves registering it to the panel when the call asks for that", async () => {
    // The caller's own choice, so the disk half still happens and is reported as it always was;
    // what changes is that nothing is registered - and that the result says so, with the way to
    // do it by hand, because a caller that believed otherwise would open a session in a task
    // space the interface does not show.
    const records = []
    const registry = {
      resolveByPath: async () => ({ title: "kratos-admin" }),
      create: async (path, title) => { records.push({ path, title }) },
    }
    const { value } = await createOnce({ workspaceRegistry: registry }, { registerWorkspace: false })
    expect(value.action).toBe("create")
    expect(value.container).not.toBe("")
    expect(records).toEqual([])
    expect(value.warnings.join(" ")).toMatch(/asked for one that stays out/)
    expect(value.warnings.join(" ")).toMatch(/E2002/)
  })

  it("leaves the Workspace title to the registry when the source root is not registered", async () => {
    const records = []
    const registry = {
      resolveByPath: async () => undefined,
      create: async (path, title) => { records.push({ path, title }) },
    }
    await createOnce({ workspaceRegistry: registry })
    // No title means the registry's own default - the task directory's name -
    // which is a better answer than an invented one, and is not an error.
    expect(records).toEqual([{ path: expect.any(String), title: undefined }])
  })

  it("warns instead of failing when nothing could register the task space", async () => {
    // Two ways a deployment has no registry to register with: one serves none at
    // all, and one hands back a service double with nothing on it. Neither may
    // turn a create that succeeded on disk into a reported failure.
    for (const services of [{}, { workspaceRegistry: {} }]) {
      const { value, captured } = await createOnce(services)
      expect(value.action).toBe("create")
      expect(value.container).not.toBe("")
      expect(value.warnings).toHaveLength(1)
      expect(value.warnings[0]).toMatch(/not registered as a DSH Workspace/)
      expect(value.warnings[0]).toMatch(/serves no Workspace registry/)
      // What the caller has to do about it, and what happens if they ignore it.
      expect(value.warnings[0]).toMatch(/Create and open/)
      expect(value.warnings[0]).toMatch(/E2002/)
      expect(value.summary).toContain("Warnings:")
      expectEnvelopeShape(captured[0].output.schema, value)
    }
  })

  it("reports why a registration failed, over a task space that is still there", async () => {
    const registry = {
      resolveByPath: async () => undefined,
      create: async () => { throw new Error("EACCES: permission denied, open '.dsh/storages/workspace.json'") },
    }
    const { value, captured } = await createOnce({ workspaceRegistry: registry })
    // The create happened; only the registration did not. A caller told the create
    // failed would not know the worktrees are on disk.
    expect(value.action).toBe("create")
    expect(value.container).not.toBe("")
    expect(value.warnings).toHaveLength(1)
    expect(value.warnings[0]).toContain("EACCES: permission denied")
    expect(value.warnings[0]).toMatch(/E2002/)
    expectEnvelopeShape(captured[0].output.schema, value)
  })

  it("drops the Workspace registration once the finish has removed the task space", async () => {
    const fixture = await taskSpaceFixture()
    const deleted = []
    const registry = {
      // One record that names this task space and one that names a different task:
      // what makes the pair worth having is that only the first may go.
      list: () => [
        { id: "ws-other", path: join(fixture.container, "kratos-api", "other") },
        { id: "ws-1", path: fixture.taskPath },
      ],
      delete: async (id) => { deleted.push(id); return true },
    }
    const { ctx, captured } = toolContext(fixture.subprocess, { workspaceRegistry: registry })
    try {
      registerTaskTool(ctx)
      const value = await captured[0].execute(
        { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container },
        {},
      )
      // The container really went, so the registration goes with it: a finished
      // task must not leave a workspace entry pointing at a directory that is gone.
      expect(value.container).toBe("")
      expect(deleted).toEqual(["ws-1"])
      expect(value.warnings.join(" ")).not.toMatch(/Workspace registration/)
      expectEnvelopeShape(captured[0].output.schema, value)
    } finally {
      await fixture.cleanup()
    }
  })

  it("leaves the registration alone when the finish asks for the group to outlive the directory", async () => {
    // The caller's own choice: the directory goes, the entry stays, and that is what keeps the
    // task's sessions under one group instead of falling back to Ungrouped. It is not something
    // that went wrong, so nothing warns about it.
    const fixture = await taskSpaceFixture()
    const deleted = []
    const registry = {
      list: () => [{ id: "ws-1", path: fixture.taskPath }],
      delete: async (id) => { deleted.push(id) },
    }
    const { ctx, captured } = toolContext(fixture.subprocess, { workspaceRegistry: registry })
    try {
      registerTaskTool(ctx)
      const value = await captured[0].execute(
        { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container, unregisterWorkspace: false },
        {},
      )
      expect(value.container).toBe("")
      expect(deleted).toEqual([])
      expect(value.warnings.join(" ")).not.toMatch(/Workspace registration/)
      expectEnvelopeShape(captured[0].output.schema, value)
    } finally {
      await fixture.cleanup()
    }
  })

  it("treats a registration that is already gone as done, not as a failure to drop one", async () => {
    // Two ways a task space turns out not to be registered any more, and neither may be
    // reported as a problem: it was never there (the user removed it from the list, or the
    // deployment never registered it), or it went between the read that found it and the
    // delete that followed - which the delete reports as "not found" and which the question
    // asked again answers with the truth.
    const cases = [
      { name: "never listed", list: () => [], failure: "workspace \"ws-1\" not found" },
      {
        name: "went between the read and the delete",
        list: (() => { let reads = 0; return (path) => (reads++ === 0 ? [{ id: "ws-1", path }] : []) })(),
        failure: "workspace \"ws-1\" not found",
      },
    ]
    for (const each of cases) {
      const fixture = await taskSpaceFixture()
      const registry = {
        list: () => each.list(fixture.taskPath),
        delete: async () => { throw new Error(each.failure) },
      }
      const { ctx, captured } = toolContext(fixture.subprocess, { workspaceRegistry: registry })
      try {
        registerTaskTool(ctx)
        const value = await captured[0].execute(
          { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container },
          {},
        )
        expect(value.container, each.name).toBe("")
        expect(value.warnings.join(" "), each.name).not.toMatch(/Workspace registration/)
      } finally {
        await fixture.cleanup()
      }
    }
  })

  it("keeps the registration while the task space is still on disk", async () => {
    const fixture = await taskSpaceFixture({ keepWorktree: true })
    const deleted = []
    const registry = {
      list: () => [{ id: "ws-1", path: fixture.taskPath }],
      delete: async (id) => { deleted.push(id) },
    }
    const { ctx, captured } = toolContext(fixture.subprocess, { workspaceRegistry: registry })
    try {
      registerTaskTool(ctx)
      const value = await captured[0].execute(
        { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container },
        {},
      )
      // The worktree could not be taken down, so the container is still there - and
      // a task space that is still there has to keep its Workspace, or it would
      // vanish from the list while sitting on disk and its sessions would scatter
      // into "Ungrouped".
      expect(value.container).not.toBe("")
      expect(deleted).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  it("reports a registration it could not drop, over a finish that still happened", async () => {
    // Neither way of failing to reach the registry may turn a finish that already
    // took the worktrees down into a reported failure, and both have to say what is
    // left to do by hand.
    const failing = [
      () => ({ list: () => { throw new Error("workspace registry is not started yet") }, delete: async () => true }),
      (path) => ({ list: () => [{ id: "ws-1", path }], delete: async () => { throw new Error("EACCES: permission denied") } }),
    ]
    for (const registryFor of failing) {
      const fixture = await taskSpaceFixture()
      const { ctx, captured } = toolContext(fixture.subprocess, { workspaceRegistry: registryFor(fixture.taskPath) })
      try {
        registerTaskTool(ctx)
        const value = await captured[0].execute(
          { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container },
          {},
        )
        expect(value.container).toBe("")
        expect(value.warnings.join(" ")).toMatch(/could not be (read|dropped)/)
        expect(value.warnings.join(" ")).toMatch(/by hand/)
        expectEnvelopeShape(captured[0].output.schema, value)
      } finally {
        await fixture.cleanup()
      }
    }
  })

  it("says nothing about registrations where the deployment serves no registry", async () => {
    const fixture = await taskSpaceFixture()
    const { ctx, captured } = toolContext(fixture.subprocess)
    try {
      registerTaskTool(ctx)
      const value = await captured[0].execute(
        { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container },
        {},
      )
      // Nothing was ever registered through this deployment, so there is nothing to
      // drop and nothing to report: a warning here would be noise on every finish.
      expect(value.container).toBe("")
      expect(value.warnings.join(" ")).not.toMatch(/Workspace registration/)
      expectEnvelopeShape(captured[0].output.schema, value)
    } finally {
      await fixture.cleanup()
    }
  })

  it("reports an absent container instead of failing", async () => {
    const { ctx, captured } = toolContext()
    registerTaskTool(ctx)
    const value = await captured[0].execute(
      { action: "list", tasksRoot: join(tmpdir(), "multi-worktree-absent-tasks") },
      {},
    )
    expect(value.action).toBe("list")
    expect(value.repositories).toEqual([])
    expect(value.summary).toContain("No task space")
    expectEnvelopeShape(captured[0].output.schema, value)
  })

  it("reports each task worktree a container holds, project layer and all", async () => {
    const container = await mkdtemp(join(tmpdir(), "multi-worktree-tool-tasks-"))
    // `<container root>/<project>/<task>/<repository>`, as `create` writes it.
    const worktree = join(container, "kratos-admin", "login", "alpha")
    await mkdir(worktree, { recursive: true })
    await writeFile(join(worktree, ".git"), "gitdir: /elsewhere\n")
    const { ctx, captured } = toolContext()
    try {
      registerTaskTool(ctx)
      const value = await captured[0].execute({ action: "list", tasksRoot: container }, {})
      // The label names both layers, so a model reading two projects' `login` tasks
      // can tell which is which.
      expect(value.repositories.map((row) => row.name)).toEqual(["kratos-admin/login/alpha"])
      expect(value.summary).toContain("1 task")
      expectEnvelopeShape(captured[0].output.schema, value)
    } finally {
      await rm(container, { recursive: true, force: true })
    }
  })

  it("does not report the archive folder as a project of its own", async () => {
    const container = await mkdtemp(join(tmpdir(), "multi-worktree-tool-archive-"))
    // What the `container` archive strategy writes: a directory at the container
    // root whose own children are named after tasks without being any.
    await mkdir(join(container, "archived-docs", "login-20260926-020933"), { recursive: true })
    const { ctx, captured } = toolContext()
    try {
      registerTaskTool(ctx)
      const value = await captured[0].execute({ action: "list", tasksRoot: container }, {})
      expect(value.repositories).toEqual([])
      expectEnvelopeShape(captured[0].output.schema, value)
    } finally {
      await rm(container, { recursive: true, force: true })
    }
  })

  it("requires the arguments an action cannot proceed without", async () => {
    const { ctx, captured } = toolContext()
    registerTaskTool(ctx)
    const definition = captured[0]
    await expect(definition.execute({ action: "create", task: "x" }, {})).rejects.toThrow(/sourceRoot is required/)
    await expect(definition.execute({ action: "create", sourceRoot: "/tmp" }, {})).rejects.toThrow(/task is required/)
    await expect(definition.execute({ action: "done" }, {})).rejects.toThrow(/task is required/)
    await expect(definition.execute({ action: "add" }, {})).rejects.toThrow(/task is required/)
    await expect(definition.execute({ action: "list" }, {})).rejects.toThrow(/tasksRoot is required/)
    // The project layer is the caller's to name, or theirs to leave to `sourceRoot`,
    // whose own directory name it is.
    await expect(definition.execute({ action: "done", task: "x", tasksRoot: "/tmp" }, {}))
      .rejects.toThrow(/project is required \(or sourceRoot, whose directory name it is\)/)
  })

  it("lets the declared enum reject an action it does not implement", async () => {
    const { ctx, captured } = toolContext()
    registerTaskTool(ctx)
    // Argument validation runs before the action switch, so an unknown action
    // never reaches the tool's own fallback branch.
    await expect(captured[0].execute({ action: "delete-everything" }, {})).rejects.toThrow(/must be one of/)
  })

  it("opens a session in the task space and hands it the work", async () => {
    const fixture = await taskSpaceFixture()
    const created = []
    const appended = []
    const prompts = []
    const services = {
      sessionController: {
        create: async (place) => { created.push(place); return { sessionId: "session-1" } },
        prompt: async (request) => { prompts.push(request); return { accepted: true } },
      },
      sessions: { get: (id) => (id === "session-1" ? { append: (type, data) => appended.push({ type, data }) } : undefined) },
      workspaceRegistry: {
        create: async () => ({}),
        resolveByPath: async () => ({ id: "ws-login", title: "kratos-admin/login" }),
        list: () => [{ id: "ws-login", path: fixture.taskPath }],
      },
      // The calling session's own switch: the only thing `inherit` copies.
      sandboxPolicy: { overrideOf: () => "danger-full-access" },
    }
    const { ctx, captured } = toolContext(fixture.subprocess, services)
    try {
      registerTaskTool(ctx)
      const value = await captured[0].execute(
        { action: "dispatch", task: "login", project: PROJECT, tasksRoot: fixture.container, prompt: "build it, then smoke it" },
        { agent: { session: { id: "session-caller" } } },
      )
      expect(value.action).toBe("dispatch")
      expect(value.sessionId).toBe("session-1")
      // Named by its Workspace, not by its directory: the controller attaches a session to a
      // Workspace only when it is named, and that attachment is what groups it in the sidebar.
      expect(created).toEqual([{ workspaceId: "ws-login" }])
      // The caller's own override, copied and marked as delegated rather than as a switch the
      // user made - the same events DSH seeds into a child agent. `danger-full-access` is a
      // bundle in DSH's own table ("full file access without approval prompts"), so its
      // approval policy is written with it.
      expect(appended).toEqual([
        { type: "sandbox/mode", data: { mode: "danger-full-access", source: "delegation" } },
        { type: "approval/policy", data: { policy: "never", source: "delegation" } },
      ])
      expect(prompts).toEqual([{ sessionId: "session-1", content: [{ type: "text", text: "build it, then smoke it" }] }])
      expect(value.warnings).toEqual([])
      expect(value.summary).toContain("session-1")
      expectEnvelopeShape(captured[0].output.schema, value)
    } finally {
      await fixture.cleanup()
    }
  })

  it("gives the new session nothing more than the caller has", async () => {
    // A caller with no override of its own: nothing is written, so the session lands on the
    // deployment default - which is where the caller is too. That is what makes `inherit` a
    // safe default rather than a promise about a mode.
    const fixture = await taskSpaceFixture()
    const created = []
    const appended = []
    const services = {
      sessionController: { create: async (place) => { created.push(place); return { sessionId: "session-2" } }, prompt: async () => ({}) },
      sessions: { get: () => ({ append: (...args) => appended.push(args) }) },
      sandboxPolicy: { overrideOf: () => undefined },
    }
    const { ctx, captured } = toolContext(fixture.subprocess, services)
    try {
      registerTaskTool(ctx)
      const value = await captured[0].execute(
        { action: "dispatch", task: "login", project: PROJECT, tasksRoot: fixture.container, prompt: "go" },
        { agent: { session: { id: "session-caller" } } },
      )
      expect(value.sessionId).toBe("session-2")
      expect(appended).toEqual([])
      // No registry in this deployment, so the directory is the only thing to open on: the
      // session still opens, it just has no Workspace to be attached to.
      expect(created).toEqual([{ cwd: fixture.taskPath }])
    } finally {
      await fixture.cleanup()
    }
  })

  it("takes the permission the call names, over the caller's own", async () => {
    const fixture = await taskSpaceFixture()
    const appended = []
    const services = {
      sessionController: { create: async () => ({ sessionId: "session-3" }), prompt: async () => ({}) },
      sessions: { get: () => ({ append: (type, data) => appended.push({ type, data }) }) },
      sandboxPolicy: { overrideOf: () => "danger-full-access" },
    }
    const { ctx, captured } = toolContext(fixture.subprocess, services)
    try {
      registerTaskTool(ctx)
      await captured[0].execute(
        { action: "dispatch", task: "login", project: PROJECT, tasksRoot: fixture.container, prompt: "go", permission: "workspace-write" },
        { agent: { session: { id: "session-caller" } } },
      )
      // `workspace-write` is a mode on its own: its preset already carries the deployment's
      // `ask`, so nothing else is written and the pair stays the one the table names.
      expect(appended).toEqual([{ type: "sandbox/mode", data: { mode: "workspace-write", source: "delegation" } }])
    } finally {
      await fixture.cleanup()
    }
  })

  it("says no session was opened when the deployment serves no session service", async () => {
    // Not a failure: the task space is still there, and the answer has to say what to do
    // instead rather than leaving the caller to believe a session is running.
    const fixture = await taskSpaceFixture()
    const { ctx, captured } = toolContext(fixture.subprocess)
    try {
      registerTaskTool(ctx)
      const value = await captured[0].execute(
        { action: "dispatch", task: "login", project: PROJECT, tasksRoot: fixture.container, prompt: "go" },
        {},
      )
      expect(value.action).toBe("dispatch")
      expect(value.sessionId).toBe("")
      expect(value.warnings.join(" ")).toMatch(/no session service/)
      expect(value.summary).toMatch(/No session was opened/)
    } finally {
      await fixture.cleanup()
    }
  })

  it("opens a session in the task space it just made, and hands it the work, in one call", async () => {
    const records = []
    const created = []
    const appended = []
    const prompts = []
    const services = {
      workspaceRegistry: {
        resolveByPath: async () => ({ id: "ws-login", title: "kratos-admin" }),
        create: async (path, title) => { records.push({ path, title }); return { path, title } },
      },
      sessionController: {
        create: async (place) => { created.push(place); return { sessionId: "session-1" } },
        prompt: async (request) => { prompts.push(request); return { accepted: true } },
      },
      sessions: { get: () => ({ append: (type, data) => appended.push({ type, data }) }) },
      sandboxPolicy: { overrideOf: () => "workspace-write" },
    }
    const { value, captured } = await createOnce(
      services,
      { prompt: "add the feature, then run the tests" },
      { agent: { session: { id: "session-caller" } } },
    )
    // The task space is still made and registered - once, by the create itself - and a session
    // is on it as well: one call leaves nothing half-started.
    expect(value.action).toBe("create")
    expect(value.sessionId).toBe("session-1")
    expect(records).toHaveLength(1)
    // Opened on the Workspace the create just registered, so it reads under that task.
    expect(created).toEqual([{ workspaceId: "ws-login" }])
    // The caller's own override, copied and marked as delegated rather than as a switch the
    // user made - the same event DSH seeds into a child agent.
    expect(appended).toEqual([{ type: "sandbox/mode", data: { mode: "workspace-write", source: "delegation" } }])
    expect(prompts).toEqual([{ sessionId: "session-1", content: [{ type: "text", text: "add the feature, then run the tests" }] }])
    expect(value.warnings).toEqual([])
    expect(value.summary).toMatch(/is on the work/)
    expectEnvelopeShape(captured[0].output.schema, value)
  })

  it("opens nothing when the create was not given a job to hand on", async () => {
    // No prompt, no session: a create that only wants the task space must not have to say so,
    // and must not need a session service to exist at all.
    const created = []
    const { value } = await createOnce({ sessionController: { create: async (place) => { created.push(place); return { sessionId: "x" } }, prompt: async () => ({}) } })
    expect(value.sessionId).toBe("")
    expect(created).toEqual([])
    expect(value.summary).not.toMatch(/is on the work/)
  })

  it("merges by itself when the task's own record says so, and not when the call said no", async () => {
    // `merge.mode: auto` is the user's standing answer that this merge happens on its own, so
    // the call does not have to ask for it. An explicit `merge: false` - an agent that was told
    // not to merge - stays a no: the hand that said it outranks the record.
    const auto = { merge: { mode: 'auto' } }
    const fixture = await taskSpaceFixture({ delivery: auto })
    try {
      const { ctx, captured } = toolContext(fixture.subprocess)
      registerTaskTool(ctx)
      const value = await captured[0].execute(
        { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container },
        {},
      )
      expect(value.repositories[0].merged).toBe(true)
    } finally {
      await fixture.cleanup()
    }
    const saidNo = await taskSpaceFixture({ delivery: auto })
    try {
      const { ctx, captured } = toolContext(saidNo.subprocess)
      registerTaskTool(ctx)
      const value = await captured[0].execute(
        { action: "done", task: "login", project: PROJECT, tasksRoot: saidNo.container, merge: false },
        {},
      )
      expect(value.repositories[0].merged).toBe(false)
    } finally {
      await saidNo.cleanup()
    }
  })

  it("refuses to merge a task whose own record says this flow does not merge it", async () => {
    const fixture = await taskSpaceFixture({ delivery: { merge: { mode: 'never' } } })
    try {
      const { ctx, captured } = toolContext(fixture.subprocess)
      registerTaskTool(ctx)
      await expect(captured[0].execute(
        { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container, merge: true },
        {},
      )).rejects.toMatchObject({ code: "E4013" })
      // And a finish that does not ask for a merge is not refused: the record forbids the
      // merge, not the finish.
      const value = await captured[0].execute(
        { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container },
        {},
      )
      expect(value.repositories[0].merged).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  it("refuses a permission it does not offer, and a task space that is not there", async () => {
    const fixture = await taskSpaceFixture()
    const { ctx, captured } = toolContext(fixture.subprocess, {
      sessionController: { create: async () => ({ sessionId: "session-4" }), prompt: async () => ({}) },
    })
    try {
      registerTaskTool(ctx)
      // The declared enum is what refuses a name outside the three, before the branch runs -
      // the runtime validates arguments ahead of the action, which is why the message is its
      // own wording rather than one written here.
      await expect(captured[0].execute(
        { action: "dispatch", task: "login", project: PROJECT, tasksRoot: fixture.container, prompt: "go", permission: "root" },
        {},
      )).rejects.toThrow(/must be one of/)
      await expect(captured[0].execute(
        { action: "dispatch", task: "nope", project: PROJECT, tasksRoot: fixture.container, prompt: "go" },
        {},
      )).rejects.toThrow(/no task space/)
    } finally {
      await fixture.cleanup()
    }
  })
})

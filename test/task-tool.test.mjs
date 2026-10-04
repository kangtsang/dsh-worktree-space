import { describe, expect, it } from "vitest"
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
 * @returns the context and the captured definitions.
 */
function toolContext(subprocess = quietSubprocess) {
  const captured = []
  const ctx = {
    subprocess,
    get: (name) => (name === "tools" ? { register: (definition) => { captured.push(definition); return () => {} } } : undefined),
  }
  return { ctx, captured }
}

/** A source root holding one repository. */
async function sourceFixture() {
  const root = await mkdtemp(join(tmpdir(), "multi-worktree-tool-"))
  await mkdir(join(root, "alpha", ".git"), { recursive: true })
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
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
    expect(captured[0].parameters.properties.action.enum).toEqual(["suggest-root", "create", "add", "list", "done"])
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
})

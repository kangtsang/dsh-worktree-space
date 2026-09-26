import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
    expect(captured[0].parameters.properties.action.enum).toEqual(["suggest-root", "create", "list", "done"])
    expect(typeof captured[0].execute).toBe("function")
    expect(typeof dispose).toBe("function")
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

  it("reports each task worktree a container holds", async () => {
    const container = await mkdtemp(join(tmpdir(), "multi-worktree-tool-tasks-"))
    const worktree = join(container, "login", "alpha")
    await mkdir(worktree, { recursive: true })
    await writeFile(join(worktree, ".git"), "gitdir: /elsewhere\n")
    const { ctx, captured } = toolContext()
    try {
      registerTaskTool(ctx)
      const value = await captured[0].execute({ action: "list", tasksRoot: container }, {})
      expect(value.repositories.map((row) => row.name)).toEqual(["login/alpha"])
      expect(value.summary).toContain("1 task")
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
    await expect(definition.execute({ action: "list" }, {})).rejects.toThrow(/tasksRoot is required/)
  })

  it("lets the declared enum reject an action it does not implement", async () => {
    const { ctx, captured } = toolContext()
    registerTaskTool(ctx)
    // Argument validation runs before the action switch, so an unknown action
    // never reaches the tool's own fallback branch.
    await expect(captured[0].execute({ action: "delete-everything" }, {})).rejects.toThrow(/must be one of/)
  })
})

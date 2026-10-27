import { describe, expect, it } from "vitest"
import { existsSync, rmSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { registerTaskTool } from "../src/host/task/tool.js"
import { parseGitArgv } from "../src/host/task/git.js"
import { PLUGIN_ROOT } from "../src/host/task/shared.js"
import { SCAN_CONCURRENCY } from "../src/host/task/concurrency.js"

/**
 * The record, from the task space directory: the plugin keeps it in its own directory, so
 * every fixture that hand-builds a task space has to put it there too.
 * @param taskPath - the task space directory.
 * @returns the record's absolute path.
 */
const recordAt = (taskPath) => join(taskPath, PLUGIN_ROOT, "worktree-space.json")

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
    // The tool reaches `subprocess` through `get`, not as a property, because the gate
    // mounts it into a session's own scope - a child fiber, where a property read of a
    // service that fiber chain did not provide throws instead of answering. A real
    // context answers both ways, so the double must too: answering only the property
    // would test a context shape the tool can no longer run in.
    get: (name) => {
      if (name === "tools") return { register: (definition) => { captured.push(definition); return () => {} } }
      if (name === "subprocess") return subprocess
      return services[name]
    },
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
    // Parsed by name, not by position: the git command line carries hardening `-c`
    // settings before `-C`, so `argv[2]` is no longer the directory.
    done: Promise.resolve({ exitCode: parseGitArgv(argv).args.join(" ").startsWith("show-ref") ? 1 : 0, signal: null }),
    collected: {
      stdout: { readFrom: () => ({ text: "" }) },
      stderr: { readFrom: () => ({ text: "" }) },
    },
  }),
}

/** A source root holding one repository. */
async function sourceFixture({ deployScript = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "multi-worktree-tool-"))
  await mkdir(join(root, "alpha", ".git"), { recursive: true })
  // A create that says it deploys needs something to deploy with (E4015), so a test whose
  // subject is the deploying shape has to give the source root an entry to find.
  if (deployScript) {
    await mkdir(join(root, PLUGIN_ROOT, "deploy"), { recursive: true })
    await writeFile(join(root, PLUGIN_ROOT, "deploy", "deploy.sh"), "#!/bin/sh\necho up\n", "utf8")
  }
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
 * @param extra - further arguments for the create call.
 * @param exec - the tool run context.
 * @param options - `keep` leaves the task space in place and hands back a `cleanup`, for a
 *   test that has to read what the create recorded before it goes.
 * @returns the action's value, the captured definition, the container, and a cleanup.
 */
async function createOnce(services = {}, extra = {}, exec = {}, { keep = false, deployScript = false } = {}) {
  const source = await sourceFixture({ deployScript })
  const container = await mkdtemp(join(tmpdir(), "multi-worktree-tool-register-"))
  const cleanup = async () => {
    await source.cleanup()
    await rm(container, { recursive: true, force: true })
  }
  try {
    const { ctx, captured } = toolContext(creatingSubprocess, services)
    registerTaskTool(ctx)
    const value = await captured[0].execute(
      { action: "create", sourceRoot: source.root, task: "login", tasksRoot: container, ...extra },
      exec,
    )
    if (!keep) await cleanup()
    return { value, captured, container, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

/** The project layer the task-space fixtures file their task under. */
const PROJECT = "kratos-admin"

/**
 * A container root for the tests that only need a path.
 *
 * The active-session guard compares paths and never touches the filesystem, so a fixed absolute
 * root answers for it; tests that need real directories build their own fixture.
 */
const CONTAINER = join(tmpdir(), "wts-tool-container")

/**
 * A task space with one worktree on disk and the record a create leaves, plus the
 * subprocess double that answers for its git reads.
 *
 * `keepWorktree` leaves the worktree where it is, which is what a finish that
 * cannot empty the container looks like from the outside: the removal was asked
 * for and the directory is still there.
 *
 * `conflict`, `uncommitted` and `dirtyCheckout` each make the double answer the way a
 * real repository does at that stop, so the flags the tool reports are produced by the
 * same code an agent would meet - not hand-built rows. `session` seeds the task record
 * with the session that was working in it, which is what the summary names.
 *
 * `unknownBranch` makes `show-ref` answer the way git does for a branch that is not
 * there, so a `target` the caller names resolves to nothing - the E4008 shape, which is
 * a failure that never starts a merge.
 * @param options - the shape to mock, and whether the removal should leave the worktree.
 * @returns the container root, the task space, the double, the calls made and a cleanup.
 */
async function taskSpaceFixture({ keepWorktree = false, delivery, conflict = false, uncommitted = false, dirtyCheckout = false, unknownBranch = false, session = "sess-task" } = {}) {
  const container = await mkdtemp(join(tmpdir(), "multi-worktree-tool-done-"))
  const taskPath = join(container, PROJECT, "login")
  const worktree = join(taskPath, "alpha")
  await mkdir(worktree, { recursive: true })
  await writeFile(join(worktree, ".git"), "gitdir: /elsewhere\n")
  // The record a create leaves behind, in the plugin's own directory, and the only
  // thing that says which branch this task made.
  await mkdir(join(taskPath, PLUGIN_ROOT), { recursive: true })
  await writeFile(recordAt(taskPath), JSON.stringify({
    task: "login", project: PROJECT, branch: "task/login",
    ...(session === "" ? {} : { sessions: [{ sessionId: session, role: "work", at: "2026-01-01T00:00:00Z" }] }),
    ...(delivery === undefined ? {} : { delivery }),
  }, null, 2) + "\n")
  const mainRepo = join(tmpdir(), "multi-worktree-tool-done-main-alpha")
  const porcelain = `worktree ${mainRepo}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${worktree}\nHEAD bbb\nbranch refs/heads/task/login\n`
  const calls = []
  const subprocess = {
    spawn: ({ argv }) => {
      // Parsed by name, not by position: the git command line carries hardening `-c`
      // settings before `-C`, so `argv[2]` is no longer the directory.
      const { cwd: gitCwd, args } = parseGitArgv(argv)
      const key = args.join(" ")
      calls.push(key)
      let exitCode = 0
      let stdout = ""
      if (key.startsWith("rev-parse --verify --quiet MERGE_HEAD")) {
        // A merge is standing only in the conflict shape.
        exitCode = conflict ? 0 : 1
      } else if (key.startsWith("rev-parse --abbrev-ref HEAD")) stdout = gitCwd === worktree ? "task/login" : "main"
      else if (key.startsWith("worktree list --porcelain")) stdout = porcelain
      else if (key.startsWith("show-ref --verify --quiet refs/heads/")) {
        // git's way of saying a branch is not there: a non-zero exit and no output.
        // `resolveMergeTarget` reads it as "this target is unusable" and throws E4008,
        // which is the failure that never starts a merge.
        if (unknownBranch) exitCode = 1
      } else if (key.startsWith("status --short")) {
        if (uncommitted) stdout = " M a.ts\n"
      } else if (key.startsWith("diff --name-only -z --diff-filter=U")) {
        // `-z` output, so the records are NUL-separated and there is no trailing newline
        // to trim. The stub has to produce the bytes real git produces under `-z`, not the
        // `\n`-separated shape of the same command without it: the reader splits on `\0`,
        // so a `\n` here would make the whole string one path - and the test would then be
        // verifying a shape git never emits.
        if (conflict) stdout = "src/a.ts\0"
      } else if (key.startsWith("diff --name-only -z HEAD")) {
        // The other `-z` listing `archive.js` reads: every path the merge changed, which
        // the marker scan then opens. Two of them, so the multi-record case is covered.
        if (conflict) stdout = "src/a.ts\0src/b.ts\0"
      } else if (key.startsWith("merge --no-ff --no-edit")) {
        // The rehearsal the finish runs before touching the target branch. A conflict
        // stops it with the merge standing; the dirty-checkout shape is refused by git
        // in its own words, which is what the tool has to tell apart from a conflict.
        if (dirtyCheckout) {
          exitCode = 1
        } else if (conflict) {
          exitCode = 1
        }
      }
      // The mocked removal has to change the filesystem: the container only becomes
      // removable once the directory it held is really gone. The path is read off the
      // parsed arguments rather than by position, because the hardening `-c` settings
      // before `-C` moved every position along.
      else if (key.startsWith("worktree remove") && !keepWorktree) rmSync(args[args.length - 1], { recursive: true, force: true })
      const stderr = dirtyCheckout && key.startsWith("merge --no-ff --no-edit")
        ? "error: Your local changes to the following files would be overwritten by merge:\n\ta.ts\n"
        : ""
      return {
        done: Promise.resolve({ exitCode, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: stdout }) },
          stderr: { readFrom: () => ({ text: stderr }) },
        },
      }
    },
  }
  return { container, taskPath, subprocess, calls, cleanup: () => rm(container, { recursive: true, force: true }) }
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
  it("registers exactly one wts_worktree_space tool and returns its disposer", () => {
    const { ctx, captured } = toolContext()
    const dispose = registerTaskTool(ctx)
    expect(captured).toHaveLength(1)
    expect(captured[0].name).toBe("wts_worktree_space")
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
      // holds. It is refused outright, before the container root is even resolved,
      // and before the `done` branch ever asks whether this call said `merge`.
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

  it("refuses strays discard, which deletes the user's own files", async () => {
    const { ctx, captured } = toolContext()
    try {
      registerTaskTool(ctx)
      // The other irreversible request, and refused for the same reason as force:
      // deleting files git never tracked has no reflog behind it and no branch to
      // recover from, so it is the user's own decision and not the model's. A
      // description that says "ask first" would be guidance rather than a gate,
      // which is why this is refused rather than discouraged.
      await expect(captured[0].execute({ action: "done", task: "login", strays: "discard", merge: false }, {}))
        .rejects.toMatchObject({ code: "E7007" })
      await expect(captured[0].execute({ action: "done", task: "login", strays: "discard", merge: false }, {}))
        .rejects.toThrow(/Worktree Space panel/)
      // The refusal is checked before `merge` is, so it bites even on a call that
      // left the required argument out - the model is told the real reason.
      await expect(captured[0].execute({ action: "done", task: "login", strays: "discard" }, {}))
        .rejects.toMatchObject({ code: "E7007" })
      // The two choices that lose nothing still go through to the host's own rules.
      for (const strays of ["archive", "keep"]) {
        await expect(captured[0].execute({ action: "done", task: "login", strays, merge: false }, {}))
          .rejects.not.toMatchObject({ code: "E7007" })
      }
    } finally { /* nothing was written: the refusal comes first */ }
  })

  it("refuses a finish that does not say whether to merge", async () => {
    const { ctx, captured } = toolContext()
    registerTaskTool(ctx)
    // `merge` is required, and it is required by the `done` branch rather than by
    // the parameter schema, because that schema is flat and shared by every action:
    // marking it required there would demand it of `create`, `list` and the rest.
    // So a call that leaves it out is refused by the hand-written check, with E7006.
    await expect(captured[0].execute({ action: "done", task: "login" }, {}))
      .rejects.toMatchObject({ code: "E7006" })
    await expect(captured[0].execute({ action: "done", task: "login" }, {}))
      .rejects.toThrow(/merge is required for done/)
    // A value that is not a boolean at all is refused a step earlier, by the schema's
    // own type check - which is the same answer by the other route: no finish ever
    // reads a `merge` that is not true or false.
    await expect(captured[0].execute({ action: "done", task: "login", merge: "true" }, {}))
      .rejects.toThrow(/merge/)
  })

  it("refuses a finish while a session is still working in the task space", async () => {
    // A finish removes the worktrees and the task space, so a session whose cwd is in there
    // loses the ground under it mid-turn. Refused before anything is removed, with the sessions
    // named and both honest ways forward.
    const taskPath = join(CONTAINER, "public", "login")
    const services = {
      agents: {
        list: () => [{
          id: "session-worker",
          status: "running",
          session: { header: { id: "session-worker", cwd: taskPath }, snapshotEvents: () => [] },
          inbox: {},
        }],
      },
    }
    const { ctx, captured } = toolContext(quietSubprocess, services)
    registerTaskTool(ctx)

    await expect(captured[0].execute(
      { action: "done", task: "login", project: "public", tasksRoot: CONTAINER, merge: false },
      {},
    )).rejects.toMatchObject({ code: "E5012" })
    await expect(captured[0].execute(
      { action: "done", task: "login", project: "public", tasksRoot: CONTAINER, merge: false },
      {},
    )).rejects.toThrow(/session-worker/)
  })

  it("lets a session finish its own work, and still refuses while another one is in there", async () => {
    // The session-finishes-its-own-work flow: the caller is running, with a turn open, inside the
    // very task space it is asking to remove. Counting the caller would refuse it with itself as
    // the blocker, and the only escape (cancel yourself first) ends the turn and the report with
    // it - so the caller is excluded and every other session still counts.
    const taskPath = join(CONTAINER, "public", "login")
    const caller = {
      id: "session-caller", status: "running", inbox: {},
      session: { header: { id: "session-caller", cwd: taskPath }, snapshotEvents: () => [{ type: "turn/start", data: { turn: 1 } }] },
    }
    const other = {
      id: "session-other", status: "running", inbox: {},
      session: { header: { id: "session-other", cwd: taskPath }, snapshotEvents: () => [{ type: "turn/start", data: { turn: 1 } }] },
    }
    const exec = { agent: { session: { id: "session-caller" } } }

    // Alone in the space: the caller is not its own blocker.
    const alone = toolContext(quietSubprocess, { agents: { list: () => [caller] } })
    registerTaskTool(alone.ctx)
    await expect(alone.captured[0].execute(
      { action: "done", task: "login", project: "public", tasksRoot: CONTAINER, merge: false },
      exec,
    )).rejects.not.toMatchObject({ code: "E5012" })

    // With another session in there: refused, and the other one is the session named.
    const together = toolContext(quietSubprocess, { agents: { list: () => [caller, other] } })
    registerTaskTool(together.ctx)
    await expect(together.captured[0].execute(
      { action: "done", task: "login", project: "public", tasksRoot: CONTAINER, merge: false },
      exec,
    )).rejects.toMatchObject({ code: "E5012" })
    await expect(together.captured[0].execute(
      { action: "done", task: "login", project: "public", tasksRoot: CONTAINER, merge: false },
      exec,
    )).rejects.toThrow(/session-other/)
  })

  it("counts a session that is mid-turn, or holding queued work, as still working", async () => {
    // Three signals, because each alone misses a case: `running` misses a turn that has ended
    // with work queued, the open turn misses a session the registry reports idle, and the inbox
    // misses a turn running with nothing queued. A finish has to see all three.
    const taskPath = join(CONTAINER, "public", "login")
    const cases = {
      "mid-turn": {
        id: "s-midturn", status: "idle", inbox: {},
        session: { header: { id: "s-midturn", cwd: taskPath }, snapshotEvents: () => [{ type: "turn/start", data: { turn: 1 } }] },
      },
      "queued work": {
        id: "s-queued", status: "idle",
        session: { header: { id: "s-queued", cwd: taskPath }, snapshotEvents: () => [] },
        inbox: { nextTurn: [{ id: "m1" }], nextStep: [] },
      },
    }
    for (const [label, agent] of Object.entries(cases)) {
      const { ctx, captured } = toolContext(quietSubprocess, { agents: { list: () => [agent] } })
      registerTaskTool(ctx)
      await expect(captured[0].execute(
        { action: "done", task: "login", project: "public", tasksRoot: CONTAINER, merge: false },
        {},
      ), label).rejects.toMatchObject({ code: "E5012" })
    }
  })

  it("lets a finish through when the session in that space has stopped", async () => {
    // The negative control: a session whose turn ended and whose inbox is empty is not working,
    // so the guard must not fire. Without this, a guard that always refused would pass the two
    // tests above.
    const taskPath = join(CONTAINER, "public", "login")
    const services = {
      agents: {
        list: () => [{
          id: "session-done",
          status: "idle",
          session: {
            header: { id: "session-done", cwd: taskPath },
            snapshotEvents: () => [{ type: "turn/start", data: { turn: 1 } }, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } }],
          },
          inbox: { nextTurn: [], nextStep: [] },
        }],
      },
    }
    const { ctx, captured } = toolContext(quietSubprocess, services)
    registerTaskTool(ctx)

    // It still fails - there is no task space on this fake filesystem - but NOT with E5012.
    await expect(captured[0].execute(
      { action: "done", task: "login", project: "public", tasksRoot: CONTAINER, merge: false },
      {},
    )).rejects.not.toMatchObject({ code: "E5012" })
  })

  it("ignores a session working outside the task space", async () => {
    // A finish is about one task space. A busy session elsewhere - another task, or the
    // dispatcher itself - must not block it, or no finish could ever run while the caller works.
    const services = {
      agents: {
        list: () => [{
          id: "session-elsewhere",
          status: "running",
          session: { header: { id: "session-elsewhere", cwd: join(CONTAINER, "public", "other-task") }, snapshotEvents: () => [] },
          inbox: {},
        }],
      },
    }
    const { ctx, captured } = toolContext(quietSubprocess, services)
    registerTaskTool(ctx)

    await expect(captured[0].execute(
      { action: "done", task: "login", project: "public", tasksRoot: CONTAINER, merge: false },
      {},
    )).rejects.not.toMatchObject({ code: "E5012" })
  })

  it("leaves the recoverable parts of finishing alone", async () => {
    const { ctx, captured } = toolContext()
    registerTaskTool(ctx)
    // Merging, and removing a branch once it has landed, are both available here:
    // `git branch -d` refuses an unmerged branch on its own, so neither loses a
    // commit. This asserts the refusal is scoped to `force` and nothing else.
    await expect(captured[0].execute({ action: "done", task: "login", merge: true, deleteBranch: true, strays: "archive" }, {}))
      .rejects.not.toMatchObject({ code: "E7007" })
  })

  it("describes force as unavailable, so the model is not asked to try it", () => {
    const { ctx, captured } = toolContext()
    registerTaskTool(ctx)
    expect(captured[0].parameters.properties.force.description).toMatch(/Refused here/)
    expect(captured[0].description).toMatch(/cannot do `force`/)
  })

  it("declares the delivery decisions where they are now taken, and nowhere else", () => {
    const { ctx, captured } = toolContext()
    registerTaskTool(ctx)
    const properties = captured[0].parameters.properties
    // The create states one flat target; the JSON policy blob it used to take is gone,
    // so a caller cannot hand over a field this flow no longer reads.
    expect(properties.deployTarget.enum).toEqual(["docker", "none"])
    expect(properties).not.toHaveProperty("delivery")
    // The finish states its own decisions, in the shape the action reads them.
    // `discard` stays declared and is refused by the guard, which is exactly how
    // `force` is treated: the parameter exists so the refusal can be explained in
    // full, and the description says which value this side will not carry out.
    expect(properties.strays.enum).toEqual(["archive", "keep", "discard"])
    expect(properties.strays.description).toMatch(/REFUSED here/)
    expect(properties.strays.description).toMatch(/E7007/)
    expect(properties.keepEntries.type).toBe("array")
    // The archive destination is not the model's to name: a caller-supplied directory
    // was the one parameter on this tool that could write outside the task space, and
    // the panel builds that path itself. The panel's own `task.done` endpoint still
    // carries it - see task-finish.test.tsx - so only the tool's declaration is gone.
    expect(properties).not.toHaveProperty("documentsDirectory")
    // `merge` is still a plain optional boolean in the schema - it is the `done`
    // branch, not the declaration, that makes it required - so the model is told so
    // in the description instead.
    expect(properties.merge.type).toBe("boolean")
    expect(properties.merge.description).toMatch(/REQUIRED for done/)
    expect(properties.merge.description).toMatch(/E7006/)
    // And the three names they replaced are not offered under their old spellings.
    expect(properties).not.toHaveProperty("cleanStray")
    expect(properties).not.toHaveProperty("keep")
    expect(properties).not.toHaveProperty("discardDocuments")
  })

  it("asks for the acceptance fence before anything is created, and says where it belongs", () => {
    const { ctx, captured } = toolContext()
    registerTaskTool(ctx)
    const properties = captured[0].parameters.properties
    // The decision is create-time only, so the parameter's own default is otherwise an
    // answer nobody gave; the description has to say where the question belongs.
    expect(properties.deployTarget.description).toMatch(/before anything is created or dispatched/)
    expect(properties.deployTarget.description).toMatch(/cannot be added or changed afterwards/)
    // And the tool's own description carries the rule too, because `dispatch` takes no
    // delivery argument at all - this is the only place a fence can be asked about when
    // the space already exists.
    expect(captured[0].description).toMatch(/Ask about the acceptance fence/)
    expect(captured[0].description).toMatch(/never answer it for the user/)
    expect(captured[0].description).toMatch(/the smoke is the finish line/)
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

  it("asks about a repository's branch a few at a time, not all of them at once", async () => {
    // The dialog names the branch every repository's HEAD is on, which is one
    // `git rev-parse` each. Asking for all of them together is the shape the scan was
    // fixed for: with forty repositories it was forty `git.exe` processes alive at once,
    // competing for process creation rather than doing git work. The double counts what
    // is in flight while it takes real time - an instant one would let a serial loop and
    // a parallel one look identical.
    const root = await mkdtemp(join(tmpdir(), "multi-worktree-tool-many-"))
    const count = 24
    for (let index = 0; index < count; index++) {
      await mkdir(join(root, `repo-${String(index).padStart(2, "0")}`, ".git"), { recursive: true })
    }
    let active = 0
    let peak = 0
    const subprocess = {
      spawn() {
        active++
        peak = Math.max(peak, active)
        return {
          done: new Promise((resolve) => setTimeout(() => {
            active--
            resolve({ exitCode: 0, signal: null })
          }, 2)),
          collected: {
            stdout: { readFrom: () => ({ text: "" }) },
            stderr: { readFrom: () => ({ text: "" }) },
          },
        }
      },
    }
    const { ctx, captured } = toolContext(subprocess)
    try {
      registerTaskTool(ctx)
      const value = await captured[0].execute({ action: "suggest-root", sourceRoot: root }, {})
      // Every repository, once: the ceiling changed the scheduling, not the answer.
      expect(value.repositories).toHaveLength(count)
      expect(peak).toBeGreaterThan(1)
      expect(peak).toBeLessThanOrEqual(SCAN_CONCURRENCY)
    } finally {
      await rm(root, { recursive: true, force: true })
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
    await mkdir(join(taskPath, PLUGIN_ROOT), { recursive: true })
    await writeFile(recordAt(taskPath), JSON.stringify({
      version: 1, task: "login", project: "kratos-admin", tasksRoot: container,
      sourceRoot: "E:/source", branch: "task/login", baseRef: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      repositories: [{ name: "alpha", sourcePath: "E:/source/alpha", branch: "task/login" }],
    }))
    // A repository somewhere else entirely — the arrangement the action exists for.
    const gamma = join(container, "..", "multi-worktree-tool-add-elsewhere", "gamma")
    await mkdir(join(gamma, ".git"), { recursive: true })
    const subprocess = {
      spawn: ({ argv }) => {
        // Parsed by name, not by position: the git command line carries hardening `-c`
        // settings before `-C`, so `argv[2]` is no longer the directory.
        const key = parseGitArgv(argv).args.join(" ")
        return {
          done: Promise.resolve({ exitCode: key.startsWith("show-ref") ? 1 : 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: key.includes("--abbrev-ref") ? "task/login" : "" }) },
            stderr: { readFrom: () => ({ text: "" }) },
          },
        }
      },
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

  it("records the delivery target the create stated, and nothing else", async () => {
    // The delivery bar is the user's to set, and a create is where they state it: the flat
    // `deployTarget` the call carries is wrapped as the policy the record keeps. The policy
    // is one field now, and the per-project stored default it used to fall back on is gone,
    // so what this call says is the whole of what the task's own record knows.
    const { value, cleanup } = await createOnce({}, { deployTarget: "docker" }, {}, { keep: true, deployScript: true })
    try {
      const record = JSON.parse(await readFile(recordAt(value.container), "utf8"))
      expect(record.delivery).toEqual({ version: 1, deploy: { target: "docker" } })
    } finally {
      await cleanup()
    }
  })

  it("records the built-in default when the create states no delivery target", async () => {
    // Nothing stated, nothing deployed and no gate: a task nobody configured has to stay
    // exactly as finishable as it was before delivery policies existed.
    const { value, cleanup } = await createOnce({}, {}, {}, { keep: true })
    try {
      const record = JSON.parse(await readFile(recordAt(value.container), "utf8"))
      expect(record.delivery).toEqual({ version: 1, deploy: { target: "none" } })
    } finally {
      await cleanup()
    }
  })

  it("refuses a deploy target the declared enum does not offer, before anything is made", async () => {
    // The target is a flat string with a closed list, so the runtime's own validation is
    // what refuses a name outside it - ahead of the action, and therefore before a single
    // directory is made. `create.js` would answer E4010 for the same value; it never sees
    // this one.
    const source = await sourceFixture()
    const container = await mkdtemp(join(tmpdir(), "multi-worktree-tool-register-"))
    const { ctx, captured } = toolContext(creatingSubprocess)
    try {
      registerTaskTool(ctx)
      await expect(captured[0].execute(
        { action: "create", sourceRoot: source.root, task: "login", tasksRoot: container, deployTarget: "kubernetes" },
        {},
      )).rejects.toThrow(/must be one of/)
      expect(await readdir(container)).toEqual([])
    } finally {
      await source.cleanup()
      await rm(container, { recursive: true, force: true })
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
        { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container, merge: false },
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
        { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container, unregisterWorkspace: false, merge: false },
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
          { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container, merge: false },
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
        { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container, merge: false },
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
          { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container, merge: false },
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
        { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container, merge: false },
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
    // whose own directory name it is. `merge` is said here because `done` refuses a
    // call that leaves it out before it ever reaches the project layer.
    await expect(definition.execute({ action: "done", task: "x", tasksRoot: "/tmp", merge: false }, {}))
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
    const signals = []
    const services = {
      sessionController: {
        create: async (place) => { created.push(place); return { sessionId: "session-1" } },
        prompt: async (request, signal) => { prompts.push(request); signals.push(signal); return { accepted: true } },
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
      // The request is the typed shape the Host's own client sends: a minted requestId, the queue
      // mode, the text, and the caller's zone. Sending the id and the content alone was what the
      // Host reported as `prompt rejected`.
      expect(prompts).toHaveLength(1)
      expect(typeof prompts[0].requestId).toBe("string")
      expect(prompts[0].requestId).not.toBe("")
      expect(prompts[0].mode).toBe("queue")
      expect(prompts[0].sessionId).toBe("session-1")
      expect(prompts[0].content).toEqual([{ type: "text", text: expect.stringContaining("build it, then smoke it") }])
      // The standing section travels in front of the caller's own words, because a
      // dispatched session cannot be reached by `send_message` afterwards - a brief
      // that forgot the reporting channel could not be corrected. The caller's text
      // is still there, verbatim, after it.
      const brief = prompts[0].content[0].text
      expect(brief.indexOf("build it, then smoke it")).toBeGreaterThan(0)
      expect(brief).toContain("session-caller")
      expect(brief).toContain("task/login")
      expect(brief).toContain("wts_session_tool send")
      expect(brief).toContain("steer")
      expect(typeof prompts[0].clientTimeZone).toBe("string")
      // The signal the contract names as well: declared required and dereferenced unguarded, so a
      // handoff that omitted it crashed before the request was ever read. This is that regression.
      expect(signals).toHaveLength(1)
      expect(typeof signals[0]?.throwIfAborted).toBe("function")
      expect(() => signals[0].throwIfAborted()).not.toThrow()
      // The caller's own override, copied and marked as delegated rather than as a switch the
      // user made - the same events DSH seeds into a child agent. `danger-full-access` is a
      // bundle in DSH's own table ("full file access without approval prompts"), so its
      // approval policy is written with it.
      expect(appended).toEqual([
        { type: "sandbox/mode", data: { mode: "danger-full-access", source: "delegation" } },
        { type: "approval/policy", data: { policy: "never", source: "delegation" } },
      ])
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toMatchObject({ sessionId: "session-1" })
      expect(prompts[0].content[0].text).toContain("build it, then smoke it")
      expect(value.warnings).toEqual([])
      expect(value.summary).toContain("session-1")
      expectEnvelopeShape(captured[0].output.schema, value)
    } finally {
      await fixture.cleanup()
    }
  })

  it("hands a deploying task's session the completion line, and only a deploying one", async () => {
    // The fence is settled at create, and this brief is the last moment its completion line
    // can be stated: a session that was never told is free to report written code as a
    // finished task, and the finish gate would then refuse a merge nobody was warned about.
    const deploys = await taskSpaceFixture({ delivery: { deploy: { target: 'docker' } } })
    const plain = await taskSpaceFixture({ delivery: { deploy: { target: 'none' } } })
    try {
      const briefFor = async (fixture) => {
        const prompts = []
        const { ctx, captured } = toolContext(fixture.subprocess, {
          sessionController: {
            create: async () => ({ sessionId: "session-1" }),
            prompt: async (request) => { prompts.push(request); return { accepted: true } },
          },
          workspaceRegistry: {
            create: async () => ({}),
            resolveByPath: async () => ({ id: "ws-login", title: "kratos-admin/login" }),
            list: () => [{ id: "ws-login", path: fixture.taskPath }],
          },
        })
        registerTaskTool(ctx)
        await captured[0].execute(
          { action: "dispatch", task: "login", project: PROJECT, tasksRoot: fixture.container, prompt: "go" },
          { agent: { session: { id: "session-caller" } } },
        )
        return prompts[0].content[0].text
      }
      const told = await briefFor(deploys)
      expect(told).toContain("its smoke is the finish line")
      expect(told).toContain("has run `smoke`")
      // The control, and the reason it is here: the same line for a task with nothing to
      // deploy would be noise every session learns to read past.
      expect(await briefFor(plain)).not.toContain("smoke is the finish line")
    } finally {
      await deploys.cleanup()
      await plain.cleanup()
    }
  })

  it("tells a dispatched session when it must report back, not only that it can", async () => {
    // The channel alone was not enough. A dispatched session has no way to see what the
    // caller knows, and the caller has no way to see this session - so a member that never
    // reports is a task the caller cannot act on, and nothing in the brief used to make the
    // obligation explicit: one sentence at the end of the standing section, sitting after
    // the paragraph that says finishing is the user's decision, which read as though
    // reporting were part of the optional half of it. What is pinned here is that all three
    // moments survive into the prompt.
    const fixture = await taskSpaceFixture()
    try {
      const prompts = []
      const { ctx, captured } = toolContext(fixture.subprocess, {
        sessionController: {
          create: async () => ({ sessionId: "session-1" }),
          prompt: async (request) => { prompts.push(request); return { accepted: true } },
        },
      })
      registerTaskTool(ctx)
      await captured[0].execute(
        { action: "dispatch", task: "login", project: PROJECT, tasksRoot: fixture.container, prompt: "go" },
        { agent: { session: { id: "session-caller" } } },
      )
      const brief = prompts[0].content[0].text

      // Its own heading, not a clause inside another point: the reader has to see it as a
      // requirement before it sees the work.
      expect(brief).toContain("# Reporting back is required")
      // The channel, and the caller it reaches. Without the id the session is told to
      // report to something it cannot name.
      expect(brief).toContain("wts_session_tool send")
      expect(brief).toContain("session-caller")
      expect(brief).toContain("steer")
      // The four moments, each stated as an obligation rather than as advice. The first is
      // the one that makes the other three cheap: an aim confirmed before any code exists is
      // a correction of one message, where the same misreading found at the finish is a
      // finished change nobody asked for.
      expect(brief).toMatch(/Before you start work, once you understand the task/)
      expect(brief).toMatch(/Every finished unit of delivery/)
      expect(brief).toMatch(/the moment you are stuck/i)
      expect(brief).toMatch(/When the task is finished/)
      // The flag the finish is recognised by, stated where the obligation is. The watch that
      // tells the caller a session stopped without a final report keys on
      // `finalReport: true`, so an obligation that names the report but never the flag leaves
      // every dispatched task reported as missing one: the send arrives, the flag does not,
      // and the caller is told the work is unaccounted for while the account sits in its
      // inbox. It has to be scoped to the finish as well - the other three moments carry no
      // flag, and a model that reads it as applying to all four turns every progress update
      // into a claim that the work is handed over.
      expect(brief).toContain("finalReport: true")
      expect(brief).toMatch(/The three moments above do not carry it/)
      // The two lines that keep the contract from reading as optional: the four moments are
      // never optional, and reporting a finish is not replaced by performing it. A member that
      // calls `done` and stops leaves the caller holding a changed task space and no account
      // of why.
      expect(brief).toContain("The four moments below are never optional")
      expect(brief).toMatch(/finishing the work yourself replace reporting it/)
      // And the final report still has to carry the four facts, the acceptance URL among
      // them - that requirement predates this section and must not have been lost to it.
      expect(brief).toContain("commit hash of each repository")
      expect(brief).toContain("the acceptance URL")
      expect(brief).toContain("what you did not verify")
      // The permission the contract cannot grant: a report that says nothing is worse
      // than silence, so the judgement call is stated too - and it has to stay scoped to
      // what lies *outside* the three moments. Without that scope a model reads the
      // permission as covering the three, which is the one misreading this section exists
      // to prevent (dropping "Outside the three," passed every other assertion here).
      expect(brief).toMatch(/Outside the four, a report\s+that would only say nothing happened is one to skip/)
      // The work itself is still after the contract, and still intact.
      expect(brief.indexOf("# Reporting back is required")).toBeLessThan(brief.indexOf("# The work"))
      expect(brief).toContain("go")
    } finally {
      await fixture.cleanup()
    }
  })

  it("starts watching the dispatched session, so an abnormal turn reaches the dispatcher", async () => {
    // The whole point of the watch: the dispatcher asked once and was told "started". Without
    // this, a session whose model call fails is a task that dies silently in a session nobody
    // has a reason to poll.
    const fixture = await taskSpaceFixture()
    const watched = []
    const services = {
      sessionController: {
        create: async () => ({ sessionId: "session-1" }),
        prompt: async () => ({ accepted: true }),
      },
      workspaceRegistry: {
        create: async () => ({}),
        resolveByPath: async () => ({ id: "ws-login" }),
        list: () => [],
      },
    }
    const { ctx, captured } = toolContext(fixture.subprocess, services)
    try {
      registerTaskTool(ctx, {
        sessionWatch: {
          watch: (sessionId, task, sender, taskPath, sourceRoot) => watched.push({ sessionId, task, sender, taskPath, sourceRoot }),
        },
      })
      const sourceRoot = join(fixture.container, "src")
      const value = await captured[0].execute(
        { action: "dispatch", task: "login", project: PROJECT, tasksRoot: fixture.container, sourceRoot, prompt: "go" },
        { agent: { session: { id: "session-caller" } } },
      )

      expect(value.sessionId).toBe("session-1")
      // Watched by the session that was opened, named by the task, addressed to the caller -
      // and armed only after the work was actually handed over. Watching is the default.
      expect(watched).toHaveLength(1)
      expect(watched[0]).toMatchObject({ sessionId: "session-1", task: "login", sender: "session-caller" })
      // The two coordinates a later "did it report?" is answered from, captured now because by
      // then the task space may be gone: the live record is read from this path, and the archive
      // it is filed into is found from this source root.
      expect(watched[0].taskPath).toBe(join(fixture.container, PROJECT, "login"))
      expect(watched[0].sourceRoot).toBe(sourceRoot)
    } finally {
      await fixture.cleanup()
    }
  })

  it("leaves the session unwatched when the call passes watchSession false", async () => {
    // The switch is per call, not a plugin setting: one dispatch may want the notices and the
    // next may not, and a task whose failures nobody needs to hear about should not produce them.
    const fixture = await taskSpaceFixture()
    const watched = []
    const services = {
      sessionController: {
        create: async () => ({ sessionId: "session-1" }),
        prompt: async () => ({ accepted: true }),
      },
      workspaceRegistry: { create: async () => ({}), resolveByPath: async () => ({ id: "ws-login" }), list: () => [] },
    }
    const { ctx, captured } = toolContext(fixture.subprocess, services)
    try {
      registerTaskTool(ctx, {
        sessionWatch: { watch: (sessionId, task, sender) => watched.push({ sessionId, task, sender }) },
      })
      const value = await captured[0].execute(
        { action: "dispatch", task: "login", project: PROJECT, tasksRoot: fixture.container, prompt: "go", watchSession: false },
        { agent: { session: { id: "session-caller" } } },
      )

      // The dispatch itself still happened; only the watch is gone.
      expect(value.sessionId).toBe("session-1")
      expect(watched).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  it("declares watchSession among the parameters, defaulting to on", () => {
    const { ctx, captured } = toolContext()
    registerTaskTool(ctx)
    const properties = captured[0].parameters.properties
    expect(properties.watchSession.type).toBe("boolean")
    // Documented as on-by-default in the description, since the parameter carries no default
    // value of its own - absence has to read as "watch".
    expect(properties.watchSession.description).toMatch(/True by default/)
  })

  it("still dispatches when no watcher was handed in", async () => {
    // A deployment whose entry made no watcher must lose only the notices, never the dispatch.
    const fixture = await taskSpaceFixture()
    const services = {
      sessionController: {
        create: async () => ({ sessionId: "session-1" }),
        prompt: async () => ({ accepted: true }),
      },
      workspaceRegistry: { create: async () => ({}), resolveByPath: async () => ({ id: "ws-login" }), list: () => [] },
    }
    const { ctx, captured } = toolContext(fixture.subprocess, services)
    try {
      registerTaskTool(ctx)
      const value = await captured[0].execute(
        { action: "dispatch", task: "login", project: PROJECT, tasksRoot: fixture.container, prompt: "go" },
        { agent: { session: { id: "session-caller" } } },
      )
      expect(value.sessionId).toBe("session-1")
      expect(value.warnings).toEqual([])
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

  it("refuses to open a session at full access while the user's grant for it is off", async () => {
    // The one capability on this tool's surface that is not the model's to hand itself.
    // The description says "ask the user first", and a description is content a model can
    // be talked out of - so the grant is read here, and a call that asks for the whole
    // machine while it is off is refused with the code the panel path uses.
    const fixture = await taskSpaceFixture()
    const created = []
    const services = {
      sessionController: { create: async () => { created.push("session"); return { sessionId: "session-3" } }, prompt: async () => ({}) },
      sessions: { get: () => ({ append: () => {} }) },
      sandboxPolicy: { overrideOf: () => "danger-full-access" },
    }
    const { ctx, captured } = toolContext(fixture.subprocess, services)
    try {
      // Nothing passed to the registrar: a deployment that wires no reader answers `off`,
      // which is the setting's own default.
      registerTaskTool(ctx)
      await expect(captured[0].execute(
        { action: "dispatch", task: "login", project: PROJECT, tasksRoot: fixture.container, prompt: "go", permission: "danger-full-access" },
        { agent: { session: { id: "session-caller" } } },
      )).rejects.toMatchObject({ code: "E4012" })
      // Refused before anything was opened: no session left in the task space with no work.
      expect(created).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  it("opens a session at full access when the user has switched the grant on", async () => {
    // The other half of the gate: with the setting on, the call the panel would have made
    // is allowed here too - and written as the pair DSH's own table means.
    const fixture = await taskSpaceFixture()
    const appended = []
    const services = {
      sessionController: { create: async () => ({ sessionId: "session-3" }), prompt: async () => ({}) },
      sessions: { get: () => ({ append: (type, data) => appended.push({ type, data }) }) },
      sandboxPolicy: { overrideOf: () => undefined },
    }
    const { ctx, captured } = toolContext(fixture.subprocess, services)
    try {
      registerTaskTool(ctx, { configuredFullAccess: () => "on" })
      await captured[0].execute(
        { action: "dispatch", task: "login", project: PROJECT, tasksRoot: fixture.container, prompt: "go", permission: "danger-full-access" },
        { agent: { session: { id: "session-caller" } } },
      )
      expect(appended).toEqual([
        { type: "sandbox/mode", data: { mode: "danger-full-access", source: "delegation" } },
        { type: "approval/policy", data: { policy: "never", source: "delegation" } },
      ])
    } finally {
      await fixture.cleanup()
    }
  })

  it("leaves `inherit` alone even while the grant is off", async () => {
    // The boundary of the gate, and the reason it is not a general permission check: with
    // the caller's own override already at full access, `inherit` copies exactly that - a
    // grant the user made for the session they are in - so it can never be wider than its
    // caller, and refusing it would be this side overruling the user's own authorisation.
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
      const value = await captured[0].execute(
        { action: "dispatch", task: "login", project: PROJECT, tasksRoot: fixture.container, prompt: "go" },
        { agent: { session: { id: "session-caller" } } },
      )
      expect(value.sessionId).toBe("session-3")
      expect(appended).toEqual([
        { type: "sandbox/mode", data: { mode: "danger-full-access", source: "delegation" } },
        { type: "approval/policy", data: { policy: "never", source: "delegation" } },
      ])
    } finally {
      await fixture.cleanup()
    }
  })

  it("refuses a create that asked for full access before it cuts anything", async () => {
    // The same gate on the other door, and at the earlier point: a create that refused
    // after cutting the worktrees would leave a task space on disk with no session on it
    // and a caller told the call failed - the state E2002 exists to describe. So nothing
    // is made, and the task name is still free afterwards.
    const source = await sourceFixture()
    const container = await mkdtemp(join(tmpdir(), "multi-worktree-tool-fullaccess-"))
    try {
      const { ctx, captured } = toolContext(creatingSubprocess, {
        sessionController: { create: async () => ({ sessionId: "session-1" }), prompt: async () => ({}) },
        sessions: { get: () => ({ append: () => {} }) },
      })
      registerTaskTool(ctx)
      await expect(captured[0].execute(
        { action: "create", sourceRoot: source.root, task: "login", tasksRoot: container, prompt: "go", permission: "danger-full-access" },
        { agent: { session: { id: "session-caller" } } },
      )).rejects.toMatchObject({ code: "E4012" })
      expect(existsSync(join(container, source.root.split(/[\\/]/).pop()))).toBe(false)
    } finally {
      await source.cleanup()
      await rm(container, { recursive: true, force: true })
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
    expect(prompts).toHaveLength(1)
    // The same standing section a dispatch carries, with the create's own facts in
    // it - and the caller's text still intact after it.
    expect(prompts[0].sessionId).toBe("session-1")
    expect(prompts[0].content[0].text).toContain("add the feature, then run the tests")
    expect(prompts[0].content[0].text).toContain("task/login")
    expect(prompts[0].content[0].text).toContain("session-caller")
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

  it("merges exactly when the call asks for it, with nothing left for the record to decide", async () => {
    // `merge` is the caller's own answer and there is no policy fallback behind it any
    // more: the same record finishes one way or the other depending on what this call
    // says, and no field of it is read for a standing answer.
    const asked = await taskSpaceFixture({ delivery: { deploy: { target: 'none' } } })
    try {
      const { ctx, captured } = toolContext(asked.subprocess)
      registerTaskTool(ctx)
      const value = await captured[0].execute(
        { action: "done", task: "login", project: PROJECT, tasksRoot: asked.container, merge: true },
        {},
      )
      expect(value.repositories[0].merged).toBe(true)
    } finally {
      await asked.cleanup()
    }
    const saidNo = await taskSpaceFixture({ delivery: { deploy: { target: 'none' } } })
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

  it("refuses a merge the record's own deployment policy gates, and only the merge", async () => {
    // The one thing the record still decides: a task whose target is docker may not land
    // until a smoke has passed. The refusal is the gate's own (E5006, the single code for
    // both "no state file" and "smoke not green"), it applies to the merge alone, and a
    // finish that leaves the work on its branch goes through.
    const fixture = await taskSpaceFixture({ delivery: { deploy: { target: 'docker' } } })
    try {
      const { ctx, captured } = toolContext(fixture.subprocess)
      registerTaskTool(ctx)
      await expect(captured[0].execute(
        { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container, merge: true },
        {},
      )).rejects.toMatchObject({ code: "E5006" })
      // And a finish that does not ask for a merge is not refused: the policy gates the
      // merge, not the finish.
      const value = await captured[0].execute(
        { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container, merge: false },
        {},
      )
      expect(value.repositories[0].merged).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  it("passes the finish's own strays choice through, keep list and all", async () => {
    // The strays decision is the call's now, not a policy recorded at create time. `keep`
    // touches nothing at all, so the untracked entry survives - and so does the whole task
    // space, because a directory with something in it is one this finish cannot remove.
    const fixture = await taskSpaceFixture()
    await writeFile(join(fixture.taskPath, "notes.md"), "what I was in the middle of\n")
    const { ctx, captured } = toolContext(fixture.subprocess)
    try {
      registerTaskTool(ctx)
      const value = await captured[0].execute(
        { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container, merge: false, strays: "keep" },
        {},
      )
      expect(value.repositories[0].removed).toBe(true)
      expect(existsSync(join(fixture.taskPath, "notes.md"))).toBe(true)
      // Nothing was disposed of, so the container is still there - which is exactly
      // what `keep` asks for, and why the Workspace registration stays with it.
      expect(value.container).not.toBe("")
    } finally {
      await fixture.cleanup()
    }
  })

  it("leaves a named entry alone even when the choice was to file everything away", async () => {
    // `keepEntries` is the exception that outranks whatever `strays` says, entry by entry:
    // a caller archiving the leftovers can still name the one file it wants left where it
    // is. What it named is still there, and the space it is in is therefore still there too.
    //
    // `archive` rather than `discard` because the tool refuses `discard` (E7007); the
    // exception itself behaves the same either way, and the panel's own path - which can
    // discard - is covered in task-operations.
    const fixture = await taskSpaceFixture()
    await writeFile(join(fixture.taskPath, "notes.md"), "the one thing worth keeping\n")
    await writeFile(join(fixture.taskPath, "scratch.txt"), "not worth keeping\n")
    const { ctx, captured } = toolContext(fixture.subprocess)
    try {
      registerTaskTool(ctx)
      const value = await captured[0].execute(
        { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container, merge: false, strays: "archive", keepEntries: ["notes.md"] },
        {},
      )
      expect(value.repositories[0].removed).toBe(true)
      expect(existsSync(join(fixture.taskPath, "notes.md"))).toBe(true)
      // The entry that was not named leaves the space either way: filed away under
      // `archive`, deleted under `discard`.
      expect(existsSync(join(fixture.taskPath, "scratch.txt"))).toBe(false)
      expect(value.container).not.toBe("")
    } finally {
      await fixture.cleanup()
    }
  })

  it("files strays into the container-root default, ignoring a directory the call names", async () => {
    // `archive`, the default when the call says nothing, is the one answer that neither
    // loses the caller's content nor leaves the task space standing. The destination is
    // not this call's to name any more: the tool declares no such parameter, and a call
    // that still carries one is ignored rather than obeyed - so the content lands in the
    // container root's own `archived-docs`, which is the path the panel shows the user.
    const fixture = await taskSpaceFixture()
    await writeFile(join(fixture.taskPath, "notes.md"), "kept for the record\n")
    const named = await mkdtemp(join(tmpdir(), "multi-worktree-tool-documents-"))
    const { ctx, captured } = toolContext(fixture.subprocess)
    try {
      registerTaskTool(ctx)
      const value = await captured[0].execute(
        { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container, merge: false, documentsDirectory: named },
        {},
      )
      expect(value.repositories[0].removed).toBe(true)
      expect(existsSync(join(fixture.taskPath, "notes.md"))).toBe(false)
      // The directory the call named is not the destination: nothing was filed there.
      expect(existsSync(join(named, "notes.md"))).toBe(false)
      // It went to the default instead, under the container root, in the project and
      // stamped-task folders the panel's own dialog would have proposed.
      const [folder] = await readdir(join(fixture.container, "archived-docs", PROJECT))
      expect(folder).toMatch(/^login-\d{8}-\d{6}$/)
      expect(existsSync(join(fixture.container, "archived-docs", PROJECT, folder, "notes.md"))).toBe(true)
      // Everything left the space, so the container went with it.
      expect(value.container).toBe("")
    } finally {
      await fixture.cleanup()
      await rm(named, { recursive: true, force: true })
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

  it("calls a failure a failure when no merge was ever started", async () => {
    // The E4008 shape: an explicit `target` that is not a local branch. `resolveMergeTarget`
    // throws it from inside the finish's `try`, before any merge is started, so there is no
    // MERGE_HEAD and no conflicted file to reconcile. Marking it a conflict - which is what
    // `conflict = !dirtyCheckout` did - sent the reader after markers that do not exist,
    // filed the audit record as E5001 ("unmerged work") instead of E5003, and dropped the
    // row out of `attention` entirely: the model read "Task 'login' finished", a "need
    // attention" list that named nothing, and no reason anywhere.
    const fixture = await taskSpaceFixture({ unknownBranch: true })
    const { ctx, captured } = toolContext(fixture.subprocess)
    try {
      registerTaskTool(ctx)
      const value = await captured[0].execute(
        { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container, merge: true, target: "nope" },
        {},
      )
      const row = value.repositories[0]
      // A plain failure, not a conflict: nothing is standing and there is nothing to reconcile.
      expect(row.conflict).toBe(false)
      expect(row.mergeInProgress).toBe(false)
      expect(row.mergeSite).toBe("")
      expect(row.conflictedFiles).toEqual([])
      expect(row.merged).toBe(false)
      expect(row.removed).toBe(false)
      // The real reason reaches the model, in the attention list, naming the repository.
      // The code is part of the sentence now, ahead of the message - see `coded` in
      // codes.js for why: the harness hands a tool failure to the model as `error.message`
      // alone, so a code that lived only on `.code` was one the model was told to branch on
      // and never received.
      expect(row.error).toMatch(/merge target 'nope' is not a local branch/)
      expect(row.error).toContain("E4008")
      expect(value.failed).toBe(true)
      expect(value.summary).toContain("need attention")
      expect(value.summary).toMatch(/alpha: E4008: merge target 'nope' is not a local branch/)
      // And the headline does not claim the task finished over a row that did nothing.
      expect(value.summary).not.toMatch(/Task 'login' finished/)
      expect(value.summary).toContain("is unfinished")
      // The path is named, so the reader knows what to go and look at.
      expect(value.summary).toContain(join(fixture.taskPath, "alpha"))
    } finally {
      await fixture.cleanup()
    }
  })

  it("still calls a standing merge a conflict, and routes it", async () => {
    // The other half of the same distinction, kept green: a merge that really is standing
    // has a MERGE_HEAD and files to reconcile, and that is what the reader is sent after.
    // Without this, "call nothing a conflict" would satisfy the test above.
    const fixture = await taskSpaceFixture({ conflict: true })
    const { ctx, captured } = toolContext(fixture.subprocess)
    try {
      registerTaskTool(ctx)
      const value = await captured[0].execute(
        { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container, merge: true },
        {},
      )
      const row = value.repositories[0]
      expect(row.conflict).toBe(true)
      expect(row.mergeInProgress).toBe(true)
      expect(row.conflictedFiles).toEqual(["src/a.ts"])
      expect(value.summary).toContain("a merge is waiting to be resolved")
      expect(value.summary).toContain("call done again")
      // Routed through the handoff sentence, and the conflict's own files are named
      // there rather than repeated in the plain attention list.
      expect(value.summary).toContain("Resolve src/a.ts")
    } finally {
      await fixture.cleanup()
    }
  })

  it("flags a conflict and names the session to hand it to, without matching English", async () => {
    // The row a caller has to route rather than retry. It reaches the model as a FLAG
    // plus the checkout and files - never as a sentence to be pattern-matched - and the
    // summary says who to talk to, because a stop with no route is a finish that ends
    // with nothing but the panel.
    const fixture = await taskSpaceFixture({ conflict: true })
    const { ctx, captured } = toolContext(fixture.subprocess)
    try {
      registerTaskTool(ctx)
      const value = await captured[0].execute(
        { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container, merge: true },
        {},
      )
      const row = value.repositories[0]
      expect(row.conflict).toBe(true)
      expect(row.mergeInProgress).toBe(true)
      expect(row.mergeSite).toBe(join(fixture.taskPath, "alpha"))
      expect(row.conflictedFiles).toEqual(["src/a.ts"])
      // Not either of the other two stops.
      expect(row.needsCommit).toBe(false)
      expect(row.dirtyCheckout).toBe(false)
      // The summary routes it, and it names the session the task space was worked in.
      expect(value.summary).toContain("a merge is waiting to be resolved")
      expect(value.summary).toContain("src/a.ts")
      expect(value.summary).toContain("wts_session_tool send")
      expect(value.summary).toContain("sess-task")
      expect(value.summary).toContain("call done again")
    } finally {
      await fixture.cleanup()
    }
  })

  it("flags work nobody committed and routes it, and does not invent the commit itself", async () => {
    const fixture = await taskSpaceFixture({ uncommitted: true })
    const { ctx, captured } = toolContext(fixture.subprocess)
    try {
      registerTaskTool(ctx)
      const value = await captured[0].execute(
        { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container, merge: true },
        {},
      )
      const row = value.repositories[0]
      // Flagged as work-to-commit, and told apart from a conflict: no merge was started.
      expect(row.needsCommit).toBe(true)
      expect(row.conflict).toBe(false)
      expect(row.mergeInProgress).toBe(false)
      expect(row.dirtyCheckout).toBe(false)
      // The summary hands it on rather than describing it as a failure to retry.
      expect(value.summary).toContain("Uncommitted work is waiting")
      expect(value.summary).toContain("wts_session_tool send")
      expect(value.summary).toContain("call done again")
      // The tool did not commit anything on its own: the message has to come from whoever
      // read the changes.
      expect(fixture.calls.some((call) => call.startsWith("add "))).toBe(false)
      expect(fixture.calls.some((call) => call.startsWith("commit "))).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  it("flags the user's own checkout as not this flow's to touch", async () => {
    // The third stop. It reads like a conflict in git's wording but is not one: nothing
    // was merged, so a caller sent after conflict markers would waste the trip - and
    // committing or stashing the user's work for them is worse than that.
    const fixture = await taskSpaceFixture({ dirtyCheckout: true })
    const { ctx, captured } = toolContext(fixture.subprocess)
    try {
      registerTaskTool(ctx)
      const value = await captured[0].execute(
        { action: "done", task: "login", project: PROJECT, tasksRoot: fixture.container, merge: true },
        {},
      )
      const row = value.repositories[0]
      expect(row.dirtyCheckout).toBe(true)
      expect(row.conflict).toBe(false)
      expect(row.needsCommit).toBe(false)
      expect(row.mergeInProgress).toBe(false)
      // The summary says whose work it is and refuses to touch it.
      expect(value.summary).toContain("has uncommitted work this merge would overwrite")
      expect(value.summary).toContain("do not commit it for them")
    } finally {
      await fixture.cleanup()
    }
  })

  /**
   * The blocks the model reads for one completed call.
   * @param tool - the captured definition.
   * @param args - the arguments the call was made with.
   * @param value - the value it returned.
   * @returns the rendered text, one entry per block.
   */
  const renderedText = (tool, args, value) => tool.output.render(args, value).map((block) => block.text)

  describe("the guidance a result carries", () => {
    // A description is read once and a model that has decided to do the work itself
    // does not go back to it; the result of the call it just made is what it reads
    // next. These are the points where the default flow has to be said out loud,
    // and the points where repeating it would be noise.

    it("tells a create with no prompt to dispatch the work, not to do it here", async () => {
      const { value, captured } = await createOnce()
      // Nothing was opened, so the space is sitting there with no session on it.
      expect(value.sessionId).toBe("")
      const [, ...rest] = renderedText(captured[0], { action: "create", task: "login" }, value)
      // The summary stays exactly what it was: it is the card's text too.
      expect(renderedText(captured[0], {}, value)[0]).toBe(value.summary)
      const guidance = rest.join("\n")
      expect(guidance).toContain("No session is on this task space yet")
      expect(guidance).toContain('action: "dispatch"')
      expect(guidance).toContain("shares none of this conversation")
      // The escape hatch is stated, because a default with no stated exception reads
      // as a prohibition - and this one is a real instruction a user may give.
      expect(guidance).toContain("only if the user explicitly asked")
      // And the task's own facts are in it, so the next call can be written from this
      // answer without a lookup.
      expect(guidance).toContain(value.task)
      expect(guidance).toContain(value.tasksRoot)
    })

    it("says nothing extra once a create has dispatched, because that is the flow", async () => {
      const services = {
        sessionController: { create: async () => ({ sessionId: "session-1" }), prompt: async () => ({}) },
        sessions: { get: () => ({ append: () => {} }) },
      }
      const { value, captured } = await createOnce(services, { prompt: "add the feature" }, { agent: { session: { id: "caller" } } })
      expect(value.sessionId).toBe("session-1")
      // One block: the answer, with no advice attached. A correct call that still
      // gets a lecture is how a model learns to skip the guidance entirely.
      expect(renderedText(captured[0], { action: "create", prompt: "x" }, value)).toEqual([value.summary])
    })

    it("points a suggest-root at a create that dispatches in one call", async () => {
      const source = await sourceFixture()
      const { ctx, captured } = toolContext()
      try {
        registerTaskTool(ctx)
        const value = await captured[0].execute({ action: "suggest-root", sourceRoot: source.root }, {})
        const guidance = renderedText(captured[0], { action: "suggest-root" }, value).slice(1).join("\n")
        // The shape of the next call, not only the rule: one create that also hands
        // the first job over, rather than a create followed by the work happening here.
        expect(guidance).toContain("`create` with a `prompt`")
        expect(guidance).toContain("not in this conversation")
      } finally {
        await source.cleanup()
      }
    })

    it("leaves a dispatch and a done alone, and an empty container alone", async () => {
      // A dispatch has handed work over and a done has finished it: both are the
      // outcome the guidance is trying to reach, so neither is told to do anything.
      const dispatched = await taskSpaceFixture()
      try {
        const { ctx, captured } = toolContext(dispatched.subprocess)
        registerTaskTool(ctx)
        const value = await captured[0].execute(
          { action: "dispatch", task: "login", project: PROJECT, tasksRoot: dispatched.container, prompt: "go" },
          {},
        )
        expect(renderedText(captured[0], { action: "dispatch" }, value)).toEqual([value.summary])
      } finally {
        await dispatched.cleanup()
      }
      const finished = await taskSpaceFixture()
      try {
        const { ctx, captured } = toolContext(finished.subprocess)
        registerTaskTool(ctx)
        const value = await captured[0].execute(
          { action: "done", task: "login", project: PROJECT, tasksRoot: finished.container, merge: true },
          {},
        )
        expect(renderedText(captured[0], { action: "done" }, value)).toEqual([value.summary])
      } finally {
        await finished.cleanup()
      }
      // Nothing to work on is a plain answer, not an invitation.
      const { ctx, captured } = toolContext()
      registerTaskTool(ctx)
      const value = await captured[0].execute({ action: "list", tasksRoot: join(tmpdir(), "multi-worktree-guidance-none") }, {})
      expect(renderedText(captured[0], { action: "list" }, value)).toEqual([value.summary])
    })

    it("leaves the card's own text untouched, guidance and all", async () => {
      // The card is read by a person who already knows what to press, and its text
      // is the projection's. Anything added to the render must not reach it.
      const { value, captured } = await createOnce()
      const meta = captured[0].output.presentationMeta({ action: "create" }, value)
      expect(JSON.stringify(meta)).not.toContain("dispatch")
      expect(meta.summary).toBe(value.summary)
    })

    /**
     * A task space with one worktree, a record naming the sessions given, and a
     * second repository outside it to add.
     * @param sessions - the record's sessions, or undefined for a record that names none.
     * @returns the container, the added repository's path, and a cleanup.
     */
    async function addFixture(sessions) {
      const container = await mkdtemp(join(tmpdir(), "multi-worktree-guidance-add-"))
      const taskPath = join(container, PROJECT, "login")
      const worktree = join(taskPath, "alpha")
      await mkdir(worktree, { recursive: true })
      await writeFile(join(worktree, ".git"), "gitdir: /elsewhere\n")
      await mkdir(join(taskPath, PLUGIN_ROOT), { recursive: true })
      await writeFile(recordAt(taskPath), JSON.stringify({
        version: 1, task: "login", project: PROJECT, tasksRoot: container,
        sourceRoot: "E:/source", branch: "task/login", baseRef: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        ...(sessions === undefined ? {} : { sessions }),
        repositories: [{ name: "alpha", sourcePath: "E:/source/alpha", branch: "task/login" }],
      }))
      const added = join(container, "..", `${basename(container)}-gamma`, "gamma")
      await mkdir(join(added, ".git"), { recursive: true })
      return {
        container,
        added,
        cleanup: async () => {
          await rm(container, { recursive: true, force: true })
          await rm(join(added, ".."), { recursive: true, force: true })
        },
      }
    }

    /** The subprocess double an `add` needs: one branch, and no existing task branch. */
    const addSubprocess = {
      spawn: ({ argv }) => {
        const key = parseGitArgv(argv).args.join(" ")
        return {
          done: Promise.resolve({ exitCode: key.startsWith("show-ref") ? 1 : 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: key.includes("--abbrev-ref") ? "task/login" : "" }) },
            stderr: { readFrom: () => ({ text: "" }) },
          },
        }
      },
    }

    it("reads the record before telling an add to open a session", async () => {
      // `add` opens nothing - a repository added to a task is not a job - so the only
      // thing that can say whether a session is already on the space is the record.
      // Without that read the guidance would tell a caller to open a session in a task
      // space that has one.
      const withoutSession = await addFixture(undefined)
      try {
        const { ctx, captured } = toolContext(addSubprocess)
        registerTaskTool(ctx)
        const value = await captured[0].execute(
          { action: "add", task: "login", project: PROJECT, tasksRoot: withoutSession.container, repos: [withoutSession.added] },
          {},
        )
        expect(value.sessionId).toBe("")
        const blocks = renderedText(captured[0], { action: "add" }, value)
        expect(blocks).toHaveLength(2)
        expect(blocks[1]).toContain("dispatch")
      } finally {
        await withoutSession.cleanup()
      }
      const withSession = await addFixture([{ sessionId: "sess-existing", role: "task", at: "2026-10-02T00:00:00Z" }])
      try {
        const { ctx, captured } = toolContext(addSubprocess)
        registerTaskTool(ctx)
        const value = await captured[0].execute(
          { action: "add", task: "login", project: PROJECT, tasksRoot: withSession.container, repos: [withSession.added] },
          {},
        )
        expect(value.sessionId).toBe("sess-existing")
        expect(renderedText(captured[0], { action: "add" }, value)).toEqual([value.summary])
      } finally {
        await withSession.cleanup()
      }
    })

    it("steers a list only when a task in it has never been worked in", async () => {
      // A container of task spaces nobody has opened a session on is the shape a
      // caller is most likely to finish by hand, so the answer says how to start.
      const idle = await addFixture(undefined)
      try {
        const { ctx, captured } = toolContext(addSubprocess)
        registerTaskTool(ctx)
        const value = await captured[0].execute({ action: "list", tasksRoot: idle.container }, {})
        const blocks = renderedText(captured[0], { action: "list" }, value)
        expect(blocks).toHaveLength(2)
        expect(blocks[1]).toContain("dispatch")
      } finally {
        await idle.cleanup()
      }
      // One session on it, and the list is a plain answer again.
      const worked = await addFixture([{ sessionId: "sess-existing", role: "task", at: "2026-10-02T00:00:00Z" }])
      try {
        const { ctx, captured } = toolContext(addSubprocess)
        registerTaskTool(ctx)
        const value = await captured[0].execute({ action: "list", tasksRoot: worked.container }, {})
        expect(renderedText(captured[0], { action: "list" }, value)).toEqual([value.summary])
        expect(value.summary).toContain("sess-existing")
      } finally {
        await worked.cleanup()
      }
    })
  })
})

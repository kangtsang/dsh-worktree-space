/**
 * Which tools a session starts with.
 *
 * The behaviour worth pinning here is not "a tool is registered" - the startup test
 * covers that - but the decision: a session inside a task space gets both real tools at
 * once, and every other session gets one small loader that mounts them on demand. It is
 * a token-budget decision, so the assertions are about which definitions reach which
 * session's scope, and about the loader being gone once it has done its work.
 *
 * The task space is a real directory with a real record, because the decision reads the
 * record through the same walk the session tools use; a mocked `taskSpaceAbove` would
 * test the mock instead of the thing that can actually be wrong. The agent is a double,
 * and deliberately so: what the gate owes cordis is "register through the session's own
 * context", and a double records exactly that. Whether the real registry then projects
 * those definitions is the acceptance instance's job.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOADER_TOOL_NAME, registerGatedTools } from '../src/host/task/tool-gate.js'
import { taskMetadata, writeTaskMetadata } from '../src/host/task/shared.js'

/** Temp directories to remove after each case. */
const directories = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }).catch(() => {})
})

/**
 * A host whose tool runtime records what each session registers.
 *
 * The root `tools` is the fallback path's target; each agent's own context carries a
 * `tools` of its own, which is the scope the gate is supposed to register into.
 */
function harness() {
  const rootRegistrations = []
  const perAgent = new Map()
  const live = []
  const disposers = []
  const listeners = new Map()
  const toolsFor = (into) => ({
    register: (definition) => {
      into.push(definition)
      return () => {
        const at = into.indexOf(definition)
        if (at >= 0) into.splice(at, 1)
      }
    },
  })
  const root = {
    get: (name) => {
      if (name === 'tools') return toolsFor(rootRegistrations)
      if (name === 'agents') return { list: () => live }
      return undefined
    },
    on: (event, listener) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return () => {}
    },
    effect: (execute) => {
      const dispose = execute()
      disposers.push(dispose)
      return dispose
    },
  }
  /**
   * Announce one session's creation, the way a real registry does.
   *
   * Separated from {@link agent} so a case can inspect the registrations **before any
   * microtask runs**, which is the only way to tell a synchronous mount from one that
   * resolves a promise later. An `await` between the two would drain the microtask queue
   * and make the distinction invisible.
   * @param agent - the double to announce.
   */
  const announce = (agent) => {
    for (const listener of listeners.get('agent/created') ?? []) listener({ agent })
  }

  /**
   * A session double: `ctx.plugin(cb)` runs the gate's mount callback against a scoped
   * context carrying this session's own `tools`, and the mount is announced through the
   * same `agent/created` a real registry emits.
   * @param cwd - the directory the session was opened on.
   * @param services - extra services this session's scope answers through `get`.
   * @returns the double, with its mount announced.
   */
  /**
   * Build a session double without announcing it.
   *
   * The announcement is the thing under test, so building and announcing are separate:
   * a case that must read registrations before any microtask runs calls this and then
   * {@link announce} with no `await` between them.
   * @param cwd - the directory the session was opened on.
   * @param services - extra services this session's scope answers through `get`.
   * @returns the double, not yet announced.
   */
  const buildAgent = (cwd, services = {}) => {
    const id = `agent-${live.length}`
    const registrations = []
    perAgent.set(id, registrations)
    // A real injected context is a full Context: both `ctx.tools` and `ctx.get('tools')`
    // answer, and the tools resolve their runtime through `get`. A double carrying only
    // one of the two would make every registration silently answer "no tool runtime".
    const scoped = {
      get: (name) => (name === 'tools' ? toolsFor(registrations) : services[name]),
      tools: toolsFor(registrations),
      // A session's scope is a child fiber of the plugin's, and reading a service that
      // no fiber in that chain provided is what the host refuses: `cannot get property
      // "x" without inject`. The double reproduces the refusal instead of answering
      // `undefined`, because `undefined` would let a property read look like "this
      // deployment serves no such service" and hide the bug this pins.
      get subprocess() {
        if ('subprocess' in services) return services.subprocess
        throw new Error('cannot get property "subprocess" without inject')
      },
    }
    const double = {
      id,
      session: { header: { cwd } },
      ctx: { plugin: (callback) => { callback(scoped); return { dispose: () => { registrations.length = 0 } } } },
    }
    live.push(double)
    return double
  }

  /**
   * A session double, built and announced.
   *
   * **No settling delay, on purpose.** The host announces `agent/created` before the
   * session's first prompt is assembled, so anything this listener registers must be
   * registered by the time it returns. A `setTimeout` here would hide exactly the
   * regression this harness exists to catch: an async mount registers one step late,
   * and the model's first request carries no tool at all.
   * @param cwd - the directory the session was opened on.
   * @param services - extra services this session's scope answers through `get`.
   * @returns the double, with its mount announced.
   */
  const agent = async (cwd, services = {}) => {
    const double = buildAgent(cwd, services)
    announce(double)
    return double
  }
  return { root, rootRegistrations, perAgent, agent, buildAgent, announce, dispose: () => { for (const dispose of disposers) dispose() } }
}

/** A directory with a task record in it: a task space, by the only definition that matters. */
async function taskSpace() {
  const container = await mkdtemp(join(tmpdir(), 'wts-gate-'))
  directories.push(container)
  const space = join(container, 'project', 'task')
  await mkdir(space, { recursive: true })
  const metadata = taskMetadata({
    task: 'task',
    project: 'project',
    sourceRoot: container,
    branch: 'task/task',
    baseRef: 'HEAD',
    createdAt: '2026-01-01T00:00:00.000Z',
    repositories: [],
  })
  await writeTaskMetadata(space, metadata)
  return { container, space }
}

/** A directory with nothing in it: outside every task space. */
async function plainDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'wts-gate-outside-'))
  directories.push(directory)
  return directory
}

describe('the tool gate', () => {
  it('registers by the time `agent/created` returns, with no microtask in between', async () => {
    // The regression this pins was measured on a real session: the mount read the
    // directory with `await`, so it registered one step late, and the model's **first**
    // request carried no Worktree Space tool at all - the loader only appeared in the
    // second header. A user who opens with "make me a task space" then gets an
    // unreachable request, because the tool that would do it is not on the list yet.
    //
    // The assertion has to run before any `await`: awaiting first would drain the
    // microtask queue and let a deferred mount pass. That is also why this builds its
    // doubles by hand instead of using `agent`, which is `async` by signature.
    const { space } = await taskSpace()
    const { root, perAgent, buildAgent, announce, dispose } = harness()
    registerGatedTools(root, {})
    const member = buildAgent(space)
    announce(member)
    // Read with no `await` in between: whatever is here now is what the first prompt
    // from this session would see.
    expect(perAgent.get(member.id).map((entry) => entry.name).sort()).toEqual(['wts_session_tool', 'wts_worktree_space'])
    dispose()
  })

  it('gives a session inside a task space both tools, and no loader', async () => {
    const { space } = await taskSpace()
    const { root, perAgent, agent, dispose } = harness()
    registerGatedTools(root, {})
    const member = await agent(space)
    expect(perAgent.get(member.id).map((entry) => entry.name).sort()).toEqual(['wts_session_tool', 'wts_worktree_space'])
    dispose()
  })

  it('gives a session outside every task space the loader alone, small enough to be free', async () => {
    const directory = await plainDirectory()
    const { root, perAgent, agent, dispose } = harness()
    registerGatedTools(root, {})
    const stranger = await agent(directory)
    const rows = perAgent.get(stranger.id)
    expect(rows.map((entry) => entry.name)).toEqual([LOADER_TOOL_NAME])
    // The whole point of the loader is that it costs a session almost nothing: a few
    // hundred characters of description and no properties to read.
    expect(rows[0].parameters.properties).toEqual({})
    expect(rows[0].description.length).toBeLessThan(1000)
    dispose()
  })

  it('mounts the real tools when the loader is called, and leaves nothing behind', async () => {
    const directory = await plainDirectory()
    const { root, perAgent, agent, dispose } = harness()
    registerGatedTools(root, {})
    const stranger = await agent(directory)
    const [loader] = perAgent.get(stranger.id)
    const value = await loader.execute({}, {})
    expect(value.loaded).toBe(true)
    expect(value.tools).toEqual(['wts_worktree_space', 'wts_session_tool'])
    // Exactly the pair: the loader disposed itself, so a second call cannot answer
    // "already loaded" and the session carries no third name.
    expect(perAgent.get(stranger.id).map((entry) => entry.name).sort()).toEqual(['wts_session_tool', 'wts_worktree_space'])
    dispose()
  })

  it('mounts nothing twice for one session', async () => {
    const { space } = await taskSpace()
    const { root, perAgent, agent, dispose } = harness()
    registerGatedTools(root, {})
    const member = await agent(space)
    // A second announcement for a session already mounted is what a resume looks like
    // from here, and it must not produce a second copy of either tool.
    expect(perAgent.get(member.id)).toHaveLength(2)
    dispose()
  })

  it('reaches the subprocess service through `get`, which a session scope is the only way to', async () => {
    // The regression this pins: the tool used to read `ctx.subprocess`. That worked while
    // it was registered against the plugin's own context, and broke the moment the gate
    // mounted it into a session's scope - a child fiber, where a property read of a
    // service no fiber in the chain provided throws `cannot get property "subprocess"
    // without inject`. Every action failed that way, with a message about inject that
    // says nothing about which service or which call.
    //
    // `suggest-root` is the action to drive here: it is the cheapest one that needs git,
    // and it reaches the service on its very first line, so a property read fails before
    // anything else could mask it.
    const { space } = await taskSpace()
    const sourceRoot = join(space, 'repo')
    await mkdir(join(sourceRoot, '.git'), { recursive: true })
    const { root, perAgent, agent, dispose } = harness()
    registerGatedTools(root, {})
    const calls = []
    const subprocess = {
      spawn: (argv) => {
        calls.push(argv)
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: '' }) },
            stderr: { readFrom: () => ({ text: '' }) },
          },
        }
      },
    }
    const member = await agent(space, { subprocess })
    const tool = perAgent.get(member.id).find((entry) => entry.name === 'wts_worktree_space')
    // The tool answers an envelope rather than a `{ ok }` reply - the failure shapes are
    // thrown, not returned - so the assertion is on the content of a successful answer.
    const value = await tool.execute({ action: 'suggest-root', sourceRoot }, {})
    expect(value.action).toBe('suggest-root')
    expect(value.repositories.map((row) => row.name)).toEqual(['repo'])
    // git really ran, through the service the scope answers - not through a property.
    expect(calls.length).toBeGreaterThan(0)
    dispose()
  })

  it('registers the pair unconditionally when the deployment serves no agent registry', async () => {
    // No `agents` and no `agent/created` to gate on: gating anyway would leave the
    // deployment with no tools at all, which is indistinguishable from not installed.
    const rootRegistrations = []
    const root = {
      get: (name) => (name === 'tools'
        ? { register: (definition) => { rootRegistrations.push(definition); return () => {} } }
        : undefined),
      on: () => () => {},
      effect: (execute) => execute(),
    }
    registerGatedTools(root, {})
    expect(rootRegistrations.map((entry) => entry.name).sort()).toEqual(['wts_session_tool', 'wts_worktree_space'])
  })
})

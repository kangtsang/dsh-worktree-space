/**
 * When a session gets the worktree tools, and when it gets one line saying they exist.
 *
 * Two of this plugin's tools are large - the task-space tool and the session tool
 * together carry about 3.6k tokens of description and parameters - and most sessions
 * never touch either. A session opened to rename a function in one repository should
 * not pay for the vocabulary of a multi-repository task space.
 *
 * So the tools are mounted per session, from what the session's own directory says:
 *
 *  - **In a task space, both tools, immediately.** That is the member: the session a
 *    dispatch put there. It reports back with `wts_session_tool send`, finishes its own
 *    work with `wts_worktree_space done`, and adds a forgotten repository with `add`.
 *    Deciding this costs nothing and adds no round trip, because the answer is a fact
 *    about the directory the session was opened on.
 *  - **Anywhere else, one small loader.** The session may be a leader about to create a
 *    space, or it may have nothing to do with this plugin at all. It gets
 *    `load_worktree_space`, a few hundred characters that say what the tools are for and
 *    that they are loaded on demand. Calling it once mounts both tools into that
 *    session and disposes itself.
 *
 * Mounting per session is not an optimisation detail; it is the only way deferred tools
 * work here. A tool declared with `deferLoading` in a session's *baseline* tool list is
 * never activated - the host documents that a deferred baseline tool waits for an
 * addition block that never comes for it - so the marker alone would make the tools
 * invisible rather than lazy. Registering into the session's own scope *after* its first
 * header is what produces the addition block that activates them.
 *
 * A deployment that serves no tool runtime registers nothing here and keeps working:
 * the /api endpoints remain the seam.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { registerSessionTools } from '../session-tools.js'
import { taskSpaceAboveSync } from './space-above.js'
import { registerTaskTool } from './tool.js'

/** The loader's tool name. Distinct from either real tool: a name cannot change its definition mid-session. */
export const LOADER_TOOL_NAME = 'load_worktree_space'

/** What a session reads before it has the real tools. Two lines: what this is, and how to start. */
const LOADER_DESCRIPTION = [
  'Mount the Worktree Space tools into this session: `wts_worktree_space` for a per-task git worktree workspace '
    + 'spanning one or more repositories, and `wts_session_tool` for watching, steering, resuming and stopping the '
    + 'sessions a task runs in. They are loaded on demand because most sessions never need them.',
  'Call it when the user asks for a task space, a worktree per task, one branch across several repositories, or when '
    + 'this session has to reach a session it dispatched - then read the `worktree-space` skill, which is the complete '
    + 'instruction set. Do not call it for ordinary git work in the current directory.',
].join('\n')

/** What the loader answers with. */
const LOADER_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    loaded: { type: 'boolean', required: true },
    tools: { type: 'array', required: true, items: { type: 'string' } },
    summary: { type: 'string', required: true },
  },
}

/**
 * Register the gated tools: per session, from that session's own directory.
 *
 * Only `tools` is required. Every session service the mount path touches is probed,
 * because a deployment that serves no agent registry must still mount normally for the
 * sessions it does serve - and a mount that threw here would leave a session with no
 * tools at all, which is indistinguishable from the plugin not being installed.
 * @param ctx - the host plugin context.
 * @param options - forwarded to the task tool: the configured container root, the handoff
 *   access setting, the archive preference, and the session watcher.
 * @returns the disposer that unmounts every session's tools, or undefined when no tool
 *   runtime is served.
 */
export function registerGatedTools(ctx, options = {}) {
  if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return undefined
  const rootTools = ctx.get('tools')
  if (rootTools === undefined || rootTools === null || typeof rootTools.register !== 'function') return undefined

  /** One child fiber per session, holding that session's registrations. */
  const mounted = new Map()

  /**
   * Mount this session's tools.
   *
   * The decision is made **synchronously, before this returns**, and that is a
   * correctness requirement rather than a style choice. `agent/created` is announced
   * before the session's first prompt is assembled, so a registration that lands even
   * one microtask later misses that assembly and the model's first request carries no
   * Worktree Space tool at all - it only appears at step two, by which point a user who
   * opened with "make me a task space" has already asked for something unreachable.
   * Measured on a real session: an async mount produced the loader in the *second*
   * header, one `developer/message` late.
   *
   * The decision is read from the session's own directory, which is the durable fact the
   * rest of the plugin already trusts for the same question. A session whose directory
   * cannot be read is treated as outside a task space: the loader is the answer that
   * costs one call and loses nothing, where guessing "member" would hand a stranger the
   * whole vocabulary.
   * @param agent - the live agent.
   * @returns the child fiber, or undefined when nothing could be mounted.
   */
  const mount = (agent) => {
    if (agent === null || agent === undefined || mounted.has(agent)) return mounted.get(agent)
    // `agent.ctx` is already the session's own scope, so the tools registered from it
    // land in that scope and in nobody else's. No extra child fiber is needed, and one
    // would only add a layer the unmount would then have to know about.
    let fiber
    try {
      fiber = agent.ctx.plugin((scoped) => { arm(scoped, agent) })
    } catch (error) {
      warn(`could not mount a session's tools: ${messageOf(error)}`)
      return undefined
    }
    mounted.set(agent, fiber)
    return fiber
  }

  /**
   * Register the tools one session may use.
   *
   * Both real tools are registered through the session's own context, so they land in
   * that session's scope and in nobody else's. The registration disposers are collected
   * on the fiber, which is what unmounts them when the session ends.
   *
   * Synchronous on purpose - see {@link mount}. `taskSpaceAboveSync` reads the same
   * files as the async walk the session tools use, so both sides reach one answer.
   * @param toolsCtx - the session-scoped context carrying `tools`.
   * @param agent - the session's agent.
   */
  const arm = (toolsCtx, agent) => {
    const cwd = agent?.session?.header?.cwd
    const space = taskSpaceAboveSync(cwd)
    if (space !== undefined) {
      install(toolsCtx)
      return
    }
    installLoader(toolsCtx, () => install(toolsCtx).loaded)
  }

  /**
   * Register the two real tools, and keep what unregisters them.
   *
   * The disposers are collected rather than left to the fiber: the fallback path below
   * registers against the plugin's own context, and cordis only unwinds a registration
   * that returned its disposer to an effect it owns. Losing them there would leave both
   * tools mounted after the plugin unloads - shadowing the next mount with a stale copy.
   *
   * A failure is reported once and swallowed: a tool runtime that refuses a
   * registration is a deployment problem, and taking the session's other tools down
   * with it would be worse than the missing pair.
   * @param toolsCtx - the context carrying `tools`: the session's, or the plugin's.
   * @returns the disposers, and whether both registrations were accepted.
   */
  const install = (toolsCtx) => {
    const disposers = []
    const keep = (dispose) => { if (typeof dispose === 'function') disposers.push(dispose) }
    try {
      keep(registerTaskTool(toolsCtx, options))
      keep(registerSessionTools(toolsCtx))
      return { loaded: disposers.length === 2, disposers }
    } catch (error) {
      warn(`could not mount the worktree tools: ${messageOf(error)}`)
      return { loaded: false, disposers }
    }
  }

  /**
   * Register the loader for one session.
   *
   * The loader disposes its own registration before mounting the real tools, so the
   * session ends up with exactly the two tools and no leftover third name. Its
   * disposer is held here rather than in a closure the fiber owns, because the call
   * that fires it is the last thing that registration will ever do.
   * @param toolsCtx - the session-scoped context carrying `tools`.
   * @param load - mounts the real tools.
   */
  const installLoader = (toolsCtx, load) => {
    let disposeLoader = () => {}
    const definition = defineTool({
      name: LOADER_TOOL_NAME,
      description: LOADER_DESCRIPTION,
      parameters: {},
      output: {
        schema: LOADER_OUTPUT,
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      execute: () => {
        // Disposed first: a loader that is still registered while the tools it loads
        // arrive would offer a second call that can only answer "already loaded".
        disposeLoader()
        const loaded = load()
        return {
          loaded,
          tools: loaded ? ['wts_worktree_space', 'wts_session_tool'] : [],
          summary: loaded
            ? 'The Worktree Space tools are now available in this session: `wts_worktree_space` (suggest-root, create, '
              + 'add, list, dispatch, done) and `wts_session_tool` (find, status, read, send, resume, cancel). Ask the '
              + 'user for the task name and the container root before creating anything.'
            : 'The Worktree Space tools could not be mounted in this session. Tell the user rather than retrying: the '
              + 'plugin is installed but this deployment refused the registration.',
        }
      },
    })
    try {
      const dispose = toolsCtx.tools.register(definition)
      disposeLoader = typeof dispose === 'function' ? dispose : () => {}
    } catch (error) {
      warn(`could not mount ${LOADER_TOOL_NAME}: ${messageOf(error)}`)
    }
  }

  const warn = (message) => {
    try {
      if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(`dsh-worktree-space: ${message}`)
    } catch { /* a log that fails must not become the failure */ }
  }

  // Sessions that already exist when this plugin loads - a reload, or a restart that
  // restored them - never emit `agent/created`, so they are enumerated once here.
  const agents = ctx.get('agents')
  const enumerable = agents !== null && agents !== undefined && typeof agents.list === 'function'
  if (enumerable) {
    for (const agent of agents.list()) {
      try { mount(agent) } catch (error) { warn(`could not mount an existing session: ${messageOf(error)}`) }
    }
  } else {
    // A deployment that serves no agent registry emits no `agent/created` either, so
    // gating would leave it with no tools at all - and that is worse than the tokens
    // this exists to save: a plugin that silently does nothing is indistinguishable from
    // one that is not installed. Those deployments keep the pair unconditionally, which
    // is the behaviour every version before this one had.
    //
    // Registered through an effect rather than directly, because cordis unwinds only the
    // disposers an effect collected: a registration whose disposer is dropped here would
    // stay mounted after the plugin unloads and shadow the next mount with a stale copy.
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        const { disposers } = install(ctx)
        return () => { for (const dispose of disposers) dispose() }
      }, 'dsh-worktree-space ungated tools')
    } else {
      install(ctx)
    }
  }

  if (typeof ctx.on === 'function') {
    ctx.on('agent/created', ({ agent }) => {
      try { mount(agent) } catch (error) { warn(`could not mount a new session: ${messageOf(error)}`) }
    })
    ctx.on('agent/disposed', ({ agent }) => { mounted.delete(agent) })
  }

  // Unmounting is the plugin's own, not each session's: a plugin that unloads while
  // its sessions keep running must take its registrations with it, or the next mount
  // would shadow them with a second copy.
  const unmountAll = () => {
    for (const fiber of mounted.values()) {
      try { fiber?.dispose?.() } catch { /* an already-disposed fiber is the normal case */ }
    }
    mounted.clear()
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => unmountAll, 'dsh-worktree-space gated tools')
  return unmountAll
}

/** One sentence from an unknown failure. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

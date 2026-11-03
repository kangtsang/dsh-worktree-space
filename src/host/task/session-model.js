/**
 * Putting a dispatched session on a model, and reading which models it could be put on.
 *
 * ## Why a switch is not "call the controller's selectModel"
 *
 * `ctx.sessionController.selectModel` looks like the answer and is the wrong tool here,
 * for a reason that only shows up in the case this exists for. It ends with
 * `agentDefaultModel.saveSelection(...)` — it writes the chosen model as **the
 * deployment's default for every new session**. That is correct for its own caller, the
 * model picker in the composer, where picking a model for the conversation you are
 * looking at is also choosing what the next conversation starts on. It is wrong for a
 * leader putting a *member* on a fallback because the member's route is failing: the
 * leader would silently move every session created afterwards, including ones belonging
 * to other tasks and to the user. So the write is done here, in the two steps that RPC
 * takes internally, minus the default:
 *
 *   1. `session.append('model/selection', selection)` — the durable half. The
 *      `modelSelection` projection folds it, so the member reads its own model back after
 *      a restart, and the composer's picker shows it. This is what makes the switch
 *      outlive the process, and it is written first: a session that restarts before the
 *      in-memory half lands still comes back on the new model.
 *   2. `selectionFor(agent).current = selection` — the in-memory half, which the request
 *      path reads for the *next* step. Without it the durable intent sits in the log
 *      while the running agent keeps asking the old route.
 *
 * ## Why the request hook as well
 *
 * Steps 1 and 2 are the documented way and are what the controller itself does, but
 * they depend on that controller's selection binding still being the one installed on
 * the agent. This plugin has been bitten by exactly that assumption before (a second
 * binding installed by a plugin loses to the one the controller installed first), so the
 * route is *also* asserted on `agent/request`, which is the public waterfall whose
 * documented contract is "return a replacement to switch". The hook only touches the
 * routes named in {@link MODEL_ROUTES}, and only for a session whose live agent it was
 * armed for, so a member whose model nobody changed is not affected by this plugin at
 * all.
 *
 * The two together are deliberately redundant. Either alone is enough on the host this
 * was written against; together they hold on a host where one of the two has moved.
 * @module dsh-worktree-space/session-model
 */

import { createHash } from 'node:crypto'

/**
 * The route overrides in force, keyed by session id.
 *
 * Module state rather than a service, because the `agent/request` hook that reads it is
 * installed once for the whole host and has no per-call context to carry it. A route is
 * removed when the session is put back on its own model, so the table only ever holds
 * the sessions a leader explicitly moved.
 */
const MODEL_ROUTES = new Map()

/** Read a service from a host context, tolerantly: absent and throwing both mean "not served". */
function service(ctx, name) {
  if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return undefined
  let value
  try {
    value = ctx.get(name)
  } catch {
    return undefined
  }
  return value === null ? undefined : value
}

/**
 * A provider/model pair as one comparable string.
 *
 * A separator that cannot appear in either half, so two different pairs can never spell
 * the same key. The same idea as `rotationKey` in the mission-guard plugin.
 * @param provider - the provider id.
 * @param model - the model id.
 * @returns the identity key.
 */
export function routeKey(provider, model) {
  return `${String(provider)}\u0000${String(model)}`
}

/**
 * Whether two selections name the same route.
 *
 * `reasoningEffort` is deliberately not part of the comparison: it is a property of the
 * route rather than a route of its own, and a member already on the right model must not
 * be reported as switched just because the effort was re-stated.
 * @param left - one selection, possibly absent.
 * @param right - the other, possibly absent.
 * @returns whether both name the same provider and model.
 */
export function sameRoute(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return false
  return left.provider === right.provider && left.model === right.model
}

/**
 * A selection, holding only the fields that are set.
 *
 * The Host's own `model/selection` payload has an optional `reasoningEffort` and no
 * place for `undefined`: an explicit `undefined` key survives into the appended event
 * and is then a value the projection's schema has to accept. So the key is left out
 * rather than set to nothing.
 * @param provider - the provider id.
 * @param model - the model id.
 * @param reasoningEffort - the effort, when one was named.
 * @returns the selection payload.
 */
export function selectionOf(provider, model, reasoningEffort) {
  return {
    provider,
    model,
    ...(typeof reasoningEffort === 'string' && reasoningEffort !== '' ? { reasoningEffort } : {}),
  }
}

/**
 * The model a session is on right now, as the session itself records it.
 *
 * Read from the durable `modelSelection` projection, which is the fold of every
 * `model/selection` event and of the last `request/header`. The projection is the right
 * source rather than `agent.options`: that one is a read-only constant captured when the
 * agent was created and is never written back, so a session that has already been
 * switched once still reports its original model there.
 * @param ctx - the host plugin context.
 * @param session - the live session.
 * @returns the selection, or undefined when the deployment serves no projections.
 */
export function currentSelectionOf(ctx, session) {
  const projections = service(ctx, 'sessionProjections')
  if (projections === undefined || typeof projections.stateOf !== 'function') return undefined
  let state
  try {
    state = projections.stateOf(session, 'modelSelection')
  } catch {
    return undefined
  }
  if (state === null || state === undefined || typeof state !== 'object') return undefined
  const route = state.pending ?? state.lastUsed
  if (route === null || route === undefined || typeof route !== 'object') return undefined
  if (typeof route.provider !== 'string' || typeof route.model !== 'string') return undefined
  return {
    provider: route.provider,
    model: route.model,
    ...(typeof route.reasoningEffort === 'string' && route.reasoningEffort !== ''
      ? { reasoningEffort: route.reasoningEffort }
      : {}),
  }
}

/**
 * Every model this host can currently route to, grouped by provider.
 *
 * Two registries have to be asked, and asking one is the mistake this is written to
 * avoid: `llm.listProviders()` is what adapter plugins register, and
 * `llm.listConfigurableProviders()` is what the settings page declares. DSH's own
 * documentation says configuration surfaces *merge* the two, so a catalog built from
 * either alone is missing the other half's providers.
 *
 * ## It is async, and that is not a style choice
 *
 * `llm.listModels()` is declared `async listModels(provider): Promise<LlmModelInfo[]>`.
 * An earlier version of this function called it synchronously and caught the result with
 * `try/catch`, which looked correct and was not: the call **returns a promise**, so a
 * provider without an adapter (`NO_ADAPTER`) rejects *after* the `try` block has already
 * finished. Nothing was awaiting it, so the rejection became an unhandled rejection and
 * took the whole host down — measured on a real instance, the boot log ends with
 * `dsh: fatal load failure: LlmError: no adapter registered for provider "amazon-bedrock"`.
 *
 * So every provider's model list is awaited **inside** its own try/catch. One provider
 * without an adapter is that provider's answer — it appears with an empty list and a note
 * saying why — and never the deployment's failure.
 *
 * Nothing here throws. A provider that is not logged in answers with nothing, a host with
 * no `llm` at all answers nothing, and both are a deployment's shape rather than a reason
 * to fail the call that asked what it could choose from.
 * @param ctx - the host plugin context.
 * @returns provider groups, in the order the registries gave them, and the default route.
 */
/**
 * How long one provider's model list may take on the configuration page.
 *
 * 5 seconds, where it used to be 4. The measurement behind it: a real network call to the
 * openrouter models endpoint took 511/536/561/596/727/1097 ms warm and 1519 ms cold, so
 * 4 s left cold starts only about 2.6x of headroom. Five is the compromise a page can sit
 * through - the row shows a "reading the model list" state while it waits - and stays well
 * under the 15 s ceiling the client's own `read` puts on the request.
 */
export const CONFIG_CATALOG_TIMEOUT_MS = 5000

/**
 * How long one provider's model list may take when a dispatch is being validated.
 *
 * 8 seconds, for the opposite reason from the one above: nobody is watching a spinner here,
 * and what is at stake is a refusal. A dispatch whose model lookup times out falls back to a
 * warning (see `explainRoute`), but a slow-but-reachable route that got cut off would be
 * reported as unreachable and refused outright - a wrong answer about a route the host can
 * actually serve. The extra seconds buy that decision more evidence.
 */
export const DISPATCH_CATALOG_TIMEOUT_MS = 8000

/**
 * Every model this host can currently route to, grouped by provider.
 *
 * `timeoutMs` is required rather than defaulted, because the two callers want different
 * numbers for reasons that are not interchangeable - a page that has to answer while someone
 * watches, and a dispatch that would rather wait than refuse a route it can reach. A default
 * would let a new call site silently inherit whichever of the two happened to be written
 * first, and the choice is the whole point of having two.
 *
 * Two registries have to be asked, and asking one is the mistake this is written to
 * avoid: `llm.listProviders()` is what adapter plugins register, and
 * `llm.listConfigurableProviders()` is what the settings page declares. DSH's own
 * documentation says configuration surfaces *merge* the two, so a catalog built from
 * either alone is missing the other half's providers.
 *
 * ## It is async, and that is not a style choice
 *
 * `llm.listModels()` is declared `async listModels(provider): Promise<LlmModelInfo[]>`.
 * An earlier version of this function called it synchronously and caught the result with
 * `try/catch`, which looked correct and was not: the call **returns a promise**, so a
 * provider without an adapter (`NO_ADAPTER`) rejects *after* the `try` block has already
 * finished. Nothing was awaiting it, so the rejection became an unhandled rejection and
 * took the whole host down - measured on a real instance, the boot log ends with
 * `dsh: fatal load failure: LlmError: no adapter registered for provider "amazon-bedrock"`.
 *
 * So every provider's model list is awaited **inside** its own try/catch. One provider
 * without an adapter is that provider's answer - it appears with an empty list and a note
 * saying why - and never the deployment's failure.
 *
 * ## Why the wall clock does not grow with the number of providers
 *
 * Every provider is asked in parallel and each has its own timeout, so the whole catalog
 * takes as long as the slowest single provider rather than the sum of them. That bound is
 * what keeps the client's 15 s request ceiling out of reach on a deployment with many
 * providers, and a test asserts it against a catalog whose providers all hang.
 *
 * Nothing here throws. A provider that is not logged in answers with nothing, a host with
 * no `llm` at all answers nothing, and both are a deployment's shape rather than a reason
 * to fail the call that asked what it could choose from.
 * @param ctx - the host plugin context.
 * @param timeoutMs - how long one provider's model list may take before its row answers
 *   empty: {@link CONFIG_CATALOG_TIMEOUT_MS} for a page, {@link DISPATCH_CATALOG_TIMEOUT_MS}
 *   for a dispatch being validated.
 * @returns provider groups, in the order the registries gave them, the default route, the
 *   notes, and whether the registry itself could be read.
 */
export async function modelCatalogOf(ctx, timeoutMs = DISPATCH_CATALOG_TIMEOUT_MS) {
  const llm = service(ctx, 'llm')
  const empty = { providers: [], default: undefined, notes: [], registryRead: 'ok' }
  // No `llm` at all is the same shape as a registry that failed: nothing was read, and a
  // reader that treats it as "complete, and this host offers nothing" would refuse every
  // model on a deployment it simply could not ask.
  if (llm === undefined) return { ...empty, registryRead: 'failed', notes: ['this deployment serves no llm registry'] }
  const notes = []
  const ids = []
  const seen = new Set()
  // Whether the provider roster itself was read. Both registries feed it, so if either
  // failed the roster is partial - which makes "this provider is absent" unreadable: the
  // provider may well exist on a registry this call never got to see.
  let registryRead = 'ok'
  const add = (id) => {
    if (typeof id !== 'string' || id === '' || seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }
  // Both registries are synchronous and both are read through their own guard: a method
  // that is absent, is not a function, or throws is one half of the catalog missing, not
  // a failed call.
  try {
    const registered = llm.listProviders()
    if (Array.isArray(registered)) for (const entry of registered) add(entry?.id)
    else { notes.push('listProviders() did not answer with a list'); registryRead = 'failed' }
  } catch (error) {
    notes.push(`listProviders() failed: ${messageOf(error)}`)
    registryRead = 'failed'
  }
  try {
    const configurable = llm.listConfigurableProviders()
    if (Array.isArray(configurable)) for (const entry of configurable) add(entry?.provider)
    else { notes.push('listConfigurableProviders() did not answer with a list'); registryRead = 'failed' }
  } catch (error) {
    notes.push(`listConfigurableProviders() failed: ${messageOf(error)}`)
    registryRead = 'failed'
  }

  const providers = await Promise.all(ids.map(async (provider) => {
    const models = []
    try {
      // `await` is the fix described above: it puts the rejection inside this try. The
      // timeout is the other half of the same lesson - a provider whose adapter is slow or
      // whose credential check hangs would hold the whole catalog open, and the menu is
      // unusable until it answers. Per provider, so one slow route delays its own row and
      // nothing else.
      const listed = await withTimeout(llm.listModels(provider), timeoutMs, provider)
      if (Array.isArray(listed)) {
        for (const entry of listed) {
          const id = typeof entry === 'string' ? entry : typeof entry?.id === 'string' ? entry.id : ''
          if (id !== '' && !models.includes(id)) models.push(id)
        }
      } else {
        // Every path that failed to read a provider writes a `${provider}: ` note, and
        // that note is what `explainRoute` uses to tell "could not read this provider"
        // from "this provider answered, and it offers nothing". A real empty array is
        // the latter, so it writes no note and stays a usable (empty) model list.
        notes.push(`${provider}: listModels() did not answer with a list`)
      }
    } catch (error) {
      // One provider's missing adapter is that provider's answer, not the catalog's.
      notes.push(`${provider}: ${messageOf(error)}`)
    }
    // A provider with no models is kept: it is still a route the deployment declares, and
    // a reader that hides it cannot tell "not logged in" from "not installed".
    return { provider, models }
  }))
  return { providers, default: defaultRouteOf(ctx), notes, registryRead }
}

/**
 * A promise, given at most `ms` to settle.
 *
 * A timeout resolves to `undefined` rather than rejecting, because the caller treats "no
 * answer" and "answer that is not a list" the same way: that provider contributes no
 * models and a note. The original promise keeps its own rejection handler attached, so a
 * late rejection cannot surface as an unhandled rejection - which is exactly how this
 * module once took a host down.
 * @param work - the promise to wait on.
 * @param ms - how long to wait.
 * @param label - the provider, for the note a timeout writes.
 * @returns the value, or undefined on timeout.
 */
function withTimeout(work, ms, label) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(undefined)
    }, ms)
    Promise.resolve(work).then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * The route the deployment would pick for a session that names none.
 *
 * Read for one purpose: to say what "inherit from the leader" resolves to when the
 * leader has never itself run a turn. A host without the service answers nothing, and
 * the caller then says it does not know rather than guessing.
 * @param ctx - the host plugin context.
 * @returns the default selection, or undefined.
 */
function defaultRouteOf(ctx) {
  const fallback = service(ctx, 'agentDefaultModel')
  if (fallback === undefined || typeof fallback.currentSelection !== 'function') return undefined
  try {
    const route = fallback.currentSelection()
    if (route === null || route === undefined || typeof route.provider !== 'string' || typeof route.model !== 'string') return undefined
    return selectionOf(route.provider, route.model, route.reasoningEffort)
  } catch {
    return undefined
  }
}

/**
 * Whether a provider/model pair is one this host can route to right now.
 *
 * Checked before anything is written, so a typo is refused with a sentence about the
 * model rather than accepted and then failing at the member's next request — which the
 * member reads as a broken provider and the leader has no way to connect back to the
 * call it made.
 * @param catalog - the catalog from {@link modelCatalogOf}.
 * @param provider - the provider id.
 * @param model - the model id.
 * @returns whether that pair is in the catalog.
 */
export function routeInCatalog(catalog, provider, model) {
  const group = catalog.providers.find((entry) => entry.provider === provider)
  return group !== undefined && group.models.includes(model)
}

/**
 * A one-line list of what the catalog actually holds, for a refusal to quote.
 *
 * A refusal that says only "no such model" leaves the caller guessing at the spelling,
 * and the spelling is the whole problem: `deepseek-chat` and `deepseek-reasoner` are one
 * word apart. Empty providers are named as empty rather than left out, because
 * "provider exists but offers nothing" is the answer that explains a failed lookup.
 * @param catalog - the catalog from {@link modelCatalogOf}.
 * @param limit - how many routes to name before summarising.
 * @returns the routes, or a sentence saying there are none.
 */
export function describeRoutes(catalog, limit = 12) {
  const routes = []
  for (const group of catalog.providers) {
    for (const model of group.models) routes.push(`${group.provider}/${model}`)
  }
  if (routes.length === 0) {
    const named = catalog.providers.map((entry) => entry.provider)
    return named.length === 0
      ? 'this deployment offers no model route at all'
      : `no model route is available (providers without a usable catalog: ${named.join(', ')})`
  }
  const head = routes.slice(0, limit).join(', ')
  return routes.length > limit ? `${head}, … (${routes.length} routes in total)` : head
}

/** The three answers {@link explainRoute} gives. */
export const ROUTE_ANSWERS = ['reachable', 'unreachable', 'unknown']

/**
 * Whether one provider/model pair can be reached, in three answers rather than two.
 *
 * A boolean is not enough here, and the difference is what decides whether a dispatch is
 * refused. `routeInCatalog` answers false for two things that are opposites:
 *
 *   - **the provider exists, was read, and does not offer this model** - a typo, or a
 *     model that was removed. This is a fact, and a dispatch naming it should be refused.
 *   - **the provider's model list could not be read at all** - no adapter, not logged in,
 *     or the per-provider timeout fired. Nothing is known, and refusing on it would mean
 *     a host that cannot answer refuses every model it has never heard of.
 *
 * Collapsing the two into one sentence ("this host cannot route to that model") made a
 * deployment-wide outage and a spelling mistake look identical to the caller.
 *
 * What each answer is read from:
 *
 *   - `registryRead === 'failed'` - the provider roster itself was never fully read, so
 *     even "this provider does not exist" is not evidence. Answer `unknown`.
 *   - the provider is absent from the roster - `unreachable`.
 *   - the provider is present and lists the model - `reachable`.
 *   - the provider is present, its model list is empty, and a note names it as having
 *     failed - `unknown`: the list is empty because the read failed, not because the
 *     provider offers nothing.
 *   - the provider is present with a **usable** (non-empty) list that lacks the model -
 *     `unreachable`: the list was read and this model is genuinely not in it.
 *
 * The empty-and-failed case is why a note naming the provider is part of the judgment
 * rather than decoration: an empty `models` on its own cannot say which of the last two
 * it is.
 * @param catalog - the catalog from {@link modelCatalogOf}.
 * @param provider - the provider id.
 * @param model - the model id.
 * @returns `{ answer, reason }`; `reason` says why, and is empty when reachable.
 */
export function explainRoute(catalog, provider, model) {
  if (catalog === null || catalog === undefined) {
    return { answer: 'unknown', reason: 'the model catalog could not be read at all' }
  }
  // A partial roster makes every provider's absence meaningless: the provider may be on
  // the half that failed. Without this, one registry read failure would turn every model
  // on the deployment into a refusal.
  if (catalog.registryRead === 'failed') {
    return { answer: 'unknown', reason: noteLine(catalog, 'the provider registry could not be read') }
  }
  const group = (catalog.providers ?? []).find((entry) => entry.provider === provider)
  if (group === undefined) {
    return { answer: 'unreachable', reason: `no provider named ${provider} is served here` }
  }
  if (group.models.includes(model)) return { answer: 'reachable', reason: '' }
  // An empty list on a provider that failed to be read is not a list of zero models.
  if (group.models.length === 0 && noteFor(catalog, provider) !== undefined) {
    return { answer: 'unknown', reason: `${provider}'s model list could not be read (${noteFor(catalog, provider)})` }
  }
  return { answer: 'unreachable', reason: `${provider} does not offer ${model}` }
}

/**
 * The note a catalog carries about one provider, if it carries one.
 *
 * Notes come in two shapes and only one of them is about a provider: `${provider}: <why>`
 * for a per-provider failure, and whole sentences about the catalog as a whole. Matching
 * is anchored at the start and at the colon, so a provider whose id contains a colon or a
 * space still matches only its own note.
 * @param catalog - the catalog from {@link modelCatalogOf}.
 * @param provider - the provider id.
 * @returns the note's text after the prefix, or undefined when there is none.
 */
function noteFor(catalog, provider) {
  const prefix = `${provider}: `
  for (const note of catalog.notes ?? []) {
    if (typeof note !== 'string' || !note.startsWith(prefix)) continue
    const why = note.slice(prefix.length).trim()
    if (why !== '') return why
  }
  return undefined
}

/** Why nothing could be read, with the catalog's own notes appended when it has any. */
function noteLine(catalog, why) {
  const notes = (catalog.notes ?? []).filter((note) => typeof note === 'string' && note.trim() !== '')
  return notes.length === 0 ? why : `${why}: ${notes.join('; ')}`
}

/**
 * The sentence to report when a route is not `reachable`, for the answer it was given.
 *
 * `unreachable` names the routes the host does offer, because the caller's next move is to
 * pick one and the spelling is the whole problem. `unknown` says plainly that nothing could
 * be read and gives the reason, because "unreachable" would be a claim this side cannot
 * make - and a caller told "unreachable" is entitled to believe the host was asked and
 * answered.
 * @param explanation - what {@link explainRoute} answered.
 * @param catalog - the catalog, for the routes an unreachable answer should list.
 * @param wanted - the route as the caller spelled it, `provider/model`.
 * @returns the sentence.
 */
export function routeWarningOf(explanation, catalog, wanted) {
  if (explanation.answer === 'unknown') {
    return `whether this host can reach ${wanted} could not be determined - the model catalog could not be read `
      + `(${explanation.reason}), so the session was opened on its inherited model; use wts_session_tool action "model" `
      + 'to set it once the session is live'
  }
  return `this host cannot route to ${wanted} (${explanation.reason}); available routes: ${describeRoutes(catalog)}`
}

/**
 * Put one live session on a model, for its next request and every one after that.
 *
 * The durable event is written before the in-memory selection, so a session that dies
 * between the two comes back on the new model rather than on the one that was failing.
 * The route table is filled first of all, so that even a host which refuses both writes
 * still gets the request rewritten by the hook — the caller is told which of the two
 * actually took effect.
 * @param ctx - the host plugin context.
 * @param agent - the live agent to move.
 * @param selection - the resolved route.
 * @returns what took effect, and why anything did not.
 */
export function applyRoute(ctx, agent, selection) {
  const sessionId = typeof agent?.id === 'string' ? agent.id : ''
  if (sessionId === '') return { durable: false, live: false, hook: false, reason: 'the agent has no id' }
  MODEL_ROUTES.set(sessionId, selection)

  let durable = false
  try {
    if (typeof agent.session?.append === 'function') {
      agent.session.append('model/selection', selection)
      durable = true
    }
  } catch {
    durable = false
  }

  let live = false
  const controller = service(ctx, 'sessionController')
  try {
    const installed = controller?.agents?.selectionFor?.(agent)
    if (installed !== undefined && installed !== null) {
      installed.current = selection
      live = true
    }
  } catch {
    // A controller that does not expose the selection, or one whose projection is not
    // registered. Not fatal: the durable event above is what the next resume reads, and
    // the hook below is what the next request reads.
    live = false
  }
  return { durable, live, hook: true }
}

/**
 * Forget a route override, so the session's own selection is what applies again.
 *
 * The durable event stays: a leader that puts a member back on its original model is
 * choosing that model, not withdrawing the history of having chosen. What is removed is
 * the rewrite, which is the part that would otherwise keep overriding the session.
 * @param sessionId - the session whose override goes away.
 * @returns whether there was one.
 */
export function clearRoute(sessionId) {
  return MODEL_ROUTES.delete(sessionId)
}

/** Whether a route override is in force for this session. */
export function routeArmedFor(sessionId) {
  return MODEL_ROUTES.has(sessionId)
}

/**
 * The `agent/request` rewrite that makes a route take effect on the next step.
 *
 * Installed once for the host. Two properties matter and both are load-bearing:
 *
 *  - **It only ever answers for a session in {@link MODEL_ROUTES}.** Every other request
 *    in the deployment is passed through untouched, so this plugin cannot change a model
 *    nobody asked it to change.
 *  - **It cannot fail the request.** The rewrite happens on the resolved config and
 *    returns a replacement; a throw here would take the model call down with it, so the
 *    body is wrapped and falls back to the config it was given.
 * @param ctx - the host plugin context.
 * @returns the disposer, or undefined when this host serves no event dispatch.
 */
export function installRouteHook(ctx) {
  if (ctx === null || ctx === undefined || typeof ctx.on !== 'function') return undefined
  try {
    const dispose = ctx.on('agent/request', (payload, next) => {
      const resolved = next()
      const sessionId = payload?.agent?.id
      const route = typeof sessionId === 'string' ? MODEL_ROUTES.get(sessionId) : undefined
      if (route === undefined) return resolved
      return Promise.resolve(resolved).then((config) => {
        const { reasoningEffort: _inherited, ...rest } = config ?? {}
        return {
          ...rest,
          provider: route.provider,
          model: route.model,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
        }
      })
    })
    return typeof dispose === 'function' ? dispose : () => {}
  } catch {
    return undefined
  }
}

/**
 * A short stable digest of a route, for the record and for tests.
 *
 * The task record keeps the model a session was dispatched on, and a provider/model pair
 * is two strings that a reader has to compare by eye. The digest is what makes "same
 * route" checkable in a test without re-implementing the comparison there.
 * @param selection - the route, possibly absent.
 * @returns a hex digest, or an empty string when there is no route.
 */
export function routeDigest(selection) {
  if (selection === null || selection === undefined) return ''
  return createHash('sha256')
    .update(routeKey(selection.provider, selection.model))
    .digest('hex')
    .slice(0, 12)
}

/** An error's message, without caring what was thrown. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The model a dispatched session should start on, and where that answer came from.
 *
 * Three levels, highest first, and the order is the whole of the feature:
 *
 *   1. **the call** — a `model` argument on the dispatch itself. One call, one session:
 *      the leader is opening a session for a job it knows the shape of.
 *   2. **the configuration** — the `taskModelProvider` / `taskModel` pair on the Plugins
 *      page. One answer for every session this plugin opens, so a team that always runs
 *      task sessions on a cheaper model says it once instead of on every dispatch.
 *   3. **the dispatching session** — the model the leader itself is on. This is the
 *      default and the reason the feature needs no configuration at all: a member
 *      inheriting the leader's model is what already happened, and it is what should
 *      still happen when nobody has an opinion.
 *
 * A level that names only half a route (a provider with no model, or the reverse) is
 * treated as not naming one at all rather than being completed from the level below.
 * Two halves from two levels is a route nobody asked for, and it would be reported as
 * "specified" while being a guess.
 *
 * The answer carries `source` because the caller has to be able to say which of the
 * three it used: a leader that set the configuration months ago and forgot is owed a
 * sentence saying so, and a member's own record is worth keeping the provenance in.
 * @param request - the call's own pair, when it named one.
 * @param configured - the configuration's pair, when it names one.
 * @param inherited - the dispatching session's current route.
 * @returns the route and which level supplied it; `route` is undefined only when no
 *   level named anything, which happens on a host that cannot say what the leader is on.
 */
export function resolveDispatchModel({ request, configured, inherited } = {}) {
  const usable = (route) => route !== null && route !== undefined
    && typeof route.provider === 'string' && route.provider !== ''
    && typeof route.model === 'string' && route.model !== ''
  if (usable(request)) {
    return { route: selectionOf(request.provider, request.model, request.reasoningEffort), source: 'request' }
  }
  if (usable(configured)) {
    return { route: selectionOf(configured.provider, configured.model, configured.reasoningEffort), source: 'config' }
  }
  if (usable(inherited)) {
    return { route: selectionOf(inherited.provider, inherited.model, inherited.reasoningEffort), source: 'leader' }
  }
  return { route: undefined, source: 'none' }
}


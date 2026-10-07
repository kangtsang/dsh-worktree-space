/**
 * The delivery policy: what finishing a task owes, and to whom.
 *
 * A task's merge can be tied to a deployment and its verification, or left free;
 * conflicts can wait for the user or be handed straight to a session; the strays a
 * task space leaves can be archived, kept or thrown away. Those are decisions about
 * how the user wants their work delivered, and they differ per project - which is
 * why they are recorded once, at create time, in the task's own record, rather than
 * decided afresh by whatever happens to be finishing the task.
 *
 * The schema here is deliberately flat and closed: every field names one decision,
 * every value comes from a fixed list, and an invalid value is refused at create
 * time (a policy that cannot be stated unambiguously would be read differently by
 * every later step) but falls back to the default when read back (a record written
 * by an older version, or edited by hand, is no reason to refuse a finish).
 */

import { coded } from './codes.js'

/** What carries the acceptance: an isolated compose environment, the user's own machine, a DSH sandbox - or nothing. */
export const DEPLOY_TARGETS = ['docker', 'host', 'dsh-acceptance', 'none']
/** Whether deploying is part of the flow by itself (auto) or waits to be asked for. */
export const DEPLOY_MODES = ['auto', 'on-request']
/** Who says the work is right: the agent alone, the agent and then the user, or the user alone. */
export const VERIFICATION_MODES = ['agent', 'agent-then-human', 'human']
/** How a merge happens once the gate is green: by itself, with a confirmation, or not through the flow at all. */
export const MERGE_MODES = ['auto', 'ask', 'never']
/** What an unresolved merge conflict does: opens a session for it, asks first, or stops the delivery. */
export const CONFLICT_MODES = ['agent-auto', 'ask', 'stop']
/** What happens to the files a task space leaves behind that git never tracked. */
export const STRAY_MODES = ['archive', 'keep', 'discard']

/**
 * The policy a task carries when nobody said otherwise: delivery off.
 *
 * Every part of this is meant to be switched on per project - the point of the
 * pipeline is to run itself - but the default has to be the shape that changes
 * nothing for a task nobody configured: no deployment expected, so no gate stands
 * between a merge and its green light. A default that deployed and gated would
 * turn every task the user has today into a task that cannot merge.
 */
export const DEFAULT_DELIVERY_POLICY = Object.freeze({
  version: 1,
  deploy: Object.freeze({ target: 'none', mode: 'on-request' }),
  verification: 'agent-then-human',
  merge: Object.freeze({ mode: 'ask', target: null, deleteBranch: true }),
  conflicts: 'ask',
  strays: 'keep',
})

const FIELDS = {
  deploy: {
    target: DEPLOY_TARGETS,
    mode: DEPLOY_MODES,
  },
  verification: VERIFICATION_MODES,
  merge: {
    mode: MERGE_MODES,
  },
  conflicts: CONFLICT_MODES,
  strays: STRAY_MODES,
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function oneOf(list, value, field, { strict }) {
  if (value === undefined || value === null || `${value}`.trim() === '') return undefined
  const text = String(value).trim()
  if (list.includes(text)) return text
  if (strict) throw coded('E4010', `'${text}' is not a valid ${field}; expected one of: ${list.join(', ')}`)
  return undefined
}

function mergeTarget(value, { strict }) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  if (text === '') return null
  if (text.includes('/') || text.includes('\\') || text.includes(' ')) {
    if (strict) throw coded('E4010', `'${text}' is not a usable merge target branch name`)
    return undefined
  }
  return text
}

/**
 * Build a policy from partial input, in one of two moods.
 *
 * Strict (create time): an invalid value refuses the whole policy, because a
 * record written with a hole in it would be read differently by the gate and by
 * the note. Lenient (read time): every invalid or missing field falls back to the
 * default, because a record from an older version must still finish.
 * @param input - the partial policy, as stored or as requested.
 * @param mode - `strict` refuses invalid values; `lenient` substitutes defaults.
 * @returns the complete policy.
 */
function buildPolicy(input, { strict }) {
  const source = isPlainObject(input) ? input : {}
  const sourceDeploy = isPlainObject(source.deploy) ? source.deploy : {}
  const sourceMerge = isPlainObject(source.merge) ? source.merge : {}

  const target = oneOf(DEPLOY_TARGETS, sourceDeploy.target, 'deploy.target', { strict }) ?? DEFAULT_DELIVERY_POLICY.deploy.target
  const deployMode = oneOf(DEPLOY_MODES, sourceDeploy.mode, 'deploy.mode', { strict }) ?? DEFAULT_DELIVERY_POLICY.deploy.mode
  const verification = oneOf(VERIFICATION_MODES, source.verification, 'verification', { strict }) ?? DEFAULT_DELIVERY_POLICY.verification
  const mergeMode = oneOf(MERGE_MODES, sourceMerge.mode, 'merge.mode', { strict }) ?? DEFAULT_DELIVERY_POLICY.merge.mode
  const conflicts = oneOf(CONFLICT_MODES, source.conflicts, 'conflicts', { strict }) ?? DEFAULT_DELIVERY_POLICY.conflicts
  const strays = oneOf(STRAY_MODES, source.strays, 'strays', { strict }) ?? DEFAULT_DELIVERY_POLICY.strays
  const mergeTargetValue = mergeTarget(sourceMerge.target, { strict }) ?? DEFAULT_DELIVERY_POLICY.merge.target
  const deleteBranch = sourceMerge.deleteBranch === undefined ? DEFAULT_DELIVERY_POLICY.merge.deleteBranch : sourceMerge.deleteBranch === true

  return {
    version: 1,
    deploy: { target, mode: deployMode },
    verification,
    merge: { mode: mergeMode, target: mergeTargetValue, deleteBranch },
    conflicts,
    strays,
  }
}

/**
 * Normalize a requested policy: the create-time mood.
 * @param input - the policy as the caller stated it.
 * @returns the complete policy.
 * @throws Error carrying E4010 when a value is not one of the allowed ones.
 */
export function normalizeDeliveryPolicy(input) {
  return buildPolicy(input, { strict: true })
}

/**
 * Read a policy back from a record: the read-time mood.
 * @param input - the policy as stored, or nothing.
 * @returns the complete policy, defaults filling every hole.
 */
export function coerceDeliveryPolicy(input) {
  return buildPolicy(input, { strict: false })
}

/**
 * The policy a task's own record carries.
 * @param metadata - the record read from the task space, if any.
 * @returns the complete policy.
 */
export function deliveryPolicyOf(metadata) {
  return coerceDeliveryPolicy(isPlainObject(metadata) ? metadata.delivery : undefined)
}

/**
 * Resolve the policy a new task starts with.
 *
 * Three answers, in the order they win: what this one request stated explicitly,
 * what the configuration remembers for the project (the user's standing answer,
 * given once at a create they chose to remember), and the built-in default that
 * turns nothing on. An explicit policy is one a caller stated for this task alone;
 * a stored default is shared by every task of the project, so an invalid value in
 * it refuses the create the same way an explicit one would - a stored mistake
 * applied silently is worse than a refused create.
 * @param project - the project layer's name.
 * @param explicit - the policy this request stated, if any.
 * @param defaults - the per-project defaults the configuration holds.
 * @returns the complete policy.
 */
export function resolveDeliveryPolicy(project, explicit, defaults = {}) {
  const stored = isPlainObject(defaults) ? defaults[project] : undefined
  const chosen = explicit !== undefined && explicit !== null ? explicit : stored
  return chosen === undefined || chosen === null
    ? coerceDeliveryPolicy(undefined)
    : normalizeDeliveryPolicy(chosen)
}

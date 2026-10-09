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
// 'dsh-acceptance' was removed as a target type: a DSH plugin is accepted on a
// web instance too, and that instance is a node process in a container like any
// other - it belongs to docker, as a documented recipe, not as a category.
export const DEPLOY_TARGETS = ['docker', 'host', 'none']
/** Whether deploying is part of the flow by itself (auto) or waits to be asked for. */
export const DEPLOY_MODES = ['auto', 'on-request']
/** Who says the work is right: the agent alone, the agent and then the user, or the user alone. */
export const VERIFICATION_MODES = ['agent', 'agent-then-human', 'human']
/** How a merge happens once the gate is green: by itself, with a confirmation, or not through the flow at all. */
export const MERGE_MODES = ['auto', 'ask', 'never']
/** What an unresolved merge conflict does: opens a session for it, asks first, or stops the delivery. */
export const CONFLICT_MODES = ['agent-auto', 'ask', 'stop']
/**
 * What happens to the files a task space leaves behind that git never tracked.
 *
 * There is no `discard` here. A policy is the flow's standing answer, and one that deletes the
 * user's own files is a standing answer nobody can take back; throwing them away stays what it
 * always was - the caller's own flag, on the abandon path, where `force` already says it.
 */
export const STRAY_MODES = ['archive', 'keep']

/**
 * The policy a task carries when nobody said otherwise: the manual flow.
 *
 * Every part of this is meant to be switched on per project - the point of the
 * pipeline is to run itself - but the default has to be the shape that changes
 * nothing for a task nobody configured: no deployment expected, no merge of the
 * flow's own, and the acceptance left to the user, who is the one who asked for the
 * work in the first place. A default that deployed and merged by itself would turn
 * every task the user has today into one that merges without them.
 */
export const DEFAULT_DELIVERY_POLICY = Object.freeze({
  version: 1,
  deploy: Object.freeze({ target: 'none', mode: 'on-request' }),
  verification: 'human',
  // The branch is kept unless something said to delete it. A task branch is the only
  // record of how the work was made once the task space is gone, and deleting it is the
  // one step here that cannot be walked back: `ask` is the merge default, and this
  // matches it - the flow does the reversible half and leaves the other to whoever
  // asked for it.
  merge: Object.freeze({ mode: 'ask', target: null, deleteBranch: false }),
  conflicts: 'ask',
  // Leftovers are archived rather than left standing. `keep` would make every finish of a
  // task nobody configured stop with the space still on disk and ask again; filing them
  // into the archive directory is the answer that lets one press finish the task, and it
  // is reversible - the archive is a copy, and the user's own files are not edited.
  strays: 'archive',
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

  // A policy that merges by itself has no one to wait for, so the human half of a
  // verification mode would be a requirement nothing could satisfy. Refused here, at create
  // time, rather than recorded and then quietly dropped by the gate - the one combination the
  // fields can state and the flow cannot honour. Reading a record back does not refuse it: a
  // record from an older version, or one edited by hand, is no reason to stop a finish, and
  // `auto` then means what it says (the gate does not wait for the ack; see `deploy.js`).
  if (strict && mergeMode === 'auto' && verification !== 'agent') {
    throw coded(
      'E4010',
      `merge.mode 'auto' merges by itself, so it cannot be combined with verification '${verification}': `
        + 'set verification to agent, or leave merge.mode at ask. Merging that waits for a person is ask '
        + '(and the person confirms in the panel).',
    )
  }

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

/**
 * Apply the strays policy to a finish request, in one place and testably.
 *
 * Two policies, mapped onto what {@link `archive.js`} already knows how to do:
 * `archive` files the user's content into the archive directory and clears the
 * build output (no per-item waiting), and it is the default; `keep` is the policy
 * declining to speak, which is the answer a caller asks for when it wants to decide
 * per finish. Deleting the content is not a mode of this policy: it is the caller's
 * `discardDocuments` flag, which only the abandon path passes.
 *
 * A caller that decided anything itself - a cleanStray, an archive directory, a
 * discard, a keep list - is honoured verbatim: the policy fills gaps, it does not
 * overrule.
 * @param policy - the task's delivery policy.
 * @param request - what the caller asked for: the cleanStray / discardDocuments
 *   flags, the documents directory, and the keep list.
 * @param archive - the archive preference, used to root the per-task folder when
 *   the policy files things away and the caller named no directory.
 * @param taskPath - the task space directory, for the folder name under the root.
 * @returns the flags `finishTask` should run with.
 */
export function applyStraysPolicy(policy, request, archive, taskPath) {
  const cleanStray = request.cleanStray === true
  const discardDocuments = request.discardDocuments === true
  const documentsDirectory = typeof request.documentsDirectory === 'string' ? request.documentsDirectory.trim() : ''
  const keep = Array.isArray(request.keep) ? request.keep : []
  const callerDecided = cleanStray || discardDocuments || documentsDirectory !== '' || keep.length > 0

  if (callerDecided || policy.strays !== 'archive') {
    // The two flags are independent, as finishTask has always treated them:
    // cleanStray clears the build output, discardDocuments throws the user's
    // content away - one without the other is a decision the caller may make.
    // This is the only way anything is thrown away: the policy above has no mode
    // that deletes, so a policy alone can never lose work.
    return { cleanStray, discardDocuments, documentsDirectory }
  }
  // Archive: the caller said nothing, so the policy speaks - file the content
  // away and clear the output, without the per-item wait. The folder layout
  // mirrors what the panel's dialog would have built: <root>/archived-docs/
  // <project>/<task>-<stamp>, the stamp keeping two finishes apart.
  const strategy = archive && archive.strategy === 'custom' && String(archive.directory ?? '').trim() !== ''
    ? String(archive.directory).trim()
    : containerRootOf(taskPath)
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const parts = String(taskPath).split(/[\\/]+/).filter((part) => part !== '')
  const task = parts[parts.length - 1] ?? 'task'
  const project = parts[parts.length - 2] ?? 'project'
  const root = String(strategy).replace(/[\\/]+$/, '')
  return {
    cleanStray: true,
    discardDocuments: false,
    documentsDirectory: `${root}\\archived-docs\\${project}\\${task}-${stamp}`,
  }
}

/** The container root a task space lives under: two levels up, as the layout lays it out. */
function containerRootOf(taskPath) {
  const parts = String(taskPath ?? '').split(/[\\/]+/).filter((part) => part !== '')
  const up = parts.slice(0, -2).join('\\')
  return up === '' ? '.' : up
}

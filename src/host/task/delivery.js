/**
 * The delivery policy: what finishing a task owes, and to whom.
 *
 * This used to be eight fields a create declared once and every later step read
 * back. It is now one: whether the task expects a deployment at all. Everything
 * else moved to where the decision is actually made - the `done` call, whose
 * arguments say what to merge, what to do with leftovers and which branch to land
 * on. A policy recorded at create time and consulted at finish time could only
 * ever be a default the caller had to remember, and four of those fields turned
 * out to be read by nobody at all (see the repository's own notes on
 * `deploy.mode`, `conflicts`, `merge.target` and `verification`).
 *
 * What is left is the one answer a later step cannot derive: does this task have
 * an environment whose smoke has to pass before the work may land? That is
 * `deploy.target`, and it is the switch that turns the finish gate on.
 *
 * The schema is deliberately flat and closed: the field names one decision, the
 * value comes from a fixed list, and an invalid value is refused at create time (a
 * policy that cannot be stated unambiguously would be read differently by every
 * later step) but falls back to the default when read back (a record written by an
 * older version, or edited by hand, is no reason to refuse a finish).
 */

import { posix, win32 } from 'node:path'
import { coded } from './codes.js'

/**
 * What carries the acceptance: an isolated compose environment, or nothing.
 *
 * `host` was removed: it ran whatever command a `deploy.yaml` named, which meant
 * the plugin owned none of the observability a deployment needs - no container to
 * find, no log to read, no label to tear down by. A failure there surfaced as an
 * exit code and 4000 characters of output, which is not enough to debug a port
 * conflict or a compile error. Docker is kept because it is the target the plugin
 * can actually see: containers carry the environment id, so the status, the
 * teardown and the "is anything running" question all have real answers.
 *
 * `dsh-acceptance` was removed earlier, for its own reason: a DSH plugin is
 * accepted on a web instance too, and that instance is a node process in a
 * container like any other - it belongs to docker, as a documented recipe, not as
 * a category.
 */
export const DEPLOY_TARGETS = ['docker', 'none']

/**
 * The policy a task carries when nobody said otherwise: the manual flow.
 *
 * `target: 'none'` means no deployment is expected, which closes the finish gate
 * entirely - the task is as finishable as it was before delivery policies existed.
 * A default that deployed and gated would turn every task the user has today into
 * one that refuses to finish until a smoke passes.
 */
export const DEFAULT_DELIVERY_POLICY = Object.freeze({
  version: 1,
  deploy: Object.freeze({ target: 'none' }),
})

const FIELDS = {
  deploy: {
    target: DEPLOY_TARGETS,
  },
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

/**
 * Build a policy from partial input, in one of two moods.
 *
 * Strict (create time): an invalid value refuses the whole policy, because a
 * record written with a hole in it would be read differently by the gate and by
 * the note. Lenient (read time): every invalid or missing field falls back to the
 * default, because a record from an older version must still finish.
 *
 * A record from before this schema shrank still reads: its `host` target is not in
 * the list any more, so it falls back to `none` - which drops the gate rather than
 * inventing one. That is the safe direction for a value this side can no longer
 * serve, and it is the same rule every other removed field follows.
 * @param input - the partial policy, as stored or as requested.
 * @param mode - `strict` refuses invalid values; `lenient` substitutes defaults.
 * @returns the complete policy.
 */
function buildPolicy(input, { strict }) {
  const source = isPlainObject(input) ? input : {}
  const sourceDeploy = isPlainObject(source.deploy) ? source.deploy : {}

  const target = oneOf(DEPLOY_TARGETS, sourceDeploy.target, 'deploy.target', { strict }) ?? DEFAULT_DELIVERY_POLICY.deploy.target

  return {
    version: 1,
    deploy: { target },
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
 * Coerce a stored policy: the read-time mood.
 * @param input - the policy as it was recorded.
 * @returns the complete policy, every missing or invalid field defaulted.
 */
export function coerceDeliveryPolicy(input) {
  return buildPolicy(input, { strict: false })
}

/**
 * Resolve the policy a new task starts with.
 *
 * One answer, not three. What this request stated wins, and the built-in default
 * is the last word after that. There used to be a per-project stored default in
 * the middle, set as JSON on the plugin's settings card; it is gone because it was
 * a second place to say the same thing, in a worse shape (a JSON text box), and
 * because the delivery decision now lives at the finish where the caller can see
 * the work it applies to.
 * @param explicit - the policy this request stated, if any.
 * @returns the complete policy.
 */
export function resolveDeliveryPolicy(explicit) {
  return explicit === undefined || explicit === null
    ? coerceDeliveryPolicy(undefined)
    : normalizeDeliveryPolicy(explicit)
}

/**
 * The policy a task's own record carries, read back leniently.
 *
 * Every finish path asks this rather than reading `recorded.delivery` directly, so
 * a record from an older version is read through one place instead of each caller
 * inventing its own fallback for a field that no longer exists.
 * @param recorded - the task's own record.
 * @returns the complete policy.
 */
export function deliveryPolicyOf(recorded) {
  return coerceDeliveryPolicy(isPlainObject(recorded) ? recorded.delivery : undefined)
}

/**
 * Apply the strays choice to a finish request, in one place and testably.
 *
 * The choice is the caller's, and it is one of three: `archive` files the user's
 * content into the archive directory and clears the build output (no per-item
 * waiting), `discard` throws the content away, and `keep` declines to speak - the
 * space is left exactly as it stands, non-empty, so the finish cannot remove the
 * directory and the user comes back to it. `archive` is the answer when the caller
 * said nothing, because it is the one that neither loses anything nor leaves the
 * task space standing.
 *
 * Deleting is reachable from here now, which it deliberately was not while this
 * was a policy recorded at create time: a standing answer that deletes the user's
 * files is one nobody can take back, whereas a `discard` on this call is a
 * decision made with the content in front of the caller. `force` is still the
 * caller's own flag and is still refused at the tool boundary, so an agent cannot
 * reach `discard` by accident.
 * @param request - what the caller asked for: the strays choice, a documents
 *   directory, a keep list, and whether this is an abandon path.
 * @param archive - the archive preference, used to root the per-task folder when
 *   the caller named no directory.
 * @param taskPath - the task space directory, for the folder name under the root.
 * @returns the flags `finishTask` should run with.
 */
export function applyStraysPolicy(request, archive, taskPath) {
  const choice = request.strays === 'keep' || request.strays === 'discard' ? request.strays : 'archive'
  const keep = Array.isArray(request.keepEntries) ? request.keepEntries : []
  const named = typeof request.documentsDirectory === 'string' ? request.documentsDirectory.trim() : ''

  if (choice === 'keep') {
    // Nothing is touched, and nothing is deleted: the caller wants the space as it
    // is. Build output stays too - a space that is being kept is not being cleared.
    return { cleanStray: false, discardDocuments: false, documentsDirectory: '', keep }
  }
  if (choice === 'discard') {
    return { cleanStray: true, discardDocuments: true, documentsDirectory: '', keep }
  }
  // Archive. A caller-named directory is the destination itself, taken verbatim:
  // the panel builds the whole path (`<root>/archived-docs/<project>/<task>-<stamp>`)
  // before it sends it, so nesting it under a second `archived-docs` would file
  // everything one level deeper than the dialog just promised the user.
  //
  // Only an absolute directory is taken. A relative one is ignored in favour of the
  // strategy default rather than refused, and `.` and `..` are the shape that matters:
  // the copy below runs `mkdir(recursive)` and then `cp`, so either of them would land
  // the whole archive in the host process's own working directory. Falling back keeps
  // a finish from being blocked - a destination this side already knows is always
  // available - and a caller with a legitimate directory still names an absolute one.
  if (named !== '' && isAbsoluteDirectory(named)) {
    return { cleanStray: true, discardDocuments: false, documentsDirectory: named, keep }
  }
  // Otherwise the configured root decides, and the folder layout mirrors what the
  // panel's dialog would have built: <root>/archived-docs/<project>/<task>-<stamp>,
  // the stamp keeping two finishes apart. The configured root is held to the same
  // absolute-path rule as a named one, for the same reason: a relative directory
  // typed into the setting would file every archive into the working directory.
  const configured = archive && archive.strategy === 'custom' ? String(archive.directory ?? '').trim() : ''
  const custom = configured !== '' && isAbsoluteDirectory(configured) ? configured : ''
  const strategy = custom !== '' ? custom : containerRootOf(taskPath)
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const parts = String(taskPath).split(/[\\/]+/).filter((part) => part !== '')
  const task = parts[parts.length - 1] ?? 'task'
  const project = parts[parts.length - 2] ?? 'project'
  // The directory being filed under decides the separator style, so a POSIX root
  // yields a POSIX path and a Windows one keeps its backslashes - on either host.
  // Joining with the other flavour's `join` leaves the foreign separator in place
  // and the whole destination reads as one file name to the host that receives it.
  const flavour = flavourOf(custom !== '' ? custom : taskPath)
  return {
    cleanStray: true,
    discardDocuments: false,
    documentsDirectory: flavour.join(strategy, 'archived-docs', project, `${task}-${stamp}`),
    keep,
  }
}

/**
 * The `node:path` flavour a value is written in.
 *
 * A backslash anywhere means the Windows flavour, which is also what a Windows path
 * with forward slashes is joined by - `win32` accepts both separators. A value with
 * no backslash is read as POSIX, which is the shape a path built on a POSIX host has
 * and the one the client counterpart picks its separator from.
 * @param value - a path in either separator style.
 * @returns the `node:path` export that joins paths of that style.
 */
function flavourOf(value) {
  return String(value ?? '').includes('\\') ? win32 : posix
}

/**
 * Whether a directory a caller or the configuration named may be filed into.
 *
 * Both flavours are asked because the value is not read from this host's own
 * filesystem: a path the panel built on Windows arrives here with a drive letter,
 * and one a POSIX host built arrives with a leading slash. `.`, `..` and a bare
 * relative name are absolute under neither, which is exactly the answer wanted for
 * them.
 * @param value - the destination to test.
 * @returns whether the value names a location from a root of its own.
 */
function isAbsoluteDirectory(value) {
  const text = String(value ?? '').trim()
  return text !== '' && (win32.isAbsolute(text) || posix.isAbsolute(text))
}

/**
 * The container root a task space lives under: two levels up, as the layout lays
 * it out. Derived from the path itself rather than by splitting on separators and
 * rejoining, because rejoining loses the leading separator of a POSIX path and
 * turns the rest into one name. A path too short to have two levels above it
 * answers `.`, the current directory, rather than an empty string - a destination
 * of `''` reads as "no destination at all" and would send the caller down the
 * discard path.
 * @param taskPath - the task space directory.
 * @returns the container root, in the separator style of the path it was read from.
 */
function containerRootOf(taskPath) {
  const flavour = flavourOf(taskPath)
  const up = flavour.dirname(flavour.dirname(String(taskPath ?? '')))
  return up === '' ? '.' : up
}

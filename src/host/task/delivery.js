/**
 * The delivery policy: what finishing a task owes, and to whom.
 *
 * This used to be eight fields a create declared once and every later step read
 * back. It is now one: what the task owes before it may land - nothing, a passing
 * smoke, or a passing smoke of a deployment. Everything
 * else moved to where the decision is actually made - the `done` call, whose
 * arguments say what to merge, what to do with leftovers and which branch to land
 * on. A policy recorded at create time and consulted at finish time could only
 * ever be a default the caller had to remember, and four of those fields turned
 * out to be read by nobody at all (see the repository's own notes on
 * `deploy.mode`, `conflicts`, `merge.target` and `verification`).
 *
 * What is left is the one answer a later step cannot derive: what does this task
 * owe before its work may land? That is `acceptance.kind`, and it is the switch
 * that turns the finish gate on - at one of two strengths, a smoke alone or a
 * deployment whose smoke has to pass.
 *
 * The field was `deploy.target` while the only answer worth recording was whether
 * a deployment was expected. It was renamed when a task that only ever runs tests
 * turned out to owe the same thing a deploying task does: a recorded verdict. A
 * name that asks about deploying cannot carry "a smoke and nothing else" without
 * reading as an exception; a name that asks about acceptance carries all three
 * answers, and the one that deploys becomes the detailed case rather than the
 * default everything else is described against.
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
 * What a task owes before its work may land: a deployment and its smoke, a smoke
 * on its own, or nothing.
 *
 * The three are one decision, not a deployment with an optional add-on, because a
 * task that only ever runs a test suite has the same thing to show as one that
 * brings a stack up: a recorded verdict on the work. Accepting the second shape is
 * what makes "run `npm test`, write `lastSmoke: pass`" a complete answer - there is
 * no container to start, no URL to hand over, and nothing for the teardown to look
 * for, but there is still a fence.
 *
 * `deploy` and `smoke` differ in exactly two ways, and both are about what the
 * environment can answer: a deployment hands over an acceptance URL and has
 * containers to tear down, and its smoke is evidence about the stack that is
 * standing rather than only about the tree. Everything else - the entry script, the
 * state file, the recorded smoke, the gate - is the same file and the same code.
 *
 * Two targets were removed to leave these three. `host` ran whatever command a
 * `deploy.yaml` named, which meant the plugin owned none of the observability a
 * deployment needs - no container to find, no log to read, no label to tear down
 * by - and a failure surfaced as an exit code and 4000 characters of output, which
 * is not enough to debug a port conflict. `dsh-acceptance` was a DSH web instance,
 * which is a node process in a container like any other: a documented recipe, never
 * a category of its own.
 */
export const ACCEPTANCE_KINDS = ['none', 'smoke', 'deploy']

/**
 * The policy a task carries when nobody said otherwise: the manual flow.
 *
 * `kind: 'none'` means nothing is expected, which closes the finish gate entirely -
 * the task is as finishable as it was before delivery policies existed. A default
 * that gated would turn every task the user has today into one that refuses to
 * finish until something is recorded, and a fence nobody chose is not a fence.
 */
export const DEFAULT_DELIVERY_POLICY = Object.freeze({
  version: 2,
  acceptance: Object.freeze({ kind: 'none' }),
})

/**
 * How a `version: 1` record's target reads as a kind.
 *
 * Read-time only, and it is the whole of the migration: every reader of a stored
 * policy goes through {@link coerceDeliveryPolicy}, so pointing the one function at
 * this map is what makes a record written before the rename keep working. Nothing
 * rewrites the old shape on disk - a record's meaning is decided by the function
 * that reads it, not by what a later write happened to normalise it to - and no
 * field was added to the new shape, so an old record is not short of anything.
 *
 * `docker` becomes `deploy` because that is what it always meant: the one target
 * that has an environment, an acceptance URL and a label to tear down by. `host` is
 * absent, which is deliberate - it is not in the current list either, so it falls
 * through to the default, exactly as it did before this rename.
 */
const LEGACY_TARGET_KINDS = {
  docker: 'deploy',
  none: 'none',
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
 * The two shapes are both read, and which one arrives is decided by what the input
 * carries rather than by its `version`: a record with `acceptance` is this schema,
 * one with `deploy` is the schema before the rename. Keying on the fields means a
 * hand-edited record that got its `version` wrong is still read as what it plainly
 * is, and a caller stating a policy at create time cannot pick a shape by claiming
 * a version.
 * @param input - the partial policy, as stored or as requested.
 * @param mode - `strict` refuses invalid values; `lenient` substitutes defaults.
 * @returns the complete policy.
 */
function buildPolicy(input, { strict }) {
  const source = isPlainObject(input) ? input : {}
  const current = isPlainObject(source.acceptance) ? source.acceptance : undefined
  // The legacy shape, read only when the current one is absent: a record carrying
  // both is one this side wrote and then somebody edited, and the field the current
  // schema names is the one to trust.
  const legacy = current === undefined && isPlainObject(source.deploy) ? source.deploy : undefined

  const stated = current === undefined
    ? oneOf(Object.keys(LEGACY_TARGET_KINDS), legacy?.target, 'deploy.target', { strict })
    : oneOf(ACCEPTANCE_KINDS, current.kind, 'acceptance.kind', { strict })
  // A legacy target that is in its own list but has no kind - nothing today, since the
  // map covers both - falls back like any other unreadable value rather than inventing
  // a fence. `LEGACY_TARGET_KINDS` is keyed off for `oneOf` so a `version: 1` record's
  // `kubernetes`/`host` is refused at create time and defaulted at read time, which is
  // the same two moods the current value gets.
  const kind = current === undefined
    ? (stated === undefined ? undefined : LEGACY_TARGET_KINDS[stated])
    : stated
  return {
    version: 2,
    acceptance: { kind: kind ?? DEFAULT_DELIVERY_POLICY.acceptance.kind },
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

/**
 * The matrix window: the newest five DSH releases, finals preferred, rc filling in.
 *
 * `dsh.compatibility.dshReleases` is a claim about what was tested, and the window
 * it names moves every time DSH publishes. This module answers "what should the
 * window be right now" from the registry's own version list, so the answer is
 * computed rather than remembered. Two callers read it:
 *
 *   - `check-dsh-window.mjs`, the gate `run-all.ps1` runs before anything else: a
 *     stale window fails the run and names the versions to move to. A checklist
 *     item is skipped sooner or later (the release flow learned this twice in one
 *     day); a gate cannot be.
 *   - the unit test, which pins the selection rule itself against fixtures.
 *
 * The rule, as the maintainer set it: five entries, newest first. A final release
 * (no prerelease suffix) always qualifies; `rc.N` fills the remaining slots;
 * `alpha`/`beta` never enter the window - they are not what "正式" means here.
 * DSH has published no finals so far, so today the window is five rc versions;
 * the day a final ships it takes a slot without this file changing.
 *
 * Ordering is semver, not publication order: npm lists versions in the order they
 * were published, and a patch to an older line published later would otherwise
 * push a newer line out of the window.
 */

/** Parse `1.2.3-rc.4` into its parts; null when it is not a version at all. */
export function parseVersion(spec) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z][A-Za-z.-]*)\.?(\d+))?$/.exec(String(spec ?? ''))
  if (m === null) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    // Absent for a final; the family and its number otherwise.
    family: m[4] === undefined ? null : m[4].toLowerCase().replace(/\.$/, ''),
    pre: m[5] === undefined ? 0 : Number(m[5]),
  }
}

/**
 * Compare two parsed versions, newest first.
 *
 * Core numbers, then final-over-prerelease, then family (alpha < beta < rc),
 * then the prerelease number. An unknown family sorts with alpha and is kept
 * out of the window by `selectWindow` anyway.
 */
export function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return right[key] - left[key]
  }
  if ((left.family === null) !== (right.family === null)) return left.family === null ? -1 : 1
  if (left.family !== right.family) {
    const rank = { alpha: 0, beta: 1, rc: 2 }
    return (rank[right.family] ?? 0) - (rank[left.family] ?? 0)
  }
  return right.pre - left.pre
}

/**
 * The window for a registry version list: newest `count` finals and rc versions.
 * @param {readonly string[]} versions - every version the registry reports.
 * @param {number} count - window size; the manifest's window is five.
 * @returns the selected version strings, newest first.
 */
export function selectWindow(versions, count = 5) {
  return versions
    .map((spec) => ({ spec, parsed: parseVersion(spec) }))
    .filter((entry) => entry.parsed !== null && (entry.parsed.family === null || entry.parsed.family === 'rc'))
    .sort((left, right) => compareVersions(left.parsed, right.parsed))
    .slice(0, count)
    .map((entry) => entry.spec)
}

/**
 * Compare a declared window with the registry's answer.
 * @param {readonly string[]} declared - the keys of `dshReleases`, any order.
 * @param {readonly string[]} expected - `selectWindow`'s answer, newest first.
 * @returns `{ ok, missing, extra }` - missing are versions to add, extra to drop.
 */
export function diffWindow(declared, expected) {
  const have = new Set(declared)
  const want = new Set(expected)
  const missing = expected.filter((v) => !have.has(v))
  const extra = declared.filter((v) => !want.has(v))
  return { ok: missing.length === 0 && extra.length === 0, missing, extra }
}
/**
 * Widen a matrix window with the floor of every declared series.
 *
 * `selectWindow` answers "the newest five releases", which is the right question
 * for "is this plugin current". It is the wrong question for "does it work across
 * the range the manifest claims": `engines.dsh` is a disjunction of ranges, one
 * per DSH series the plugin says it supports, and the newest five can leave a
 * whole series untested. A plugin that declares three series and measures only
 * the newest five has, in the worst case, never booted against two of them.
 *
 * So the window is the union of the two answers - the newest five, plus the lowest
 * release that satisfies each declared series. The floor is the interesting
 * version in a series: everything above it is the direction the plugin is being
 * developed toward, and the floor is the case a user who has not upgraded yet
 * actually runs.
 *
 * A series with no published version that satisfies it contributes nothing. That
 * is a manifest bug rather than a window bug - it means the range names a version
 * that does not exist - and reporting it as an empty contribution lets the caller
 * say so in its own words instead of failing here with a stack.
 */

/** A very small subset of semver range syntax: `>=x`, `>` , and the caret/tilde forms. */
function satisfiesFloor(spec, range) {
  const parsed = parseVersion(spec)
  if (parsed === null) return false
  // Each clause is `>=<version>` by construction: the manifest writes its series
  // floors that way on purpose, and anything more elaborate would need a semver
  // library this plugin deliberately does not carry.
  const clause = /^>=\s*(\S+)$/.exec(range.trim())
  if (clause === null) return false
  const floor = parseVersion(clause[1])
  if (floor === null) return false
  return compareVersions(parsed, floor) <= 0
}

/**
 * The lowest published version of each declared series.
 *
 * Series are the clauses of a disjunction, so `>=0.2.0-rc.1 || >=0.2.1-rc.1`
 * names two. A clause with no matching release among `versions` is reported in
 * `unmatched`, because a floor nobody can install is a claim the matrix cannot
 * measure and the release should say so rather than pass over it.
 * @param {readonly string[]} versions - every version the registry reports.
 * @param {string} range - the manifest's declared range, `||`-joined.
 * @returns `{ floors, unmatched }` - floors sorted newest first, unmatched clauses verbatim.
 */
export function seriesFloors(versions, range) {
  const clauses = String(range ?? '')
    .split('||')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  const floors = []
  const unmatched = []
  for (const clause of clauses) {
    const matching = versions
      .filter((spec) => satisfiesFloor(spec, clause))
      .map((spec) => ({ spec, parsed: parseVersion(spec) }))
      .filter((entry) => entry.parsed !== null)
      .sort((left, right) => compareVersions(left.parsed, right.parsed))
    if (matching.length === 0) {
      unmatched.push(clause)
      continue
    }
    floors.push(matching[matching.length - 1].spec)
  }
  return { floors, unmatched }
}

/**
 * The matrix window: the newest five releases plus every declared series floor.
 *
 * Deduplicated by version and ordered newest first, so the report reads the same
 * way it did when it was five entries. A floor that is already among the newest
 * five appears once - which is the common case for the most recently declared
 * series, and the reason the count differs between releases.
 * @param {readonly string[]} versions - every version the registry reports.
 * @param {object} options - `range` is the manifest's declared range; `count` the window size.
 * @returns `{ window, floors, unmatched }` - the union, the floors it added, and any clause with no release.
 */
export function selectMatrixWindow(versions, { range, count = 5 } = {}) {
  const newest = selectWindow(versions, count)
  const { floors, unmatched } = range === undefined
    ? { floors: [], unmatched: [] }
    : seriesFloors(versions, range)
  const bySpec = new Map()
  for (const spec of [...newest, ...floors]) {
    const parsed = parseVersion(spec)
    if (parsed !== null) bySpec.set(spec, parsed)
  }
  const window = [...bySpec.entries()]
    .sort((left, right) => compareVersions(left[1], right[1]))
    .map(([spec]) => spec)
  return { window, floors, unmatched }
}

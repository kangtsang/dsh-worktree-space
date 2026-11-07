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

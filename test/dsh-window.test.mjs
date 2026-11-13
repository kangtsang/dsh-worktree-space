import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { compareVersions, diffWindow, parseVersion, selectMatrixWindow, selectWindow, seriesFloors } from "../scripts/dsh-window.mjs"

/**
 * The window rule, pinned against fixtures rather than the live registry.
 *
 * The registry answers change with every DSH publish; a test that asked it would
 * be a second copy of the gate, red on the day the window legitimately moves.
 * What must not change is the RULE: the newest five (finals and rc only, semver
 * order) unioned with the lowest release of every series the manifest declares.
 * The gate itself (`check-dsh-window.mjs`) asks the registry; this file holds
 * the rule still while it does.
 *
 * The second half is what keeps a declared range from being a claim nobody
 * measured: `engines.dsh` says "these series, from these floors", and a matrix
 * that only ever boots the newest five has never run the floor of an older
 * series - which is exactly what a user who has not upgraded runs.
 */

// The real list as of 2026-11-13, kept as a fixture: publication order, with
// alpha interleaved and an older line's rc published after a newer line's alpha.
const PUBLISHED = [
  "0.0.1-rc.1", "0.1.7-rc.2", "0.2.0-rc.1", "0.2.0-rc.2",
  "0.2.1-alpha.1", "0.2.1-rc.1", "0.2.1-rc.2", "0.2.1-rc.3",
  "0.2.1-rc.4", "0.2.1-rc.5", "0.2.2-alpha.2", "0.2.2-alpha.3", "0.2.2-rc.1",
  "0.2.2-rc.2", "0.2.2-rc.3",
]

describe("selectWindow", () => {
  it("takes the newest five rc when no finals exist", () => {
    expect(selectWindow(PUBLISHED)).toEqual([
      "0.2.2-rc.3", "0.2.2-rc.2", "0.2.2-rc.1", "0.2.1-rc.5", "0.2.1-rc.4",
    ])
  })

  it("never lets alpha or beta into the window", () => {
    const window = selectWindow([...PUBLISHED, "0.3.0-alpha.1", "0.3.0-beta.1"])
    expect(window).not.toContain("0.3.0-alpha.1")
    expect(window).not.toContain("0.3.0-beta.1")
    expect(window).toHaveLength(5)
  })

  it("prefers a final over its own and older prereleases", () => {
    // The day DSH ships a final it takes a slot without the rule changing. Where
    // it lands is the subtle part: semver puts a final above every prerelease of
    // its OWN core and below the next core, so 0.2.1 sits between 0.2.2-rc.1 and
    // 0.2.1-rc.5 - it displaces the newest rc of its own series, not the oldest
    // entry in the window.
    const window = selectWindow([...PUBLISHED, "0.2.1"])
    expect(window).toHaveLength(5)
    expect(window).toContain("0.2.1")
    expect(window.indexOf("0.2.1")).toBeLessThan(window.indexOf("0.2.1-rc.5"))
    expect(window).not.toContain("0.2.1-rc.4")
  })

  it("orders by semver, not by publication order", () => {
    // An older line's rc published LAST must not push the newer line out.
    const window = selectWindow(["0.2.2-rc.1", "0.2.1-rc.5", "0.2.1-rc.4", "0.2.1-rc.3", "0.2.1-rc.2", "0.1.9-rc.9"])
    expect(window).toEqual(["0.2.2-rc.1", "0.2.1-rc.5", "0.2.1-rc.4", "0.2.1-rc.3", "0.2.1-rc.2"])
  })

  it("ranks rc.10 above rc.9, not below it", () => {
    // String ordering would put rc.10 between rc.1 and rc.2; the number is a number.
    const window = selectWindow(["0.3.0-rc.1", "0.3.0-rc.9", "0.3.0-rc.10", "0.3.0-rc.2", "0.3.0-rc.3", "0.3.0-rc.4"], 3)
    expect(window).toEqual(["0.3.0-rc.10", "0.3.0-rc.9", "0.3.0-rc.4"])
  })

  it("ignores entries that are not versions", () => {
    expect(selectWindow(["latest", "next", "", "0.2.2-rc.1"])).toEqual(["0.2.2-rc.1"])
  })
})

describe("parseVersion / compareVersions", () => {
  it("parses finals and prereleases alike", () => {
    expect(parseVersion("1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3, family: null })
    expect(parseVersion("0.2.2-rc.1")).toMatchObject({ family: "rc", pre: 1 })
    expect(parseVersion("0.2.2-alpha.12")).toMatchObject({ family: "alpha", pre: 12 })
    expect(parseVersion("not-a-version")).toBeNull()
  })

  it("sorts a final above every prerelease of its own core", () => {
    const final = parseVersion("0.2.1")
    const rc = parseVersion("0.2.1-rc.99")
    expect(compareVersions(final, rc)).toBeLessThan(0)
    expect(compareVersions(rc, final)).toBeGreaterThan(0)
  })
})

describe("diffWindow", () => {
  it("accepts the same set in any order", () => {
    const expected = selectWindow(PUBLISHED)
    expect(diffWindow([...expected].reverse(), expected)).toEqual({ ok: true, missing: [], extra: [] })
  })

  it("names what to add and what to drop", () => {
    // The window as it stood before 0.2.2-rc.2/rc.3 were published, against the
    // window the rule now answers: two added, two dropped, nothing else.
    const expected = selectWindow(PUBLISHED)
    const stale = ["0.2.1-rc.2", "0.2.1-rc.3", "0.2.1-rc.4", "0.2.1-rc.5", "0.2.2-rc.1"]
    const diff = diffWindow(stale, expected)
    expect(diff.ok).toBe(false)
    expect(diff.missing).toEqual(["0.2.2-rc.3", "0.2.2-rc.2"])
    expect(diff.extra).toEqual(["0.2.1-rc.2", "0.2.1-rc.3"])
  })
})

describe("the manifest against the rule", () => {
  it("declares the newest five plus every series floor, all rc or final", () => {
    // Offline shape check: the live-registry comparison is the gate's job, run
    // before every matrix. What this pins is that the manifest never drifts into
    // an alpha entry, or into a window that has lost one of the halves the rule
    // names, without the gate being bypassed.
    const root = fileURLToPath(new URL("..", import.meta.url))
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    const declared = Object.keys(manifest.dsh.compatibility.dshReleases)
    // More than five is the normal case now: five newest plus floors, minus the
    // floors that are already within the newest five.
    expect(declared.length).toBeGreaterThanOrEqual(5)
    for (const spec of declared) {
      const parsed = parseVersion(spec)
      expect(parsed, `${spec} is not a version`).not.toBeNull()
      expect([null, "rc"], `${spec} is not final/rc`).toContain(parsed.family)
    }
    // dshOperations verdicts only for versions the window names.
    for (const spec of Object.keys(manifest.dsh.compatibility.dshOperations ?? {})) {
      expect(declared, `dshOperations names ${spec} outside the window`).toContain(spec)
    }
  })
})

describe("selectMatrixWindow", () => {
  // The declared range this plugin actually ships: three series, so three floors.
  const RANGE = ">=0.2.0-rc.1 || >=0.2.1-rc.1 || >=0.2.2-rc.1"

  it("unions the newest five with each series floor", () => {
    // Seven entries, not five: the newest five reach back only to 0.2.1-rc.4, so
    // the 0.2.1 and 0.2.0 series would have gone unmeasured entirely.
    const { window, floors } = selectMatrixWindow(PUBLISHED, { range: RANGE })
    expect(window).toEqual([
      "0.2.2-rc.3", "0.2.2-rc.2", "0.2.2-rc.1", "0.2.1-rc.5", "0.2.1-rc.4", "0.2.1-rc.1", "0.2.0-rc.1",
    ])
    expect(floors).toEqual(["0.2.0-rc.1", "0.2.1-rc.1", "0.2.2-rc.1"])
  })

  it("names each floor once when it is also inside the newest five", () => {
    // 0.2.2-rc.1 is both the floor of its series and the newest release. The
    // union must not list it twice, and the report must not either.
    const { window } = selectMatrixWindow(PUBLISHED, { range: RANGE })
    expect(window.filter((spec) => spec === "0.2.2-rc.1")).toHaveLength(1)
  })

  it("measures the floor of a series instead of its newest release", () => {
    // The point of the floor: a user on 0.2.0-rc.1 is not on 0.2.0-rc.2, and the
    // lower one is what the range promises to have booted.
    const { floors } = selectMatrixWindow(PUBLISHED, { range: ">=0.2.0-rc.1" })
    expect(floors).toEqual(["0.2.0-rc.1"])
  })

  it("reports a series with no published release rather than dropping it", () => {
    // A range naming a version that does not exist is a claim nothing can test.
    // Silently contributing nothing would let the matrix pass one entry short of
    // what the manifest promises.
    const { window, floors, unmatched } = selectMatrixWindow(PUBLISHED, { range: RANGE + " || >=9.9.9" })
    expect(unmatched).toEqual([">=9.9.9"])
    expect(floors).not.toContain("9.9.9")
    // The union of the three real floors with the newest five; the unmeasurable
    // clause contributes nothing rather than a made-up entry.
    expect(window).toHaveLength(7)
  })

  it("falls back to the newest five when no range is declared", () => {
    expect(selectMatrixWindow(PUBLISHED, {}).window).toEqual(selectWindow(PUBLISHED))
  })
})

describe("seriesFloors", () => {
  it("splits a disjunction into one floor per clause", () => {
    const { floors } = seriesFloors(PUBLISHED, ">=0.2.0-rc.1 || >=0.2.1-rc.1")
    expect(floors).toEqual(["0.2.0-rc.1", "0.2.1-rc.1"])
  })

  it("never picks an alpha as a floor", () => {
    // 0.2.1-alpha.1 is published but is not what the range promises; a floor is
    // the lowest release a user can actually be running.
    const { floors } = seriesFloors(PUBLISHED, ">=0.2.1-rc.1")
    expect(floors).toEqual(["0.2.1-rc.1"])
  })
})

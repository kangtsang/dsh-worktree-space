import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { compareVersions, diffWindow, parseVersion, selectWindow } from "../scripts/dsh-window.mjs"

/**
 * The window rule, pinned against fixtures rather than the live registry.
 *
 * The registry answers change with every DSH publish; a test that asked it would
 * be a second copy of the gate, red on the day the window legitimately moves.
 * What must not change is the RULE: five entries, finals and rc only, semver
 * order. The gate itself (`check-dsh-window.mjs`) asks the registry; this file
 * holds the rule still while it does.
 */

// The real list as of 2026-11-07, kept as a fixture: publication order, with
// alpha interleaved and an older line's rc published after a newer line's alpha.
const PUBLISHED = [
  "0.0.1-rc.1", "0.1.7-rc.2", "0.2.0-rc.1", "0.2.0-rc.2",
  "0.2.1-alpha.1", "0.2.1-rc.1", "0.2.1-rc.2", "0.2.1-rc.3",
  "0.2.1-rc.4", "0.2.1-rc.5", "0.2.2-alpha.2", "0.2.2-alpha.3", "0.2.2-rc.1",
]

describe("selectWindow", () => {
  it("takes the newest five rc when no finals exist", () => {
    expect(selectWindow(PUBLISHED)).toEqual([
      "0.2.2-rc.1", "0.2.1-rc.5", "0.2.1-rc.4", "0.2.1-rc.3", "0.2.1-rc.2",
    ])
  })

  it("never lets alpha or beta into the window", () => {
    const window = selectWindow([...PUBLISHED, "0.3.0-alpha.1", "0.3.0-beta.1"])
    expect(window).not.toContain("0.3.0-alpha.1")
    expect(window).not.toContain("0.3.0-beta.1")
    expect(window).toHaveLength(5)
  })

  it("prefers a final over its own and older prereleases", () => {
    // The day DSH ships a final it takes a slot without the rule changing.
    const window = selectWindow([...PUBLISHED, "0.2.1"])
    expect(window[0]).toBe("0.2.2-rc.1")
    expect(window).toContain("0.2.1")
    expect(window).not.toContain("0.2.1-rc.2")
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
    const expected = selectWindow(PUBLISHED)
    const stale = ["0.2.0-rc.1", "0.2.0-rc.2", "0.2.1-rc.1", "0.2.1-rc.2", "0.2.1-rc.3"]
    const diff = diffWindow(stale, expected)
    expect(diff.ok).toBe(false)
    expect(diff.missing).toEqual(["0.2.2-rc.1", "0.2.1-rc.5", "0.2.1-rc.4"])
    expect(diff.extra).toEqual(["0.2.0-rc.1", "0.2.0-rc.2", "0.2.1-rc.1"])
  })
})

describe("the manifest against the rule", () => {
  it("declares exactly five releases, all rc or final", () => {
    // Offline shape check: the live-registry comparison is the gate's job, run
    // before every matrix. What this pins is that the manifest never drifts into
    // a six-entry window or an alpha entry without the gate being bypassed.
    const root = fileURLToPath(new URL("..", import.meta.url))
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    const declared = Object.keys(manifest.dsh.compatibility.dshReleases)
    expect(declared).toHaveLength(5)
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

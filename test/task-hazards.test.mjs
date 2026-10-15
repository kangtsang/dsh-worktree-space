/**
 * The two hazards a create reports on, and the gate preview a deploy reports.
 *
 * Each of these was previously invisible until it hurt: a link only surfaced when
 * the finish could not file a stray, an e2e configuration only when someone trusted
 * a green run that meant nothing, and a missing delivery fact only as an E5005 at
 * the very end. What is asserted here is that the finding arrives at the point where
 * it can still be acted on - which is the whole of what these four changes are.
 */
import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findE2eConfigs, inspectE2eConfig, inspectE2eConfigs } from "../src/host/task/e2e.js"
import { findLinks, symlinksRefused } from "../src/host/task/links.js"
import { deliveryGatePreview } from "../src/host/task/deploy.js"
import { PLUGIN_ROOT } from "../src/host/task/shared.js"
import { WARNING_CODES } from "../src/host/task/codes.js"

/** A scratch directory, removed when the test that made it is done. */
async function scratch(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe("the link probe a create runs", () => {
  it("finds a symbolic link below a directory, as a path relative to it", async () => {
    const { dir, cleanup } = await scratch("dsh-links-")
    try {
      await mkdir(join(dir, "nested"), { recursive: true })
      await writeFile(join(dir, "nested", "real.txt"), "x")
      try {
        await symlink(join(dir, "nested", "real.txt"), join(dir, "nested", "alias.txt"))
      } catch {
        // A machine that cannot create one cannot be asked to find one; the probe
        // below is what this test would otherwise be asserting on.
        return
      }
      const found = await findLinks(dir)
      expect(found.links).toContain(join("nested", "alias.txt"))
      expect(found.truncated).toBe(false)
    } finally {
      await cleanup()
    }
  })

  it("does not descend into a link, so a self-referential tree terminates", async () => {
    const { dir, cleanup } = await scratch("dsh-links-loop-")
    try {
      try {
        await symlink(dir, join(dir, "self"))
      } catch {
        return
      }
      // A walk that followed `self` would never come back; the bound is what makes
      // this terminate either way, and the assertion is that it did.
      const found = await findLinks(dir)
      expect(found.links).toEqual(["self"])
    } finally {
      await cleanup()
    }
  })

  // The listing is used as a *filter*: `archive.js` copies a stray with every path
  // the scan named excluded, and `fs.cp` recreates the links it does not exclude. So
  // a link missing from a short list is a link the copy then tries to recreate - the
  // EPERM the filter exists to avoid, arriving through the filter itself. A caller
  // therefore has to be able to tell "no links" from "no links I looked far enough to
  // see", and this is that distinction.
  it("says when it stopped at its bound, rather than reporting a short list as the whole one", async () => {
    const { dir, cleanup } = await scratch("dsh-links-truncated-")
    try {
      // More entries than the bound, so the walk cannot finish. The links are placed
      // after the filler, which is what makes the count wrong rather than merely short:
      // a caller trusting `links.length` here would report fewer links than exist.
      for (let index = 0; index < 6; index += 1) {
        await mkdir(join(dir, `filler-${index}`), { recursive: true })
      }
      try {
        await symlink(join(dir, "filler-0"), join(dir, "zzz-alias"))
      } catch {
        // No link privilege on this machine: the truncation flag is still the subject,
        // and it does not depend on a link being creatable.
      }

      const bounded = await findLinks(dir, { maxEntries: 2 })
      expect(bounded.truncated, "a walk that stopped at its bound must say so").toBe(true)

      // The negative control: a bound large enough for the whole tree reports the
      // whole tree, so `truncated` is not simply always true.
      const whole = await findLinks(dir, { maxEntries: 1000 })
      expect(whole.truncated).toBe(false)
    } finally {
      await cleanup()
    }
  })

  // The same question asked of the other way the walk runs out: the budget is spent
  // exactly when the queue still holds directories nobody has read. There the inner
  // loop never trips, because it never sees a `seen` past the bound - the queue is
  // what says the walk is unfinished. Removing that half leaves `truncated` false for
  // this shape, and a caller would then copy a stray believing it had the whole list
  // of links. Kept as its own case because the two triggers fail independently.
  it("says so when the budget runs out with directories still queued", async () => {
    const { dir, cleanup } = await scratch("dsh-links-queued-")
    try {
      // One child holding one grandchild: reading the root's child costs one, reading
      // the grandchild's entries costs the second, and the grandchild itself is then
      // queued and unread when the budget ends.
      await mkdir(join(dir, "nested", "deep"), { recursive: true })
      const atBound = await findLinks(dir, { maxEntries: 2 })
      expect(atBound.truncated, "a queue still holding directories is an unfinished walk").toBe(true)
      // And one more entry of budget is enough to finish, which is what shows the flag
      // tracks the budget rather than being set whenever the queue was ever non-empty.
      const justEnough = await findLinks(dir, { maxEntries: 3 })
      expect(justEnough.truncated).toBe(false)
    } finally {
      await cleanup()
    }
  })

  it("answers the machine-wide question once, and the same way each time", async () => {
    const first = await symlinksRefused()
    const second = await symlinksRefused()
    expect(second).toBe(first)
    expect(typeof first).toBe("boolean")
  })
})

describe("the e2e configuration probe a create runs", () => {
  it("reads reuseExistingServer true as a finding", () => {
    const found = inspectE2eConfig("export default { webServer: { reuseExistingServer: true } }")
    expect(found.reusesExistingServer).toBe(true)
  })

  it("does not read reuseExistingServer false as one", () => {
    const found = inspectE2eConfig("export default { webServer: { reuseExistingServer: false } }")
    expect(found.reusesExistingServer).toBe(false)
  })

  it("names a fixed local address, and ignores an address built from the environment", () => {
    const fixed = inspectE2eConfig("const baseURL = 'http://localhost:5173'")
    expect(fixed.fixedUrls).toEqual(["http://localhost:5173"])
    // The one form a task space actually needs: the suite is told where to point,
    // so there is nothing to warn about.
    const derived = inspectE2eConfig("baseURL: process.env.E2E_BASE_URL")
    expect(derived.fixedUrls).toEqual([])
    expect(derived.reusesExistingServer).toBe(false)
  })

  it("finds a config by stem, whatever extension the runner accepts", async () => {
    const { dir, cleanup } = await scratch("dsh-e2e-")
    try {
      await writeFile(join(dir, "playwright.config.mjs"), "export default {}")
      await writeFile(join(dir, "cypress.config.ts"), "export default {}")
      await writeFile(join(dir, "vitest.config.ts"), "export default {}")
      const found = await findE2eConfigs(dir)
      expect(found.sort()).toEqual(["cypress.config.ts", "playwright.config.mjs"])
    } finally {
      await cleanup()
    }
  })

  it("looks past a dependency tree, whose configuration is somebody else's", async () => {
    const { dir, cleanup } = await scratch("dsh-e2e-skip-")
    try {
      await mkdir(join(dir, "node_modules", "dep"), { recursive: true })
      await writeFile(join(dir, "node_modules", "dep", "playwright.config.ts"), "export default { webServer: { reuseExistingServer: true } }")
      expect(await findE2eConfigs(dir)).toEqual([])
      expect(await inspectE2eConfigs(dir)).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it("reports the file, and what it said, together", async () => {
    const { dir, cleanup } = await scratch("dsh-e2e-report-")
    try {
      await writeFile(
        join(dir, "playwright.config.ts"),
        "export default { use: { baseURL: 'http://127.0.0.1:3000' }, webServer: { reuseExistingServer: true } }",
      )
      const findings = await inspectE2eConfigs(dir)
      expect(findings).toHaveLength(1)
      expect(findings[0].path).toBe("playwright.config.ts")
      expect(findings[0].reusesExistingServer).toBe(true)
      expect(findings[0].fixedUrls).toEqual(["http://127.0.0.1:3000"])
    } finally {
      await cleanup()
    }
  })

  it("says nothing about a repository with no e2e suite at all", async () => {
    const { dir, cleanup } = await scratch("dsh-e2e-none-")
    try {
      await writeFile(join(dir, "README.md"), "# nothing to run")
      expect(await inspectE2eConfigs(dir)).toEqual([])
    } finally {
      await cleanup()
    }
  })
})

describe("the delivery gate preview", () => {
  /** A task space directory holding the state a test wants the preview to read. */
  async function taskSpaceWith(state) {
    const { dir, cleanup } = await scratch("dsh-gate-")
    // The deploy root is the plugin's own directory followed by `deploy`; the state file
    // sits at that directory's top, which is what the plugin hands the script.
    await mkdir(join(dir, PLUGIN_ROOT, "deploy"), { recursive: true })
    if (state !== undefined) await writeFile(join(dir, PLUGIN_ROOT, "deploy", ".state.json"), JSON.stringify(state))
    return { dir, cleanup }
  }

  const deploying = { deploy: { target: 'docker' } }

  it("applies nothing to a policy that deploys nothing", async () => {
    const { dir, cleanup } = await taskSpaceWith(undefined)
    try {
      const preview = await deliveryGatePreview({ delivery: { deploy: { target: 'none' } } }, dir)
      expect(preview.applies).toBe(false)
      expect(preview.missing).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it("names the deployment and the smoke when no state file was ever written", async () => {
    const { dir, cleanup } = await taskSpaceWith(undefined)
    try {
      const preview = await deliveryGatePreview({ delivery: deploying }, dir)
      expect(preview.applies).toBe(true)
      // Both keys, because a missing state file means neither fact is recorded: the
      // deployment never happened and there is no smoke. A screen names the step, not the code.
      expect(preview.missing).toEqual(["deployment", "smoke"])
    } finally {
      await cleanup()
    }
  })

  it("names the smoke, in the gate's own keys", async () => {
    const { dir, cleanup } = await taskSpaceWith({ url: "http://localhost:1" })
    try {
      const preview = await deliveryGatePreview({ delivery: deploying }, dir)
      // The same key `assertDeliveryGate` refuses over, so a screen can say both in
      // one vocabulary rather than translating two. The smoke is the whole of the
      // gate now: the human acceptance it once waited for beside this is gone.
      expect(preview.missing).toEqual(["smoke"])
    } finally {
      await cleanup()
    }
  })

  it("names nothing once the smoke has passed", async () => {
    const { dir, cleanup } = await taskSpaceWith({
      lastSmoke: { result: "pass", at: "2026-01-01T00:00:00Z" },
    })
    try {
      const preview = await deliveryGatePreview({ delivery: deploying }, dir)
      expect(preview.missing).toEqual([])
    } finally {
      await cleanup()
    }
  })
})

describe("the warning codes these findings are reported under", () => {
  it("registers both, so a screen can say them in another language", () => {
    expect(Object.hasOwn(WARNING_CODES, "workspace-holds-links")).toBe(true)
    expect(Object.hasOwn(WARNING_CODES, "workspace-e2e-points-elsewhere")).toBe(true)
  })
})

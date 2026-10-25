import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fetchLatestVersion, isNewerVersion } from "../src/client/lib/update-check.js"

/**
 * A registry double that answers per host, so "the first host is down but the mirror has
 * it" can be spelled as itself rather than as an ordering accident.
 */
function registryAnswering(answers) {
  return vi.fn(async (url) => {
    const host = Object.keys(answers).find((key) => url.startsWith(key))
    if (host === undefined) throw new Error(`unexpected host in ${url}`)
    const answer = answers[host]
    if (answer instanceof Error) throw answer
    if (answer === null) return { ok: false, json: async () => ({}) }
    return { ok: true, json: async () => ({ version: answer }) }
  })
}

beforeEach(() => {
  // `fetchLatestVersion` caches at module level with a 1 hour TTL, which is the behaviour
  // worth keeping - so the module is rebuilt per test rather than the cache being
  // exported for tests to clear.
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("isNewerVersion", () => {
  it("compares the release triple numerically, not as text", () => {
    // The reason this is a comparison and not a string test: "1.10.0" sorts before
    // "1.9.0" as text.
    expect(isNewerVersion("1.10.0", "1.9.0")).toBe(true)
    expect(isNewerVersion("1.9.0", "1.10.0")).toBe(false)
  })

  it("says no for the same version, which is the common case", () => {
    expect(isNewerVersion("1.3.6", "1.3.6")).toBe(false)
  })

  it("tolerates a leading v and a pre-release suffix", () => {
    // The registry reports plain versions, but a hand-written one should not produce
    // NaN and a false "update available".
    expect(isNewerVersion("v1.4.0", "1.3.6")).toBe(true)
    expect(isNewerVersion("1.4.0-rc.1", "1.3.6")).toBe(true)
  })

  it("treats a pre-release as its release, which is a deliberate choice", () => {
    // `1.4.0-rc.1` compares equal to `1.4.0`. The question this answers is "is something
    // newer published", and a release candidate published as npm's `latest` is newer
    // than the stable version someone is running.
    expect(isNewerVersion("1.4.0-rc.1", "1.4.0")).toBe(false)
    expect(isNewerVersion("1.4.0", "1.4.0-rc.1")).toBe(false)
  })

  it("treats a missing component as zero", () => {
    expect(isNewerVersion("1.4", "1.3.6")).toBe(true)
    expect(isNewerVersion("2", "1.99.99")).toBe(true)
  })
})

describe("fetchLatestVersion", () => {
  it("reads the version from the public registry", async () => {
    vi.stubGlobal("fetch", registryAnswering({ "https://registry.npmjs.org": "9.9.9" }))
    const { fetchLatestVersion: read } = await import("../src/client/lib/update-check.js")
    expect(await read()).toBe("9.9.9")
  })

  it("falls back to the mirror when the public registry cannot be reached", async () => {
    // A mainland network times out on registry.npmjs.org; without the mirror the whole
    // feature would be silently dead for that region.
    const fetchMock = registryAnswering({
      "https://registry.npmjs.org": new Error("ETIMEDOUT"),
      "https://registry.npmmirror.com": "9.9.9",
    })
    vi.stubGlobal("fetch", fetchMock)
    const { fetchLatestVersion: read } = await import("../src/client/lib/update-check.js")
    expect(await read()).toBe("9.9.9")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("answers null when no registry could be reached, rather than throwing", async () => {
    // A plugin that announced an outage would be worse than one that stayed quiet.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline") }))
    const { fetchLatestVersion: read } = await import("../src/client/lib/update-check.js")
    await expect(read()).resolves.toBeNull()
  })

  it("answers null for a 404 or a body with no version", async () => {
    vi.stubGlobal("fetch", registryAnswering({
      "https://registry.npmjs.org": null,
      "https://registry.npmmirror.com": null,
    }))
    const { fetchLatestVersion: read } = await import("../src/client/lib/update-check.js")
    await expect(read()).resolves.toBeNull()

    vi.resetModules()
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ name: "x" }) })))
    const { fetchLatestVersion: read2 } = await import("../src/client/lib/update-check.js")
    await expect(read2()).resolves.toBeNull()
  })

  it("asks once for two mounts in the same tick", async () => {
    // The panel and the dialog both render the pill; two requests for one number is the
    // cost this cache exists to avoid.
    const fetchMock = registryAnswering({ "https://registry.npmjs.org": "9.9.9" })
    vi.stubGlobal("fetch", fetchMock)
    const { fetchLatestVersion: read } = await import("../src/client/lib/update-check.js")
    const [first, second] = await Promise.all([read(), read()])
    expect(first).toBe("9.9.9")
    expect(second).toBe("9.9.9")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("reuses the answer for an hour, then asks again", async () => {
    vi.useFakeTimers()
    const fetchMock = registryAnswering({ "https://registry.npmjs.org": "9.9.9" })
    vi.stubGlobal("fetch", fetchMock)
    const { fetchLatestVersion: read } = await import("../src/client/lib/update-check.js")

    await read()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Inside the hour: still the cached promise, no second request.
    vi.advanceTimersByTime(59 * 60 * 1000)
    await read()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Past it: asked again.
    vi.advanceTimersByTime(2 * 60 * 1000)
    await read()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("caches the failure too, so an offline machine does not retry on every render", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("offline") })
    vi.stubGlobal("fetch", fetchMock)
    const { fetchLatestVersion: read } = await import("../src/client/lib/update-check.js")
    await read()
    await read()
    // Two hosts on the first call, and nothing on the second.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

/**
 * Whether a newer version has been published.
 *
 * The only thing this asks is "is the package on npm newer than the bundle running" - it
 * never downloads, never prompts, and never reports a failure. A machine with no network,
 * a registry that is down, a corporate proxy that blocks npm: all of them answer "no
 * update", because a plugin that announced an outage would be worse than one that stayed
 * quiet.
 *
 * The version comes from the bundle, not from a request: `package.json` is not readable
 * from a browser, and asking the Host for a number that was fixed at build time would be
 * a round trip to learn something this side already knows.
 */
import { useEffect, useState } from "react"
import { PLUGIN_NAME, PLUGIN_VERSION } from "./meta"

/**
 * Registries to try, in order.
 *
 * The public one first, and a mirror second: `registry.npmmirror.com` is what a mainland
 * network reaches when `registry.npmjs.org` times out, and a single host would make the
 * feature silently dead for a whole region. Both serve the same document shape.
 */
const REGISTRY_HOSTS = ["https://registry.npmjs.org", "https://registry.npmmirror.com"]

/** How long an answer is reused. A published version changes at most a few times a day. */
const TTL_MS = 60 * 60 * 1000

/**
 * One shared request, and when it was made.
 *
 * Module-level rather than per-hook: the title row renders in the panel and in the dialog,
 * and both asking would double the traffic for one number. The promise is cached rather
 * than the value so two mounts in the same tick share the request in flight.
 */
let cached: { at: number; promise: Promise<string | null> } | null = null

/**
 * The `version` field of one registry's `latest` document.
 * @param host - the registry base.
 * @returns the version, or null when that host could not answer.
 */
async function readVersion(host: string): Promise<string | null> {
  try {
    const response = await fetch(`${host}/${PLUGIN_NAME}/latest`)
    if (!response.ok) return null
    const body = (await response.json()) as { version?: unknown }
    return typeof body.version === "string" ? body.version : null
  } catch {
    // No network, a blocked host, a body that is not JSON: all of them are "no answer".
    return null
  }
}

/**
 * The newest published version, or null when no registry could be reached.
 *
 * Cached for {@link TTL_MS}, and the failure is cached with the success: a machine that
 * cannot reach either registry must not retry on every render.
 * @returns the version string, or null.
 */
export function fetchLatestVersion(): Promise<string | null> {
  if (cached === null || Date.now() - cached.at >= TTL_MS) {
    cached = {
      at: Date.now(),
      promise: (async () => {
        for (const host of REGISTRY_HOSTS) {
          const version = await readVersion(host)
          if (version !== null) return version
        }
        return null
      })(),
    }
  }
  return cached.promise
}

/**
 * Whether `latest` is a later release than `current`.
 *
 * Numeric on the release triple, and **a pre-release counts as its release**: `1.4.0-rc.1`
 * compares equal to `1.4.0`. That is deliberate here even though it is lossy - the
 * question this answers is "should the reader be told something newer exists", and a
 * release candidate published to npm *is* newer than the stable version someone is
 * running. The cost is that a reader on `1.3.6` is offered `1.4.0` when only
 * `1.4.0-rc.1` exists; npm's `latest` tag is what decides that, and a project that
 * publishes an rc as `latest` has already made that choice.
 *
 * @param latest - the registry's version.
 * @param current - this bundle's version.
 * @returns whether latest is ahead.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (value: string): number[] =>
    value.replace(/^v/, "").split("-", 1)[0].split(".").map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(latest)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left > right
  }
  return false
}

/**
 * The newer published version, or null when this bundle is current.
 *
 * Nothing renders while the question is open, and nothing renders when the answer is
 * "no" - a capsule that appeared and vanished would make the heading row jump.
 * @returns the newer version, or null.
 */
export function useNewerVersion(): string | null {
  const [latest, setLatest] = useState<string | null>(null)
  useEffect(() => {
    // A working tree is never behind the registry, and telling a developer to update
    // their own checkout is noise.
    if (PLUGIN_VERSION.includes("-dev")) return undefined
    let live = true
    void fetchLatestVersion().then((version) => {
      if (live && version !== null) setLatest(version)
    })
    return () => { live = false }
  }, [])
  return latest !== null && isNewerVersion(latest, PLUGIN_VERSION) ? latest : null
}

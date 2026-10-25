/**
 * The version this bundle reports, and where its release notes live.
 *
 * A browser cannot read `package.json`, and asking the Host for the version would be a
 * round trip for a number that is fixed the moment the bundle is built. So the build
 * substitutes both values in (see `build.mjs`), from the same `package.json` the manifest
 * and the registry agree on - one source, three readers.
 *
 * The `typeof` guards are what keep a bundle built without those defines loading: an
 * undefined identifier is not a syntax error in a `typeof` check, so this degrades to a
 * development version rather than failing at import time.
 */

declare const __WTS_VERSION__: string | undefined
declare const __WTS_REPO__: string | undefined

/** The package name, which is also what the registry is queried with. */
export const PLUGIN_NAME = "dsh-worktree-space"

/**
 * This bundle's own version.
 *
 * `-dev` is what an unstamped build reports, and the update check skips itself for it:
 * a working tree is never behind the registry, and telling a developer to update their
 * own checkout is noise.
 */
export const PLUGIN_VERSION: string = typeof __WTS_VERSION__ === "string" ? __WTS_VERSION__ : "0.0.0-dev"

/** The public repository, without the `git+` prefix or `.git` suffix a manifest carries. */
export const PLUGIN_REPO: string =
  typeof __WTS_REPO__ === "string" && __WTS_REPO__ !== ""
    ? __WTS_REPO__
    : "https://github.com/kangtsang/dsh-worktree-space"

/**
 * Where a reader goes for "what changed".
 *
 * The changelog rather than a releases page: this repository publishes by tag and keeps
 * its release notes in `docs/CHANGELOG.md`, so a link to `/releases` would land on an
 * empty list. The public repository carries that file - it is one of the documents the
 * export publishes - so the address is stable for every released version.
 */
export const RELEASE_NOTES_URL = `${PLUGIN_REPO}/blob/main/docs/CHANGELOG.md`

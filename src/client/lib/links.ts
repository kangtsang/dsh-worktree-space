/** Where this plugin takes bug reports; the beta notice links here too. */
export const ISSUES_URL = "https://github.com/kangtsang/dsh-worktree-space/issues"

/**
 * An acceptance URL the card may render, or nothing.
 *
 * The Host has this same rule (`acceptanceUrl` in `src/host/task/deploy.js`) and is
 * the side that owns it, because the state file it reads is written by a deploy
 * script rather than by this plugin. This copy is the client's guard for the one
 * case the Host cannot cover: a Host older than that fix, whose `deploymentStatus`
 * still passes the state file's `url` through as it came.
 *
 * That matters more here than a wrong label would. React refuses an object as a
 * child, this console registers no error boundary, and a thrown render unmounts the
 * whole settings page - so a script-written `{"evil": true}` blanked the panel. A
 * value this cannot open is therefore answered as "no URL recorded", which is the
 * same thing the card already says for a state file that never wrote one.
 *
 * `http:` and `https:` only: those are the protocols a deploy can hand out, and a
 * `javascript:` or `data:` URL is not an acceptance URL whatever a state file says.
 * @param value - the value the Host reported as the acceptance URL.
 * @returns the URL when it is one a link may carry, else null.
 */
export function acceptanceUrl(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : null
}

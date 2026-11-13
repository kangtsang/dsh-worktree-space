/** Where this plugin takes bug reports; the beta notice links here too. */
export const ISSUES_URL = "https://github.com/kangtsang/dsh-worktree-space/issues"

/**
 * The plugin's own introduction video.
 *
 * Sits beside {@link ISSUES_URL} rather than in the component, because both are
 * places outside this plugin that a reader may want to go, and the description
 * line is the only place either one is offered. A reader who just arrived has a
 * question the flow sentence does not answer - what this looks like in use - and
 * a two-minute video answers it faster than the paragraph above does.
 */
export const VIDEO_URL = "https://www.bilibili.com/video/BV1iM466VEz2"

/**
 * The plugin's own repository, which is where a star is given.
 *
 * The issues page above is the same project one path deeper, and the two are spelled
 * out rather than derived from one another: a star and a bug report are different
 * intents, and a reader who follows either should land where that intent is answered
 * rather than on a page they then have to navigate away from.
 */
export const STAR_URL = "https://github.com/kangtsang/dsh-worktree-space"

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

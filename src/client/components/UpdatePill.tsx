import { useCallback, useEffect, useRef, useState } from "react"
import { format, useT } from "../lib/i18n"
import { HoverHint } from "./HoverHint"
import { PLUGIN_NAME, RELEASE_NOTES_URL } from "../lib/meta"
import { useNewerVersion } from "../lib/update-check"

/**
 * The spec a reader pastes into the Plugins page to install this version.
 *
 * `name@version` is what that field takes, and the exact version rather than `@latest`:
 * the pill exists because a *particular* version is newer than the one running, and
 * `@latest` would install whatever is newest at the moment of the click - which may have
 * moved on, or may be a version the reader has not just read the notes for.
 * @param version - the newer version.
 * @returns the package spec.
 */
export function installSpec(version: string): string {
  return `${PLUGIN_NAME}@${version}`
}

/** How long the "copied" confirmation stays up. */
const COPIED_MS = 1600

/**
 * A capsule beside the page's title, when the registry has something newer.
 *
 * It renders nothing at all when there is no update - not an empty box, not a spacer -
 * because the heading row is shared by the panel and the dialog and must not reflow when
 * an answer arrives a moment after the page paints.
 *
 * Two actions, because there are two things a reader does with this news:
 *
 * - **Left click** opens the release notes, which is what "what changed" means. It goes to
 *   the changelog rather than to a releases page: this repository publishes by tag and
 *   keeps its notes in `docs/CHANGELOG.md`, so `/releases` would land on an empty list.
 * - **Right click** copies `dsh-worktree-space@1.3.7` - the spec the Plugins page accepts -
 *   so the reader can paste it straight into the install field instead of retyping a
 *   version number they just read off a capsule.
 *
 * The two are separated this way rather than as two buttons so the heading row keeps one
 * element. A second button beside the title competes with the title for the reader's
 * attention, and the copy is a convenience for a reader who has already decided.
 */
/**
 * @param props.compact - the Plugins-detail form: it sits in a row of small outline
 * buttons beside uninstall, so it takes that row's height and type size instead of the
 * heading row's.
 */
export function UpdatePill({ compact = false }: { compact?: boolean } = {}) {
  const t = useT()
  const newer = useNewerVersion()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])

  const copy = useCallback(async (version: string) => {
    const spec = installSpec(version)
    try {
      await navigator.clipboard.writeText(spec)
      setCopied(true)
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => { setCopied(false) }, COPIED_MS)
    } catch {
      // No clipboard (a denied permission, an insecure context). The pill's accessible
      // name still carries the spec, so it can be selected and copied by hand; saying
      // "copy failed" in a capsule too small for the sentence would be worse than
      // silently not confirming.
    }
  }, [])

  if (newer === null) return null
  const spec = installSpec(newer)
  // `t` resolves a key and nothing else; the spec goes in through `format`, which is how
  // every other placeholder in this plugin is filled.
  const tip = copied
    ? format(t("updateCopied"), { spec })
    : format(t("updateTip"), { spec, version: `v${newer}` })
  return (
    <HoverHint label={tip} className="dws-update-pill-hint" delayMs={80}>
      <a
        className={compact ? "dws-update-pill dws-update-pill-compact" : "dws-update-pill"}
        data-copied={copied ? "true" : "false"}
        href={RELEASE_NOTES_URL}
        target="_blank"
        rel="noreferrer"
        aria-label={tip}
        onContextMenu={(event) => {
          // The right button belongs to the copy, so the browser's own menu - whose only
          // useful entry here would be "copy link address", which copies the changelog URL
          // rather than the spec the reader actually needs - does not open.
          event.preventDefault()
          void copy(newer)
      }}
      >
        <span className="dws-update-pill-label">{copied ? t("updateCopiedShort") : t("updateAvailable")}</span>
        <span className="dws-update-pill-version">{`↑ v${newer}`}</span>
      </a>
    </HoverHint>
  )
}

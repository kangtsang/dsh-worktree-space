import { format, useT } from "../lib/i18n"
import { HoverHint } from "./HoverHint"
import { RELEASE_NOTES_URL } from "../lib/meta"
import { useNewerVersion } from "../lib/update-check"

/**
 * A capsule beside the page's title, when the registry has something newer.
 *
 * It renders nothing at all when there is no update - not an empty box, not a spacer -
 * because the row it sits in must not reflow when an answer arrives a moment after the
 * page paints.
 *
 * One action: clicking it opens the release notes, which is what "what changed" means.
 * It goes to the changelog rather than to a releases page: this repository publishes by
 * tag and keeps its notes in `docs/CHANGELOG.md`, so `/releases` would land on an empty
 * list. The capsule carries no copy gesture of its own; a reader who wants the install
 * spec reads the version on it and types it on the Plugins page.
 */
export function UpdatePill() {
  const t = useT()
  const newer = useNewerVersion()
  if (newer === null) return null
  // `t` resolves a key and nothing else; the version goes in through `format`, which is
  // how every other placeholder in this plugin is filled.
  const tip = format(t("updateTip"), { version: `v${newer}` })
  return (
    <HoverHint label={tip} className="dws-update-pill-hint" delayMs={80}>
      <a
        className="dws-update-pill"
        href={RELEASE_NOTES_URL}
        target="_blank"
        rel="noreferrer"
        aria-label={tip}
      >
        <span className="dws-update-pill-label">{t("updateAvailable")}</span>
        <span className="dws-update-pill-version">{`↑ v${newer}`}</span>
      </a>
    </HoverHint>
  )
}
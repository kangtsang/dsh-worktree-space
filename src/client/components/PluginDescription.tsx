import { isChinese, useLanguage, useT } from "../lib/i18n"
import { ISSUES_URL, STAR_URL, VIDEO_URL } from "../lib/links"

/**
 * The two lines that say what this plugin does and how a task walks through it,
 * with the two links a reader eventually wants at the end of the second.
 *
 * It is the same block in two places - the manage dialog and the sidebar panel -
 * and it is assembled once here rather than spelled out twice, which is how the
 * two would drift apart. The first line describes the plugin; the second is the
 * flow its views follow, and the links ride at the end of that line rather than
 * the description's, because it is where the reader is looking when something in
 * the flow goes wrong - or when they want to see the flow before running it.
 *
 * The video comes first because it answers the question a reader has on arrival
 * ("what does this look like?"); the feedback link second, because a report only
 * makes sense after they have seen what it does. Both wear the same class: this is
 * the one pair of links on the screen, and a reader looking for either should not
 * have to go looking for a change of colour.
 *
 * The flow is a block-level span, not a nested paragraph: the host wraps this in
 * a `<p>` already, and a `<p>` inside a `<p>` is not what it looks like to the
 * parser. A single space separates the flow, the video and the feedback link - no
 * middot, which read as punctuation belonging to the sentence it was attached to -
 * and the links underline at rest rather than on hover only.
 */
export function PluginDescription() {
  const t = useT()
  const chinese = isChinese(useLanguage())
  return (
    <>
      {t("panelDescription")}
      <span className="dws-usage-flow">{t("usageFlow")}{" "}
        {/* The video is Chinese-only, so the English interface does not offer it:
            a reader who cannot follow the narration is better served by the
            written flow above than by a link they would have to abandon. */}
        {chinese ? <><a className="dws-feedback-link" href={VIDEO_URL} target="_blank" rel="noreferrer">{t("videoLink")}</a>{" "}</> : null}
        <a className="dws-feedback-link" href={ISSUES_URL} target="_blank" rel="noreferrer">{t("feedbackLink")}</a>{" "}
        {/* The star follows the feedback link rather than leading the line: a reader
            who has just been told where to report a problem is the one most likely to
            have an opinion worth a star, and the mark is a glyph plus one word rather
            than a sentence of its own.

            The mark is the character U+2606 rather than an icon component, and that is
            the whole reason it is one: `text-decoration` paints under every glyph in the
            run, but an inline SVG is a replaced box that the decoration line skips - so
            the word was underlined and the star beside it was not. A text character is
            part of the same run, so one underline covers both and the link reads as the
            single target it is. It is also the hollow star, which is the honest drawing:
            a filled one would claim the reader had already starred the project. */}
        <a className="dws-feedback-link dws-star-link" href={STAR_URL} target="_blank" rel="noreferrer">
          <span className="dws-star-mark" aria-hidden="true">☆</span>{" "}{t("starLink")}
        </a>
      </span>
    </>
  )
}
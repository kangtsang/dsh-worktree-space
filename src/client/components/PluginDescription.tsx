import { isChinese, useLanguage, useT } from "../lib/i18n"
import { ISSUES_URL, VIDEO_URL } from "../lib/links"

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
        <a className="dws-feedback-link" href={ISSUES_URL} target="_blank" rel="noreferrer">{t("feedbackLink")}</a>
      </span>
    </>
  )
}
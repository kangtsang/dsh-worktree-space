import { useT } from "../lib/i18n"
import { ISSUES_URL } from "../lib/links"

/**
 * The two lines that say what this plugin does and how a task walks through it,
 * with the one link a reader eventually wants at the end of the second.
 *
 * It is the same block in two places - the manage dialog and the sidebar panel -
 * and it is assembled once here rather than spelled out twice, which is how the
 * two would drift apart. The first line describes the plugin; the second is the
 * flow its views follow, and the feedback link rides at the end of that line
 * rather than the description's, because it is where the reader is looking when
 * something in the flow goes wrong.
 *
 * The flow is a block-level span, not a nested paragraph: the host wraps this in
 * a `<p>` already, and a `<p>` inside a `<p>` is not what it looks like to the
 * parser. No separator between the flow and the link - a middot read as
 * punctuation belonging to the sentence it was attached to - and the link
 * underlines at rest rather than on hover only: this is the one link on the
 * screen, and a reader looking for it should not have to go looking for a change
 * of colour.
 */
export function PluginDescription() {
  const t = useT()
  return (
    <>
      {t("panelDescription")}
      <span className="dws-usage-flow">{t("usageFlow")}{" "}<a className="dws-feedback-link" href={ISSUES_URL} target="_blank" rel="noreferrer">{t("feedbackLink")}</a></span>
    </>
  )
}
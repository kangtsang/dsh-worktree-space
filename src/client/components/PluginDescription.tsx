import { format, useT } from "../lib/i18n"
import { ISSUES_URL } from "../lib/links"

/**
 * The sentence that says what this plugin does, with the one link a reader eventually
 * wants underneath it.
 *
 * It is the same sentence in three places - the manage dialog, the sidebar panel and
 * the settings page - and it is assembled once here rather than spelled out three
 * times, which is how the three would drift apart. The first version put the link on
 * the view description instead, which is a different sentence entirely: that one
 * describes the current tab, this one describes the plugin.
 *
 * No separator between the sentence and the link. A middot read as punctuation
 * belonging to the sentence it was attached to. And the link underlines at rest
 * rather than on hover only: this is the one link on the screen, and a reader
 * looking for it should not have to go looking for a change of colour.
 */
export function PluginDescription() {
  const t = useT()
  return (
    <>
      {t("panelDescription")}
      <a className="dws-feedback-link" href={ISSUES_URL} target="_blank" rel="noreferrer">{t("feedbackLink")}</a>
    </>
  )
}
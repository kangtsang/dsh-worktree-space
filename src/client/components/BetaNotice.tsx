import { useT } from "../lib/i18n"
import { ISSUES_URL } from "../lib/links"

/**
 * The one line that says what this plugin is: a beta, and where to complain about it.
 *
 * Worktree Space moves branches, worktrees and commits, so a wrong answer costs more
 * than a redraw - and this is the honest version of a stability promise. One component
 * for the three places the page is headed (the panel, the dialog and the settings card)
 * keeps the sentence from drifting apart between them.
 */
export function BetaNotice() {
  const t = useT()
  return <p className="dws-beta-notice">
    <span className="dws-beta-badge">{t("betaBadge")}</span>
    <span>{t("betaNotice")} <a href={ISSUES_URL} target="_blank" rel="noreferrer">{t("betaNoticeLink")}</a></span>
  </p>
}

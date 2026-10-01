import { useT } from "../lib/i18n"
import { ISSUES_URL } from "../lib/links"

/**
 * The one line that says what is experimental here: letting an agent commit work nobody
 * committed, and letting one resolve a merge conflict - plus where to complain about it.
 *
 * Worktree Space moves branches, worktrees and commits, so a wrong answer costs more than
 * a redraw - but this is not a promise about the plugin as a whole. What is still being
 * worked out is the part that hands a repository to an agent, so the notice lives in the
 * finish panel that offers to do that, and nowhere the page merely manages worktrees.
 */
export function BetaNotice() {
  const t = useT()
  return <p className="dws-beta-notice">
    <span className="dws-beta-badge">{t("betaBadge")}</span>
    <span>{t("betaNotice")} <a href={ISSUES_URL} target="_blank" rel="noreferrer">{t("betaNoticeLink")}</a></span>
  </p>
}

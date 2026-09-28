import { useT } from "../lib/i18n"
import { ISSUES_URL } from "../lib/links"

/**
 * The one line that says what is experimental here: handing a merge conflict to an agent,
 * and where to complain about it.
 *
 * Worktree Space moves branches, worktrees and commits, so a wrong answer costs more than
 * a redraw - but this is not a promise about the plugin as a whole. What is still being
 * worked out is the part that lets an agent resolve a conflict, so the notice lives in the
 * finish report that offers to do that, and nowhere the page merely manages worktrees.
 */
export function BetaNotice() {
  const t = useT()
  return <p className="dws-beta-notice">
    <span className="dws-beta-badge">{t("betaBadge")}</span>
    <span>{t("betaNotice")} <a href={ISSUES_URL} target="_blank" rel="noreferrer">{t("betaNoticeLink")}</a></span>
  </p>
}

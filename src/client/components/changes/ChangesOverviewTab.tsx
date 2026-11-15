/**
 * 变更总览 — one task space or Workspace, one row per repository.
 *
 * It answers the question the row's "查看变更" button asks before anything is
 * opened: which repositories are inside this space, what each is compared
 * against, and how much each carries. A row opens 变更查看 on top of this tab,
 * the way the shell's local changes card opens its changes view.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { errorText } from "../../lib/error-text"
import { format, useT } from "../../lib/i18n"
import { changesViewAddress, entryName, parseChangesOverviewAddress } from "../../lib/change-address"
import type { ChangesTabProps } from "../../lib/changes-tab"
import type { ChangesOverviewAnswer } from "../../lib/types"
import { FolderClosed, Loader2, RefreshCw } from "../icons"

/**
 * Draw the overview.
 * @param props - the tab's runtime hooks and the injected Host face.
 * @returns the overview.
 */
export function ChangesOverviewTab({ useTabInfo, api }: ChangesTabProps): ReactNode {
  const t = useT()
  const { tab } = useTabInfo()
  const target = useMemo(() => parseChangesOverviewAddress(tab.contentId), [tab.contentId])
  const [answer, setAnswer] = useState<ChangesOverviewAnswer | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (target === undefined) return
    const controller = new AbortController()
    setLoading(true)
    setError("")
    api.changesOverview(target.path, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setAnswer(value) })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorText(t, reason)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [api, target?.path, generation, t])

  const open = useCallback((path: string, base: string) => {
    tab.actions.openResource(changesViewAddress(path, base))
  }, [tab.actions])

  if (target === undefined) return <Notice>{t("changesBadAddress")}</Notice>
  return (
    <div className="dws-changes-overview">
      <header className="dws-changes-overview-head">
        <span className="dws-changes-overview-title"><FolderClosed size={16} />{answer?.title ?? entryName(target.path)}</span>
        <button type="button" className="dws-changes-tool" onClick={() => setGeneration((value) => value + 1)} aria-label={t("changesRefresh")} title={t("changesRefresh")} disabled={loading}>
          {loading ? <Loader2 size={14} className="dws-spin" /> : <RefreshCw size={14} />}
        </button>
      </header>
      <p className="dws-changes-overview-path" title={target.path}>{target.path}</p>
      {error !== "" ? <p className="dws-changes-error" role="alert">{error}</p> : null}
      {answer === null && loading ? <p className="dws-changes-loading" role="status"><Loader2 size={14} className="dws-spin" />{t("changesLoading")}</p> : null}
      {answer === null ? null : answer.repositories.length === 0 ? <p className="dws-changes-empty">{t("changesNoRepositories")}</p> : (
        <div className="dws-changes-overview-list">
          {answer.repositories.map((repository) => {
            const disabled = repository.path === "" || repository.error !== undefined
            return (
              <button key={repository.name} type="button" className="dws-change-repo" disabled={disabled} onClick={() => open(repository.path, repository.base ?? "")}>
                <span className="dws-change-repo-name">{repository.name}</span>
                {repository.error !== undefined ? <span className="dws-change-repo-error">{repository.error}</span> : (
                  <>
                    <span className="dws-change-repo-refs">
                      <span className="dws-change-repo-label">{t("changesScopeBranch")}：</span>
                      <span className="dws-change-repo-head">{repository.branch ?? t("changesDetached")}</span>
                      <span aria-hidden="true">→</span>
                      <span className="dws-change-repo-base" title={repository.baseCommit}>{repository.base ?? t("noRemoteBranch")}</span>
                    </span>
                    <span className="dws-change-repo-counts">
                      <span className="dws-line-add">+{repository.insertions ?? 0}</span>
                      <span className="dws-line-del">−{repository.deletions ?? 0}</span>
                    </span>
                    <span className="dws-line-files">{format(t("changesFileCount"), { count: String(repository.files ?? 0) })}</span>
                  </>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="dws-changes-notice" role="alert">{children}</div>
}

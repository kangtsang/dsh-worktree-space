import { useEffect, useId, useRef, useState } from "react"
import { AlertCircle, GitPullRequest, InformationCircle, Loader2 } from "./icons"
import { format, useT } from "../lib/i18n"
import { isInsideDirectory, nameOf, slashPath } from "../lib/paths"
import { HoverHint } from "./HoverHint"
import type { TaskInspection, WorktreeList, WorkspacesService } from "../lib/types"
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input } from "./ui"
import type { createWorktreeApi } from "../lib/api"

type BaseMode = "head" | "named"

interface AddRepositoryDialogProps {
  /** The task space to extend; its own record says where it is filed and what branch it is on. */
  taskPath: string
  api: ReturnType<typeof createWorktreeApi>
  workspaces: WorkspacesService
  /** The repository view's own list — the same rows the user picked a repository from to create this task. */
  repositories: WorktreeList[]
  onAdded: () => void
  onClose: () => void
}

/**
 * Add repositories to a task that is already under way.
 *
 * The candidates are the repository view's list and nothing else — the same list
 * the task was created from. A repository that is not on it is not offered, because
 * the one place a repository enters that list is the repository view's own
 * "add repository" button, and two ways in would be two lists to keep in step.
 *
 * What is already in the task is not offered. Every worktree is named after the
 * directory its source repository lives in, so a repository whose name the task
 * already uses could not be cut into it at all; the Host would refuse, and a row
 * that could only fail is not a choice.
 * @param props - the task space, the services to reach, and the repository list.
 * @returns the dialog element.
 */
export function AddRepositoryDialog({ taskPath, api, workspaces, repositories, onAdded, onClose }: AddRepositoryDialogProps) {
  const t = useT()
  const id = useId()
  const [inspection, setInspection] = useState<TaskInspection | null>(null)
  const [loading, setLoading] = useState(true)
  const [picked, setPicked] = useState<string[]>([])
  const [baseMode, setBaseMode] = useState<BaseMode>("head")
  const [namedBase, setNamedBase] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const busyRef = useRef(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api.inspectTask(taskPath).then((next) => {
      if (!alive) return
      setInspection(next)
      // The task's own base is the one worth reusing: it is the commit every
      // repository it started with started from, so a repository joining it can
      // start there too. An empty one — HEAD is what the task used — leaves the
      // field empty rather than putting a guess in it.
      setNamedBase(next.baseRef ?? "")
    }).catch((reason) => {
      if (alive) setError(String(reason?.message ?? reason))
    }).finally(() => {
      if (alive) setLoading(false)
    })
    return () => { alive = false }
  }, [api, taskPath])

  const held = new Set(inspection?.repositories ?? [])
  const candidates = repositories
    .filter((entry) => !held.has(nameOf(entry.repoPath)))
    // A repository inside the task space could not be cut into it: its worktree
    // would land inside the repository it is meant to be a checkout of.
    .filter((entry) => !isInsideDirectory(taskPath, entry.repoPath))

  const toggle = (repoPath: string, include: boolean) => setPicked((current) => (
    include ? [...new Set([...current, repoPath])] : current.filter((entry) => entry !== repoPath)
  ))
  const setAll = (include: boolean) => setPicked(include ? candidates.map((entry) => entry.repoPath) : [])

  // No warning about a repository that shares no directory with the task space, and
  // none about one on another volume. Neither changes what adding it does: the merge
  // reads each repository from its own worktree and does not care where that is. The
  // one thing that does care — the session handed a commit, and how far it is
  // allowed to reach — is asked at the finish, where it is actually asked, rather
  // than warned about here over an operation that has not happened yet.
  const baseRef = baseMode === "named" ? namedBase.trim() : ""
  const canAdd = picked.length > 0 && (baseMode === "head" || baseRef !== "") && !loading

  const add = async () => {
    if (busyRef.current || !inspection || !canAdd) return
    busyRef.current = true
    setBusy(true)
    setError("")
    try {
      await api.addRepositories({
        task: inspection.task,
        project: inspection.project,
        tasksRoot: inspection.tasksRoot,
        repositories: picked,
        ...(baseRef === "" ? {} : { baseRef }),
      })
      onAdded()
      onClose()
    } catch (reason: any) {
      setError(String(reason?.message ?? reason))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const dismiss = () => { if (!busyRef.current) onClose() }
  const fieldsDisabled = busy || loading || inspection === null

  const picker = <fieldset className="dws-field dws-repositories-fieldset" disabled={fieldsDisabled} aria-describedby={picked.length === 0 ? `${id}-repositories-note` : undefined}>
    <legend className="dws-field-legend">
      <span id={`${id}-repositories`} className="dws-field-label">{t("addRepositoriesLabel")}</span>
      {/* The label says which repositories may be chosen; not where the list comes
          from, which is the question this answers. Hover only: the icon repeats
          nothing that is already on screen. */}
      <HoverHint label={t("addRepositoriesSourceHint")} className="dws-field-hint">
        <InformationCircle size={13} aria-hidden="true" />
      </HoverHint>
    </legend>
    <div className="dws-repo-picker">
      <div className="dws-repo-choices">
        {candidates.map((entry) => {
          const name = nameOf(entry.repoPath)
          return <label key={entry.repoPath} className="dws-check-option" htmlFor={`${id}-repo-${name}`}>
            <input id={`${id}-repo-${name}`} className="dws-checkbox" type="checkbox" checked={picked.includes(entry.repoPath)} onChange={(event) => toggle(entry.repoPath, event.target.checked)} />
            {/* The same name-then-branch line the repository view renders, so a
                repository reads the same wherever this plugin lists it. */}
            <span className="dws-check-copy">
              <span className="dws-check-name">
                <span className="dws-check-label">{name}</span>
                {entry.currentBranch === undefined ? null : <span className="dws-branch-label" title={`${t("currentBranchLabel")}: ${entry.currentBranch}`}><GitPullRequest size={12} /><span className="dws-branch-value">{entry.currentBranch}</span></span>}
              </span>
              <span className="dws-check-path" title={slashPath(entry.repoPath)}>{slashPath(entry.repoPath)}</span>
            </span>
          </label>
        })}
      </div>
      <div className="dws-repo-picker-foot">
        {picked.length === 0 ? <p id={`${id}-repositories-note`} className="dws-field-note">{t("addRepositoriesHint")}</p> : null}
        <div className="dws-repo-actions">
          <span className="dws-check-count" aria-live="polite">{format(t("repositoriesCountLabel"), { count: String(picked.length), total: String(candidates.length) })}</span>
          <span className="dws-picker-tools">
            <button type="button" className="dws-link-button" onClick={() => setAll(true)}>{t("selectAll")}</button>
            <span className="dws-picker-divider" aria-hidden="true" />
            <button type="button" className="dws-link-button" onClick={() => setAll(false)}>{t("selectNone")}</button>
          </span>
        </div>
      </div>
    </div>
  </fieldset>

  const base = <fieldset className="dws-field dws-base-fieldset" disabled={fieldsDisabled}>
    <legend className="dws-field-legend"><span className="dws-field-label">{t("basedOn")}</span></legend>
    <div className="dws-radio-group" role="radiogroup" aria-label={t("basedOn")}>
      {(["head", "named"] as const).map((mode) => <label key={mode} htmlFor={`${id}-${mode}`} className="dws-radio-option" data-selected={baseMode === mode ? "true" : undefined}>
        <input id={`${id}-${mode}`} className="dws-radio-input" type="radio" name={`${id}-base`} value={mode} checked={baseMode === mode} onChange={() => setBaseMode(mode)} />
        <span className="dws-radio-copy"><span className="dws-radio-label">{t(mode === "head" ? "baseHead" : "baseNamed")}</span></span>
      </label>)}
    </div>
    {baseMode === "named" ? <>
      <Input className="dws-base-ref" value={namedBase} disabled={fieldsDisabled} onChange={(event) => setNamedBase(event.target.value)} placeholder={t("baseRefPlaceholder")} autoComplete="off" spellCheck={false} aria-label={t("baseNamed")} aria-describedby={`${id}-base-note`} />
      <p id={`${id}-base-note`} className="dws-form-note">{t("baseRefHint")}</p>
    </> : null}
  </fieldset>

  return (
    <Dialog open onOpenChange={(open) => { if (!open) dismiss() }}>
      <DialogContent busy={busy} className="dws-create-dialog">
        <header className="dws-dialog-heading">
          <DialogTitle className="dws-dialog-title">{t("addRepositoriesTitle")}</DialogTitle>
          <DialogDescription className="dws-form-note">{t("addRepositoriesDescription")}</DialogDescription>
          <div className="dws-repo-context"><strong>{inspection?.task ?? ""}</strong><code title={slashPath(taskPath)}>{slashPath(taskPath)}</code></div>
        </header>

        <form className="dws-create-form" onSubmit={(event) => { event.preventDefault(); void add() }} aria-busy={busy}>
          <div className="dws-dialog-body">
            {error ? <div className="dws-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><span>{error}</span></div> : null}
            {loading ? <div className="dws-dialog-loading" role="status">
              <div><Loader2 size={16} className="dws-spin" aria-hidden="true" /> {t("loadingTask")}</div>
              <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
            </div> : <div className="dws-form-fields">
              {picker}
              {base}
            </div>}
          </div>

          <footer className="dws-dialog-footer">
            <Button type="button" className="dws-button-ghost" disabled={busy} onClick={dismiss}>{t("cancel")}</Button>
            <Button type="submit" className="dws-button-primary" disabled={busy || !canAdd}>
              {busy ? <Loader2 size={16} className="dws-spin" aria-hidden="true" /> : null}
              {busy ? t("addingRepositories") : t("addRepositoriesConfirm")}
            </Button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  )
}
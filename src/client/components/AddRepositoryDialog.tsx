import { useEffect, useId, useRef, useState } from "react"
import { AlertCircle, GitPullRequest, Loader2, Plus } from "./icons"
import { format, useT } from "../lib/i18n"
import { commonAncestor, isInsideDirectory, nameOf, slashPath } from "../lib/paths"
import { addRepositorySource } from "../lib/repositories"
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
 * The candidates are the repository view's list, which is the same list the task
 * was created from — a repository the user can see there is one they can put in
 * here, and nothing else is offered without being named. A path can also be typed
 * in, which registers it the same way the repository view does: as a Workspace, so
 * it joins that list rather than living only in this one dialog.
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
  const [manualPath, setManualPath] = useState("")
  const [manualError, setManualError] = useState("")
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

  // One picked repository with nothing above both of them means the session that
  // commits in the task space cannot reach that repository's `.git` without being
  // widened, and a path on another volume cannot be widened at all. Nothing about
  // the merge or the finish changes; this is what the user will be asked to
  // approve when a commit is handed to an agent, so it is said here rather than
  // then. Named the same way the finish names it, so the two agree.
  const unreachable = picked.filter((repoPath) => commonAncestor(taskPath, repoPath) === undefined)
  const baseRef = baseMode === "named" ? namedBase.trim() : ""
  const canAdd = picked.length > 0 && (baseMode === "head" || baseRef !== "") && !loading

  const addManual = async () => {
    const path = manualPath.trim()
    if (path === "" || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setManualError("")
    try {
      await addRepositorySource(api, workspaces, path)
      // The registration is what puts it in the list the picker draws from, and
      // that list arrives with the next scan rather than with this request — so
      // the path is offered here directly, and the scan will agree with it.
      setPicked((current) => (current.some((entry) => entry === path) ? current : [...current, path]))
      setManualPath("")
    } catch (reason: any) {
      setManualError(String(reason?.message ?? reason))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

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
    <legend className="dws-field-legend"><span id={`${id}-repositories`} className="dws-field-label">{t("addRepositoriesLabel")}</span></legend>
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
                {entry.currentBranch === undefined ? null : <span className="dws-branch-label" title={`${t("branch")}: ${entry.currentBranch}`}><GitPullRequest size={12} /><span className="dws-branch-value">{entry.currentBranch}</span></span>}
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
    {/* A repository the repository view does not know about is typed in here, and
        becomes one it does know about: this is the repository view's own entry
        point, so both lists are the list of Workspaces and cannot drift. */}
    <div className="dws-add-source">
      <label className="dws-field-label" htmlFor={`${id}-manual`}><span id={`${id}-manual-label`}>{t("addRepositoryManual")}</span><span className="dws-field-note">{t("addRepositoryManualHint")}</span></label>
      <div className="dws-add-source-row">
        <Input id={`${id}-manual`} aria-labelledby={`${id}-manual-label`} value={manualPath} disabled={fieldsDisabled} onChange={(event) => setManualPath(event.target.value)} placeholder={t("addRepositoryManualPlaceholder")} autoComplete="off" spellCheck={false} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addManual() } }} />
        <Button type="button" className="dws-button-ghost" disabled={fieldsDisabled || manualPath.trim() === ""} onClick={() => void addManual()}>{busy ? <Loader2 size={14} className="dws-spin" aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}{t("addRepositoryAdd")}</Button>
      </div>
      {manualError ? <p className="dws-field-note dws-field-note-warning" role="alert">{manualError}</p> : null}
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
              {/* Said here rather than at the finish, because it changes nothing
                  about what the finish will do and everything about what the
                  session that commits here will be allowed to touch. */}
              {unreachable.length > 0 ? <p className="dws-form-note dws-field-note-warning">{format(t("addRepositoriesIsolation"), { names: unreachable.map((entry) => nameOf(entry)).join(", ") })}</p> : null}
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
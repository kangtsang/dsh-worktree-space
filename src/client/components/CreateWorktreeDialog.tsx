import { useEffect, useId, useRef, useState } from "react"
import { AlertCircle, Loader2 } from "lucide-react"
import { createWorktreeApi } from "../lib/api"
import { format, useT } from "../lib/i18n"
import { slashPath, slugOf, taskDirectory } from "../lib/paths"
import type { TaskRootSuggestion, WorkspaceNavigation, WorkspacesService, Workspace } from "../lib/types"
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input } from "./ui"

type BaseMode = "head" | "named"

interface CreateWorktreeDialogProps {
  target: Pick<Workspace, "path" | "title">
  api: ReturnType<typeof createWorktreeApi>
  workspaces: WorkspacesService
  uiWorkspace: WorkspaceNavigation
  onCreated: (path: string) => void
  onClose: () => void
}

/**
 * Create a task space: one worktree per selected repository, all on one
 * branch, in a container outside the source tree.
 *
 * The dialog drives the same host operations the `task_worktree_space` tool uses, so
 * a single repository and a directory holding repositories take one path — the
 * one this plugin exists for.
 * @param props - the source root to create in, the services to reach, and the
 * created/closed callbacks.
 * @returns the dialog element.
 */
export function CreateWorktreeDialog({ target, api, workspaces, uiWorkspace, onCreated, onClose }: CreateWorktreeDialogProps) {
  const t = useT()
  const id = useId()
  const [suggestion, setSuggestion] = useState<TaskRootSuggestion | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [taskName, setTaskName] = useState("")
  const [tasksRoot, setTasksRoot] = useState("")
  const [selected, setSelected] = useState<string[]>([])
  const [baseMode, setBaseMode] = useState<BaseMode>("head")
  const [namedBase, setNamedBase] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  // Prevent duplicate mutations even before React commits the disabled state.
  const busyRef = useRef(false)
  const [recovery, setRecovery] = useState<{ task: string; tasksRoot: string; path: string; branch: string } | null>(null)

  useEffect(() => {
    setTaskName("")
    setBaseMode("head")
    setNamedBase("")
    setRecovery(null)
  }, [target.path])

  useEffect(() => {
    let alive = true
    setSuggestion(null)
    setLoading(true)
    setError("")
    api.suggestRoot(target.path).then((next) => {
      if (!alive) return
      setSuggestion(next)
      setTasksRoot(next.suggested)
      // Every discovered repository is in the task until the user narrows it.
      setSelected(next.repositories.map((repository) => repository.name))
    }).catch((reason) => {
      if (alive) setError(String(reason?.message ?? reason))
    }).finally(() => {
      if (alive) setLoading(false)
    })
    return () => { alive = false }
  }, [api, target.path, loadAttempt])

  const repositories = suggestion?.repositories ?? []
  const branchPrefix = suggestion?.branchPrefix ?? "feat/"
  // The host refuses separators and whitespace; this form additionally keeps the
  // name a valid Git ref, so the branch cannot fail later.
  const normalizedName = taskName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  const taskSlug = normalizedName ? slugOf(taskName) : ""
  const validSlug = /^[a-z0-9_][a-z0-9._-]*$/.test(taskSlug)
    && !taskSlug.includes("..") && !taskSlug.endsWith(".") && !taskSlug.endsWith(".lock")
  const taskBranch = validSlug ? `${branchPrefix}${taskSlug}` : ""
  const taskPath = taskSlug !== "" && tasksRoot.trim() !== "" ? taskDirectory(tasksRoot.trim(), taskSlug) : ""
  const invalidName = taskName.length > 0 && !validSlug
  // Which rule it broke, in the order the checks run.
  const nameProblem = !invalidName ? "" : taskSlug === "" ? "invalidNameEmpty" : taskSlug.startsWith(".") ? "invalidNameLeadingDot" : taskSlug.includes("..") ? "invalidNameConsecutiveDots" : taskSlug.endsWith(".lock") ? "invalidNameLockSuffix" : taskSlug.endsWith(".") ? "invalidNameTrailingDot" : "invalidNameGeneric"
  const sourceReady = suggestion !== null && repositories.length > 0
  const fieldsDisabled = busy || loading || !sourceReady || !!recovery
  const baseRef = baseMode === "named" ? namedBase.trim() : ""
  const canCreate = validSlug && selected.length > 0 && tasksRoot.trim() !== ""

  const startBusy = () => { busyRef.current = true; setBusy(true); setError("") }
  const endBusy = () => { busyRef.current = false; setBusy(false) }
  const dismiss = () => { if (!busyRef.current) onClose() }

  const registerAndOpen = async (createdPath: string, slug: string) => {
    const workspace = await workspaces.create({ path: createdPath })
    try {
      await workspaces.rename(workspace.workspaceId, `${target.title}/${slug}`)
      await uiWorkspace.openWorkspace(workspace.workspaceId)
      onCreated(createdPath)
      onClose()
    } catch (reason) {
      // A failed retry must not leave another partially registered Workspace.
      await workspaces.delete(workspace.workspaceId)
      throw reason
    }
  }

  const retryRegister = async () => {
    if (!recovery || busyRef.current) return
    startBusy()
    try { await registerAndOpen(recovery.path, recovery.task); setRecovery(null) }
    catch (reason: any) { setError(`${t("registerFailed")} ${String(reason?.message ?? reason)}`) }
    finally { endBusy() }
  }

  const cleanupCreated = async () => {
    if (!recovery || busyRef.current) return
    startBusy()
    try {
      // The task is freshly created, so finishing it removes its worktrees and
      // the container while keeping the branches.
      await api.doneTask({ task: recovery.task, tasksRoot: recovery.tasksRoot })
      setRecovery(null)
      onClose()
    } catch (reason: any) {
      setError(format(t("cleanupFailed"), { error: String(reason?.message ?? reason), path: recovery.path }))
    } finally { endBusy() }
  }

  const create = async () => {
    if (busyRef.current || recovery || loading || !sourceReady) return
    if (!validSlug) {
      setError(t(taskName.trim() !== "" && nameProblem !== "" ? nameProblem : "fillTaskName"))
      return
    }
    if (selected.length === 0) {
      setError(t("repositoriesHint"))
      return
    }
    startBusy()
    let created: { path: string; task: string } | undefined
    let workspace: Workspace | undefined
    // Which step failed decides what the user is offered: only a registration the
    // plugin made itself is worth undoing or retrying as one unit.
    let phase: "create" | "register" | "rename" | "open" = "create"
    try {
      const result = await api.createTask({
        sourceRoot: target.path,
        task: taskSlug,
        tasksRoot: tasksRoot.trim(),
        repos: selected,
        baseRef: baseRef === "" ? undefined : baseRef,
      })
      created = { path: result.path, task: result.task }
      phase = "register"
      workspace = await workspaces.create({ path: result.path })
      phase = "rename"
      await workspaces.rename(workspace.workspaceId, `${target.title}/${result.task}`)
      phase = "open"
      await uiWorkspace.openWorkspace(workspace.workspaceId)
      onCreated(result.path)
      onClose()
    } catch (reason: any) {
      const detail = String(reason?.message ?? reason)
      if (phase === "open") {
        // The task and its registration are fine; only showing the Session failed.
        if (created) onCreated(created.path)
        setError(`${t("openFailed")}${detail}`)
        return
      }
      if (workspace?.workspaceId) {
        try {
          await workspaces.delete(workspace.workspaceId)
        } catch (cleanupError: any) {
          if (created) setRecovery({ ...created, tasksRoot: tasksRoot.trim(), branch: taskBranch })
          setError(format(t("cleanupFailed"), { error: String(cleanupError?.message ?? cleanupError), path: created?.path ?? "" }))
          return
        }
      }
      if (created) {
        setRecovery({ ...created, tasksRoot: tasksRoot.trim(), branch: taskBranch })
        setError(`${t("registerFailed")} ${detail}`)
      } else {
        setError(`${t("operationFailed")}${detail}`)
      }
    } finally {
      endBusy()
    }
  }

  const toggleRepository = (name: string, include: boolean) => {
    setSelected((current) => (include
      ? [...new Set([...current, name])]
      : current.filter((entry) => entry !== name)))
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) dismiss() }}>
      <DialogContent busy={busy} className="dws-create-dialog">
        <header className="dws-dialog-heading">
          <DialogTitle className="dws-dialog-title">{t("dialogTitle")}</DialogTitle>
          <DialogDescription className="dws-form-note">{t("createDescription")}</DialogDescription>
          <div className="dws-repo-context"><strong>{target.title}</strong><code title={slashPath(target.path)}>{slashPath(target.path)}</code></div>
        </header>

        <form className="dws-create-form" onSubmit={(event) => { event.preventDefault(); void create() }} aria-busy={busy}>
          <div className="dws-dialog-body">
            {error ? <div className="dws-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><span>{error}</span></div> : null}
            {loading ? <div className="dws-dialog-loading" role="status">
              <div><Loader2 size={16} className="dws-spin" aria-hidden="true" /> {t("loadingSourceRoot")}</div>
              <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
            </div> : !sourceReady ? <div className="dws-empty">
              <p>{t("notSourceRoot")}</p>
              <Button type="button" className="dws-button-ghost" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>{t("retry")}</Button>
            </div> : <>
              <div className="dws-field">
                <div className="dws-field-heading">
                  <label className="dws-field-label" htmlFor={`${id}-name`}>{t("taskName")}</label>
                  <p id={`${id}-name-note`} className={invalidName ? "dws-field-note dws-field-note-warning" : "dws-field-note"}>{invalidName ? t(nameProblem) : t("taskNameHint")}</p>
                </div>
                <Input id={`${id}-name`} value={taskName} disabled={fieldsDisabled} onChange={(event) => setTaskName(event.target.value)} placeholder={t("taskNamePlaceholder")} autoFocus autoComplete="off" spellCheck={false} aria-invalid={invalidName || undefined} aria-describedby={`${id}-name-note`} />
              </div>

              <div className="dws-field">
                <div className="dws-field-heading">
                  <label className="dws-field-label" htmlFor={`${id}-container`}>{t("containerLocation")}</label>
                  <p id={`${id}-container-note`} className="dws-field-note">{t("containerHint")}</p>
                </div>
                <Input id={`${id}-container`} value={tasksRoot} disabled={fieldsDisabled} onChange={(event) => setTasksRoot(event.target.value)} autoComplete="off" spellCheck={false} aria-describedby={`${id}-container-note`} />
              </div>

              <fieldset className="dws-field dws-repositories-fieldset" disabled={fieldsDisabled} aria-labelledby={`${id}-repositories`} aria-describedby={selected.length === 0 ? `${id}-repositories-note` : undefined}>
                {/* The count belongs beside the group's name; the legend carries
                    only the name so it stays the group's accessible label. */}
                <legend className="dws-field-legend">
                  <span id={`${id}-repositories`} className="dws-field-label">{format(t("repositoriesCountLabel"), { count: String(selected.length), total: String(repositories.length) })}</span>
                  {selected.length === 0 ? <span id={`${id}-repositories-note`} className="dws-field-note">{t("repositoriesHint")}</span> : null}
                </legend>
                <div className="dws-repo-choices">
                  {repositories.map((repository) => <label key={repository.name} className="dws-check-option" htmlFor={`${id}-repo-${repository.name}`}>
                    <input id={`${id}-repo-${repository.name}`} className="dws-checkbox" type="checkbox" checked={selected.includes(repository.name)} onChange={(event) => toggleRepository(repository.name, event.target.checked)} />
                    <span className="dws-check-copy"><span className="dws-check-label">{repository.name}</span><span className="dws-check-path" title={slashPath(repository.path)}>{slashPath(repository.path)}</span></span>
                  </label>)}
                </div>
              </fieldset>

              <fieldset className="dws-field dws-base-fieldset" disabled={fieldsDisabled}>
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

              <dl className="dws-preview" aria-live="polite" aria-atomic="true">
                <div className="dws-preview-row"><dt className="dws-preview-label">{t("branch")}</dt><dd className="dws-preview-value">{recovery?.branch ?? (taskBranch || "—")}</dd></div>
                <div className="dws-preview-row"><dt className="dws-preview-label">{t("taskDirectoryLabel")}</dt><dd className="dws-preview-value">{slashPath(recovery?.path ?? taskPath) || "—"}</dd></div>
              </dl>
            </>}
          </div>

          <footer className="dws-dialog-footer">
            {recovery ? <>
              <Button type="button" className="dws-button-danger" disabled={busy} onClick={() => void cleanupCreated()}>{t("cleanupTask")}</Button>
              <Button type="button" className="dws-button-primary" disabled={busy} onClick={() => void retryRegister()}>{busy ? <Loader2 size={16} className="dws-spin" aria-hidden="true" /> : null}{t("retryRegister")}</Button>
            </> : <>
              <Button type="button" className="dws-button-ghost" disabled={busy} onClick={dismiss}>{t("cancel")}</Button>
              <Button type="submit" className="dws-button-primary" disabled={busy || loading || !canCreate}>
                {busy ? <Loader2 size={16} className="dws-spin" aria-hidden="true" /> : null}
                {busy ? t("creating") : t("createAndOpen")}
              </Button>
            </>}
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  )
}

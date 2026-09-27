import { useCallback, useEffect, useRef, useState } from "react"
import { AlertCircle, Check, GitPullRequestArrow, Loader2 } from "lucide-react"
import { createWorktreeApi } from "../lib/api"
import { format, useT } from "../lib/i18n"
import { documentsDirectoryFor } from "../lib/documents"
import { cleanPath, nameOf, parentOf } from "../lib/paths"
import type { FinishTaskResult, TaskPlan, TaskPlanRepository, WorkspacesService } from "../lib/types"
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client"
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Select } from "./ui"

interface ArchiveTaskDialogProps {
  /** Absolute path of the task container to archive. Either entry point knows it. */
  path: string
  api: ReturnType<typeof createWorktreeApi>
  workspaces: WorkspacesService
  sessions: ISessions
  /** Called once the task is archived, so the opener can refresh what it shows. */
  onArchived?: () => void
  onClose: () => void
}

/**
 * Archive one task: merge what the user chose, remove its worktrees, and clean up
 * after itself.
 *
 * The dialog resolves the task itself, from the path alone, because it is opened
 * from two places that know nothing about each other — the settings page, which
 * already has the task in hand, and the workspace list, which has only the
 * registered directory. It also re-reads the worktrees' state rather than
 * trusting the opener, since it is about to remove them.
 *
 * Archiving deletes the container, which is the directory DSH registered as a
 * Workspace and the working directory of the sessions opened inside it. The
 * registration is therefore removed too, which is what lets those sessions fall
 * back to Ungrouped with their history intact; and a session still running here
 * stops the archive instead of having its directory pulled out from under it.
 */
export function ArchiveTaskDialog({ path, api, workspaces, sessions, onArchived, onClose }: ArchiveTaskDialogProps) {
  const t = useT()
  // Looked up before the state below so the documents folder can be named after
  // the registered Workspace, which reads as `kratos-admin/testb`.
  const workspace = workspaces.list.getSnapshot().items.find((item) => cleanPath(item.path) === cleanPath(path))
  const [plan, setPlan] = useState<TaskPlan | null>(null)
  const [loadError, setLoadError] = useState("")
  // Merging is what a task is for, so it is on; deleting the branch and forcing
  // past uncommitted work are not, and are left for the user to ask for.
  const [options, setOptions] = useState({ merge: true, deleteBranch: false, force: false, archiveDocuments: true })
  // Named once, and used both for the preview and for the call, so what the user
  // reads is the folder they get.
  const [documentsDirectory] = useState(() => documentsDirectoryFor(path, workspace?.title, new Date()))
  const [error, setError] = useState("")
  const [result, setResult] = useState<FinishTaskResult | null>(null)
  const [registrationError, setRegistrationError] = useState("")
  const [busy, setBusy] = useState(false)
  // The branch chosen per repository, once it differs from the default. Held here
  // rather than read back from the plan, so a choice keeps showing while the
  // preview of it — its commit count, its warnings — is still being fetched.
  const [targets, setTargets] = useState<Record<string, string>>({})
  const planGeneration = useRef(0)
  /** One read answers everything this dialog shows: each repository's branch, what
   * it would merge into, how many commits that is, and how much is uncommitted —
   * none of it trusted from the opener, since this dialog removes those worktrees. */
  const loadPlan = useCallback(async (chosen?: Record<string, string>) => {
    // Answering a request the user has already replaced would put a stale preview
    // back on screen, so only the newest call is allowed to land.
    const generation = ++planGeneration.current
    try {
      const planned = await api.planTask({
        task: nameOf(path),
        tasksRoot: parentOf(path),
        ...(chosen === undefined || Object.keys(chosen).length === 0 ? {} : { targets: chosen }),
      })
      if (generation !== planGeneration.current) return
      setPlan(planned)
      setLoadError("")
    } catch (reason: any) {
      if (generation !== planGeneration.current) return
      setLoadError(String(reason?.message ?? reason))
    }
  }, [api, path])

  useEffect(() => {
    setPlan(null); setLoadError(""); setTargets({})
    void loadPlan()
    return () => { planGeneration.current += 1 }
  }, [loadPlan])

  /** Preview this repository merging into the branch just chosen. */
  const chooseTarget = (name: string, branch: string) => {
    const next = { ...targets, [name]: branch }
    setTargets(next)
    void loadPlan(next)
  }

  const running = (workspace?.sessionIds ?? []).some((sessionId) => sessions.list.getSnapshot().byId[sessionId]?.running === true)
  /** Strays carrying writing, which the warning names one by one. */
  const documentStrays = (plan?.strays ?? []).filter((stray) => stray.documents > 0)
  // Build output and editor state are expected in a working directory; anything
  // else in there is the user's own, and cleaning would delete it.
  const contentStrays = (plan?.strays ?? []).filter((stray) => stray.kind === "content")
  const noiseStrays = (plan?.strays ?? []).filter((stray) => stray.kind !== "content")
  const strayName = (stray: { name: string; directory: boolean }) => stray.directory ? `${stray.name}/` : stray.name
  /**
   * The branches offered for a repository.
   *
   * The resolved target leads, even when the Host's own list left it out — a select
   * whose value is missing from its options renders blank and would silently drop
   * the branch the merge is actually going to use.
   */
  const candidates = (entry: TaskPlanRepository) => entry.target !== undefined && !entry.branches.includes(entry.target)
    ? [entry.target, ...entry.branches]
    : entry.branches

  const close = () => { if (!busy) onClose() }
  const archive = async () => {
    if (plan === null || busy || running) return
    setBusy(true); setError(""); setRegistrationError("")
    try {
      const archived = await api.doneTask({
        task: plan.task,
        tasksRoot: plan.tasksRoot,
        merge: options.merge,
        // The branch each repository was pointed at, when the user picked one; a
        // repository left alone is the Host's own default to resolve.
        ...(options.merge && Object.keys(targets).length > 0 ? { targets } : {}),
        // Deleting a branch only means something once it was merged, and the host
        // refuses the pair the other way round.
        deleteBranch: options.merge && options.deleteBranch,
        force: options.force,
        // The container is cleared either way: archiving finishes a task, and a
        // task that is finished leaves nothing of its own behind. What is left to
        // decide is whether the user's writing is kept, and where.
        cleanStray: true,
        // The container's own content always leaves it: filed out of the way when
        // the box is ticked (its default), discarded when it is not. Sent only
        // when there is content, so the common case carries no extra arguments.
        ...(contentStrays.length === 0 ? {} : options.archiveDocuments
          ? { documentsDirectory }
          : { discardDocuments: true }),
      })
      // The directory is gone, so a registration pointing at it would be a row
      // with nothing behind it, and its sessions could never be validated again.
      if (workspace !== undefined) {
        try {
          await workspaces.delete(workspace.workspaceId)
        } catch (reason: any) {
          setRegistrationError(String(reason?.message ?? reason))
        }
      }
      setResult(archived)
      onArchived?.()
    } catch (reason: any) {
      setError(`${t("operationError")}${String(reason?.message ?? reason)}`)
    } finally {
      setBusy(false)
    }
  }

  const optionsDisabled = busy || plan === null || running

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent busy={busy} className="dws-confirm-dialog dws-finish-dialog">
        <div className="dws-dialog-heading">
          <DialogTitle className="dws-dialog-title">{format(t("finishTitle"), { task: plan?.task ?? "" })}</DialogTitle>
          <DialogDescription className="dws-form-note">{t("finishDescription")}</DialogDescription>
        </div>
        <div className="dws-dialog-body">
          {/* What there is to archive, before anything is chosen. */}
          {plan !== null && result === null ? <p className="dws-dialog-status" role="status">
            <span>{plan.changedFiles > 0 ? format(t("dirty"), { count: String(plan.changedFiles) }) : t("clean")}</span>
            <span aria-hidden="true">·</span>
            <span>{format(t("planCommits"), { count: String(plan.commits) })}</span>
          </p> : null}
          <div className="dws-remove-target"><GitPullRequestArrow size={18} /><div><strong>{plan?.mergeTarget ?? plan?.task ?? ""}</strong><code>{path}</code></div></div>
          {/* Each repository's branch, the branch it would merge into, and how far
              ahead it is — the per-repository detail behind the totals above. The
              target is choosable where the Host offered branches to choose from. */}
          {plan !== null && plan.repositories.length > 0 ? <ul className="dws-finish-repos dws-plan">
            {plan.repositories.map((entry) => <li key={entry.path}>
              <strong>{entry.name}</strong>
              <span>{entry.branch ?? "—"}</span>
              {candidates(entry).length === 0
                ? <span>{entry.target === undefined ? "" : `→ ${entry.target}`}</span>
                : <>
                  <span aria-hidden="true">→</span>
                  <Select
                    className="dws-plan-target"
                    aria-label={`${t("planTargetLabel")} · ${entry.name}`}
                    // Read-only once the task is finished: the plan stays on screen
                    // as the record of what was done, but nothing here still points
                    // at a task space that no longer exists.
                    disabled={optionsDisabled || result !== null}
                    value={targets[entry.name] ?? entry.target ?? ""}
                    onChange={(event) => chooseTarget(entry.name, event.target.value)}
                  >
                    {candidates(entry).map((branch) => <option key={branch} value={branch}>{branch}</option>)}
                  </Select>
                </>}
              <span>{format(t("planCommits"), { count: String(entry.commits) })}</span>
              <span>{entry.changedFiles > 0 ? format(t("dirty"), { count: String(entry.changedFiles) }) : t("clean")}</span>
              {/* Saying it before the merge, not after: a target the source
                  repository is not on is merged in a checkout of its own. */}
              {entry.target !== undefined && entry.target !== entry.checkedOut
                ? <span className="dws-plan-detour">{t("planTemporaryWorktree")}</span>
                : null}
              {entry.error ? <span className="dws-finish-error">{entry.error}</span> : null}
            </li>)}
          </ul> : null}
          {/* What "clean other content" would remove, listed before the choice
              rather than reported after it. Build output and editor state are
              named in one line; everything else is the user's and is listed. */}
          {plan !== null && result === null ? <div className="dws-plan-strays">
            <p className="dws-plan-strays-head">
              <span>{t("planStrays")}</span>
              {contentStrays.length > 0 ? <span>{format(t("planCount"), { count: String(contentStrays.length) })}</span> : null}
            </p>
            {contentStrays.length === 0
              ? <p className="dws-plan-strays-none">{t("planStraysNone")}</p>
              : <ul>{contentStrays.map((stray) => <li key={stray.name}>
                <code title={stray.name}>{strayName(stray)}</code>
                {stray.documents > 0 ? <span className="dws-plan-doc">{format(t("planDocuments"), { count: String(stray.documents) })}</span> : null}
              </li>)}</ul>}
            {noiseStrays.length > 0 ? <p className="dws-plan-noise">{format(t("planNoise"), {
              count: String(noiseStrays.length),
              names: noiseStrays.map(strayName).join("、"),
            })}</p> : null}
            <p className="dws-plan-breadcrumb">{t("planBreadcrumb")}</p>
          </div> : null}
          {loadError ? <div className="dws-error" role="alert"><AlertCircle size={16} /><span>{loadError}</span></div> : null}
          {result ? <div className="dws-finish-report" role="status">
            <p>{result.failed ? t("finishPartial") : result.repositories.some((entry) => entry.merged) ? t("finishDone") : t("finishDoneKept")}</p>
            <ul className="dws-finish-repos">{result.repositories.map((entry) => <li key={entry.path}>
              <strong>{entry.name}</strong>
              <span>{[entry.merged ? format(t("finishMerged"), { target: entry.target ?? "" }) : null, entry.removed ? t("finishRemoved") : null, entry.branchDeleted ? t("finishBranchDeleted") : null].filter(Boolean).join(" · ") || t("finishUntouched")}</span>
              {entry.error ? <span className="dws-finish-error">{entry.error}</span> : null}
            </li>)}</ul>
            <p>{result.containerRemoved ? t("finishContainerRemoved") : format(t("finishContainerKept"), { path: result.path })}</p>
            {result.archivedStrays.length ? <p>{format(t("finishArchived"), { path: documentsDirectory, names: result.archivedStrays.join(", ") })}</p> : null}
            {result.strays.length ? <p>{format(t("finishStrays"), { names: result.strays.join(", ") })}</p> : null}
            {result.warnings.map((warning) => <p className="dws-finish-error" key={warning}>{warning}</p>)}
            {workspace !== undefined
              ? <p className={registrationError === "" ? undefined : "dws-finish-error"}>
                {registrationError === "" ? t("archiveWorkspaceRemoved") : format(t("archiveWorkspaceKept"), { error: registrationError })}
              </p>
              : null}
          </div> : null}
          {result === null && plan === null && loadError === "" ? <div className="dws-dialog-loading" role="status">
            <div><Loader2 size={16} className="dws-spin" aria-hidden="true" /> {t("loadingRepository")}</div>
            <span aria-hidden="true" />
          </div> : null}
          {result === null && plan !== null ? <>
            <p className="dws-notice" role="status"><AlertCircle size={15} aria-hidden="true" /><span>{t("archiveConsequence")}</span></p>
            <label className="dws-check-option"><input type="checkbox" className="dws-checkbox" disabled={optionsDisabled} checked={options.merge} onChange={(event) => setOptions((current) => ({ ...current, merge: event.target.checked, deleteBranch: event.target.checked ? current.deleteBranch : false }))} /><span className="dws-check-copy"><span className="dws-check-label">{t("finishMerge")}</span><span className="dws-check-path">{t("finishMergeHint")}</span></span></label>
            <label className="dws-check-option"><input type="checkbox" className="dws-checkbox" disabled={optionsDisabled || !options.merge} checked={options.merge && options.deleteBranch} onChange={(event) => setOptions((current) => ({ ...current, deleteBranch: event.target.checked }))} /><span className="dws-check-copy"><span className="dws-check-label">{t("finishDeleteBranch")}</span><span className="dws-check-path">{t("finishDeleteBranchHint")}</span></span></label>
            <label className="dws-check-option"><input type="checkbox" className="dws-checkbox" disabled={optionsDisabled} checked={options.force} onChange={(event) => setOptions((current) => ({ ...current, force: event.target.checked }))} /><span className="dws-check-copy"><span className="dws-check-label">{t("finishForce")}</span><span className="dws-check-path">{t("finishForceHint")}</span></span></label>
            {/* The one choice about the container's own files: keep the writing,
                or let everything in there go. Only offered when there is writing
                to keep — otherwise there is nothing to decide. */}
            {contentStrays.length > 0 ? <><label className="dws-check-option"><input type="checkbox" className="dws-checkbox" disabled={optionsDisabled} checked={options.archiveDocuments} onChange={(event) => setOptions((current) => ({ ...current, archiveDocuments: event.target.checked }))} /><span className="dws-check-copy"><span className="dws-check-label">{t("archiveDocuments")}</span><span className="dws-check-path">{format(t("archiveDocumentsHint"), { path: documentsDirectory })}</span></span></label>
              {/* Only unticking loses anything, so only unticking warns: ticked,
                  the content is merely filed out of the way. */}
              {!options.archiveDocuments ? <p className="dws-notice dws-notice-danger" role="alert">
                <AlertCircle size={15} aria-hidden="true" />
                <span>{format(t("archiveDocumentsWarning"), {
                  names: contentStrays.map(strayName).join("、"),
                  count: String(documentStrays.reduce((total, stray) => total + stray.documents, 0)),
                })}</span>
              </p> : null}</> : null}
            {plan.changedFiles > 0 && !options.force ? <p className="dws-notice" role="status"><AlertCircle size={15} aria-hidden="true" /><span>{format(t("finishDirtyNotice"), { count: String(plan.changedFiles) })}</span></p> : null}
            {options.force ? <p className="dws-notice dws-notice-danger" role="alert"><AlertCircle size={15} aria-hidden="true" /><span>{t("finishForceWarning")}</span></p> : null}
            {running ? <div className="dws-error" role="alert"><AlertCircle size={16} /><span>{t("archiveRunning")}</span></div> : null}
            {error ? <div className="dws-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div> : null}
          </> : null}
        </div>
        <div className="dws-dialog-footer">
          {result
            ? <Button onClick={close}>{t("close")}</Button>
            : <><Button className="dws-button-ghost" disabled={busy} onClick={close}>{t("cancel")}</Button><Button className="dws-button-danger-solid" disabled={optionsDisabled} onClick={() => void archive()}>{busy ? <Loader2 size={14} className="dws-spin" /> : <Check size={14} />}{busy ? t("finishing") : t("finishConfirmAction")}</Button></>}
        </div>
      </DialogContent>
    </Dialog>
  )
}

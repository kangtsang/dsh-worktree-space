import { useCallback, useEffect, useRef, useState } from "react"
import { AlertCircle, Check, Loader2 } from "./icons"
import { createWorktreeApi } from "../lib/api"
import { format, useT } from "../lib/i18n"
import { documentsDirectoryFor } from "../lib/documents"
import { cleanPath, commonAncestor, nameOf, parentOf, slashPath } from "../lib/paths"
import { clearFinishScene, readFinishScene, saveFinishScene, type FinishSceneSession } from "../lib/finishScene"
import type { FinishTaskRepository, FinishTaskResult, TaskPlan, TaskPlanRepository, WorkspaceNavigation, WorkspacesService, WorktreeList } from "../lib/types"
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client"
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Select } from "./ui"

interface ArchiveTaskDialogProps {
  /** Absolute path of the task container to archive. Either entry point knows it. */
  path: string
  api: ReturnType<typeof createWorktreeApi>
  workspaces: WorkspacesService
  sessions: ISessions
  /** The navigation face, which is how the user reaches a session this dialog opened. */
  uiWorkspace: WorkspaceNavigation
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
export function ArchiveTaskDialog({ path, api, workspaces, sessions, uiWorkspace, onArchived, onClose }: ArchiveTaskDialogProps) {
  const t = useT()
  // Looked up before the state below so the documents folder can be named after
  // the registered Workspace, which reads as `kratos-admin/testb`.
  const workspace = workspaces.list.getSnapshot().items.find((item) => cleanPath(item.path) === cleanPath(path))
  const [plan, setPlan] = useState<TaskPlan | null>(null)
  const [loadError, setLoadError] = useState("")
  // Merging is what a task is for, so it is on; deleting the branch and forcing
  // past uncommitted work are not, and are left for the user to ask for. Deleting a
  // branch that was never merged is how a task space is abandoned instead of
  // finished, and that costs the work on it — which is why it takes Force as well.
  const [options, setOptions] = useState({ merge: true, deleteBranch: false, force: false, archiveDocuments: true })
  // Named once, and used both for the preview and for the call, so what the user
  // reads is the folder they get.
  const [documentsDirectory, setDocumentsDirectory] = useState(() => documentsDirectoryFor(path, workspace?.title, new Date()))
  const [error, setError] = useState("")
  // A report the dialog left behind when it was unmounted is put straight back: the
  // user is returning from the session it handed on, not opening a fresh finish.
  const [result, setResult] = useState<FinishTaskResult | null>(() => readFinishScene(path)?.result ?? null)
  const [registrationError, setRegistrationError] = useState("")
  const [busy, setBusy] = useState(false)
  // The branch chosen per repository, once it differs from the default. Held here
  // rather than read back from the plan, so a choice keeps showing while the
  // preview of it — its commit count, its warnings — is still being fetched.
  const [targets, setTargets] = useState<Record<string, string>>({})
  // The sessions the conflict handoff opened, one per conflicting repository, and
  // whatever stopped one from being opened at all. Kept here rather than derived
  // from the report, because the sessions outlive the request that made them.
  const [handoff, setHandoff] = useState<FinishSceneSession[]>(() => readFinishScene(path)?.handoff ?? [])
  const [authorizing, setAuthorizing] = useState(false)
  const [handoffError, setHandoffError] = useState("")
  // The sessions run outside this dialog, so the rows reporting on them have to
  // follow the Host's list rather than a value read once. The counter is the render.
  const [, setSessionTick] = useState(0)
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

  /**
   * Hold the report so it survives this dialog being unmounted.
   *
   * Opening a handed-off session takes over the view the dialog was drawn in, and the
   * user has to come back to it to continue finishing: without this the panel they
   * return to is empty, and the sessions it opened are forgotten rather than reported.
   * Only an unfinished finish is held. One that went through has nothing left to offer,
   * and a later visit to the page has to open on the task, not on its last report.
   */
  useEffect(() => {
    if (result === null) return
    if (result.failed) saveFinishScene(path, { result, handoff })
    else clearFinishScene(path)
  }, [path, result, handoff])

  /**
   * The configured destination, once the Host answers with it.
   *
   * Read rather than assumed, and it arrives after the first paint: the computed
   * folder is on screen until then, so the row never shows an empty path while it
   * waits. A Host that answers nothing leaves the computed folder in place — which
   * is exactly what an empty setting means.
   */
  useEffect(() => {
    let live = true
    void api.preferences().then((served) => {
      if (!live) return
      const configured = typeof served?.archiveDocumentsDirectory === "string" ? served.archiveDocumentsDirectory : ""
      if (configured.trim() === "") return
      setDocumentsDirectory(documentsDirectoryFor(path, workspace?.title, new Date(), configured))
    }).catch(() => { /* falls back to the computed folder */ })
    return () => { live = false }
  }, [api, path, workspace?.title])

  /**
   * Follow the sessions the handoff opened, so "working" turns into "stopped" on
   * its own: an agent that is still resolving a conflict must not read as done.
   */
  useEffect(() => sessions.list.subscribe(() => setSessionTick((tick) => tick + 1)), [sessions])

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
  /**
   * The repositories whose merge is standing unresolved, which is what the report
   * offers to hand on. Read from the answer rather than the plan: a conflict does not
   * exist until the merge has been tried.
   */
  const conflicts = (result?.repositories ?? []).filter((entry) => entry.mergeInProgress === true)
  /**
   * The sessions this dialog opened that are still working. They own the next step:
   * the merge has to be committed before finishing can read it, so the finish waits
   * for them rather than racing them - and only the Host's own list can say when they
   * stopped.
   */
  const sessionRunning = (sessionId: FinishSceneSession["sessionId"]) => sessions.list.getSnapshot().byId[sessionId]?.running === true
  const working = handoff.filter((opened) => sessionRunning(opened.sessionId))
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
  /**
   * Whether confirming would throw work away, which is what the button's colour is
   * for. Finishing a task is routine - it merges, keeps the branches unless asked,
   * and the merge itself can be reverted - so the button warns rather than shouts.
   * It turns red only when something concrete is about to be lost, and this dialog
   * can name it: uncommitted files that Force will discard, or a branch whose
   * commits it will force-delete without merging them anywhere.
   */
  const discardsWork = (plan?.changedFiles ?? 0) > 0 && options.force
    || (plan?.commits ?? 0) > 0 && options.deleteBranch && !options.merge
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
        // A merged branch is deleted as asked; an unmerged one only when the user
        // also forced it, which is how a task space is abandoned. The Host refuses
        // the pair the other way round.
        deleteBranch: options.deleteBranch && (options.merge || options.force),
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
      // A registration is dropped only once the directory behind it is really gone:
      // a finish that failed keeps the container - with the worktree whose conflict
      // still has to be resolved - and unregistering it then would hide the task
      // space and scatter its sessions into "Ungrouped" while it sits there on disk.
      if (workspace !== undefined && archived.containerRemoved) {
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

  /**
   * What one conflicting repository's agent is asked to do.
   *
   * Everything it needs to act is in the message: which repository, which way the
   * merge runs, where the conflict is standing, and which files could not be
   * reconciled — plus the one thing this plugin will not do for it, which is choose
   * between the two sides. It is told not to push, because finishing is still this
   * plugin's job: the branch has to be merged into its target and the worktrees
   * removed afterwards.
   *
   * It also names the session's own working directory, because that is its write
   * boundary: an agent that takes the worktree for its working directory would go
   * looking for the merge in the wrong tree.
   */
  const promptFor = (entry: FinishTaskRepository, site: string, boundary: string) => format(t("finishHandoffPrompt"), {
    task: plan?.task ?? "",
    name: entry.name,
    branch: entry.branch ?? "",
    target: entry.target ?? "",
    site: slashPath(site),
    boundary: slashPath(boundary),
    // Only a boundary that reaches wider than the worktree can promise that the
    // repository's git metadata is writable. When it is the worktree itself, saying
    // so would be a claim the sandbox is about to contradict.
    scope: slashPath(boundary) === slashPath(site) ? t("finishHandoffScopeTight") : t("finishHandoffScopeWide"),
    files: (entry.conflictedFiles ?? []).join(", "),
  })

  /**
   * Hand the conflicts on: one session per conflicting repository, opened on a
   * working directory that reaches both the worktree and the repository's git
   * metadata, each told to resolve the conflict and commit.
   *
   * The dialog stays the one that decides, either way. A session that fails, or is
   * stopped, leaves the conflict exactly where it was; and nothing here waits on the
   * sessions, because this plugin cannot know whether what an agent did is what the
   * user wanted. So the report says which sessions were opened and whether they are
   * still working, and asking for the finish again is the user's move - that call
   * reads the merge they committed and completes the rest.
   */
  const authorize = async () => {
    if (conflicts.length === 0 || authorizing) return
    setAuthorizing(true); setHandoffError("")
    const opened: FinishSceneSession[] = []
    const failures: string[] = []
    // The Host names each repository by the worktree the task lives in, and a session's
    // working directory is its write boundary - so the boundary has to reach the
    // repository behind that worktree, whose `.git` is what a commit writes. The Host
    // reports that repository with the conflict. Only a Host that reported none is worth
    // a scan of every registered Workspace, which walks real directory trees and can hit
    // its own budget; with neither answer, the worktree is handed on and costs an approval.
    let scanned: WorktreeList[] = []
    if (conflicts.some((entry) => entry.mainRepo === undefined || entry.mainRepo === "")) {
      const roots = [...new Set([...workspaces.list.getSnapshot().items.map((item) => cleanPath(item.path)), cleanPath(path)])]
      try {
        const remembered = await api.cachedScan(roots)
        scanned = remembered === null ? await api.scan(roots) : remembered.repositories
      } catch { scanned = [] }
    }
    for (const entry of conflicts) {
      const site = entry.mergeSite === undefined || entry.mergeSite === "" ? entry.path : entry.mergeSite
      // A linked worktree keeps its git metadata in the main repository, so the site
      // alone cannot commit the merge it resolved: the common ancestor of the two is the
      // narrowest directory that reaches both. The Host's own answer comes first; the
      // scan is the fallback, and reads both spellings of a Windows path because the Host
      // joins with backslashes while git prints forward slashes. Where they share only a
      // volume root - or where the worktree already reaches the repository - the worktree
      // itself is all there is to open on, passed on exactly as the Host named it.
      const repository = scanned.find((list) => list.worktrees.some((row) => slashPath(row.path).toLowerCase() === slashPath(site).toLowerCase()))
      const fromScan = repository === undefined ? "" : repository.commonDir === "" ? repository.repoPath : repository.commonDir
      const metadata = entry.mainRepo || fromScan || entry.path
      const ancestor = commonAncestor(site, metadata)
      const boundary = ancestor === undefined || slashPath(site).toLowerCase() === ancestor.toLowerCase() ? site : ancestor
      try {
        const sessionId = await sessions.create({ cwd: boundary })
        // A session opens blank, so this is its first turn rather than a steer, and
        // the reference is a handle for the length of the call - not something to
        // keep: the session is followed through the Host's own list instead.
        await sessions.using(sessionId, { source: "controllerOperation" }, async (reference) => {
          await reference.binding.session.prompt([{ type: "text", text: promptFor(entry, site, boundary) }], "queue")
        })
        opened.push({ name: entry.name, site, boundary, sessionId })
      } catch (reason: any) {
        failures.push(`${entry.name}: ${String(reason?.message ?? reason)}`)
      }
    }
    // Named once each: asking twice for the same repository replaces its session
    // rather than opening a second one for a conflict that is already spoken for.
    setHandoff((current) => [...current.filter((previous) => !opened.some((one) => one.name === previous.name)), ...opened])
    if (failures.length > 0) setHandoffError(failures.join("; "))
    setAuthorizing(false)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent busy={busy} className="dws-confirm-dialog dws-finish-dialog">
        <div className="dws-dialog-heading">
          <DialogTitle className="dws-dialog-title">{format(t("finishTitle"), { task: plan?.task ?? "" })}</DialogTitle>
          <DialogDescription className="dws-form-note">{t("finishDescription")}</DialogDescription>
        </div>
        <div className="dws-dialog-body">
          {/* What there is to archive, before anything is chosen. The branch each
              repository merges into is per repository and named on its own row, so it
              is not summarised here: one line would have to pick one of them. */}
          {plan !== null && result === null ? <p className="dws-dialog-status" role="status">
            <span>{plan.changedFiles > 0 ? format(t("dirty"), { count: String(plan.changedFiles) }) : t("clean")}</span>
            <span aria-hidden="true">·</span>
            <span>{format(t("planCommits"), { count: String(plan.commits) })}</span>
            <span aria-hidden="true">·</span>
            <span>{t("taskDirectoryLabel")}</span>
            <code title={slashPath(path)}>{slashPath(path)}</code>
          </p> : null}
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
            <p>{result.failed
              ? result.repositories.every((entry) => !entry.merged && !entry.removed) ? t("finishNone") : t("finishPartial")
              : result.repositories.some((entry) => entry.merged) ? t("finishDone")
                // Nothing was merged, so what a branch's fate was is the headline: the
                // task was either kept for a merge later, or abandoned outright.
                : result.repositories.length > 0 && result.repositories.every((entry) => entry.branchDeleted) ? t("finishDoneDiscarded")
                  : t("finishDoneKept")}</p>
            <ul className="dws-finish-repos">{result.repositories.map((entry) => <li key={entry.path}>
              <strong>{entry.name}</strong>
              <span>{[entry.merged ? format(t("finishMerged"), { target: entry.target ?? "" }) : null, entry.removed ? t("finishRemoved") : null, entry.branchDeleted ? t("finishBranchDeleted") : null, entry.autoCommitted ? t("finishAutoCommitted") : null].filter(Boolean).join(" · ") || (entry.mergeInProgress ? t("finishConflictKept") : entry.conflict ? t("finishConflicted") : t("finishUntouched"))}</span>
              {/* One explanation, never two. A merge left standing is not a failure to
                  explain away but the step that is left, so it names the checkout and the
                  files to reconcile; a merge that was aborted says so. The two cannot both
                  be true — an aborted merge leaves no MERGE_HEAD behind — so a kept merge
                  must not also be described as aborted. Git's own output stays one click
                  away in either case, where the conflict itself is legible. */}
              {entry.mergeInProgress
                ? <>
                  <span className="dws-finish-conflict dws-finish-handoff" role="status">{format(t("finishConflictHandoff"), { site: slashPath(entry.mergeSite === undefined || entry.mergeSite === "" ? entry.path : entry.mergeSite) })}</span>
                  {(entry.conflictedFiles ?? []).length > 0
                    ? <span className="dws-finish-files">{format(t("finishConflictFiles"), { files: (entry.conflictedFiles ?? []).join(", ") })}</span>
                    : null}
                  <details className="dws-finish-log"><summary>{t("finishGitOutput")}</summary><pre>{entry.error}</pre></details>
                </>
                : entry.conflict
                  ? <>
                    <span className="dws-finish-conflict">{t("finishConflict")}</span>
                    <details className="dws-finish-log"><summary>{t("finishGitOutput")}</summary><pre>{entry.error}</pre></details>
                  </>
                  : entry.error ? <span className="dws-finish-error">{entry.error}</span> : null}
            </li>)}</ul>
            {/* The conflict is the step that is left rather than a casualty: it says
                where it is standing, what it could not reconcile, and puts the choice
                of who resolves it in front of the user. Nothing is started until the
                button is pressed - an agent costs a session, and a session is the
                user's to spend. */}
            {conflicts.length > 0 ? <div className="dws-finish-handoff-panel">
              <p className="dws-finish-handoff-title">{t("finishHandoffTitle")}</p>
              <p>{t("finishHandoffExplain")}</p>
              {handoff.length > 0
                ? <>
                  <p>{format(t("finishHandoffAuthorized"), {
                    count: String(handoff.length),
                    sessions: handoff.map((opened) => opened.name).join(", "),
                  })}</p>
                  <ul className="dws-finish-handoff-sessions">{handoff.map((opened) => {
                    const solving = sessionRunning(opened.sessionId)
                    return <li key={opened.sessionId}>
                    <strong>{opened.name}</strong>
                    <code title={slashPath(opened.site)}>{slashPath(opened.site)}</code>
                    {/* The write boundary, when it reaches wider than the worktree:
                        that width is what saves the approval, so it is not a detail. */}
                    {slashPath(opened.boundary) === slashPath(opened.site) ? null
                      : <span className="dws-finish-handoff-boundary">{format(t("finishHandoffBoundary"), { path: slashPath(opened.boundary) })}</span>}
                    {/* While the agent works the state is the thing to notice, so it
                        carries the same amber as every other pending state here; once
                        it stops, the row goes quiet. */}
                    <span className={solving ? "dws-finish-handoff-running" : "dws-finish-handoff-idle"}>{solving ? t("finishHandoffRunning") : t("finishHandoffIdle")}</span>
                    {/* The agent works in its own session, not behind this button, so
                        the only useful thing this dialog can do is take the user there. */}
                    <button type="button" className="dws-finish-handoff-open" onClick={() => uiWorkspace.openSession(opened.sessionId)}>{t("finishHandoffOpen")}</button>
                  </li>
                  })}</ul>
                  {/* What the agent asks for is approved in that session: approvals never
                      reach this dialog, so saying where they are is the whole of the help. */}
                  <p className="dws-finish-handoff-hint">{t("finishHandoffApprove")}</p>
                </>
                : <p className="dws-finish-handoff-hint">{t("finishHandoffHint")}</p>}
              {handoff.length === 0 ? <Button className="dws-button-warn-solid" disabled={authorizing} onClick={() => void authorize()}>
                {authorizing ? <Loader2 size={14} className="dws-spin" /> : null}
                {authorizing ? t("finishHandoffAuthorizing") : t("finishHandoffAuthorize")}
              </Button> : null}
              {handoffError !== "" ? <p className="dws-finish-error">{format(t("finishHandoffFailed"), { error: handoffError })}</p> : null}
            </div> : null}
            <p>{result.containerRemoved ? t("finishContainerRemoved") : format(t("finishContainerKept"), { path: slashPath(result.path) })}</p>
            {result.archivedStrays.length ? <p>{format(t("finishArchived"), { path: slashPath(documentsDirectory), names: result.archivedStrays.join(", ") })}</p> : null}
            {result.strays.length ? <p>{format(t("finishStrays"), { names: result.strays.join(", ") })}</p> : null}
            {result.warnings.map((warning) => <p className="dws-finish-error" key={warning}>{warning}</p>)}
            {workspace !== undefined
              ? <p className={registrationError === "" ? undefined : "dws-finish-error"}>
                {registrationError !== "" ? format(t("archiveWorkspaceKept"), { error: registrationError }) : result.containerRemoved ? t("archiveWorkspaceRemoved") : t("archiveWorkspaceKeptIntact")}
              </p>
              : null}
          </div> : null}
          {result === null && plan === null && loadError === "" ? <div className="dws-dialog-loading" role="status">
            <div><Loader2 size={16} className="dws-spin" aria-hidden="true" /> {t("loadingRepository")}</div>
            <span aria-hidden="true" />
          </div> : null}
          {result === null && plan !== null ? <>
            <p className="dws-notice" role="status"><AlertCircle size={15} aria-hidden="true" /><span>{t("archiveConsequence")}</span></p>
            <label className="dws-check-option"><input type="checkbox" className="dws-checkbox" disabled={optionsDisabled} checked={options.merge} onChange={(event) => setOptions((current) => ({ ...current, merge: event.target.checked, deleteBranch: event.target.checked || current.force ? current.deleteBranch : false }))} /><span className="dws-check-copy"><span className="dws-check-label">{t("finishMerge")}</span><span className="dws-check-path">{t("finishMergeHint")}</span></span></label>
            <label className="dws-check-option"><input type="checkbox" className="dws-checkbox" disabled={optionsDisabled || (!options.merge && !options.force)} checked={options.deleteBranch && (options.merge || options.force)} onChange={(event) => setOptions((current) => ({ ...current, deleteBranch: event.target.checked }))} /><span className="dws-check-copy"><span className="dws-check-label">{t("finishDeleteBranch")}</span><span className="dws-check-path">{t("finishDeleteBranchHint")}</span></span></label>
            <label className="dws-check-option"><input type="checkbox" className="dws-checkbox" disabled={optionsDisabled} checked={options.force} onChange={(event) => setOptions((current) => ({ ...current, force: event.target.checked, deleteBranch: current.merge || event.target.checked ? current.deleteBranch : false }))} /><span className="dws-check-copy"><span className="dws-check-label">{t("finishForce")}</span><span className="dws-check-path">{t("finishForceHint")}</span></span></label>
            {/* Nothing here decides what to do about uncommitted work or a conflict:
                committing first, and stopping at a conflict instead of picking a side,
                are what finishing does. A conflict is handed on after it happens —
                from the report below — not agreed to beforehand. */}
            {/* The one choice about the container's own files: keep the writing,
                or let everything in there go. Only offered when there is writing
                to keep — otherwise there is nothing to decide. */}
            {contentStrays.length > 0 ? <><label className="dws-check-option"><input type="checkbox" className="dws-checkbox" disabled={optionsDisabled} checked={options.archiveDocuments} onChange={(event) => setOptions((current) => ({ ...current, archiveDocuments: event.target.checked }))} /><span className="dws-check-copy"><span className="dws-check-label">{t("archiveDocuments")}</span><span className="dws-check-path">{format(t("archiveDocumentsHint"), { path: slashPath(documentsDirectory) })}</span></span></label>
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
            {/* Forcing says what it will cost, and asking for the branch too costs
                more: the commits that were never merged go with it. */}
            {options.force ? <p className="dws-notice dws-notice-danger" role="alert"><AlertCircle size={15} aria-hidden="true" /><span>{options.deleteBranch ? t("finishForceWarningBranch") : t("finishForceWarning")}</span></p> : null}
            {running ? <div className="dws-error" role="alert"><AlertCircle size={16} /><span>{t("archiveRunning")}</span></div> : null}
            {error ? <div className="dws-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div> : null}
          </> : null}
        </div>
        <div className="dws-dialog-footer">
          {result
            ? <>
              {/* The same action as the first call, offered where the reason for it
                  is: once the conflicts have been dealt with in their worktrees, the
                  finish reads the merge they committed and does the rest. */}
              {/* Held back while an agent is still working: finishing now would try to
                  merge a branch whose merge is not committed yet, and the report would
                  describe a race instead of the result. */}
              {conflicts.length > 0 ? <Button className="dws-button-warn-solid" disabled={busy || working.length > 0} onClick={() => void archive()}>{busy || working.length > 0 ? <Loader2 size={14} className="dws-spin" /> : <Check size={14} />}{busy ? t("finishing") : working.length > 0 ? t("finishContinueWaiting") : t("finishContinue")}</Button> : null}
              <Button onClick={close}>{t("close")}</Button>
            </>
            : <><Button className="dws-button-ghost" disabled={busy} onClick={close}>{t("cancel")}</Button><Button className={discardsWork ? "dws-button-danger-solid" : "dws-button-warn-solid"} disabled={optionsDisabled} onClick={() => void archive()}>{busy ? <Loader2 size={14} className="dws-spin" /> : <Check size={14} />}{busy ? t("finishing") : t("finishConfirmAction")}</Button></>}
        </div>
      </DialogContent>
    </Dialog>
  )
}

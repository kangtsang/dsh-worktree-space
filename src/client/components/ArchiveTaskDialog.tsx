import { useCallback, useEffect, useRef, useState } from "react"
import { AlertCircle, Check, Loader2 } from "./icons"
import { createWorktreeApi } from "../lib/api"
import { format, useT } from "../lib/i18n"
import { documentsDirectoryFor } from "../lib/documents"
import { cleanPath, commonAncestor, nameOf, parentOf, slashPath } from "../lib/paths"
import { clearFinishScene, readFinishScene, saveFinishScene, type FinishSceneSession } from "../lib/finishScene"
import { BetaNotice } from "./BetaNotice"
import type { FinishTaskResult, TaskPlan, TaskPlanRepository, WorkspaceNavigation, WorkspacesService } from "../lib/types"
import type { ISessions, SessionTarget } from "@deepseek-ai/dsh-api-session-controller/client"
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
  /**
   * The surface this dialog was drawn in, told to step aside when the user follows a
   * session. Closing the dialog is not enough on its own: the management page holds the
   * main column and its dialog version floats over the shell, so either one would be
   * left standing in front of the very session the user asked for. Opened from the
   * workspace list there is nothing underneath but the conversation, so it is left out.
   */
  onLeave?: () => void
}

/**
 * One repository as the agent is told about it.
 *
 * A session is opened per batch rather than per repository, so what the prompt needs travels
 * on the entry instead of in a closure over the plan: the batch is decided inside the call
 * that opens the sessions, and the message describing it is built from the batch itself.
 */
interface HandoffTarget {
  name: string
  /** Where the session works for this repository - the worktree, or the kept merge site. */
  site: string
  mainRepo?: string
  branch?: string
  /** The branch this one merges into, named in the conflict prompt only. */
  target?: string
  /** The files the rehearsal left conflicted, named in the conflict prompt only. */
  files?: string[]
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
export function ArchiveTaskDialog({ path, api, workspaces, sessions, uiWorkspace, onArchived, onClose, onLeave }: ArchiveTaskDialogProps) {
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
  // The sessions the handoff opened, one row per repository it handed on, and
  // whatever stopped one from being opened at all. Kept here rather than derived
  // from the report, because the sessions outlive the request that made them. A row
  // is a repository, not a session: repositories handed on together share one.
  const [handoff, setHandoff] = useState<FinishSceneSession[]>(() => readFinishScene(path)?.handoff ?? [])
  const [authorizing, setAuthorizing] = useState(false)
  const [handoffError, setHandoffError] = useState("")
  /**
   * Whether the Host's configuration offers the two agent entries.
   *
   * Shown until the Host says otherwise, which is the setting's own default: the entries
   * are the finish this plugin has been shipping, and a profile that would rather do the
   * commit and the conflict resolution itself turns them off. It governs the entries and
   * the notice that explains them, and nothing else - a session that was already opened
   * stays on screen, because that is the state of the work rather than an offer.
   */
  const [handoffEntry, setHandoffEntry] = useState(true)
  // The sessions run outside this dialog, so the rows reporting on them have to
  // follow the Host's list rather than a value read once. The counter is the render.
  const [, setSessionTick] = useState(0)
  const planGeneration = useRef(0)
  /** Whether a step is running, so two of them cannot hand the same work on twice. */
  const stepping = useRef(false)
  /**
   * The repository jobs an in-flight open already claimed.
   *
   * A step reads the handoff it has rendered with, so a second step starting before the
   * first one's sessions have been recorded would see the same work unclaimed and open a
   * second session for it. Claiming is synchronous, before the first await, so the
   * duplicate is refused rather than discovered afterwards.
   */
  const claimed = useRef(new Set<string>())
  /**
   * The handed-on jobs whose stop has already been answered with a fresh plan.
   *
   * The plan on screen is the one taken before the handoff, and it still says what the
   * worktrees held then - so the only way to see a commit an agent has made is to read the
   * plan again. One read per stop, marked here as it is asked for: the Host's list is
   * followed on every render, and reading the plan on each of them would be a loop.
   *
   * A job rather than a session, keyed the way the handoff claims them: one session is
   * carried on from the commits to the conflict and stops once for each, so keyed by
   * session the conflict's own stop would go unanswered.
   */
  const refreshed = useRef(new Set<string>())
  /**
   * The jobs the plan on screen has been read in answer to.
   *
   * Kept apart from the mark above, and set with the plan rather than where the read is
   * asked for: the render between those two moments would otherwise read a plan that still
   * describes the worktrees as they were, and call a conflict that is standing resolved.
   */
  const [answered, setAnswered] = useState<Set<string>>(() => new Set())
  /** One read answers everything this dialog shows: each repository's branch, what
   * it would merge into, how many commits that is, and how much is uncommitted —
   * none of it trusted from the opener, since this dialog removes those worktrees.
   * `answers` names the handed-on jobs this read was taken for, and is recorded with
   * the plan it produced: what the panel says about a stop has to rest on a plan that
   * speaks to it, not on the one taken before that work began. */
  const loadPlan = useCallback(async (chosen?: Record<string, string>, answers?: string[]) => {
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
      if (answers !== undefined) setAnswered((previous) => new Set([...previous, ...answers]))
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
   * Read the plan again once an agent this dialog handed work to has stopped.
   *
   * What is on screen is the plan taken before the handoff, and it still describes the
   * worktrees as they were: nothing in it can tell a commit an agent has made from the one
   * it was asked to make. So the stop is what asks for the second read - and only a stop
   * the Host has really answered for: a row that is blank, or no row at all, is a session
   * whose work has not begun, and reading the plan then would come back with the same
   * uncommitted files as before. The chosen targets ride along, so the preview that comes
   * back is the one the user was looking at.
   *
   * A stop belongs to the job, not to the session: handed a conflict while it stood idle,
   * a session reads as stopped before its prompt has been picked up, and that read must not
   * be the last word on the stop that comes after the work. So the mark a job carries is
   * dropped as soon as its session is seen running again.
   */
  useEffect(() => {
    const stopped = handoff.filter((opened) => {
      const row = sessions.list.getSnapshot().byId[opened.sessionId]
      if (row === undefined || row.blank === true) return false
      const claim = `${opened.kind}:${opened.name}`
      if (row.running === true) { refreshed.current.delete(claim); return false }
      if (refreshed.current.has(claim)) return false
      refreshed.current.add(claim)
      return true
    })
    if (stopped.length > 0) void loadPlan(targets, stopped.map((opened) => `${opened.kind}:${opened.name}`))
  })

  /**
   * Hold the report so it survives this dialog being unmounted.
   *
   * Opening a handed-off session takes over the view the dialog was drawn in, and the
   * user has to come back to it to continue finishing: without this the panel they
   * return to is empty, and the sessions it opened are forgotten rather than reported.
   * Only work that is still in hand is held: a finish that went through has nothing left
   * to offer, and a later visit to the page has to open on the task, not on its last
   * report. Sessions opened before any answer came back are held too, so returning from
   * one reuses it rather than opening a second for the same repository.
   */
  useEffect(() => {
    if (result === null ? handoff.length > 0 : result.failed) saveFinishScene(path, { result, handoff })
    else if (result !== null) clearFinishScene(path)
  }, [path, result, handoff])

  /**
   * What the Host has configured, once it answers: the destination archived documents
   * are filed into, and whether the agent entries are offered at all.
   *
   * Read rather than assumed, and it arrives after the first paint: the computed
   * folder is on screen until then, so the row never shows an empty path while it
   * waits. A Host that answers nothing leaves the computed folder in place — which
   * is exactly what an empty setting means — and leaves the entries shown, which is
   * what the setting defaults to.
   */
  useEffect(() => {
    let live = true
    void api.preferences().then((served) => {
      if (!live) return
      setHandoffEntry(served?.handoffEntry !== "hide")
      const configured = typeof served?.archiveDocumentsDirectory === "string" ? served.archiveDocumentsDirectory : ""
      if (configured.trim() === "") return
      setDocumentsDirectory(documentsDirectoryFor(path, workspace?.title, new Date(), configured))
    }).catch(() => { /* falls back to the computed folder and to hidden entries */ })
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
   * Whether the Host's own list says a session this dialog opened is working right now.
   *
   * Its rows are the only thing that can say so: the sessions outlive the request that
   * made them, and the merge has to be committed before finishing can read it.
   */
  const sessionRunning = (sessionId: FinishSceneSession["sessionId"]) => sessions.list.getSnapshot().byId[sessionId]?.running === true
  /**
   * Whether the agent this panel put on the work has still to begin, or is still at it.
   *
   * The button that carries the finish on is held back by this, and only by a row that
   * says so. Silence is not that answer: a session is recorded as blank the moment it is
   * created and only starts running a moment later, so a blank row - or no row at all, on
   * a page opened moments ago - belongs to a session whose work has not begun. Taking that
   * for a session that has finished would race the agent the button just put on the work,
   * and the merge would be tried while the commit behind it is still being written.
   */
  const agentPending = handoff.some((opened) => {
    const row = sessions.list.getSnapshot().byId[opened.sessionId]
    return row !== undefined && (row.running === true || row.blank === true)
  })
  /**
   * The repositories with work nobody has committed, read from the plan.
   *
   * The plan was taken before any merge was tried, so this is what the user's own edits
   * look like - not the conflicted files a merge leaves behind. Each of them needs an
   * agent to write the commit: the message has to come from whoever read those changes,
   * and this side has not.
   */
  const dirtyRepos = (plan?.repositories ?? []).filter((entry) => (entry.changedFiles ?? 0) > 0)
  /** Whether this finish commits at all: Force discards the work, and an abandonment goes with it. */
  const keepsWork = !options.force && (options.merge || !options.deleteBranch)
  /** The repositories an agent still has to commit for, before a merge can carry their work. */
  const needsCommit = keepsWork
    ? dirtyRepos.filter((entry) => !handoff.some((opened) => opened.name === entry.name && opened.kind === "commit"))
    : []
  /** The conflicting merges no agent has been put on yet. */
  const needsConflict = conflicts.filter((entry) => !handoff.some((opened) => opened.name === entry.name && opened.kind === "conflict"))
  /** Which of the two jobs the agents here are on, so the panel names the right one. */
  const phase: "commit" | "conflict" = handoff.some((opened) => opened.kind === "conflict") || conflicts.length > 0 ? "conflict" : "commit"
  /**
   * Whether work nobody committed is still standing in the way.
   *
   * Force is the other way past it - the work is discarded rather than committed - and
   * nothing else moves: a worktree holding uncommitted files refuses to be removed, and
   * the commit is not this side's to write. So confirming waits for the agent, and the
   * panel offers the one thing that starts it.
   */
  const commitPending = keepsWork && dirtyRepos.length > 0
  /**
   * Whether the commits this panel handed over are in, as far as the plan can say.
   *
   * Read from a plan taken after the agent stopped rather than from the one that sent it:
   * the repositories that plan named are exactly the ones the agent was asked to commit, so
   * a plan that no longer reports any of them as changed is the agent's answer. What comes
   * next is a merge into the user's own checkout, and that is not this side's to start - so
   * all this does is say the commits are done, and the press stays with the user.
   */
  const commitDone = phase === "commit" && handoff.some((opened) => opened.kind === "commit") && dirtyRepos.length === 0
  /**
   * Whether the conflict this panel handed over has been resolved, as far as the plan can say.
   *
   * Read the same way the commits are, and for the same reason: from a plan taken in answer
   * to this job's stop rather than from the one that sent it. A merge is only visible to the
   * plan through its uncommitted files - one that is standing and one that is resolved but
   * not committed both leave them - so a plan that reports none, in answer to this stop, is
   * the agent's answer. Nothing follows it by itself either: what comes next is the merge
   * into the user's own checkout, so all this does is say the conflict is done.
   */
  const conflictDone = phase === "conflict"
    && handoff.some((opened) => opened.kind === "conflict" && answered.has(`${opened.kind}:${opened.name}`))
    && dirtyRepos.length === 0
  /**
   * The sessions the panel reports, one per conversation.
   *
   * A repository is not a session: repositories handed on together share one, and the same
   * one is carried on as the work moves from committing to resolving. So the boundary and
   * the state belong here rather than on a row - a session that covers two repositories
   * would otherwise repeat both, and say the same directory twice.
   */
  const handoffSessions = [...new Set(handoff.map((opened) => opened.sessionId))].map((sessionId) => {
    const entries = handoff.filter((opened) => opened.sessionId === sessionId)
    return {
      sessionId,
      boundary: entries[0].boundary,
      // The job in hand wins over what a repository was first opened for: a session reused
      // for a conflict is on that conflict, whatever the other repository in it was for.
      kind: entries.some((entry) => entry.kind === phase) ? phase : entries[0].kind,
      // A session opened on the worktree alone cannot reach the repository's git
      // directory, and neither can one opened on the task space for worktrees that share no
      // directory: only a boundary that really reaches it can be committed in, and the
      // session remembers which of the two it was opened as.
      wide: entries.every((entry) => entry.wide),
    }
  })
  /**
   * The rows the panel is actually about, now that it may be about the second job.
   *
   * The two jobs come one after the other, and the first is finished by the time the second
   * is asked about: a finish stopped on a conflict has had its commits made already, so
   * listing those repositories again - "opened for the commits", beside a question about the
   * merge - would be reporting work that is behind us. The conflict rows appear once the
   * user has put an agent on the conflict, and they name the very session the commits went
   * through, because that is the conversation being carried on.
   */
  const shownHandoff = phase === "conflict" ? handoff.filter((opened) => opened.kind === "conflict") : handoff
  const shownSessions = handoffSessions.filter((session) => shownHandoff.some((opened) => opened.sessionId === session.sessionId))
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
   * Following the session the panel reports: the session takes over the view, this
   * dialog closes, and the surface it was drawn in steps aside with it. Leaving that
   * surface out was the bug this exists to fix — the management page owns the main
   * column, and its dialog version floats over the shell, so either one stayed in
   * front of the conversation the user had just asked to see.
   */
  const followSession = (sessionId: SessionTarget) => {
    if (busy) return
    uiWorkspace.openSession(sessionId)
    onClose()
    onLeave?.()
  }
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
      // A merge that stopped on a conflict is not handed on from here: putting an agent
      // on a repository is a decision, and the panel asks for it in as many words. What
      // is done with the answer is to report it.
    } catch (reason: any) {
      setError(`${t("operationError")}${String(reason?.message ?? reason)}`)
    } finally {
      setBusy(false)
    }
  }

  const optionsDisabled = busy || plan === null || running

  /**
   * Where an agent is opened for one repository, and whether that reaches the git metadata.
   *
   * A linked worktree keeps its git metadata inside the source repository, and every commit
   * writes there - so the session's working directory has to reach both, and their common
   * ancestor is the narrowest directory that does. Where the two share nothing but a volume
   * root there is no such directory, and the worktree is all this can offer: `reaches` is
   * then false, and the panel sends the user into the session for the elevation a git command
   * writing into that metadata will need.
   */
  const scopeFor = (site: string, mainRepo?: string) => {
    const metadata = mainRepo === undefined || mainRepo === "" ? site : mainRepo
    const ancestor = commonAncestor(site, metadata)
    // Nothing to widen means the worktree keeps its own spelling: only a boundary that
    // really reaches further is normalised, and the session opens on the worktree exactly
    // as the Host named it.
    return {
      boundary: ancestor === undefined || slashPath(ancestor) === slashPath(site) ? site : ancestor,
      reaches: ancestor !== undefined && slashPath(ancestor) !== slashPath(site),
    }
  }

  /**
   * The directory that reaches every one of these boundaries, where there is one.
   *
   * What is handed on together is opened on the narrowest directory covering all of it,
   * so one conversation can do all of that work. `commonAncestor` answers `undefined`
   * once only a volume root is left, and that is too wide to open a session on - it
   * would put the whole disk in reach - so the caller opens the one session on the task
   * space instead, and says the elevation may have to be approved by hand.
   */
  const commonBoundary = (boundaries: string[]) => boundaries.length < 2
    ? undefined
    : boundaries.slice(1).reduce<string | undefined>((left, right) => left === undefined ? undefined : commonAncestor(left, right), boundaries[0])

  /**
   * What a batch of repositories' agent is asked to do.
   *
   * Everything it needs is in the one message: the repositories with their branches and
   * worktrees, where the work is standing, and which files are involved. The commit is the
   * agent's own work now, so the message says that too - and names the session's working
   * directory, because that is the boundary its git commands are allowed to write inside. It
   * is told not to push and not to merge: the branch still has to be merged into its target,
   * and the worktrees removed afterwards, which is this plugin's job. What the session is told
   * about its own working directory is decided per batch, by `scopeLine` below.
   */
  /**
   * What the session is told about its own working directory.
   *
   * The directory is named either way, because that is where its git commands are allowed to
   * write. What differs is whether it really reaches the .git of every repository in the
   * batch: where it does not, the agent is told to ask for the elevation rather than left to
   * run into the refusal.
   */
  const scopeLine = (boundary: string, wide: boolean) => format(t(wide ? "finishPromptScopeWide" : "finishPromptScopeTight"), { boundary: slashPath(boundary) })
  const commitPromptFor = (entries: HandoffTarget[], boundary: string, wide: boolean) => format(t("finishCommitPrompt"), {
    task: plan?.task ?? "",
    scope: scopeLine(boundary, wide),
    repositories: entries.map((entry) => format(t("finishCommitRepository"), {
      name: entry.name,
      branch: entry.branch ?? "",
      site: slashPath(entry.site),
    })).join("\n"),
  })
  const conflictPromptFor = (entries: HandoffTarget[], boundary: string, wide: boolean) => format(t("finishHandoffPrompt"), {
    task: plan?.task ?? "",
    scope: scopeLine(boundary, wide),
    repositories: entries.map((entry) => format(t("finishHandoffRepository"), {
      name: entry.name,
      branch: entry.branch ?? "",
      target: entry.target ?? "",
      site: slashPath(entry.site),
      files: (entry.files ?? []).join(", "),
    })).join("\n"),
  })

  /**
   * Put an agent on the repositories that need one.
   *
   * A repository already spoken for keeps its session: the agent has this worktree in its
   * context - it made the commit that came before the merge - so a conflict is handed to
   * the same conversation rather than explained again to a new one. Only a repository with
   * no session gets one, which is what keeps this idempotent when the user comes back to a
   * dialog whose sessions are still there.
   *
   * What is not spoken for is handed on together whatever its directories look like: one
   * session for the whole batch, opened on their common ancestor where they have one and on
   * the task space where they do not - the one conversation is kept either way, and where that
   * directory cannot reach a repository's git metadata the panel says the elevation is the
   * user's to approve in that session.
   *
   * One message per session: the batch is described once, as a list of the repositories it
   * covers, rather than queued a turn per repository - the agent has the whole job from the
   * start and works through it.
   */
  const openAgentSessions = async (entries: HandoffTarget[], kind: "commit" | "conflict", textFor: (batch: HandoffTarget[], boundary: string, wide: boolean) => string) => {
    setAuthorizing(true); setHandoffError("")
    const opened: FinishSceneSession[] = []
    const failures: string[] = []
    // Claimed before the first await, so a second step starting while this one is still
    // opening sessions cannot hand the same repository on twice.
    const wanted = entries.filter((entry) => {
      const claim = `${kind}:${entry.name}`
      if (claimed.current.has(claim)) return false
      claimed.current.add(claim)
      return true
    })
    const spokenFor = wanted.filter((entry) => handoff.some((one) => one.name === entry.name))
    const fresh = wanted.filter((entry) => !handoff.some((one) => one.name === entry.name))
    const scoped = fresh.map((entry) => ({ entry, ...scopeFor(entry.site, entry.mainRepo) }))
    const shared = commonBoundary(scoped.map((one) => one.boundary))
    const batches: Array<{ boundary: string; wide: boolean; sessionId?: FinishSceneSession["sessionId"]; entries: HandoffTarget[] }> = [
      ...spokenFor.map((entry) => {
        const previous = handoff.find((one) => one.name === entry.name)!
        return { boundary: previous.boundary, wide: previous.wide, sessionId: previous.sessionId, entries: [entry] }
      }),
      // One batch either way, and only when there is something left to hand on. Several
      // repositories are opened on whatever covers them all - their common ancestor where they
      // have one, and the task space where they share nothing but a volume root, which reaches
      // every worktree the Host named even though the git metadata a commit writes may lie
      // outside it. A single repository keeps its own boundary, which is the one that reaches
      // its metadata.
      ...(scoped.length === 0 ? [] : [{
        boundary: shared ?? (scoped.length === 1 ? scoped[0].boundary : path),
        wide: scoped.length === 1 ? scoped[0].reaches : shared !== undefined,
        entries: scoped.map((one) => one.entry),
      }]),
    ]
    for (const batch of batches) {
      let sessionId: FinishSceneSession["sessionId"]
      try {
        sessionId = batch.sessionId ?? await sessions.create({ cwd: batch.boundary })
      } catch (reason: any) {
        // The session could not be opened at all, so nothing in this batch was handed on.
        for (const entry of batch.entries) {
          claimed.current.delete(`${kind}:${entry.name}`)
          failures.push(`${entry.name}: ${String(reason?.message ?? reason)}`)
        }
        continue
      }
      try {
        // A session opens blank, so this is its first turn rather than a steer, and the
        // reference is a handle for the length of the call - not something to keep: the
        // session is followed through the Host's own list instead. Every repository in the
        // batch rides in that one turn, so a shared session is not queued a message per
        // repository and its agent can settle the whole list in a single pass.
        await sessions.using(sessionId, { source: "controllerOperation" }, async (reference) => {
          await reference.binding.session.prompt([{ type: "text", text: textFor(batch.entries, batch.boundary, batch.wide) }], "queue")
        })
        for (const entry of batch.entries) opened.push({ name: entry.name, site: entry.site, boundary: batch.boundary, wide: batch.wide, kind, sessionId })
      } catch (reason: any) {
        for (const entry of batch.entries) {
          claimed.current.delete(`${kind}:${entry.name}`)
          failures.push(`${entry.name}: ${String(reason?.message ?? reason)}`)
        }
      }
    }
    // Named once each: asking twice for the same repository replaces its row rather
    // than opening a second session for work that is already spoken for.
    setHandoff((current) => [...current.filter((previous) => !opened.some((one) => one.name === previous.name)), ...opened])
    if (failures.length > 0) setHandoffError(failures.join("; "))
    setAuthorizing(false)
  }

  /**
   * Hand the uncommitted work to an agent, at the user's word.
   *
   * This is the only thing the dialog does about work nobody committed, and it does it
   * only when asked: opening a session on a repository is a decision, and the commit that
   * follows writes into that repository's own git directory - which the sandbox may have
   * to be talked into, in the session, by hand.
   *
   * Nothing here starts the next step, and neither does the session stopping: the merge
   * that follows reaches the user's own checkout, so the panel waits for a word about it
   * every time. What the stop does do is have the plan read again, so the panel can say
   * the commits are in - see the effect above, and `commitDone`.
   */
  const authorizeCommit = async () => {
    if (needsCommit.length === 0 || busy || authorizing || running) return
    await openAgentSessions(needsCommit.map((entry) => ({
      name: entry.name,
      site: entry.path,
      mainRepo: entry.mainRepo,
      branch: entry.branch,
    })), "commit", commitPromptFor)
  }

  /**
   * Hand a merge that stopped on a conflict to an agent, at the user's word.
   *
   * The same word the commit phase waits for, and where there is one the same session:
   * the agent that made the commit in front of the merge already has that worktree in
   * its context, so it is asked about the conflict rather than a new conversation being
   * told the story again.
   *
   * Like the commit phase, this does not hand the finish back to itself. What follows a
   * resolved conflict is a merge into the user's own checkout, and that is a step worth
   * asking for twice: the session stopping means an agent believes it is done, not that
   * the branch is ready to be carried into the repository it came from. So nothing is
   * started here - the footer's button is what reads the state again, once the user has
   * looked at what the agent left behind. What the stop does do is have that read taken, so
   * the panel can say the conflict is resolved: see the effect above, and `conflictDone`.
   */
  const authorizeConflict = async () => {
    if (needsConflict.length === 0 || busy || authorizing || running) return
    // A merge that is standing has a checkout of its own to name, which is not always the
    // repository's: a target the source repository is not on is merged in one of its own.
    await openAgentSessions(needsConflict.map((entry) => ({
      name: entry.name,
      site: entry.mergeSite === undefined || entry.mergeSite === "" ? entry.path : entry.mergeSite,
      mainRepo: entry.mainRepo,
      branch: entry.branch,
      target: entry.target,
      files: entry.conflictedFiles ?? [],
    })), "conflict", conflictPromptFor)
  }

  /**
   * Move the finish along, one step at a time.
   *
   * This is the archive call and nothing else, and it runs when the user asks for it: what
   * it does not do is put an agent on a repository - that is a decision, and the panel asks
   * for it in as many words, once for work nobody committed and once for a merge that
   * stopped on a conflict. Neither handoff is followed by an automatic second step, either:
   * the merge that comes last reaches the user's own checkout, so the panel reads the state
   * again when the user presses the button rather than when a session happens to stop.
   */
  const step = async () => {
    if (stepping.current) return
    if (plan === null || busy || running) return
    if (result !== null && !result.failed) return
    stepping.current = true
    try {
      await archive()
    } finally {
      stepping.current = false
    }
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
              <span>{[entry.merged ? format(t("finishMerged"), { target: entry.target ?? "" }) : null, entry.removed ? t("finishRemoved") : null, entry.branchDeleted ? t("finishBranchDeleted") : null].filter(Boolean).join(" · ") || (entry.mergeInProgress ? t("finishConflictKept") : entry.conflict ? t("finishConflicted") : t("finishUntouched"))}</span>
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
          {/* The agent's part of the finish, wherever it has got to. A repository is not a
              session here: repositories handed on together share one, and a repository
              keeps the one it was given as the work moves from committing to resolving - so
              the rows name repositories, and the line under them says what the session
              carrying them is doing and where its git commands may write. */}
          {(handoff.length > 0 || authorizing || needsCommit.length > 0 || needsConflict.length > 0) ? <div className="dws-finish-handoff-panel">
            <div className="dws-finish-handoff-head">
              {commitDone || conflictDone
                // The work handed over has come back done, so the headline stops asking for
                // it: it says what is left, under the green light the page uses for a clean
                // worktree. The press it names is the footer's own button - the panel reads
                // the state again when the user presses it, rather than the moment the
                // agent's session stops. Both jobs read the same way: the commits are in, or
                // the conflict is resolved.
                ? <p className="dws-finish-handoff-title is-done" role="status"><span className="dws-status-dot" aria-hidden="true" /><span>{t(commitDone ? "finishCommitDone" : "finishConflictDone")}</span></p>
                : <p className="dws-finish-handoff-title">{t(phase === "conflict" ? "finishHandoffTitle" : "finishCommitTitle")}</p>}
              {/* Handing work to an agent is the one part of the finish that waits for a
                  word from the user: nothing on this side can write the commit, and a merge
                  that stopped on a conflict is not this side's to reconcile either. Offered
                  only while a repository still has no session on it, so it reads once rather
                  than beside the rows it already produced. It is a plain button, without the
                  warning colour or a glyph of its own: handing the work over is not a hazard,
                  and the title above it already says what is waiting. */}
              {handoffEntry && phase === "commit" && needsCommit.length > 0
                ? <Button disabled={authorizing || busy || running} onClick={() => void authorizeCommit()}>{t("finishAuthorizeCommit")}</Button>
                : null}
              {handoffEntry && phase === "conflict" && needsConflict.length > 0
                ? <Button disabled={authorizing || busy || running} onClick={() => void authorizeConflict()}>{t("finishAuthorizeConflict")}</Button>
                : null}
            </div>
            {/* The rehearsal is explained while there is a conflict to read about; once it
                is resolved the headline says so, and a paragraph about files still standing
                in the worktree would contradict it. */}
            {phase === "conflict" && !conflictDone ? <p>{t("finishHandoffExplain")}</p> : null}
            {/* What is left after the agent's part: the merging the plugin does, said here
                rather than left to be discovered. */}
            {phase === "conflict" ? <p className="dws-finish-handoff-hint">{t("finishHandoffHint")}</p> : null}
            {/* Said before the session exists, because it is what the user has to do once
                it does: the approval a commit may need is not this dialog's to give. A
                Host that offers no such entry says the same thing about doing it by hand
                here, so the line is there either way - the finish stops on this work
                whether or not an agent may be put on it. */}
            {phase === "commit"
              ? <p className="dws-finish-handoff-hint">{t(handoffEntry ? "finishCommitEscalation" : "finishCommitManual")}</p>
              : null}
            {shownHandoff.length > 0 ? <>
              {/* What the sessions are for is said once, not on every row: the job is the
                  same for all of them, the rows below name the repositories themselves, and
                  the repository list is already there - so this sentence names neither. What
                  it does carry is the write boundary, in its own colour rather than as a
                  footnote: it is what the commit's git commands depend on. */}
              <p className="dws-finish-handoff-authorized">{format(t("finishHandoffAuthorized"), {
                count: String(shownSessions.length),
                job: t(shownSessions.every((session) => session.kind === "conflict") ? "finishHandoffJobConflict" : "finishHandoffJobCommit"),
              })}{shownSessions.map((session, index) => <span key={session.sessionId}>
                {index > 0 ? "、" : null}
                <span className="dws-finish-handoff-boundary" title={session.wide ? t("finishHandoffScopeWide") : t("finishHandoffScopeTight")}>{format(t("finishHandoffBoundary"), { path: slashPath(session.boundary) })}</span>
              </span>)}</p>
              <ul className="dws-finish-handoff-sessions">{shownHandoff.map((opened) => <li key={`${opened.kind}:${opened.name}`}>
                <strong>{opened.name}</strong>
                <code title={slashPath(opened.site)}>{slashPath(opened.site)}</code>
              </li>)}</ul>
              {/* One line per session rather than one per repository: what the agent is on
                  belongs to the conversation, and every repository listed above is in it. */}
              {shownSessions.map((session) => {
                const solving = sessionRunning(session.sessionId)
                return <p className={solving ? "dws-finish-handoff-state" : "dws-finish-handoff-state is-idle"} key={session.sessionId}>
                  <span>{solving ? t(session.kind === "conflict" ? "finishHandoffRunningConflict" : "finishHandoffRunningCommit") : t("finishHandoffIdle")}</span>
                  {/* The agent works in its own session, not behind a button here, so this
                      is the way to it - and going there takes this dialog and the surface
                      it was drawn in off the screen (see followSession above), because the
                      session it opens takes over the view they were covering. */}
                  <button type="button" className="dws-finish-handoff-open" onClick={() => followSession(session.sessionId)}>{t("finishHandoffOpen")}</button>
                </p>
              })}
              {/* Directly under the rows that carry it, and only when one does: this says
                  what the button above it does to the dialog, so it belongs beside that
                  button rather than under the notice further down. The glyph is the one
                  the consequence notice wears, in this line's own grey: a thing to know,
                  not a warning. */}
              {shownSessions.length > 0 ? <p className="dws-finish-handoff-note"><AlertCircle size={13} aria-hidden="true" /><span>{t("finishHandoffScene")}</span></p> : null}
            </> : null}
            {authorizing ? <p className="dws-finish-handoff-hint" role="status"><Loader2 size={14} className="dws-spin" aria-hidden="true" /> {t("finishHandoffAuthorizing")}</p> : null}
            {/* Handing work to an agent is the part of this that is still being worked
                out, and this panel is where that is said rather than the page. It is said
                only where the entries it describes are offered: the notice explains them,
                so it has nothing to explain on a Host that hides them. */}
            {handoffEntry ? <BetaNotice /> : null}
            {handoffError !== "" ? <p className="dws-finish-error">{format(t("finishHandoffFailed"), { error: handoffError })}</p> : null}
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
              {/* The same action as the first call, offered wherever an agent's step was
                  left unfinished: a merge that was resolved but never committed, a commit
                  an agent did not make, or a session that stopped halfway. Each is named
                  in the report above, and pressing this reads the state again. After a
                  conflict it is also the only way on, which is why the panel asks for it
                  rather than starting by itself. */}
              {/* Held back while an agent is still working or has not started yet: finishing
                  now would try to merge a branch whose merge is not committed yet, and the
                  report would describe a race instead of the result. */}
              {result.failed ? <Button className="dws-button-warn-solid" disabled={busy || agentPending} onClick={() => void step()}>{busy || agentPending ? <Loader2 size={14} className="dws-spin" /> : <Check size={14} />}{busy ? t("finishing") : agentPending ? t("finishContinueWaiting") : t("finishContinue")}</Button> : null}
              <Button onClick={close}>{t("close")}</Button>
            </>
            : <><Button className="dws-button-ghost" disabled={busy} onClick={close}>{t("cancel")}</Button><Button className={discardsWork ? "dws-button-danger-solid" : "dws-button-warn-solid"} disabled={optionsDisabled || commitPending} onClick={() => void step()}>{busy ? <Loader2 size={14} className="dws-spin" /> : <Check size={14} />}{busy ? t("finishing") : t("finishConfirmAction")}</Button></>}
        </div>
      </DialogContent>
    </Dialog>
  )
}

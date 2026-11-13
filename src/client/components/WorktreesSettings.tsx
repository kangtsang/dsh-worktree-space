import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertCircle, Check, ChevronRight, FolderClosed, FolderGit, FolderGit2, GitPullRequest, Loader2, Plus, RefreshCw, Search, X } from "./icons"
import { format, useT } from "../lib/i18n"
import { sumLines } from "../lib/lines"
import { errorText } from "../lib/error-text"
import { previewValue, subscribePreview } from "../lib/config-preview"
import { mapWithLimit } from "../lib/concurrency"
import { cleanPath, isInsideDirectory, sameLocation, slashPath } from "../lib/paths"
import { addRepositorySource } from "../lib/repositories"
import { rememberedRepositories, scannedRepositories } from "../lib/scan"
import { groupTasks, type TaskGroup, type TaskRepository } from "../lib/tasks"
import type { RememberedScan, LineChanges, SourceRootClassification, UpstreamStatus, Workspace, Worktree, WorktreeList, WorkspacesService, WorkspaceNavigation } from "../lib/types"
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client"
import { AddRepositoryDialog } from "./AddRepositoryDialog"
import { ArchiveTaskDialog } from "./ArchiveTaskDialog"
import { LineCounts } from "./LineCounts"
import type { ConfigFormLike } from "./PluginConfigCard"
import { DeployCard } from "./DeployCard"
import { finishScenes } from "../lib/finish-scene"
import { Button, Input, Select } from "./ui"

/** The three views this page has, in the order they are offered: a Workspace is where a
 *  task space starts from, a repository is what one is opened across, a task space is
 *  what the page then has to keep an eye on. Finishing a task is the last of the three,
 *  so it is offered last rather than first. */
export const WORKTREE_VIEWS = [['spaces', 'viewWorkspaces'], ['repos', 'viewRepositories'], ['tasks', 'viewTasks']] as const
export type WorktreeView = (typeof WORKTREE_VIEWS)[number][0]

/**
 * The same three views as the navigation column's rows.
 *
 * The label comes back as a copy key, because the column is a component and resolves it
 * through the locale; the pair travels together so a host drawing its own switcher and
 * the column cannot offer the views in different orders.
 * @returns one `{ value, label }` per view, in the order they are offered.
 */
export function worktreeNavItems() {
  return WORKTREE_VIEWS.map(([value, label]) => ({ value, label: label as string }))
}

interface Props {
  api: any
  workspaces: WorkspacesService
  uiWorkspace: WorkspaceNavigation
  sessions: ISessions
  /**
   * Opens the host's directory chooser, or undefined when this deployment has none.
   *
   * Both "add a Workspace" and "add a repository" name a directory on the Host, and the
   * Host already mounts a picker for exactly that - the same one its own Workspace flow
   * uses. Passing it in keeps this component free of the client root and lets a test
   * drive the browse step without one.
   */
  pickDirectory?: () => Promise<string | null>

  onCreate?: (target: Pick<Workspace, "path" | "title">) => void
  /**
   * The view and its setter, for a host that offers the switcher itself — the main
   * panel has a nav column of its own, so the toolbar keeps only the filters.
   * Left out, the section holds the view and renders the switcher in its toolbar.
   */
  control?: { view: WorktreeView; onView: (view: WorktreeView) => void }
  /**
   * The host's own way out of the page, handed to the finish dialog: following a
   * session there has to leave the page too, or it covers the conversation. The panel
   * passes its way back to the conversation, the dialog passes its close.
   */
  onLeave?: () => void
  /**
   * This plugin's configuration form, when the shell serves one, for the finish dialog's
   * full-access switch. Left out, the dialog still says which state is in force - it reads
   * that from the Host - and simply does not offer the way to change it from there.
   */
  config?: ConfigFormLike
}
type Filter = "all" | "attention"
/** The filters both views offer: everything found, or only what needs attention. */
const FILTERS = [['all', 'filterAll'], ['attention', 'filterAttention']] as const
const repoName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/**
 * Worktrees asked about at once.
 *
 * Each one is a `git` process on the Host - `status` and a `rev-list` - so the
 * ceiling is on how many are in flight, not on how fast they answer. Six is the
 * same figure the Host scans with, so the two stages of one refresh add up to a
 * known load instead of to each other.
 */
/**
 * A fetch failure in the reader's words, with git's own sentence kept for the hover.
 *
 * git answers a failed fetch with its own vocabulary - `transport 'file' not
 * allowed`, `Could not read from remote repository`, `E3003: ... exceeded its
 * deadline` - and none of it says what the reader can do. These three buckets are
 * the ones that actually happen: no remote to reach, the remote refused, and the
 * clock ran out. Anything else falls back to the first, which is true of every
 * failure this call can produce in the sense that matters: the numbers are local.
 * @param error - the message the Host carried back.
 * @param t - the copy resolver.
 * @returns a sentence for the hover, and the word for the row.
 */
function fetchFailureText(error: string, t: (key: string) => string) {
  const text = error.toLowerCase()
  if (/timed out|deadline|e3003/.test(text)) return t("fetchFailedTimeout")
  if (/could not read from remote|no such remote|does not appear to be a git repository|not found/.test(text)) return t("fetchFailedUnreachable")
  if (/permission denied|authentication|credentials|publickey|access denied/.test(text)) return t("fetchFailedDenied")
  return t("fetchFailedGeneric")
}

/**
 * The two changing sets of a group, added into one pair.
 *
 * A collapsed row answers "how much is this carrying" in one number, so the committed
 * and uncommitted halves are summed rather than drawn as two pairs: the pair is a
 * magnitude, and splitting it made the row say the same thing twice. Either half may be
 * absent - git could not measure it - and the other still counts, which is why this adds
 * whatever is there rather than requiring both. The file count is summed the same way,
 * and stays absent when neither half reported one.
 * @param group - the task or Workspace whose totals are being drawn.
 * @returns the summed pair.
 */
function totalLines(group: { committedChanges?: LineChanges; workingChanges?: LineChanges }): LineChanges {
  return sumLines(group.committedChanges, group.workingChanges)
}

/**
 * The line counts under a worktree row, in the order a finish reads them.
 *
 * Committed first, because that is what a merge would carry; the uncommitted half
 * follows, because that is the other thing deciding whether a finish can proceed.
 */
function ChangeSummary({ committed, working, committedHint, workingHint }: {
  committed?: LineChanges
  working?: LineChanges
  committedHint?: string
  workingHint?: string
}) {
  const t = useT()
  return (
    <div className="dws-worktree-changes">
      <span className="dws-changes-label">{t("committedChangesLabel")}</span>
      <LineCounts changes={committed} hint={committedHint ?? t("committedChangesHint")} />
      <span className="dws-changes-label">{t("workingChangesLabel")}</span>
      <LineCounts changes={working} hint={workingHint ?? t("workingChangesHint")} />
    </div>
  )
}

/**
 * The base branch a worktree is measured against, and what the measurement is.
 *
 * One component for the three views that show a worktree row, because the numbers
 * and the branch they belong to have to stay one answer: a row that named the base
 * but not the counts, or the counts under a different branch, would read as two
 * independent facts. Both ends of the comparison are named whenever the caller has
 * both: one name on its own left the reader to guess what the counts were measured
 * against, which is the question a comparison is asked to answer.
 */
function BranchDetail({ currentBranch, currentLabel, baseBranch, baseLabel, ahead, behind, aheadHint, behindHint, committedChanges, workingChanges }: {
  /**
   * The branch the comparison starts from, when the row should name both ends.
   *
   * A row that shows only the far end leaves the reader guessing which pair of branches
   * the counts describe: "origin/main" beside a Workspace, or "main" beside a task's
   * branch, is one branch out of two. Absent means the far end alone is enough - the
   * rows that have no second name to give.
   */
  currentBranch?: string
  /** The word in front of {@link currentBranch}, defaulting to "current branch". */
  currentLabel?: string
  baseBranch?: string
  /** The word in front of the branch, defaulting to "base branch". */
  baseLabel?: string
  ahead: number
  behind: number
  /**
   * What the two counts mean for this row, when it is not the task/base case.
   *
   * A source repository is compared with its remote-tracking branch, not with another
   * local one, so the task wording is wrong there - and the numbers travel with the
   * sentence, which is why the hints come in with the row rather than being looked up
   * from a constant inside this component.
   */
  aheadHint?: string
  behindHint?: string
  committedChanges?: LineChanges
  workingChanges?: LineChanges
}) {
  const t = useT()
  const label = baseLabel ?? t("baseBranchLabel")
  const currentWord = currentLabel ?? t("currentBranchLabel")
  const aheadText = format(aheadHint ?? t("aheadHint"), { count: String(ahead) })
  const behindText = format(behindHint ?? t("behindHint"), { count: String(behind) })
  return (
    <>
      {currentBranch === undefined ? null : <span className="dws-branch-label dws-current-branch" title={`${currentWord}: ${currentBranch}`}>
        <span className="dws-branch-name">{currentWord}：</span>
        <span className="dws-branch-value">{currentBranch}</span>
      </span>}
      <span className="dws-branch-label dws-base-branch" title={`${label}: ${baseBranch ?? t("branchesDiffer")}`}>
        <span className="dws-branch-name">{label}：</span>
        <span className="dws-branch-value">{baseBranch ?? t("branchesDiffer")}</span>
      </span>
      {ahead > 0 || behind > 0 ? <span className="dws-ahead-behind" title={`${aheadText} · ${behindText}`}>
        <span className="dws-ahead">↑ {ahead}</span>
        <span className="dws-behind">↓ {behind}</span>
      </span> : null}
    </>
  )
}

const STATUS_CONCURRENCY = 6
const relativePath = (repoPath: string, path: string) => path.startsWith(`${repoPath}/`) ? path.slice(repoPath.length + 1) : path

export function WorktreesSettings({ api, workspaces, uiWorkspace, sessions, pickDirectory, onCreate, control, onLeave, config }: Props) {
  const t = useT()
  const [ownView, setOwnView] = useState<WorktreeView>("spaces")
  const view = control?.view ?? ownView
  const setView = control?.onView ?? setOwnView
  const [repos, setRepos] = useState<WorktreeList[]>([])
  const [busy, setBusy] = useState(false)
  // What the Host last reported as in force, kept apart from the pending choice so
  // that one can outrank the other without erasing it: once a choice is gone -
  // accepted or refused - the Host's answer is the truth again.
  const [servedDepth, setServedDepth] = useState<number | null>(null)
  // The depth on screen, and the one sent with the scan.
  //
  // Derived rather than stored, because a stored copy is a copy that can go stale:
  // the number has to be right from a scan's first millisecond, and the two things
  // that can change it mid-scan - a pending choice, and the Host answering a call
  // that was already in flight - both land while the scan is still running.
  //
  // Pending choice first, then what the Host last reported. The Host still answers
  // every scan with what it really used, because `resolveScanDepth` can clamp what
  // it is given; that answer becomes the served value for the next scan.
  const intendedDepth = () => {
    const pending = previewValue("scanDepth")
    if (typeof pending === "string" && pending.trim() !== "") {
      const parsed = Number(pending)
      if (Number.isFinite(parsed)) return parsed
    }
    return servedDepth
  }
  const [error, setError] = useState("")
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  // The rows the user has opened. Empty is the page's opening state: every foldable row
  // starts folded, because these views are lists of repositories and one Workspace with a
  // dozen under it unfolded would push the other Workspaces off the screen.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  // What each Workspace is, once asked: whether a task space can start there, and
  // how many repositories it would span. Filled when the view is opened.
  //
  // The results must not be a dependency of this effect: writing "checking" would
  // change them, re-run the effect, and abort the very requests whose answers it is
  // waiting for - which left every row saying so forever.
  const [classifications, setClassifications] = useState<Record<string, SourceRootClassification | "checking" | "failed">>({})
  /**
   * Each source repository's comparison with its remote-tracking branch.
   *
   * Keyed by repository path and filled in after the Workspaces are classified,
   * because the repositories only become known then. A repository that tracks no
   * branch answers `upstream: null`, which is a fact about it rather than a failure,
   * so it is stored like any other answer.
   */
  const [upstreams, setUpstreams] = useState<Record<string, UpstreamStatus>>({})
  // Bumped to ask the classification effect below to start over. Its cache of
  // already-asked paths is scoped to one run of the effect, so a new run asks every
  // Workspace again - which is the point when what changed was the scan depth, since
  // every one of those counts depends on it.
  const [reclassifyToken, setReclassifyToken] = useState(0)
  useEffect(() => {
    if (view !== "spaces") return
    const controller = new AbortController()
    // Only the Workspaces this run has not already answered for. Re-asking the whole
    // list every time one is added would put every other row back to "checking",
    // which is its own kind of wrong: a row claiming to be unexamined when it was
    // examined a moment ago is no better than one claiming to be unreadable.
    const answered = new Set<string>()
    const classifyMissing = () => {
      const items = workspaces.list.getSnapshot().items as Workspace[]
      const pending = items.map(workspace => workspace.path).filter(path => !answered.has(path))
      if (pending.length === 0) return
      for (const path of pending) answered.add(path)
      setClassifications(current => ({ ...current, ...Object.fromEntries(pending.map(path => [path, "checking" as const])) }))
      // One request for the page rather than one per row. Every path is still
      // walked now and answered now - nothing is carried over from the last time
      // this ran - so this is one round trip instead of N, not a cheaper answer.
      //
      // A path the Host left out failed, and says so on its own: the answer omits
      // what it could not read rather than reporting it as empty, because a row
      // with no answer is drawn unreadable, which is a claim about the read, while
      // a row reading zero is a claim about the Workspace, and only one of those
      // rules the Workspace out.
      void api.classifyRoots(pending, controller.signal).then((classified: SourceRootClassification[]) => {
        if (controller.signal.aborted) return
        const answered = new Map(classified.map(entry => [entry.path, entry] as const))
        setClassifications(current => ({
          ...current,
          ...Object.fromEntries(pending.map(path => [path, answered.get(path) ?? "failed"] as const)),
        }))
      }).catch(() => {
        if (controller.signal.aborted) return
        setClassifications(current => ({
          ...current,
          ...Object.fromEntries(pending.map(path => [path, "failed" as const])),
        }))
      })
    }
    // Subscribed rather than run once. Registering a Workspace is what makes the list
    // grow, and a row with no answer is drawn as "cannot check" — so a row added from
    // this page stays wrong until the view is left and come back to. The refresh
    // button rescans repositories; this is not that, and never was.
    classifyMissing()
    const dispose = workspaces.list.subscribe(() => classifyMissing())
    return () => { controller.abort(); dispose() }
  }, [view, api, workspaces, reclassifyToken])
  /**
   * Ask each source repository how it compares with its remote-tracking branch.
   *
   * Run after classification has named the repositories, and only in the view that
   * shows them: this is a second round of git calls, and the two other views never
   * draw a source repository's own comparison. One request per repository, bounded
   * like every other per-row read on this page.
   */
  /**
   * One repository's remote answer, found by location rather than by spelling.
   *
   * The two halves of this page name a repository differently: classification answers
   * with the path the Host resolved (`D:\work\repo`), while the row that draws it
   * holds the path the scan reported (`D:/work/repo`). Looking the answer up by the
   * raw string therefore missed every time, and every row fell through to "no
   * upstream" - which is exactly what a reader sees for a repository that has one.
   *
   * `slashPath` is the panel's existing "one location, one spelling" for display, and
   * `sameLocation` is the comparison it uses for identity; this folds both sides the
   * same way and then compares with `sameLocation`, so Windows case folding is not
   * reinvented here.
   */
  const upstreamOf = (path: string) => {
    const direct = upstreams[path]
    if (direct !== undefined) return direct
    const key = Object.keys(upstreams).find(entry => sameLocation(entry, path))
    return key === undefined ? undefined : upstreams[key]
  }

  /**
   * The repositories the classification has named so far, as one stable string.
   *
   * The effect below keys on this rather than on the `classifications` object
   * itself. Classification writes that object twice per run - every path set to
   * "checking", then the answers - and each write is a new object, so an effect
   * depending on it was torn down and restarted in the middle of its own requests.
   * Every fetch takes seconds, so the restart always won and no answer ever landed:
   * the rows stayed on "no upstream" for repositories that have one.
   *
   * A joined path list changes only when the set of repositories does, which is the
   * thing the requests actually depend on.
   */
  const upstreamPaths = useMemo(() => [...new Set(
    Object.values(classifications)
      .flatMap(entry => entry === "checking" || entry === "failed" ? [] : entry.repositories.map(repo => repo.path)),
  )].join("\n"), [classifications])
  /**
   * The paths already asked about, and the answer for each.
   *
   * A ref rather than state for the "already asked" half: recording it in state
   * would re-render the page for a fact no row draws, and a re-render is what
   * restarted the effect this hook is here to keep still. The answers live in
   * `upstreams`; this only remembers which paths are settled, so a second run of
   * the effect does not re-fetch them.
   */
  const askedPaths = useRef<Set<string>>(new Set())
  useEffect(() => {
    // Deliberately not keyed on `view`. The answers are about repositories, not about
    // which tab is showing, and a request cancelled by a tab switch threw away work
    // the Host had already done - sixty milliseconds of `git` per repository, and the
    // reader got nothing for it. Fetching regardless means the numbers are ready
    // before the reader switches back, and the state survives the tab that does not
    // draw them.
    if (upstreamPaths === "") return
    const wanted = upstreamPaths.split("\n").filter(path => !askedPaths.current.has(path))
    // Nothing new to ask: a re-render caused by something else entirely must not
    // start another round of requests.
    if (wanted.length === 0) return
    let live = true
    void (async () => {
      // Phase one: compare against the refs already on disk, and paint that at once.
      // This is one `git` per repository and no network, so the rows fill in
      // immediately. It is also the answer that stands if the remote cannot be
      // reached, which is why it is not a placeholder to be replaced later.
      const local = await mapWithLimit(wanted, STATUS_CONCURRENCY, async (path) => {
        try { return [path, await api.upstream(path)] as const }
        catch { return undefined }
      })
      if (!live) return
      const first = local.filter(entry => entry !== undefined)
      for (const [path] of first) askedPaths.current.add(path)
      if (first.length > 0) setUpstreams(current => ({ ...current, ...Object.fromEntries(first) }))

      // Phase two: ask the Host to refresh each remote, then repaint. Only the two
      // counts can move - the branch name, the line totals and whether the branch
      // tracks anything are facts about the checkout, not about the remote - so a
      // fetch that turns up nothing new changes nothing on screen.
      //
      // Sequenced one repository at a time: this is a network round trip per
      // repository, and firing them together makes the slowest remote's timeout the
      // wall-clock of the whole page for no gain.
      const fetched: Array<readonly [string, UpstreamStatus]> = []
      for (const path of wanted) {
        if (!live) return
        try { fetched.push([path, await api.upstream(path, undefined, true)] as const) }
        catch { /* the local answer above stands */ }
      }
      if (!live || fetched.length === 0) return
      // A fetch that moved no remote-tracking ref answers `changed: false`, and the
      // numbers on screen already describe the same state. Repainting them would be a
      // render for a value that cannot have changed - the common case on a repository
      // nobody else pushes to.
      const moved = fetched.filter(([, answer]) => answer.changed !== false)
      if (moved.length === 0) return
      setUpstreams(current => {
        const next = { ...current }
        for (const [path, answer] of moved) {
          // Looked up by location, not by spelling: the key stored in phase one came
          // from the same string, but a second phase that guessed wrong would add a
          // duplicate entry beside it rather than replace it.
          const key = Object.keys(next).find(entry => sameLocation(entry, path)) ?? path
          next[key] = answer
        }
        return next
      })
    })()
    return () => { live = false }
  }, [api, upstreamPaths])
  /** Path of the task whose archive dialog is open, if any. */
  const [archiving, setArchiving] = useState<string | null>(null)
  /** Path of the task whose add-repository dialog is open, if any. */
  const [extending, setExtending] = useState<string | null>(null)
  // Adding a repository to the repository view. The field is here rather than in a
  // dialog of its own because it is one path and one button: the whole of what it
  // does is register a Workspace, and a dialog would be a window around that.
  const [addingSource, setAddingSource] = useState(false)
  const [sourcePath, setSourcePath] = useState("")
  const [sourceError, setSourceError] = useState("")
  // Kept apart from `sourceError` because it is not one: the repository the user
  // named is in the list already, which is what they asked for, so it is drawn in
  // the warn colour and announced as a status rather than interrupting them as a
  // failure. A field that stays open under a red error tells the reader the last
  // thing they did was wrong; it was not.
  const [sourceNotice, setSourceNotice] = useState("")
  const [sourceBusy, setSourceBusy] = useState(false)
  const [addingSpace, setAddingSpace] = useState(false)
  const [spacePath, setSpacePath] = useState("")
  const [spaceError, setSpaceError] = useState("")
  const [spaceBusy, setSpaceBusy] = useState(false)
  // A finish that stopped at a conflict left its report behind, and the session it
  // handed on lives in a view of its own: coming back reopens that report, so the user
  // continues from where they were instead of finding the task and starting over.
  useEffect(() => {
    setArchiving((current) => current ?? finishScenes()[0] ?? null)
  }, [])
  const refreshController = useRef<AbortController | null>(null)
  // Whether a scan of this mount has already landed. The remembered answer is
  // painted only until then: once real rows exist, a late-arriving memory must not
  // put back what the scan has just replaced - including an empty result.
  const paintedFresh = useRef(false)
  /**
   * Rescan the Workspaces.
   *
   * `extra` names paths to scan even if the Workspace list has not published them
   * yet. Creating a Workspace resolves before the registry's snapshot catches up,
   * so scanning the snapshot alone leaves the repository the user just added off
   * the page until the next refresh — the path is known exactly, so it is scanned
   * rather than waited for.
   */
  /**
   * The finish press: open the dialog, and nothing else.
   *
   * The delivery gate used to be asked here, by reading a deployment status and comparing
   * it to the policy before the dialog was allowed to open. That pre-check was wrong in two
   * ways, and both of them trapped the user rather than the model:
   *
   * - It asked a *different* question from the gate. It required a state file to exist
   *   before it would even warn (`status.stateFound`), so a task whose deploy script never
   *   wrote one - the commonest shape of "no passing smoke" - opened the dialog with no
   *   warning and no acknowledgement, and the finish was then refused with E5006 and no way
   *   for the user to answer. The gate itself treats a missing file and a red smoke as the
   *   same answer.
   * - It only ran on this one entry. The workspace menu's own finish item opens the dialog
   *   directly, and so does the report left behind by a finish that stopped - both bypassed
   *   the question entirely, and both were then refused.
   *
   * The gate is a warning to the user, never a wall: the panel's job is to say what is
   * missing and let them go on, and the Host records the overrule. So the question belongs
   * to the dialog, which every entry reaches, and it is answered there from the plan the
   * Host computes with the gate's own function. This function now only opens the door.
   */
  const finishClick = useCallback(async (task: TaskGroup) => {
    setArchiving(task.path)
  }, [])

  const refresh = useCallback(async (extra: string[] = []) => {
    refreshController.current?.abort()
    const controller = new AbortController()
    refreshController.current = controller
    setBusy(true); setError("")
    try {
      const registered = workspaces.list.getSnapshot().items.map((workspace: Workspace) => workspace.path)
      const paths = extra.reduce((all, path) => (all.some((known) => sameLocation(known, path)) ? all : [...all, path]), registered)
      // The number that goes on screen goes into the request, so the walk and the
      // label are one decision rather than two that can disagree. Null when the
      // panel has not been told yet, and then the Host falls back to its own
      // configuration - which is the same thing said more slowly.
      const depth = intendedDepth()
      const answer = await api.scan(paths, controller.signal, depth ?? undefined)
      if (controller.signal.aborted) return
      // What the Host actually walked, which is what it resolved the request to.
      // A clamp here is the one case where the label was briefly ahead of the
      // walk, and adopting it keeps the next scan honest.
      setServedDepth(answer.bounds.depth)
      // An incomplete answer is still an answer. The repositories that were read
      // go on screen and the reason goes beside them; the error path below is for
      // when there is nothing to show at all, which is the only case where an
      // error and an empty list are the same thing to a reader.
      setError(answer.complete ? "" : answer.reason)
      const discovered = scannedRepositories(answer.lists)
      paintedFresh.current = true
      setRepos(discovered.map(list => ({ ...list, worktrees: list.worktrees.map(row => ({ ...row, checking: true })) })))
      // Flattened, because the limit has to mean something concrete: every entry
      // here is a `git` process on the Host, and a ceiling counted in
      // repositories would let one repository with twenty worktrees spend twenty
      // times what a repository with one does. The nesting this replaced put no
      // bound on anything - every worktree of every repository was asked for at
      // once, which is the same crowd arriving faster, not less work.
      const wanted = discovered.flatMap((list, repo) =>
        list.worktrees.map(row => ({ repo, row, target: list.currentBranch })))
      const answered = await mapWithLimit(wanted, STATUS_CONCURRENCY, async ({ repo, row, target }) => {
        try { return { repo, row: { ...row, ...(await api.status(row.path, target, controller.signal)) } } }
        catch (reason: any) { return { repo, row: { ...row, statusError: errorText(t, reason) } } }
      })
      const byRepo = new Map<number, WorktreeList["worktrees"]>()
      for (const { repo, row } of answered) {
        const rows = byRepo.get(repo)
        if (rows === undefined) byRepo.set(repo, [row])
        else rows.push(row)
      }
      const next = discovered.map((list, repo) => ({ ...list, worktrees: byRepo.get(repo) ?? [] }))
      if (!controller.signal.aborted) setRepos(next)
    } catch (reason: any) {
      if (!controller.signal.aborted) setError(errorText(t, reason))
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }, [api, workspaces, t])
  // A scan setting that changes while the panel is open has to reach the panel.
  //
  // Without this the depth control answers nothing: the scan only re-ran on mount,
  // on a Workspace being added, and on the refresh button, so choosing a different
  // depth left the previous scan's rows and counts on screen. "The setting does not
  // work" and "the panel did not look again" look identical from here, and the first
  // is the conclusion everyone reaches - which is how a depth that was wired up
  // correctly still read as broken.
  //
  // What is watched is the *pending* choice, not the served value: the Host has not
  // applied it yet at this point, and the preview is dropped the moment it does.
  // So the settle that follows a successful write is not a second change, and a
  // refused write is not a change at all.
  useEffect(() => {
    const fields = ['scanDepth', 'maxScanDirectories', 'ignoredScanDirectories', 'removedScanDirectories']
    const acted = new Map<string, string>()
    return subscribePreview(() => {
      for (const field of fields) {
        const value = previewValue(field)
        if (value === undefined || acted.get(field) === value) continue
        acted.set(field, value)
        void refresh()
        // Both halves have to be asked again: the repository list comes from
        // `worktree.scan`, the count on each Workspace card from
        // `task.classify-roots`, and they are separate requests over separate walks.
        // Refreshing only the first leaves the cards showing the depth that was in
        // force when they were last asked.
        setReclassifyToken((current) => current + 1)
        return
      }
    })
  }, [refresh])
  // The panel is unmounted whenever it is closed, so every opening starts here.
  // It paints what the Host remembers of the last scan - which is the whole point
  // of that memory - and scans again regardless: the remembered rows are replaced
  // the moment the fresh answer lands, so a stale list costs one repaint at most.
  useEffect(() => {
    const controller = new AbortController()
    const paths = workspaces.list.getSnapshot().items.map((workspace: Workspace) => workspace.path)
    void api.cachedScan(paths, controller.signal).then((remembered: RememberedScan | null) => {
      if (!remembered || controller.signal.aborted) return
      // Taken whether or not any rows came back, because the two are unrelated
      // facts: what the Host remembers is about the scan that already happened,
      // and this is about the one on screen now. Skipping it when the repaint is
      // skipped is how a panel with nothing remembered ends up unable to name the
      // depth of its first scan.
      setServedDepth(remembered.current.depth)
      // The remembered rows are still a shortcut, never a fallback: an empty list
      // paints nothing, which is what a Host that remembers nothing deserves.
      if (paintedFresh.current || remembered.repositories.length === 0) return
      setRepos(rememberedRepositories(remembered))
    }).catch(() => {
      // Remembered rows are a shortcut, never a fallback the panel depends on: a
      // Host that cannot answer leaves it with the scan already under way.
    })
    void refresh()
    return () => {
      controller.abort()
      refreshController.current?.abort()
    }
  }, [api, workspaces, refresh, t])

  // Committed work the merge target does not have is something to act on even
  // though the working tree is clean, which is why it counts as attention.
  const needsAttention = (row: Worktree) => !!(row.changedFiles || row.commits || row.locked || row.prunable || (row.statusError && !row.checking))
  const needle = query.trim().toLocaleLowerCase()
  /**
   * Whether a value is one the search is looking for.
   *
   * The one test every row in all three views shares, so that a repository, a
   * worktree under it, and a task space are matched by the same rule rather than
   * by three rules that agree today.
   */
  const mentions = (...values: (string | undefined)[]) =>
    needle === "" || values.some(value => value?.toLocaleLowerCase().includes(needle))

  /** The worktrees of a repository a search is on screen, and no others. */
  const visibleWorktrees = (repo: WorktreeList) =>
    needle === "" ? repo.worktrees : repo.worktrees.filter(row => mentions(row.path, row.branch))

  /** The repositories of a task space a search is on screen, and no others. */
  const visibleTaskRepositories = (task: TaskGroup) =>
    needle === "" ? task.repositories : task.repositories.filter((repository: TaskRepository) => mentions(repository.path, repository.name))

  const visibleRepos = repos.filter(repo => {
    if (filter === "attention" && !repo.worktrees.some(needsAttention)) return false
    return mentions(repo.repoPath, repo.currentBranch, ...repo.worktrees.flatMap(row => [row.path, row.branch]))
  })
  const totalWorktrees = repos.reduce((count, repo) => count + repo.worktrees.length, 0)
  // Counted after the same filter the rows are drawn with, or the summary reports a
  // larger number than the list holds - and a count that disagrees with what is on
  // screen is the one thing a reader cannot tell from the screen alone.
  const shownWorktrees = visibleRepos.reduce((count, repo) => count + visibleWorktrees(repo).length, 0)
  /** `shown / total` while something narrows the list, the total alone otherwise. */
  const counted = (shown: number, total: number) => (shown === total ? String(total) : `${shown} / ${total}`)
  // The same two filters in both views: every task holds worktrees by
  // definition, so a "has worktrees" filter has nothing to say in either.
  const statusLabel = (row: Worktree) => {
    if (row.checking) return t("checkingStatus")
    if (row.statusError) return /worktree-unavailable|ENOENT|No such file/i.test(row.statusError) ? t("unavailable") : row.statusError
    if (row.changedFiles) return format(t("dirty"), { count: String(row.changedFiles) })
    if (row.prunable) return t("prunable")
    return t("clean")
  }
  // A clean working tree can still hold a branch's worth of committed work that has
  // not been merged back, so this rides beside the status rather than inside it.
  const pendingBadge = (commits: number | undefined) => commits
    ? <span className="dws-status dws-status-pending" title={t("pendingHint")}><span className="dws-status-dot" />{format(t("pending"), { count: String(commits) })}</span>
    : null
  const toggleRepo = (path: string) => setExpanded(previous => {
    const next = new Set(previous)
    if (next.has(path)) next.delete(path); else next.add(path)
    return next
  })
  // A repository still being read is flagged as such, so a read in flight is not
  // reported as a read that could not be answered.
  //
  // Grouping walks every repository and every worktree, and it answered to nothing
  // that had changed since the last render — the search box below re-renders this on
  // every keystroke while asking a question only the query affects. So the grouping
  // is derived from the scan and the narrowing is left to the filter under it.
  const tasks = useMemo(() => groupTasks(repos), [repos])
  // A task needs attention when any of its repositories does, which is the same
  // condition the repository view filters on, one level up.
  const taskNeedsAttention = (task: TaskGroup) => task.changedFiles > 0 || task.commits > 0 || task.lockedRepositories > 0 || task.prunableRepositories > 0 || task.unknownRepositories > 0
  const visibleTasks = tasks.filter(task => {
    if (filter === "attention" && !taskNeedsAttention(task)) return false
    return !needle || [task.name, task.path, task.branch, ...task.repositories.map(repository => repository.path)].some(value => value?.toLocaleLowerCase().includes(needle))
  })
  const taskRepositoryCount = tasks.reduce((count, task) => count + task.repositories.length, 0)
  const shownTaskRepositoryCount = visibleTasks.reduce((count, task) => count + visibleTaskRepositories(task).length, 0)
  // Declared before the fold button below, which reads it: the three views share one
  // set of opened paths, and the Workspace rows are in it now that they expand.
  const workspaceItems = workspaces.list.getSnapshot().items as Workspace[]
  /**
   * Which Workspace owns each repository (`owner`), and which repositories each one
   * owns (`under`).
   *
   * Containment alone is not enough. A Workspace registered inside another one -
   * `E:\workspace\public` under `E:\workspace` - contains every repository under the
   * inner one, so listing by containment showed those repositories twice: once
   * under the Workspace that actually scanned them, and once under the parent that
   * reached them only by walking through. The parent then had two numbers that
   * disagreed - a badge from `classify-roots`, which does not skip the nested
   * Workspace, and a list from the scan, which does - and no way on the page to tell
   * which of the two was the real one.
   *
   * One owner settles it. The Host no longer walks the nested path as part of its
   * parent either, so the parent's badge and its list are counting the same set.
   *
   * The answer and its reverse are derived in the same pass and remembered together:
   * a Workspace row asks what it owns on every render, and a render is every
   * keystroke of the search box. A Workspace of ninety-odd repositories against a
   * handful of Workspaces is a few thousand comparisons per character typed, for an
   * answer that only the scan and the Workspace list can change - so it is derived
   * from exactly those two, and the search keeps its own filter over the result.
   */
  const owned = useMemo(() => {
    const owner = new Map<string, string>()
    const under = new Map<string, WorktreeList[]>()
    const bySpecificity = [...workspaceItems].sort((left, right) => right.path.length - left.path.length)
    for (const repo of repos) {
      for (const workspace of bySpecificity) {
        if (sameLocation(repo.repoPath, workspace.path) || isInsideDirectory(workspace.path, repo.repoPath)) {
          owner.set(cleanPath(repo.repoPath), workspace.path)
          const list = under.get(workspace.path)
          if (list === undefined) under.set(workspace.path, [repo])
          else list.push(repo)
          break
        }
      }
    }
    return { owner, under }
  }, [repos, workspaceItems])
  /**
   * The repositories a Workspace spans, as the scan found them.
   *
   * Taken from the scan rather than from the number the classification reports,
   * because those are two different answers and a Workspace reading "12
   * repositories" must expand to those twelve and not to some other set. The scan
   * and the classification are two walks over the same bounds - the classification
   * counts through `discoverSourceRepos`, the scan lists through
   * `discoverGitRoots` - and both prune a nested Workspace the same way, so what
   * this returns is what the badge counted.
   *
   * One Workspace each, and the most specific one: a repository under a Workspace
   * registered inside this one belongs to the inner Workspace and is not listed here.
   * See `owned` for why it cannot be both. The lists are built in the order the scan
   * returned them, which is the order the rows were listed in.
   *
   * An arrow rather than a declaration because `collapsiblePaths` below reads it while
   * the component body is still being built, and a `const` read above its own
   * definition throws at runtime without `tsc` noticing: the file used a hoisted
   * function here, and nothing says it has to stay one.
   * @param workspace - the Workspace whose repositories to list.
   * @returns the repositories under it, in the order the scan returned them.
   */
  const repositoriesUnder = (workspace: Workspace) => owned.under.get(workspace.path) ?? []
  // One set of opened paths drives all three views, so the button beside the filters
  // says what the next click does to everything on the page.
  const collapsiblePaths = [
    ...visibleRepos.filter(repo => repo.worktrees.length > 0).map(repo => repo.repoPath),
    ...visibleTasks.filter(task => task.repositories.length > 0).map(task => task.path),
    // Workspaces too, now that they expand: the button says what the next click does
    // to everything on the page, and leaving the third view out makes it lie about
    // the view the user is looking at.
    ...workspaceItems.filter(workspace => {
      const answer = classifications[workspace.path]
      return answer !== undefined && answer !== "checking" && answer !== "failed" && repositoriesUnder(workspace).length > 0
    }).map(workspace => workspace.path),
  ]
  // Whether every foldable row is open, which is what the button beside the filters
  // turns on and off. An empty page has nothing open, so it offers to open everything.
  const everythingExpanded = collapsiblePaths.length > 0 && collapsiblePaths.every(path => expanded.has(path))
  const toggleAll = () => setExpanded(everythingExpanded ? new Set() : new Set(collapsiblePaths))
  /**
   * Whether a row is unfolded.
   *
   * The user's own clicks are the only thing that opens a row, and one exception: while a
   * search is narrowing the page, the matches inside a row are shown, because a row kept
   * for a repository that then hides it says the search found something it does not show.
   * @param path - the row's own path, which is the key of the opened set.
   * @returns whether the row's contents are on screen.
   */
  const isOpen = (path: string) => needle !== "" || expanded.has(path)
  // A search is asked two separate questions - which Workspaces to keep, and which
  // of each one's repositories to list inside it - so both read the one `needle`.
  const visibleWorkspaces = workspaceItems.filter(workspace => {
    const state = classifications[workspace.path]
    const ready = state !== undefined && state !== "checking" && state !== "failed"
    // The filter keeps the Workspaces that hold a repository, which is exactly the
    // question the row's own badge answers - and it asks the same list the badge
    // counts, so the two can never disagree about which Workspaces are empty.
    // One that has not answered yet stays visible rather than disappearing for the
    // length of a scan.
    if (filter === "attention" && ready && repositoriesUnder(workspace).length === 0) return false
    if (needle === "") return true
    return workspace.title.toLowerCase().includes(needle) || workspace.path.toLowerCase().includes(needle)
      // A repository the Workspace spans is a thing to search for by name, the same
      // way a task is searchable by the repositories it holds. Without this the
      // row a search matched and the rows it expands to disagree about what the
      // Workspace contains.
      || repositoriesUnder(workspace).some(repo => repo.repoPath.toLowerCase().includes(needle))
  })
  const taskRepoStatus = (repository: TaskRepository) => {
    if (repository.checking) return { state: "checking", label: t("checkingStatus") }
    if (repository.unknown) return { state: "unavailable", label: t("statusUnknown") }
    if (repository.changedFiles) return { state: "dirty", label: format(t("dirty"), { count: String(repository.changedFiles) }) }
    if (repository.prunable) return { state: "prunable", label: t("prunable") }
    return { state: "clean", label: t("clean") }
  }

  /**
   * Register the repository the user typed as a Workspace, which is what puts it
   * in this list at all.
   *
   * Nothing here is a list of ours: the repository view is a scan of the
   * Workspaces, so the entry goes where every other entry comes from and is
   * removed the way every other entry is.
   *
   * Whether it is worth registering is answered by that scan, so the scan's own
   * repository paths are what decides. A repository the last scan already listed
   * is on the page in front of the user: registering it again would put a second
   * Workspace over a directory that already has one, which they would then have to
   * delete by hand. That is a notice and not a failure — nothing is broken, the
   * repository is where they asked for it to be — so it is said once, in the warn
   * colour, with the field left open so a mistyped path can be corrected without
   * starting again.
   */
  /**
   * Ask the host for a directory, and put what it answered into the field.
   *
   * `null` is a cancel and changes nothing: the row stays open with whatever it held,
   * which is what a user who backed out of the chooser expects. A failure is reported
   * in the row's own error line rather than silently - a button that looks dead is the
   * one outcome worth spending a sentence on.
   *
   * @param apply - receives the chosen path, or is not called on a cancel.
   * @param fail - receives the message when the chooser could not be opened.
   */
  const browse = async (apply: (path: string) => void, fail: (message: string) => void) => {
    if (pickDirectory === undefined) return
    try {
      const chosen = await pickDirectory()
      if (chosen !== null && chosen !== "") apply(chosen)
    } catch (reason: any) {
      fail(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const addSource = async () => {
    const path = sourcePath.trim()
    if (path === "" || sourceBusy) return
    setSourceBusy(true)
    setSourceError("")
    try {
      const outcome = await addRepositorySource(api, workspaces, path, repos.map((repo) => repo.repoPath))
      if (!outcome.added) {
        setSourceNotice(t("addRepositoryAlready"))
        return
      }
      setSourceNotice("")
      setSourcePath("")
      setAddingSource(false)
      await refresh([path])
    } catch (reason: any) {
      setSourceError(errorText(t, reason))
    } finally {
      setSourceBusy(false)
    }
  }

  /**
   * Register a directory as a Workspace, the way the user would in DSH's own UI.
   *
   * A Workspace does not have to hold a repository — it may be one the user is
   * about to clone into, or a directory of projects none of which is a repository
   * yet — so this refuses only a path that is not a directory, and leaves the
   * repository judgement to the repository view's own button, which is the one
   * that has to make it.
   */
  const addSpace = async () => {
    const path = spacePath.trim()
    if (path === "" || spaceBusy) return
    setSpaceBusy(true)
    setSpaceError("")
    try {
      const state = await api.classifyRoot(path)
      if (!state.isDirectory) throw new Error(format(t("addWorkspaceNotDirectory"), { path: slashPath(path) }))
      const registered = workspaces.list.getSnapshot().items ?? []
      if (registered.some((workspace: Workspace) => sameLocation(workspace.path, path))) {
        throw new Error(t("addWorkspaceAlready"))
      }
      await workspaces.create({ path })
      setSpacePath("")
      setAddingSpace(false)
      await refresh([path])
    } catch (reason: any) {
      setSpaceError(errorText(t, reason))
    } finally {
      setSpaceBusy(false)
    }
  }

  // The toolbar's pieces, in the two orders the two hosts read them in.
  const viewButtons = WORKTREE_VIEWS.map(([value, label]) => <button key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)}>{t(label)}</button>)
  // What narrows the list is what the list holds. A task and a repository are filtered
  // by what needs attention, because both can be in that state; a Workspace is not a
  // place work happens, it is a place a task space starts from, so the one thing there
  // is to narrow is whether it holds a repository at all.
  const filterButtons = FILTERS.map(([value, label]) => {
    const text = view === "spaces" && value === "attention" ? t("filterWithWorktrees") : t(label)
    return <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{text}</button>
  })
  const foldButton = <button type="button" className="dws-filter-fold" aria-pressed={everythingExpanded} onClick={toggleAll}>{everythingExpanded ? t("collapseAll") : t("expandAll")}</button>
  const divider = <span className="dws-filter-divider" aria-hidden="true">|</span>
  /** Between two runs rather than inside one, so it gets air on both sides. */
  const separator = <span className="dws-filter-divider dws-filter-separator" aria-hidden="true">|</span>

  /** One line per view: what that view holds, and what a row of it can start or finish.
   *  The heading's own line says what the plugin does for a task across repositories;
   *  this answers the narrower question the view switcher just asked. It sits under the
   *  controls because it describes the list they are about to narrow. */
  const viewDescription = view === "spaces" ? t("viewSpacesDescription") : view === "repos" ? t("viewReposDescription") : t("viewTasksDescription")

  // The list is the only thing that scrolls: one reading column holds the toolbar and
  // the filters, and the rows move under them. The heading is the dialog's, from its
  // own header, so the section starts on the toolbar.
  const listBody = view === "repos" || view === "tasks" || view === "spaces"
  return <section className="dws-settings" aria-label={t("worktrees")}>
    <div className="dws-settings-pinned">

      <div className="dws-toolbar">
        <label className="dws-search"><Search size={16} aria-hidden="true" /><Input aria-label={t("searchPlaceholder")} placeholder={t("searchPlaceholder")} value={query} onChange={event => setQuery(event.target.value)} />{query ? <Button className="dws-icon-button" aria-label={t("clearFilters")} onClick={() => setQuery("")}><X size={14} /></Button> : null}</label>
        <Button className="dws-button dws-refresh" aria-label={t("refresh")} title={t("refresh")} disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} className={busy ? "dws-spin" : undefined} />{t("refresh")}</Button>
        {/* Offered only in the repository view: it is this view's list being added
            to, and in the other two the same button would answer a question the
            user is not asking. */}
        {view === "repos" && !addingSource ? <Button className="dws-button dws-add-source-button" disabled={busy} onClick={() => { setSourceError(""); setSourceNotice(""); setAddingSource(true) }}><Plus size={14} />{t("addRepositorySource")}</Button> : null}
        {view === "repos" && addingSource ? <div className="dws-add-source-row">
          {/* The path is a directory on the Host, so it is chosen rather than typed:
              the host mounts a picker for exactly this, and a typed path is the one
              thing here a user can get wrong without noticing. The field stays for the
              case where no picker exists, and shows what was chosen otherwise. */}
          <Input aria-label={t("addRepositorySource")} placeholder={t("addRepositoryManualPlaceholder")} value={sourcePath} autoFocus autoComplete="off" spellCheck={false} onChange={event => setSourcePath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addSource() } }} />
          {pickDirectory === undefined ? null : (
            <Button className="dws-button" disabled={sourceBusy} onClick={() => void browse(setSourcePath, setSourceError)}>{t("browse")}</Button>
          )}
          <Button className="dws-button-primary" disabled={sourceBusy || sourcePath.trim() === ""} onClick={() => void addSource()}>{sourceBusy ? <Loader2 size={14} className="dws-spin" aria-hidden="true" /> : null}{sourceBusy ? t("addingRepository") : t("addRepositoryAdd")}</Button>
          <Button className="dws-icon-button" aria-label={t("cancel")} onClick={() => { setAddingSource(false); setSourcePath(""); setSourceError(""); setSourceNotice("") }}><X size={14} /></Button>
        </div> : null}
        {/* The same offer one level up: a Workspace is a directory the user has
            named, and naming one is DSH's own job, done here because this is where
            the list of them is. It sits next to the refresh rather than with the
            repository button, which is a different act — that one adds a
            repository to a Workspace list this one is what extends. */}
        {view === "spaces" && !addingSpace ? <Button className="dws-button dws-add-source-button" disabled={busy} onClick={() => { setSpaceError(""); setAddingSpace(true) }}><Plus size={14} />{t("addWorkspace")}</Button> : null}
        {view === "spaces" && addingSpace ? <div className="dws-add-source-row">
          {/* Same as the repository row above: a Workspace is a directory the Host
              names, so the Host's own chooser picks it. */}
          <Input aria-label={t("addWorkspace")} placeholder={t("addWorkspacePlaceholder")} value={spacePath} autoFocus autoComplete="off" spellCheck={false} onChange={event => setSpacePath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addSpace() } }} />
          {pickDirectory === undefined ? null : (
            <Button className="dws-button" disabled={spaceBusy} onClick={() => void browse(setSpacePath, setSpaceError)}>{t("browse")}</Button>
          )}
          <Button className="dws-button-primary" disabled={spaceBusy || spacePath.trim() === ""} onClick={() => void addSpace()}>{spaceBusy ? <Loader2 size={14} className="dws-spin" aria-hidden="true" /> : null}{spaceBusy ? t("addingWorkspace") : t("addWorkspaceConfirm")}</Button>
          <Button className="dws-icon-button" aria-label={t("cancel")} onClick={() => { setAddingSpace(false); setSpacePath(""); setSpaceError("") }}><X size={14} /></Button>
        </div> : null}
      </div>
      {sourceError ? <div className="dws-error" role="alert"><AlertCircle size={16} /><span>{sourceError}</span></div> : null}
        {sourceNotice ? <p className="dws-notice" role="status"><AlertCircle size={15} aria-hidden="true" /><span>{sourceNotice}</span></p> : null}
      {spaceError ? <div className="dws-error" role="alert"><AlertCircle size={16} /><span>{spaceError}</span></div> : null}
      <div className="dws-list-controls">
        {/* The dialog form offers the three views here, as it always has, set off from
            the run that follows by the same `|` the filters and the fold button share. */}
        {control === undefined
          ? <><div className="dws-filters" role="group" aria-label={t("viewSwitch")}>{viewButtons}</div>{separator}</>
          : null}
        <div className="dws-filters" role="group" aria-label={t("filters")}>{filterButtons}{divider}{foldButton}</div>
        <span className="dws-summary" {...(view === "tasks" ? { title: format(t("summaryTasksHint"), { tasks: String(tasks.length), worktrees: String(taskRepositoryCount) }) } : {})}>{view === "repos" ? <>{counted(visibleRepos.length, repos.length)} {t("repositories")}<span aria-hidden="true">·</span>{counted(shownWorktrees, totalWorktrees)} {t("worktreeCount")}</> : view === "tasks" ? <>{counted(visibleTasks.length, tasks.length)} {t("taskCount")}<span aria-hidden="true">·</span>{counted(shownTaskRepositoryCount, taskRepositoryCount)} {t("worktreeCount")}</> : <>{counted(visibleWorkspaces.length, workspaceItems.length)} {t("workspaceCount")}</>}</span>
      </div>
      <p className="dws-view-description">{viewDescription}</p>
      {error ? <div className="dws-error" role="alert"><AlertCircle size={16} /><span>{error}</span><Button className="dws-button-ghost" disabled={busy} onClick={() => void refresh()}>{t("retry")}</Button></div> : null}
      {busy ? <div className="dws-loading-message" role="status"><Loader2 size={14} className="dws-spin" /><span>{intendedDepth() === null ? t("scanningUnknown") : format(t("scanning"), { depth: String(intendedDepth()) })}</span></div> : null}
      {!busy && view === "repos" && visibleRepos.length === 0 ? <div className="dws-empty"><FolderGit size={24} strokeWidth={1.5} /><h3>{t("noMatches")}</h3></div> : null}
      {!busy && view === "tasks" && visibleTasks.length === 0 ? <div className="dws-empty"><FolderClosed size={24} strokeWidth={1.5} /><h3>{tasks.length ? t("noMatches") : t("noTasks")}</h3>{tasks.length ? null : <p>{t("noTasksHint")}</p>}</div> : null}
    </div>
    {listBody ? <div className="dws-list-body">
    {busy && repos.length === 0 ? <div className="dws-skeleton-list" aria-hidden="true">{[0, 1, 2].map(index => <div className="dws-skeleton-row" key={index}><span /><div><span /><span /></div></div>)}</div> : null}
    {view === "repos" ? <div className="dws-repo-list">
      {visibleRepos.map(repo => {
        // What the row expands to. A search lists what it matched, not everything
        // the repository holds: the row staying because one worktree matched and
        // then listing all of them says the search found all of them, and the badge
        // beside the name counts the same list, so it has to be counted the same way.
        const listed = visibleWorktrees(repo)
        const canExpand = listed.length > 0
        const open = canExpand && isOpen(repo.repoPath)
        return <article className="dws-repo" key={repo.repoPath}>
          <header className="dws-repo-header">
            <button type="button" className="dws-chevron-toggle" disabled={!canExpand} onClick={() => toggleRepo(repo.repoPath)} aria-expanded={canExpand ? open : undefined} aria-label={`${t("toggleRepository")} ${repoName(repo.repoPath)}`}>{canExpand ? <ChevronRight size={14} className="dws-chevron" /> : <span className="dws-chevron-placeholder" />}</button>
            <FolderGit size={24} className="dws-repo-icon" />
            <span className="dws-repo-heading"><span className="dws-repo-title"><h3>{repoName(repo.repoPath)}</h3><span className="dws-branch-label" title={`${t("currentBranchLabel")}: ${repo.currentBranch ?? t("detached")}`}><GitPullRequest size={12} /><span className="dws-branch-value">{repo.currentBranch ?? t("detached")}</span></span>{listed.length > 0 ? <span className="dws-count" title={format(t("worktreeCountHint"), { count: String(listed.length) })}>{listed.length}</span> : null}</span><span className="dws-repo-path" title={slashPath(repo.repoPath)}>{slashPath(repo.repoPath)}</span></span>
            {onCreate ? <Button className="dws-button-ghost dws-create-repo" aria-label={t("workspaceCreate")} title={`${t("workspaceCreate")} · ${repoName(repo.repoPath)}`} onClick={() => onCreate({ path: repo.repoPath, title: repoName(repo.repoPath) })}><Plus size={15} /><span>{t("workspaceCreate")}</span></Button> : null}
          </header>
          {open ? <div className="dws-worktree-list">
            {listed.map(row => {
              const state = row.checking ? "checking" : row.statusError ? "unavailable" : row.changedFiles ? "dirty" : row.prunable ? "prunable" : "clean"
              return <div className="dws-worktree" key={row.path}>
                <FolderGit2 size={18} className="dws-tree-icon" aria-hidden="true" />
                <div className="dws-worktree-info">
                  <div className="dws-worktree-title">
                    {/* The worktree's own branch, named the way the two other branch
                        figures on this row are ("基线分支：…"): the icon alone said
                        "a branch" without saying which relation it had. The hover
                        spells the relation out, because the sentence on screen names
                        the branch rather than the role it plays. */}
                    <span className="dws-branch-label dws-worktree-branch" title={`${t("currentBranchLabel")}: ${row.branch ?? t("detached")}`}>
                      <span className="dws-branch-name">{t("branchLabel")}：</span>
                      <strong className="dws-branch-value">{row.branch ?? t("detached")}</strong>
                    </span>
                    <span className={`dws-status dws-status-${state}`} title={row.statusError}><span className="dws-status-dot" />{statusLabel(row)}</span>
                    <BranchDetail baseBranch={repo.currentBranch} ahead={row.commits ?? 0} behind={row.behind ?? 0} />
                    {row.locked ? <span className="dws-status">{t("locked")}</span> : null}
                  </div>
                  <div className="dws-worktree-path" title={slashPath(row.path)}>{slashPath(relativePath(repo.repoPath, row.path))}</div>
                  <ChangeSummary committed={row.committedChanges} working={row.workingChanges} />
                </div>
              </div>
            })}
          </div> : null}
        </article>
      })}
    </div> : null}
    {view === "tasks" ? <div className="dws-repo-list">
      {visibleTasks.map(task => {
        // Same rule as the repository rows: a search lists what it matched, and the
        // badge counts that same list.
        const listed = visibleTaskRepositories(task)
        return <article className="dws-task" key={task.path}>
        <header className="dws-task-header">
          <button type="button" className="dws-chevron-toggle" disabled={listed.length === 0} onClick={() => toggleRepo(task.path)} aria-expanded={listed.length > 0 ? isOpen(task.path) : undefined} aria-label={`${t("toggleTask")} ${task.name}`}>{listed.length > 0 ? <ChevronRight size={14} className="dws-chevron" /> : <span className="dws-chevron-placeholder" />}</button>
          <FolderClosed size={24} className="dws-task-icon" />
          <span className="dws-task-heading">
            <span className="dws-task-title">
              <h3>{task.name}</h3>
              <span className="dws-branch-label" title={`${t("taskBranchLabel")}: ${task.branch ?? t("branchesDiffer")}`}><span className="dws-branch-name">{t("taskBranchLabel")}：</span><span className="dws-branch-value">{task.branch ?? t("branchesDiffer")}</span></span>
              {/* The task's own totals. The per-repository detail - the base branch,
                  the ahead/behind counts and the line changes - lives on the rows
                  that open below, so the collapsed row answers "how much is this task
                  carrying" without listing four repositories to do it. */}
              {task.commits > 0 || task.behind > 0 ? <span className="dws-count dws-ahead-behind" title={`${format(t("aheadHint"), { count: String(task.commits) })} · ${format(t("behindHint"), { count: String(task.behind) })}`}>
                <span className="dws-ahead">↑ {task.commits}</span>
                <span className="dws-behind">↓ {task.behind}</span>
              </span> : null}
              {task.committedChanges === undefined && task.workingChanges === undefined ? null : <LineCounts className="dws-count" changes={totalLines(task)} hint={t("totalChangesHint")} />}
              {/* The same hint the repository rows carry: both numbers answer "how many
                  worktrees", one under a repository and one under a task space. */}
              <span className="dws-count" title={format(t("worktreeCountHint"), { count: String(listed.length) })}>{listed.length}</span>
            </span>
            <span className="dws-task-path" title={slashPath(task.path)}>{slashPath(task.path)}</span>
          </span>
          <Button className="dws-button-ghost dws-add-repository" disabled={busy} onClick={() => setExtending(task.path)}><Plus size={15} /><span>{t("addRepositoryToTask")}</span></Button>
          <Button className="dws-button-ghost dws-finish-task" disabled={busy} onClick={() => finishClick(task)}><Check size={15} /><span>{t("finishTask")}</span></Button>
        </header>
        <DeployCard api={api} path={task.path} />
        {listed.length === 0 || isOpen(task.path) ? <div className="dws-worktree-list">
          {listed.map(repository => {
            const state = taskRepoStatus(repository)
            return <div className="dws-worktree" key={repository.path}>
              <FolderGit2 size={18} className="dws-tree-icon" aria-hidden="true" />
              <div className="dws-worktree-info">
                <div className="dws-worktree-title">
                  <strong>{repository.name}</strong>
                  <span className={`dws-status dws-status-${state.state}`}><span className="dws-status-dot" />{state.label}</span>
                  {/* What this repository is measured against, named where the
                      measurement is: the base is the branch its source checkout
                      sits on, which is where a merge would land. */}
                  <BranchDetail currentBranch={repository.branch} baseBranch={repository.baseBranch} ahead={repository.commits} behind={repository.behind} />
                  {repository.locked ? <span className="dws-status">{t("locked")}</span> : null}
                </div>
                <div className="dws-worktree-path" title={slashPath(repository.path)}>{slashPath(repository.path)}</div>
                <ChangeSummary committed={repository.committedChanges} working={repository.workingChanges} />
              </div>
            </div>
          })}
        </div> : null}
      </article>
      })}
    </div> : null}
    {view === "spaces" ? <div className="dws-repo-list">
      {workspaceItems.length === 0 ? <p className="dws-no-linked">{t("workspaceEmpty")}</p> : visibleWorkspaces.length === 0 ? <div className="dws-empty"><FolderClosed size={24} strokeWidth={1.5} /><h3>{t("noMatches")}</h3></div> : visibleWorkspaces.map(workspace => {
        const state = classifications[workspace.path]
        const ready = state !== undefined && state !== "checking" && state !== "failed"
        // What this Workspace owns, from the scan. Not from the classification: that
        // is a second walk measuring a slightly different thing, and the two numbers
        // came to disagree - a Workspace reading "0 repositories" beside a row
        // listing twelve, with nothing on the page to say which was the real one.
        // The badge counts the list the row shows, so it cannot.
        const owned = ready ? repositoriesUnder(workspace) : []
        // A search lists what it matched, not what the Workspace happens to hold.
        // Matching the row and then expanding it to every repository underneath says
        // the search found all of them, and the panel is the only place the reader
        // is told which of a Workspace's repositories are on screen.
        const spanned = owned.filter(repo => needle === "" || repo.repoPath.toLowerCase().includes(needle))
        const canHost = ready && state.isSourceRoot
        // The sentence explaining that no task space can start there is not a count, so it
        // takes the row's right edge instead: the edge the creation button of the rows
        // that can host one ends on. Judged on what it owns rather than on what the
        // search left on screen - "nothing here can host a task space" is a fact about
        // the Workspace, not about the query.
        //
        // Still guarded on `ready`: a Workspace the Host could not answer has an empty
        // list because nothing came back, not because there is nothing there, and
        // saying it cannot host a task space rules out a directory nobody looked in.
        const empty = ready && owned.length === 0
        // A Workspace the Host could not answer is neither a count nor a verdict:
        // saying "cannot host a task space" about a read that never came back would
        // rule out a Workspace that may well hold three repositories. It gets the
        // amber an unreadable worktree status gets, not the neutral checking look.
        const badge = state === "checking"
          ? { className: "dws-status-checking", label: t("workspaceChecking") }
          : ready
            ? { className: canHost ? "dws-status-clean" : "dws-status-zero", label: format(t("workspaceSpans"), { count: String(spanned.length) }) }
            : { className: "dws-status-unavailable", label: t("workspaceUnreadable") }
        // What the row expands to. A Workspace the Host has not answered has nothing
        // to show, so it stays closed - "cannot check" is already on its badge, and an
        // expandable row would promise a list that cannot be produced.
        const canExpand = spanned.length > 0
        // A Workspace that happens to BE a task space shows what the task view shows:
        // one row per repository, with its base branch and what it carries. Opening it
        // onto the bare repository list would answer a weaker question than the same
        // directory already answers one view away. It can open even when the scan
        // found no repository under it as a root - the task's own worktrees are the
        // content, and they are known from the task grouping.
        const asTask = tasks.find(task => sameLocation(task.path, workspace.path))
        const open = (canExpand || asTask !== undefined) && isOpen(workspace.path)
        // The same totals the task branch draws, for a Workspace that is a plain source
        // root: every repository's own comparison with its remote, added up. A source
        // root holds no worktree count to report - the number beside the name is how
        // many repositories it spans, and a second count would be the same number
        // under a different word.
        //
        // Absent rather than zero when nothing has answered yet: a root whose
        // repositories have not been read shows no totals at all, which is what "not
        // known" looks like on this page.
        const totals = spanned.reduce((all, repo) => {
          const answer = upstreamOf(repo.repoPath)
          if (answer === undefined) return all
          all.read += 1
          all.ahead += answer.commits ?? 0
          all.behind += answer.behind ?? 0
          // Both halves, summed into the one pair the row draws - the same rule the task
          // row follows, so a Workspace's number means what a task's number means. The
          // sum keeps a file count only when some answer carried one: a row that drew
          // "0文件" over three unknown repositories would be inventing a number.
          if (answer.committedChanges === undefined && answer.workingChanges === undefined) return all
          all.changes = sumLines(all.changes, sumLines(answer.committedChanges, answer.workingChanges))
          all.lines += 1
          return all
        }, { read: 0, ahead: 0, behind: 0, lines: 0, changes: undefined as LineChanges | undefined })
        return <article className="dws-repo" key={workspace.workspaceId}>
          <header className="dws-repo-header">
            {/* A Workspace is a folder like a task is, and it wears the same closed one:
                both name a place work starts from rather than something the plugin made.
                It does expand now - to the repositories the scan found under it - so it
                takes the chevron and the toggle the other two views' rows already use.
                A Workspace holding nothing keeps the placeholder rather than a chevron
                that would open onto an empty list. */}
            <button type="button" className="dws-chevron-toggle" disabled={!canExpand && asTask === undefined} onClick={() => toggleRepo(workspace.path)} aria-expanded={canExpand || asTask !== undefined ? open : undefined} aria-label={`${t("toggleWorkspace")} ${workspace.title}`}>{(canExpand || asTask !== undefined) ? <ChevronRight size={14} className="dws-chevron" /> : <span className="dws-chevron-placeholder" />}</button>
            <FolderClosed size={24} className="dws-repo-icon" />
            <span className="dws-repo-heading">
              <span className="dws-repo-title">
                <h3>{workspace.title}</h3>
                {asTask === undefined
                  ? <>
                    <span className={"dws-status " + badge.className}>
                      <span className="dws-status-dot" />
                      {badge.label}
                    </span>
                    {/* The root's own totals, the same two pairs the task branch draws:
                        every repository here compared with its remote, added up. Only
                        once at least one repository has answered - a root nobody has
                        read yet shows the badge alone, which is what "not known" looks
                        like on this page. */}
                    {totals.read > 0 && (totals.ahead > 0 || totals.behind > 0) ? <span className="dws-ahead-behind" title={`${format(t("upstreamAheadHint"), { count: String(totals.ahead) })} · ${format(t("upstreamBehindHint"), { count: String(totals.behind) })}`}>
                      <span className="dws-ahead">↑ {totals.ahead}</span>
                      <span className="dws-behind">↓ {totals.behind}</span>
                    </span> : null}
                    {/* One pair for the root, committed and uncommitted together - the
                        same rule the task row follows, and the reason the hint says
                        "together" rather than naming only the committed half. */}
                    {totals.lines > 0 && totals.changes !== undefined ? <LineCounts changes={totals.changes} hint={t("totalChangesHint")} /> : null}
                  </>
                  : <>
                    {/* The same line the task view draws for this directory, in the same
                        order: the branch every repository shares, what it carries back,
                        and how many worktrees it holds. A Workspace that is a task space
                        is the same thing as a task row, so it reads the same wherever it
                        appears - including the counts, which are the task's own totals
                        and not a per-repository answer. */}
                    <span className="dws-branch-label" title={`${t("taskBranchLabel")}: ${asTask.branch ?? t("branchesDiffer")}`}>
                      <span className="dws-branch-name">{t("taskBranchLabel")}：</span>
                      <span className="dws-branch-value">{asTask.branch ?? t("branchesDiffer")}</span>
                    </span>
                    {asTask.commits > 0 || asTask.behind > 0 ? <span className="dws-ahead-behind" title={`${format(t("aheadHint"), { count: String(asTask.commits) })} · ${format(t("behindHint"), { count: String(asTask.behind) })}`}>
                      <span className="dws-ahead">↑ {asTask.commits}</span>
                      <span className="dws-behind">↓ {asTask.behind}</span>
                    </span> : null}
                    {/* One pair here too, committed and uncommitted together: this row
                        is the task row seen from another view, and the two have to read
                        the same number for the same directory. */}
                    {asTask.committedChanges === undefined && asTask.workingChanges === undefined ? null : <LineCounts changes={totalLines(asTask)} hint={t("totalChangesHint")} />}
                    {/* A count of worktrees, not of repositories: this directory holds one
                        worktree per repository, and "holds no Git repository" was a verdict
                        about starting a task space here rather than a fact about what is
                        inside. */}
                    <span className="dws-count" title={format(t("worktreeCountHint"), { count: String(asTask.repositories.length) })}>{asTask.repositories.length}</span>
                  </>}
              </span>
              <span className="dws-repo-path" title={`${t("workspacePathLabel")}: ${slashPath(workspace.path)}`}>{slashPath(workspace.path)}</span>
            </span>
            {empty && asTask === undefined ? <span className="dws-status dws-space-status">{t("workspaceCannot")}</span> : null}
            {onCreate && canHost ? <Button className="dws-button-ghost dws-create-repo" aria-label={t("workspaceCreate")} title={t("workspaceCreate")} onClick={() => onCreate({ path: workspace.path, title: workspace.title })}><Plus size={15} /><span>{t("workspaceCreate")}</span></Button> : null}
          </header>
          {/* The repositories the Workspace spans, in the row shape the worktrees below a
              repository use - that is the shape this panel already reads as "something
              inside something". The icon is the repository view's own rather than the
              worktree's: these are repositories, and a repository shown here that wore
              a worktree's icon would be the one row in the panel wearing the wrong one. */}
          {open ? <div className="dws-worktree-list">
            {asTask === undefined
              ? spanned.map(repository => {
                const remote = upstreamOf(repository.repoPath)
                return <div className="dws-worktree" key={repository.repoPath}>
                <FolderGit size={18} className="dws-tree-icon" aria-hidden="true" />
                <div className="dws-worktree-info">
                  <div className="dws-worktree-title">
                    <strong>{repoName(repository.repoPath)}</strong>
                    {/* A source repository is measured against its remote-tracking
                        branch rather than against another local one: nothing here is
                        going to be merged anywhere, so "how far from what the remote
                        has" is the question worth answering. It keeps the same shape
                        the worktree rows use - the branch, then ahead/behind, then the
                        line counts - so one row reads like the next. */}
                    <BranchDetail
                      // The branch on this side of the comparison, so the pair reads as
                      // "this branch against the remote's" rather than one name alone.
                      currentBranch={remote?.branch}
                      baseBranch={remote?.upstream ?? t("noRemoteBranch")}
                      baseLabel={t("remoteBranchLabel")}
                      ahead={remote?.commits ?? 0}
                      behind={remote?.behind ?? 0}
                      // A source repository is the branch the reader is on against
                      // what its remote has - not a task branch against a base. The
                      // numbers come from the same comparison, the sentence must not.
                      aheadHint={t("upstreamAheadHint")}
                      behindHint={t("upstreamBehindHint")}
                    />
                    {/* Three states, told apart rather than merged into one mark.
                        A successful fetch is the norm and says nothing. A fetch that
                        was tried and failed is a fault, and wears the amber the rest
                        of this page uses for "readable but not current" - the sentence
                        behind it is the reader's own words, with git's kept in the
                        title for whoever needs the diagnosis. A fetch nobody asked
                        for is a choice, so it is neutral grey and says only that the
                        numbers come from disk. */}
                    {/* Four states, told apart rather than merged into one mark.
                        A successful fetch is the norm and says nothing. Numbers from the
                        local refs - before the fetch has even been asked for - are the
                        ordinary first answer and say nothing either. A fetch that was
                        tried and failed is a fault, and wears the amber the rest of this
                        page uses for "readable but not current": the sentence behind it
                        is the reader's own words, with git's kept in the title for
                        whoever needs the diagnosis. A fetch nobody asked for is a
                        choice, so it is neutral grey. */}
                    {remote?.upstream == null ? null
                      : remote.fetched === true ? null
                      : remote.fetchEnabled === false
                        ? <span className="dws-status dws-status-idle" title={t("upstreamFetchOff")}>
                          <span className="dws-status-dot" />{t("upstreamNotFetched")}
                        </span>
                        // `fetchError` is only ever set by a fetch that was tried, so an
                        // empty one here means the refresh has not come back yet. The
                        // numbers on screen are the local answer, which is exactly what
                        // they are, and nothing has gone wrong.
                        : remote.fetchError === undefined || remote.fetchError === "" ? null
                        : <span className="dws-status dws-status-stale" title={`${fetchFailureText(remote.fetchError, t)}\n${remote.fetchError}`}>
                          <span className="dws-status-dot" />{t("upstreamFetchFailedLabel")}
                        </span>}
                    {repository.worktrees.length > 0 ? <span className="dws-count" title={format(t("worktreeCountHint"), { count: String(repository.worktrees.length) })}>{repository.worktrees.length}</span> : null}
                  </div>
                  <div className="dws-worktree-path" title={`${t("repositoryPathLabel")}: ${slashPath(repository.repoPath)}`}>{slashPath(relativePath(workspace.path, repository.repoPath))}</div>
                  <ChangeSummary committed={remote?.committedChanges} working={remote?.workingChanges} committedHint={t("upstreamCommittedHint")} workingHint={t("upstreamWorkingHint")} />
                </div>
              </div>})
              : asTask.repositories.map(repository => <div className="dws-worktree" key={repository.path}>
                <FolderGit2 size={18} className="dws-tree-icon" aria-hidden="true" />
                <div className="dws-worktree-info">
                  <div className="dws-worktree-title">
                    <strong>{repository.name}</strong>
                    <BranchDetail currentBranch={repository.branch} baseBranch={repository.baseBranch} ahead={repository.commits} behind={repository.behind} />
                    {repository.locked ? <span className="dws-status">{t("locked")}</span> : null}
                  </div>
                  <div className="dws-worktree-path" title={slashPath(repository.path)}>{slashPath(relativePath(workspace.path, repository.path))}</div>
                  <ChangeSummary committed={repository.committedChanges} working={repository.workingChanges} />
                </div>
              </div>)}
          </div> : null}
        </article>
      })}
    </div> : null}
    </div> : null}
    {extending ? <AddRepositoryDialog
      taskPath={extending}
      api={api}
      workspaces={workspaces}
      // `repos` has already been through `scannedRepositories`, and a second pass
      // over it finds no main worktree left to read a branch from — which is how a
      // row here loses the branch the repository view and the create dialog both
      // show. What the dialog wants is this list as it stands.
      repositories={repos}
      onAdded={() => { void refresh() }}
      onClose={() => setExtending(null)}
    /> : null}
    {archiving ? <ArchiveTaskDialog
      path={archiving}
      api={api}
      workspaces={workspaces}
      sessions={sessions}
      uiWorkspace={uiWorkspace}
      onArchived={() => { void refresh() }}
      onClose={() => setArchiving(null)}
      onLeave={onLeave}
      config={config}
    /> : null}
  </section>
}

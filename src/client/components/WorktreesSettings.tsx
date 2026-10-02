import { useCallback, useEffect, useRef, useState } from "react"
import { AlertCircle, Check, ChevronRight, FolderClosed, FolderGit, FolderGit2, GitPullRequest, Loader2, Plus, RefreshCw, Search, X } from "./icons"
import { format, useT } from "../lib/i18n"
import { sameLocation, slashPath } from "../lib/paths"
import { addRepositorySource } from "../lib/repositories"
import { rememberedRepositories, scannedRepositories } from "../lib/scan"
import { groupTasks, type TaskGroup, type TaskRepository } from "../lib/tasks"
import type { RememberedScan, SourceRootClassification, Workspace, Worktree, WorktreeList, WorkspacesService, WorkspaceNavigation } from "../lib/types"
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client"
import { AddRepositoryDialog } from "./AddRepositoryDialog"
import { ArchiveTaskDialog } from "./ArchiveTaskDialog"
import { finishScenes } from "../lib/finish-scene"
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input, Select } from "./ui"

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
  /** Render the section's own header. Off when the host supplies the heading. */
  heading?: boolean
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
}
type Filter = "all" | "attention"
/** The filters both views offer: everything found, or only what needs attention. */
const FILTERS = [['all', 'filterAll'], ['attention', 'filterAttention']] as const
const repoName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path
const relativePath = (repoPath: string, path: string) => path.startsWith(`${repoPath}/`) ? path.slice(repoPath.length + 1) : path

export function WorktreesSettings({ api, workspaces, uiWorkspace, sessions, heading = true, onCreate, control, onLeave }: Props) {
  const t = useT()
  const [ownView, setOwnView] = useState<WorktreeView>("spaces")
  const view = control?.view ?? ownView
  const setView = control?.onView ?? setOwnView
  const [repos, setRepos] = useState<WorktreeList[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [action, setAction] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  // What each Workspace is, once asked: whether a task space can start there, and
  // how many repositories it would span. Filled when the view is opened.
  //
  // The results must not be a dependency of this effect: writing "checking" would
  // change them, re-run the effect, and abort the very requests whose answers it is
  // waiting for - which left every row saying so forever.
  const [classifications, setClassifications] = useState<Record<string, SourceRootClassification | "checking" | "failed">>({})
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
      void Promise.all(pending.map(async path => {
        try {
          return [path, await api.classifyRoot(path, controller.signal)] as const
        } catch {
          return [path, "failed"] as const
        }
      })).then(results => {
        if (controller.signal.aborted) return
        setClassifications(current => ({ ...current, ...Object.fromEntries(results) }))
      })
    }
    // Subscribed rather than run once. Registering a Workspace is what makes the list
    // grow, and a row with no answer is drawn as "cannot check" — so a row added from
    // this page stays wrong until the view is left and come back to. The refresh
    // button rescans repositories; this is not that, and never was.
    classifyMissing()
    const dispose = workspaces.list.subscribe(() => classifyMissing())
    return () => { controller.abort(); dispose() }
  }, [view, api, workspaces])
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
  const refresh = useCallback(async (extra: string[] = []) => {
    refreshController.current?.abort()
    const controller = new AbortController()
    refreshController.current = controller
    setBusy(true); setError("")
    try {
      const registered = workspaces.list.getSnapshot().items.map((workspace: Workspace) => workspace.path)
      const paths = extra.reduce((all, path) => (all.some((known) => sameLocation(known, path)) ? all : [...all, path]), registered)
      const lists: WorktreeList[] = await api.scan(paths, controller.signal)
      if (controller.signal.aborted) return
      const discovered = scannedRepositories(lists)
      paintedFresh.current = true
      setRepos(discovered.map(list => ({ ...list, worktrees: list.worktrees.map(row => ({ ...row, checking: true })) })))
      const next = await Promise.all(discovered.map(async list => ({
        ...list,
        worktrees: await Promise.all(list.worktrees.map(async row => {
          try { return { ...row, ...(await api.status(row.path, list.currentBranch, controller.signal)) } }
          catch (reason: any) { return { ...row, statusError: String(reason?.message ?? reason) } }
        })),
      })))
      if (!controller.signal.aborted) setRepos(next)
    } catch (reason: any) {
      if (!controller.signal.aborted) setError(String(reason?.message ?? reason))
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }, [api, workspaces, t])
  // The panel is unmounted whenever it is closed, so every opening starts here.
  // It paints what the Host remembers of the last scan - which is the whole point
  // of that memory - and scans again regardless: the remembered rows are replaced
  // the moment the fresh answer lands, so a stale list costs one repaint at most.
  useEffect(() => {
    const controller = new AbortController()
    const paths = workspaces.list.getSnapshot().items.map((workspace: Workspace) => workspace.path)
    void api.cachedScan(paths, controller.signal).then((remembered: RememberedScan | null) => {
      if (!remembered || controller.signal.aborted || paintedFresh.current) return
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
  const visibleRepos = repos.filter(repo => {
    if (filter === "attention" && !repo.worktrees.some(needsAttention)) return false
    return !needle || [repo.repoPath, repo.currentBranch, ...repo.worktrees.flatMap(row => [row.path, row.branch])].some(value => value?.toLocaleLowerCase().includes(needle))
  })
  const totalWorktrees = repos.reduce((count, repo) => count + repo.worktrees.length, 0)
  const shownWorktrees = visibleRepos.reduce((count, repo) => count + repo.worktrees.length, 0)
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
  const toggleRepo = (path: string) => setCollapsed(previous => {
    const next = new Set(previous)
    if (next.has(path)) next.delete(path); else next.add(path)
    return next
  })
  // A repository still being read is flagged as such, so a read in flight is not
  // reported as a read that could not be answered.
  const tasks = groupTasks(repos)
  // A task needs attention when any of its repositories does, which is the same
  // condition the repository view filters on, one level up.
  const taskNeedsAttention = (task: TaskGroup) => task.changedFiles > 0 || task.commits > 0 || task.lockedRepositories > 0 || task.prunableRepositories > 0 || task.unknownRepositories > 0
  const visibleTasks = tasks.filter(task => {
    if (filter === "attention" && !taskNeedsAttention(task)) return false
    return !needle || [task.name, task.path, task.branch, ...task.repositories.map(repository => repository.path)].some(value => value?.toLocaleLowerCase().includes(needle))
  })
  const taskRepositoryCount = tasks.reduce((count, task) => count + task.repositories.length, 0)
  const shownTaskRepositoryCount = visibleTasks.reduce((count, task) => count + task.repositories.length, 0)
  // One set of collapsed paths drives both views, so the button beside the filters
  // says what the next click does to all of them.
  const collapsiblePaths = [
    ...visibleRepos.filter(repo => repo.worktrees.length > 0).map(repo => repo.repoPath),
    ...visibleTasks.filter(task => task.repositories.length > 0).map(task => task.path),
  ]
  const everythingCollapsed = collapsiblePaths.length > 0 && collapsiblePaths.every(path => collapsed.has(path))
  const toggleAll = () => setCollapsed(everythingCollapsed ? new Set() : new Set(collapsiblePaths))
  const workspaceItems = workspaces.list.getSnapshot().items as Workspace[]
  const visibleWorkspaces = workspaceItems.filter(workspace => {
    const state = classifications[workspace.path]
    const ready = state !== undefined && state !== "checking" && state !== "failed"
    // The filter keeps the Workspaces that hold a repository, which is exactly the
    // question the row's own badge answers: how many repositories the Workspace spans.
    // One that has not answered yet stays visible rather than disappearing for the
    // length of a scan.
    if (filter === "attention" && ready && state.repositoryCount === 0) return false
    const needle = query.trim().toLowerCase()
    if (needle === "") return true
    return workspace.title.toLowerCase().includes(needle) || workspace.path.toLowerCase().includes(needle)
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
   * removed the way every other entry is. Registering one that is already
   * registered is not a failure — the user asked for it to be in the list and it
   * is — so it says so and moves on rather than sending them looking for
   * something to fix.
   */
  const addSource = async () => {
    const path = sourcePath.trim()
    if (path === "" || sourceBusy) return
    setSourceBusy(true)
    setSourceError("")
    try {
      const outcome = await addRepositorySource(api, workspaces, path)
      setSourcePath("")
      setAddingSource(false)
      if (!outcome.added) setError(t("addRepositoryAlready"))
      else await refresh([path])
    } catch (reason: any) {
      setSourceError(String(reason?.message ?? reason))
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
      setSpaceError(String(reason?.message ?? reason))
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
  const foldButton = <button type="button" className="dws-filter-fold" aria-pressed={everythingCollapsed} onClick={toggleAll}>{everythingCollapsed ? t("expandAll") : t("collapseAll")}</button>
  const divider = <span className="dws-filter-divider" aria-hidden="true">|</span>
  /** Between two runs rather than inside one, so it gets air on both sides. */
  const separator = <span className="dws-filter-divider dws-filter-separator" aria-hidden="true">|</span>

  /** One line per view: what that view holds, and what a row of it can start or finish.
   *  The heading's own line says what the plugin does for a task across repositories;
   *  this answers the narrower question the view switcher just asked. It sits under the
   *  controls because it describes the list they are about to narrow. */
  const viewDescription = view === "spaces" ? t("viewSpacesDescription") : view === "repos" ? t("viewReposDescription") : t("viewTasksDescription")

  // The list is the only thing that scrolls: one reading column holds the heading,
  // the toolbar and the filters, and the rows move under them. The dialog says the
  // first half for both hosts and borrows the toolbar for the switcher it owns; the
  // panel's own frame draws the heading, because it has one.
  const listBody = view === "repos" || view === "tasks" || view === "spaces"
  return <section className="dws-settings" aria-label={t("worktrees")}>
    <div className="dws-settings-pinned">
      {heading ? <header className="dws-settings-header">
        <div><h2>{t("worktreesTitle")}</h2><p>{t("panelDescription")}</p></div>
      </header> : null}
      <div className="dws-toolbar">
        <label className="dws-search"><Search size={16} aria-hidden="true" /><Input aria-label={t("searchPlaceholder")} placeholder={t("searchPlaceholder")} value={query} onChange={event => setQuery(event.target.value)} />{query ? <Button className="dws-icon-button" aria-label={t("clearFilters")} onClick={() => setQuery("")}><X size={14} /></Button> : null}</label>
        <Button className="dws-button dws-refresh" aria-label={t("refresh")} title={t("refresh")} disabled={busy || !!action} onClick={() => void refresh()}><RefreshCw size={14} className={busy ? "dws-spin" : undefined} />{t("refresh")}</Button>
        {/* Offered only in the repository view: it is this view's list being added
            to, and in the other two the same button would answer a question the
            user is not asking. */}
        {view === "repos" && !addingSource ? <Button className="dws-button dws-add-source-button" disabled={busy || !!action} onClick={() => { setSourceError(""); setAddingSource(true) }}><Plus size={14} />{t("addRepositorySource")}</Button> : null}
        {view === "repos" && addingSource ? <div className="dws-add-source-row">
          <Input aria-label={t("addRepositorySource")} placeholder={t("addRepositoryManualPlaceholder")} value={sourcePath} autoFocus autoComplete="off" spellCheck={false} onChange={event => setSourcePath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addSource() } }} />
          <Button className="dws-button-primary" disabled={sourceBusy || sourcePath.trim() === ""} onClick={() => void addSource()}>{sourceBusy ? <Loader2 size={14} className="dws-spin" aria-hidden="true" /> : null}{sourceBusy ? t("addingRepository") : t("addRepositoryAdd")}</Button>
          <Button className="dws-icon-button" aria-label={t("cancel")} onClick={() => { setAddingSource(false); setSourcePath(""); setSourceError("") }}><X size={14} /></Button>
        </div> : null}
        {/* The same offer one level up: a Workspace is a directory the user has
            named, and naming one is DSH's own job, done here because this is where
            the list of them is. It sits next to the refresh rather than with the
            repository button, which is a different act — that one adds a
            repository to a Workspace list this one is what extends. */}
        {view === "spaces" && !addingSpace ? <Button className="dws-button dws-add-source-button" disabled={busy || !!action} onClick={() => { setSpaceError(""); setAddingSpace(true) }}><Plus size={14} />{t("addWorkspace")}</Button> : null}
        {view === "spaces" && addingSpace ? <div className="dws-add-source-row">
          <Input aria-label={t("addWorkspace")} placeholder={t("addWorkspacePlaceholder")} value={spacePath} autoFocus autoComplete="off" spellCheck={false} onChange={event => setSpacePath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addSpace() } }} />
          <Button className="dws-button-primary" disabled={spaceBusy || spacePath.trim() === ""} onClick={() => void addSpace()}>{spaceBusy ? <Loader2 size={14} className="dws-spin" aria-hidden="true" /> : null}{spaceBusy ? t("addingWorkspace") : t("addWorkspaceConfirm")}</Button>
          <Button className="dws-icon-button" aria-label={t("cancel")} onClick={() => { setAddingSpace(false); setSpacePath(""); setSpaceError("") }}><X size={14} /></Button>
        </div> : null}
      </div>
      {sourceError ? <div className="dws-error" role="alert"><AlertCircle size={16} /><span>{sourceError}</span></div> : null}
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
      {busy ? <div className="dws-loading-message" role="status"><Loader2 size={14} className="dws-spin" /><span>{t("scanning")}</span></div> : null}
      {!busy && view === "repos" && visibleRepos.length === 0 ? <div className="dws-empty"><FolderGit size={24} strokeWidth={1.5} /><h3>{t("noMatches")}</h3></div> : null}
      {!busy && view === "tasks" && visibleTasks.length === 0 ? <div className="dws-empty"><FolderClosed size={24} strokeWidth={1.5} /><h3>{tasks.length ? t("noMatches") : t("noTasks")}</h3>{tasks.length ? null : <p>{t("noTasksHint")}</p>}</div> : null}
    </div>
    {listBody ? <div className="dws-list-body">
    {busy && repos.length === 0 ? <div className="dws-skeleton-list" aria-hidden="true">{[0, 1, 2].map(index => <div className="dws-skeleton-row" key={index}><span /><div><span /><span /></div></div>)}</div> : null}
    {view === "repos" ? <div className="dws-repo-list">
      {visibleRepos.map(repo => {
        const canExpand = repo.worktrees.length > 0
        const expanded = canExpand && !collapsed.has(repo.repoPath)
        return <article className="dws-repo" key={repo.repoPath}>
          <header className="dws-repo-header">
            <button type="button" className="dws-repo-toggle" onClick={() => toggleRepo(repo.repoPath)} disabled={!canExpand} aria-expanded={canExpand ? expanded : undefined} aria-label={`${t("toggleRepository")} ${repoName(repo.repoPath)}`}>
              {canExpand ? <ChevronRight size={14} className="dws-chevron" /> : <span className="dws-chevron-placeholder" />}<FolderGit size={24} className="dws-repo-icon" />
              <span className="dws-repo-heading"><span className="dws-repo-title"><h3>{repoName(repo.repoPath)}</h3><span className="dws-branch-label"><GitPullRequest size={12} /><span className="dws-branch-value">{repo.currentBranch ?? t("detached")}</span></span>{repo.worktrees.length > 0 ? <span className="dws-count" title={format(t("worktreeCountHint"), { count: String(repo.worktrees.length) })}>{repo.worktrees.length}</span> : null}</span><span className="dws-repo-path" title={slashPath(repo.repoPath)}>{slashPath(repo.repoPath)}</span></span>
            </button>
            {onCreate ? <Button className="dws-button-ghost dws-create-repo" aria-label={t("workspaceCreate")} title={`${t("workspaceCreate")} · ${repoName(repo.repoPath)}`} onClick={() => onCreate({ path: repo.repoPath, title: repoName(repo.repoPath) })}><Plus size={15} /><span>{t("workspaceCreate")}</span></Button> : null}
          </header>
          {expanded ? <div className="dws-worktree-list">
            {repo.worktrees.map(row => {
              const state = row.checking ? "checking" : row.statusError ? "unavailable" : row.changedFiles ? "dirty" : row.prunable ? "prunable" : "clean"
              return <div className="dws-worktree" key={row.path}>
                <FolderGit2 size={18} className="dws-tree-icon" aria-hidden="true" />
                <div className="dws-worktree-info"><div className="dws-worktree-title"><strong>{row.branch ?? t("detached")}</strong><span className={`dws-status dws-status-${state}`} title={row.statusError}><span className="dws-status-dot" />{statusLabel(row)}</span>{pendingBadge(row.commits)}{row.locked ? <span className="dws-status">{t("locked")}</span> : null}</div><div className="dws-worktree-path" title={slashPath(row.path)}>{slashPath(relativePath(repo.repoPath, row.path))}</div></div>
              </div>
            })}
          </div> : null}
        </article>
      })}
    </div> : null}
    {view === "tasks" ? <div className="dws-repo-list">
      {visibleTasks.map(task => <article className="dws-task" key={task.path}>
        <header className="dws-task-header">
          <button type="button" className="dws-repo-toggle" onClick={() => toggleRepo(task.path)} disabled={task.repositories.length === 0} aria-expanded={task.repositories.length > 0 ? !collapsed.has(task.path) : undefined} aria-label={`${t("toggleTask")} ${task.name}`}>
          {task.repositories.length > 0 ? <ChevronRight size={14} className="dws-chevron" /> : <span className="dws-chevron-placeholder" />}<FolderClosed size={24} className="dws-task-icon" />
          <span className="dws-task-heading">
            <span className="dws-task-title">
              <h3>{task.name}</h3>
              <span className="dws-branch-label" title={`${t("branch")}: ${task.branch ?? t("branchesDiffer")}`}><GitPullRequest size={12} /><span className="dws-branch-value">{task.branch ?? t("branchesDiffer")}</span></span>
              {/* The same hint the repository rows carry: both numbers answer "how many
                  worktrees", one under a repository and one under a task space. */}
              <span className="dws-count" title={format(t("worktreeCountHint"), { count: String(task.repositories.length) })}>{task.repositories.length}</span>
              {pendingBadge(task.commits)}
            </span>
            <span className="dws-task-path" title={slashPath(task.path)}>{slashPath(task.path)}</span>
          </span>
          </button>
          <Button className="dws-button-ghost dws-add-repository" disabled={busy || !!action} onClick={() => setExtending(task.path)}><Plus size={15} /><span>{t("addRepositoryToTask")}</span></Button>
          <Button className="dws-button-ghost dws-finish-task" disabled={busy || !!action} onClick={() => setArchiving(task.path)}><Check size={15} /><span>{t("finishTask")}</span></Button>
        </header>
        {task.repositories.length === 0 || !collapsed.has(task.path) ? <div className="dws-worktree-list">
          {task.repositories.map(repository => {
            const state = taskRepoStatus(repository)
            return <div className="dws-worktree" key={repository.path}>
              <FolderGit2 size={18} className="dws-tree-icon" aria-hidden="true" />
              <div className="dws-worktree-info"><div className="dws-worktree-title"><strong>{repository.name}</strong><span className={`dws-status dws-status-${state.state}`}><span className="dws-status-dot" />{state.label}</span>{pendingBadge(repository.commits)}{repository.locked ? <span className="dws-status">{t("locked")}</span> : null}</div><div className="dws-worktree-path" title={slashPath(repository.path)}>{slashPath(repository.path)}</div></div>
            </div>
          })}
        </div> : null}
      </article>)}
    </div> : null}
    {view === "spaces" ? <div className="dws-repo-list">
      {workspaceItems.length === 0 ? <p className="dws-no-linked">{t("workspaceEmpty")}</p> : visibleWorkspaces.length === 0 ? <div className="dws-empty"><FolderClosed size={24} strokeWidth={1.5} /><h3>{t("noMatches")}</h3></div> : visibleWorkspaces.map(workspace => {
        const state = classifications[workspace.path]
        const ready = state !== undefined && state !== "checking" && state !== "failed"
        const canHost = ready && state.isSourceRoot
        // Every Workspace that has answered says what it spans, right after its name,
        // a count of zero included. The sentence explaining that no task space can
        // start there is not a count, so it takes the row's right edge instead: the
        // edge the creation button of the rows that can host one ends on.
        const empty = ready && state.repositoryCount === 0
        // A Workspace the Host could not answer is neither a count nor a verdict:
        // saying "cannot host a task space" about a read that never came back would
        // rule out a Workspace that may well hold three repositories. It gets the
        // amber an unreadable worktree status gets, not the neutral checking look.
        const badge = state === "checking"
          ? { className: "dws-status-checking", label: t("workspaceChecking") }
          : ready
            ? { className: canHost ? "dws-status-clean" : "dws-status-zero", label: format(t("workspaceSpans"), { count: String(state.repositoryCount) }) }
            : { className: "dws-status-unavailable", label: t("workspaceUnreadable") }
        return <article className="dws-repo" key={workspace.workspaceId}>
          <header className="dws-repo-header">
            {/* A Workspace is a folder like a task is, and it wears the same closed one:
                both name a place work starts from rather than something the plugin made.
                No chevron and no placeholder, because these rows do not expand. */}
            <FolderClosed size={24} className="dws-repo-icon" />
            <span className="dws-repo-heading">
              <span className="dws-repo-title">
                <h3>{workspace.title}</h3>
                <span className={"dws-status " + badge.className}>
                  <span className="dws-status-dot" />
                  {badge.label}
                </span>
              </span>
              <span className="dws-repo-path" title={slashPath(workspace.path)}>{slashPath(workspace.path)}</span>
            </span>
            {empty ? <span className="dws-status dws-space-status">{t("workspaceCannot")}</span> : null}
            {onCreate && canHost ? <Button className="dws-button-ghost dws-create-repo" aria-label={t("workspaceCreate")} title={t("workspaceCreate")} onClick={() => onCreate({ path: workspace.path, title: workspace.title })}><Plus size={15} /><span>{t("workspaceCreate")}</span></Button> : null}
          </header>
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
    /> : null}
  </section>
}

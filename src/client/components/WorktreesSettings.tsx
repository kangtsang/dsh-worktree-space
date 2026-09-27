import { useCallback, useEffect, useRef, useState } from "react"
import { AlertCircle, Check, ChevronRight, FolderGit, FolderGit2, GitPullRequest, Loader2, Plus, RefreshCw, Search, X } from "lucide-react"
import { format, useT } from "../lib/i18n"
import { slashPath } from "../lib/paths"
import { rememberedRepositories, scannedRepositories } from "../lib/scan"
import { groupTasks, type TaskGroup, type TaskRepository } from "../lib/tasks"
import type { RememberedScan, SourceRootClassification, Workspace, Worktree, WorktreeList, WorkspacesService, WorkspaceNavigation } from "../lib/types"
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client"
import { ArchiveTaskDialog } from "./ArchiveTaskDialog"
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input, Select } from "./ui"

interface Props {
  api: any
  workspaces: WorkspacesService
  uiWorkspace: WorkspaceNavigation
  sessions: ISessions
  /** Render the section's own header. Off when the host supplies the heading. */
  heading?: boolean
  onCreate?: (target: Pick<Workspace, "path" | "title">) => void
}
type Filter = "all" | "attention"
/** The filters both views offer: everything found, or only what needs attention. */
const FILTERS = [['all', 'filterAll'], ['attention', 'filterAttention']] as const
const repoName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path
const relativePath = (repoPath: string, path: string) => path.startsWith(`${repoPath}/`) ? path.slice(repoPath.length + 1) : path

export function WorktreesSettings({ api, workspaces, uiWorkspace, sessions, heading = true, onCreate }: Props) {
  const t = useT()
  const [repos, setRepos] = useState<WorktreeList[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [action, setAction] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  // Tasks are the unit this page is about, so it opens on them; the repository
  // list stays one click away for everything a task does not cover.
  const [view, setView] = useState<"repos" | "tasks" | "spaces">("tasks")
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
    const items = workspaces.list.getSnapshot().items as Workspace[]
    setClassifications(Object.fromEntries(items.map(workspace => [workspace.path, "checking" as const])))
    void Promise.all(items.map(async workspace => {
      try {
        return [workspace.path, await api.classifyRoot(workspace.path, controller.signal)] as const
      } catch {
        return [workspace.path, "failed"] as const
      }
    })).then(results => {
      if (controller.signal.aborted) return
      setClassifications(Object.fromEntries(results))
    })
    return () => { controller.abort() }
  }, [view, api, workspaces])
  /** Path of the task whose archive dialog is open, if any. */
  const [archiving, setArchiving] = useState<string | null>(null)
  const refreshController = useRef<AbortController | null>(null)
  // Whether a scan of this mount has already landed. The remembered answer is
  // painted only until then: once real rows exist, a late-arriving memory must not
  // put back what the scan has just replaced - including an empty result.
  const paintedFresh = useRef(false)
  const refresh = useCallback(async () => {
    refreshController.current?.abort()
    const controller = new AbortController()
    refreshController.current = controller
    setBusy(true); setError("")
    try {
      const paths = workspaces.list.getSnapshot().items.map((workspace: Workspace) => workspace.path)
      const lists: WorktreeList[] = await api.scan(paths, controller.signal)
      if (controller.signal.aborted) return
      const discovered = scannedRepositories(lists)
      paintedFresh.current = true
      setRepos(discovered.map(list => ({ ...list, worktrees: list.worktrees.map(row => ({ ...row, statusError: t("checkingStatus") })) })))
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
      setRepos(rememberedRepositories(remembered, t("checkingStatus")))
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
  const needsAttention = (row: Worktree) => !!(row.changedFiles || row.commits || row.locked || row.prunable || (row.statusError && row.statusError !== t("checkingStatus")))
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
    if (row.statusError === t("checkingStatus")) return t("checkingStatus")
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
  // The sentinel this page writes while a read is in flight is passed down, so a
  // repository being read is not reported as one that could not be read.
  const tasks = groupTasks(repos, { pending: t("checkingStatus") })
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
    // What needs attention here is a Workspace a task space cannot start in.
    if (filter === "attention" && ready && state.isSourceRoot) return false
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

  return <section className="dws-settings" aria-label={t("worktrees")}>
    {heading ? <header className="dws-settings-header">
      <div><h2>{t("worktreesTitle")}</h2><p>{t("panelDescription")}</p></div>
    </header> : null}
    <div className="dws-toolbar">
      <label className="dws-search"><Search size={16} aria-hidden="true" /><Input aria-label={t("searchPlaceholder")} placeholder={t("searchPlaceholder")} value={query} onChange={event => setQuery(event.target.value)} />{query ? <Button className="dws-icon-button" aria-label={t("clearFilters")} onClick={() => setQuery("")}><X size={14} /></Button> : null}</label>
      <Button className="dws-icon-button dws-refresh" aria-label={t("refresh")} title={t("refresh")} disabled={busy || !!action} onClick={() => void refresh()}><RefreshCw size={16} className={busy ? "dws-spin" : undefined} /></Button>
    </div>
    <div className="dws-list-controls">
      <div className="dws-filters" role="group" aria-label={t("viewSwitch")}>{([['tasks', 'viewTasks'], ['spaces', 'viewWorkspaces'], ['repos', 'viewRepositories']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)}>{t(label)}</button>)}<span className="dws-filter-divider" aria-hidden="true">|</span><button type="button" className="dws-filter-fold" aria-pressed={everythingCollapsed} onClick={toggleAll}>{everythingCollapsed ? t("expandAll") : t("collapseAll")}</button></div>
      <div className="dws-filters" role="group" aria-label={t("worktrees")}>{FILTERS.map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(label)}</button>)}</div>
      <span className="dws-summary">{view === "repos" ? <>{counted(visibleRepos.length, repos.length)} {t("repositories")}<span aria-hidden="true">·</span>{counted(shownWorktrees, totalWorktrees)} {t("worktreeCount")}</> : view === "tasks" ? <>{counted(visibleTasks.length, tasks.length)} {t("taskCount")}<span aria-hidden="true">·</span>{counted(shownTaskRepositoryCount, taskRepositoryCount)} {t("repositories")}</> : <>{counted(visibleWorkspaces.length, workspaceItems.length)} {t("workspaceCount")}</>}</span>
    </div>
    {error ? <div className="dws-error" role="alert"><AlertCircle size={16} /><span>{error}</span><Button className="dws-button-ghost" disabled={busy} onClick={() => void refresh()}>{t("retry")}</Button></div> : null}
    {busy ? <div className="dws-loading-message" role="status"><Loader2 size={14} className="dws-spin" /><span>{repos.length > 0 ? t("refreshing") : t("scanning")}</span></div> : null}
    {busy && repos.length === 0 ? <div className="dws-skeleton-list" aria-hidden="true">{[0, 1, 2].map(index => <div className="dws-skeleton-row" key={index}><span /><div><span /><span /></div></div>)}</div> : null}
    {!busy && view === "repos" && visibleRepos.length === 0 ? <div className="dws-empty"><FolderGit2 size={26} strokeWidth={1.5} /><h3>{t("noMatches")}</h3></div> : null}
    {!busy && view === "tasks" && visibleTasks.length === 0 ? <div className="dws-empty"><GitPullRequest size={26} strokeWidth={1.5} /><h3>{tasks.length ? t("noMatches") : t("noTasks")}</h3>{tasks.length ? null : <p>{t("noTasksHint")}</p>}</div> : null}
    {view === "repos" ? <div className="dws-repo-list">
      {visibleRepos.map(repo => {
        const canExpand = repo.worktrees.length > 0
        const expanded = canExpand && !collapsed.has(repo.repoPath)
        return <article className="dws-repo" key={repo.repoPath}>
          <header className="dws-repo-header">
            <button type="button" className="dws-repo-toggle" onClick={() => toggleRepo(repo.repoPath)} disabled={!canExpand} aria-expanded={canExpand ? expanded : undefined} aria-label={`${t("toggleRepository")} ${repoName(repo.repoPath)}`}>
              {canExpand ? <ChevronRight size={14} className="dws-chevron" /> : <span className="dws-chevron-placeholder" />}<FolderGit2 size={18} className="dws-repo-icon" />
              <span className="dws-repo-heading"><span className="dws-repo-title"><h3>{repoName(repo.repoPath)}</h3><span className="dws-branch-label"><GitPullRequest size={12} /><span className="dws-branch-value">{repo.currentBranch ?? t("detached")}</span></span>{repo.worktrees.length > 0 ? <span className="dws-count">{repo.worktrees.length}</span> : null}</span><span className="dws-repo-path" title={slashPath(repo.repoPath)}>{slashPath(repo.repoPath)}</span></span>
            </button>
            {onCreate ? <Button className="dws-button-ghost dws-create-repo" aria-label={t("workspaceCreate")} title={`${t("workspaceCreate")} · ${repoName(repo.repoPath)}`} onClick={() => onCreate({ path: repo.repoPath, title: repoName(repo.repoPath) })}><Plus size={15} /><span>{t("workspaceCreate")}</span></Button> : null}
          </header>
          {expanded ? <div className="dws-worktree-list">
            {repo.worktrees.map(row => {
              const state = row.statusError === t("checkingStatus") ? "checking" : row.statusError ? "unavailable" : row.changedFiles ? "dirty" : row.prunable ? "prunable" : "clean"
              return <div className="dws-worktree" key={row.path}>
                <GitPullRequest size={16} className="dws-tree-icon" aria-hidden="true" />
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
          <button type="button" className="dws-repo-toggle" onClick={() => toggleRepo(task.path)} disabled={task.repositories.length === 0} aria-expanded={task.repositories.length > 0 ? !collapsed.has(task.path) : undefined} aria-label={`${t("toggleRepository")} ${task.name}`}>
          {task.repositories.length > 0 ? <ChevronRight size={14} className="dws-chevron" /> : <span className="dws-chevron-placeholder" />}<FolderGit size={18} className="dws-task-icon" />
          <span className="dws-task-heading">
            <span className="dws-task-title">
              <h3>{task.name}</h3>
              <span className="dws-branch-label" title={`${t("branch")}: ${task.branch ?? t("branchesDiffer")}`}><GitPullRequest size={12} /><span className="dws-branch-value">{task.branch ?? t("branchesDiffer")}</span></span>
              <span className="dws-count">{task.repositories.length}</span>
              {pendingBadge(task.commits)}
            </span>
            <span className="dws-task-path" title={slashPath(task.path)}>{slashPath(task.path)}</span>
          </span>
          </button>
          <Button className="dws-button-ghost dws-finish-task" disabled={busy || !!action} onClick={() => setArchiving(task.path)}><Check size={15} /><span>{t("finishTask")}</span></Button>
        </header>
        {task.repositories.length === 0 || !collapsed.has(task.path) ? <div className="dws-worktree-list">
          {task.repositories.map(repository => {
            const state = taskRepoStatus(repository)
            return <div className="dws-worktree" key={repository.path}>
              <FolderGit2 size={16} className="dws-tree-icon" aria-hidden="true" />
              <div className="dws-worktree-info"><div className="dws-worktree-title"><strong>{repository.name}</strong><span className={`dws-status dws-status-${state.state}`}><span className="dws-status-dot" />{state.label}</span>{pendingBadge(repository.commits)}{repository.locked ? <span className="dws-status">{t("locked")}</span> : null}</div><div className="dws-worktree-path" title={slashPath(repository.path)}>{slashPath(repository.path)}</div></div>
            </div>
          })}
        </div> : null}
      </article>)}
    </div> : null}
    {view === "spaces" ? <div className="dws-repo-list">
      {workspaceItems.length === 0 ? <p className="dws-no-linked">{t("workspaceEmpty")}</p> : visibleWorkspaces.length === 0 ? <div className="dws-empty"><FolderGit2 size={26} strokeWidth={1.5} /><h3>{t("noMatches")}</h3></div> : visibleWorkspaces.map(workspace => {
        const state = classifications[workspace.path]
        const ready = state !== undefined && state !== "checking" && state !== "failed"
        const canHost = ready && state.isSourceRoot
        // Every Workspace that has answered says what it spans, right after its name,
        // a count of zero included. The sentence explaining that no task space can
        // start there is not a count, so it takes the row's right edge instead: the
        // edge the creation button of the rows that can host one ends on.
        const empty = ready && state.repositoryCount === 0
        const badge = state === "checking"
          ? { className: "dws-status-checking", label: t("workspaceChecking") }
          : ready
            ? { className: canHost ? "dws-status-clean" : "dws-status-zero", label: format(t("workspaceSpans"), { count: String(state.repositoryCount) }) }
            : { className: "dws-status-checking", label: t("workspaceCannot") }
        return <article className="dws-repo" key={workspace.workspaceId}>
          <header className="dws-repo-header">
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
    {archiving ? <ArchiveTaskDialog
      path={archiving}
      api={api}
      workspaces={workspaces}
      sessions={sessions}
      onArchived={() => { void refresh() }}
      onClose={() => setArchiving(null)}
    /> : null}
  </section>
}

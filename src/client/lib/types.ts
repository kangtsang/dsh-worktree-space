import type { WorkspaceView, IWorkspaces } from "@deepseek-ai/dsh-api-workspace-controller/client"
import type { UiWorkspace } from "@deepseek-ai/dsh-client-ui-workspace/client"
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client"
import type { ArchiveStrategy } from "./documents"
import type { HostWarning } from "./host-messages"

/** Workspace row projected by the Host Workspace Controller. */
export type Workspace = WorkspaceView

export interface Worktree {
  path: string
  branch?: string
  head?: string
  isMain: boolean
  detached: boolean
  locked: boolean
  prunable: boolean
  changedFiles?: number
  /** Commits on this worktree's HEAD that the merge target does not have yet. */
  commits?: number
  statusError?: string
  /**
   * The page is reading this row's status right now, so there is no answer to show
   * yet. This is a flag rather than a mark written into `statusError`, because a
   * read still in flight and a read that failed arrive in the same field and must
   * not be told apart by comparing the text.
   */
  checking?: boolean
}

export interface WorktreeStatus {
  branchLine: string
  changedFiles: number
  /** Absent when no target was named, or git could not resolve the one named. */
  commits?: number
  output: string
}

/**
 * One repository's worktrees, as the Host read them.
 *
 * `currentBranch` is filled in on the client from the main worktree's row rather
 * than asked for over git: the scan used to send `defaultBranch` and `defaultRef`,
 * read by nothing anywhere, and `commonDir` before them, also read by nothing. All
 * three cost a `git` process per repository, which on Windows is ~95% process
 * creation - the scan of a ninety-four repository Workspace went from about 3.9s
 * to about 0.9s by dropping them. If a future feature needs one, it belongs on the
 * endpoint that needs it, not back on the path every refresh walks.
 */
export interface WorktreeList {
  repoPath: string
  currentBranch?: string
  worktrees: Worktree[]
}

/**
 * Answer of `worktree.scan`: what was found, and whether that is all of it.
 *
 * A scan that found some of the repositories under a Workspace returns those and
 * `complete: false` with a `reason`. It used to throw instead, which discarded
 * every repository it had already read and left the panel showing whatever was
 * remembered - so one repository refusing to answer turned ninety good rows into
 * an error page.
 */
export interface ScanAnswer {
  lists: WorktreeList[]
  /** Whether `lists` is everything the scan was going to look at. */
  complete: boolean
  /** Why not, in one sentence. Empty when `complete`. */
  reason: string
  /**
   * The bounds this scan really used, as the Host resolved them.
   *
   * Reported rather than guessed at on the client: the panel names the depth while
   * the scan runs, and the Host is the only side that knows it - the config may
   * have moved on, `resolveScanDepth` may have clamped what the caller sent, and a
   * payload may have carried a depth of its own. A name assembled from the client's
   * own copy of the setting is one that can disagree with the walk it is
   * describing, which is the one thing a scanning message must not do.
   */
  bounds: { depth: number; directories: number }
}

/**
 * Answer of `worktree.cached`: what the Host still remembers of a scan, and what
 * a scan would run at right now.
 *
 * It is the previous scan's own answer, held in the Host's memory since that scan
 * and dropped when the DSH instance exits — never written down, and never the last
 * word, because the panel scans again as soon as it has painted this.
 *
 * Answered whether or not anything is remembered. A Host that remembers nothing
 * about these paths has empty `repositories`, which is a different statement from
 * "this Host cannot tell you the current bounds" — and the panel needs the bounds
 * before its very first scan resolves, so a miss must not take them away.
 */
export interface RememberedScan {
  repositories: WorktreeList[]
  /** The statuses the Host happens to hold, by worktree path; others are missing. */
  statuses: Record<string, WorktreeStatus>
  /**
   * The bounds a scan started *now* would use, read from the Host's configuration.
   *
   * Not the remembered scan's own bounds, and not derived from them: a panel that
   * named a depth from a previous run would be showing the scan that just
   * happened, not the one on screen. Read on the Host so the client cannot be the
   * one deciding, and carried here so the panel learns it from a call it already
   * makes rather than from a new round trip.
   */
  current: { depth: number; directories: number }
}

/** One repository a task would span. */
export interface SourceRepository {
  name: string
  path: string
  /** The branch its HEAD is on, absent for a detached or unreadable HEAD. */
  branch?: string
}

/**
 * Answer of `task.classify-root`: whether a workspace can hold a task.
 *
 * A source root is a repository that is not a linked worktree, or a directory
 * whose top-level children are repositories — which is what lets the entry
 * appear for a workspace that is a container rather than a repository.
 */
export interface SourceRootClassification {
  path: string
  /**
   * Whether the path is a directory that exists.
   *
   * `isSourceRoot` cannot be used for this: a directory holding no repositories
   * and a path that is not there both answer false.
   */
  isDirectory: boolean
  /** Whether the path itself is a repository (a linked worktree is not). */
  isRepository: boolean
  /** Whether a task can be started here. */
  isSourceRoot: boolean
  repositoryCount: number
  repositories: SourceRepository[]
}

/** Answer of `task.suggest-root`: the recommended container and its repositories. */
export interface TaskRootSuggestion {
  sourceRoot: string
  suggested: string
  /** Whether the container root came from the caller rather than the recommendation. */
  explicit: boolean
  /** Branch prefix a create would use, so the preview and the host cannot disagree. */
  branchPrefix: string
  repositories: SourceRepository[]
}

/** Answer of `task.create`. */
export interface CreateTaskResult {
  task: string
  /** The project layer the task was filed under: the source root's directory name. */
  project: string
  branch: string
  path: string
  tasksRoot: string
  baseRef?: string
  repositories: Array<{ name: string; path: string }>
}

/**
 * Answer of `task.add-repositories`: the repositories one call added to a task
 * that already existed.
 *
 * The repositories the task already had are not listed — nothing was taken away,
 * and the caller can re-read the task for those — so this is only ever the new
 * worktrees and where their source repositories live.
 */
export interface AddRepositoriesResult {
  task: string
  project: string
  branch: string
  path: string
  tasksRoot: string
  /** The commit the new worktrees started from; absent when each used its own HEAD. */
  baseRef?: string
  repositories: Array<{
    name: string
    /** The worktree inside the task space. */
    path: string
    /** The source repository it was cut from, wherever that is. */
    sourcePath: string
  }>
}

/** Per-repository outcome of `task.done`. */
export interface FinishTaskRepository {
  name: string
  path: string
  /** The source repository behind this worktree, as `task.plan` reports it. */
  mainRepo?: string
  branch?: string
  /** The branch this repository was merged into, when a merge was attempted. */
  target?: string
  merged: boolean
  removed: boolean
  branchDeleted: boolean
  /** Why this repository was left alone; the worktree and branch stay put. */
  error?: string
  /** The merge hit a conflict and left the worktree and branch in place. */
  conflict?: boolean
  /**
   * A merge is deliberately still in progress in this checkout.
   *
   * A conflicting merge is never aborted where it would have to be resolved: the
   * conflicted files are here, and the target branch moves when someone commits the
   * merge here.
   */
  mergeInProgress?: boolean
  /** The checkout an unresolved merge is waiting in. */
  mergeSite?: string
  /** The files the merge could not reconcile, relative to `mergeSite`. */
  conflictedFiles?: string[]
}

/** Answer of `task.inspect`: whether a directory is a task container. */
export interface TaskInspection {
  path: string
  isTask: boolean
  /** The task's name, from its breadcrumb when it has one. */
  task: string
  /** The project the task is filed under, from its record or from its path. */
  project: string
  /** The container root the task sits in, which `task.done` takes as `tasksRoot`. */
  tasksRoot: string
  branch?: string
  sourceRoot?: string
  /**
   * The commit every repository of this task started from, when the task named
   * one rather than starting each repository at its own HEAD. Absent is a fact
   * about the task, not an omission: it is how the caller tells "each at its own
   * HEAD" from "a base this Host cannot name".
   */
  baseRef?: string
  repositories: string[]
}

/** One repository's part of `task.plan`. */
export interface TaskPlanRepository {
  name: string
  path: string
  /**
   * The source repository behind this worktree.
   *
   * The worktree's git directory lives in there, so this is half of what the
   * narrowest write boundary for a session that commits here has to reach.
   */
  mainRepo?: string
  branch?: string
  /** The branch this repository's branch would merge into, as things stand. */
  target?: string
  /** The branch the source repository has checked out: the default target. */
  checkedOut?: string
  /**
   * Every branch that could be merged into instead, the checked-out one first.
   *
   * Branches another worktree holds are left out — merging into one of those would
   * mean moving a checkout someone else is using.
   */
  branches: string[]
  /**
   * Commits that merge would bring, or nothing when git would not say.
   *
   * The Host omits the field rather than reporting a zero it did not count: a caller
   * has to be able to tell "there is nothing to merge" from "this could not be
   * counted", and only the first is a zero. The row's own `error` is what says which
   * happened, so a missing count is shown by leaving it out.
   */
  commits?: number
  changedFiles: number
  error?: string
}

/** One entry in a container that is not a worktree; `cleanStray` removes these. */
export interface TaskPlanStray {
  name: string
  directory: boolean
  /** Documents (`.md` and friends) found in it, so writing can be warned about. */
  documents: number
  /** Build output and editor state are expected; anything else is the user's. */
  kind: "build" | "editor" | "content"
}

/** Answer of `task.plan`: what archiving would do, before anything is done. */
export interface TaskPlan {
  task: string
  /** The project the task is filed under, which `task.done` takes as `project`. */
  project: string
  path: string
  /** The container root the task sits in, which `task.done` takes as `tasksRoot`. */
  tasksRoot: string
  /** The target the first repository resolved, when any did. */
  mergeTarget?: string
  changedFiles: number
  commits: number
  repositories: TaskPlanRepository[]
  /** What the container holds besides its worktrees. */
  strays: TaskPlanStray[]
}

/** Answer of `task.done`. */
export interface FinishTaskResult {
  task: string
  /** The project the finished task was filed under. */
  project: string
  path: string
  /** The merge target the first merged repository reported. */
  mergeTarget?: string
  repositories: FinishTaskRepository[]
  /** Container entries that are not worktrees, so the container was kept. */
  strays: string[]
  /** Leftovers filed into the documents directory rather than deleted. */
  archivedStrays: string[]
  removedStrays: string[]
  containerRemoved: boolean
  failed: boolean
  warnings: HostWarning[]
}

/** Answer of `task.preference`: the settings a dialog defaults from. */
export interface TaskPreference {
  defaultBranchPrefix: string
  /**
   * Which root archived documents are filed under; see {@link ArchiveStrategy}.
   *
   * Optional because the answer is cast rather than parsed: a Host that predates
   * this setting answers without it, and the caller reads that as the shipped
   * default rather than as a strategy it has to guess at.
   */
  archiveDocumentsStrategy?: ArchiveStrategy
  /** The root the `custom` strategy files into, empty when none is set. */
  archiveDocumentsDirectory: string
  /** `show` when the finish offers the two experimental agent entries, `hide` otherwise. */
  handoffEntry: string
  /**
   * `on` when the sessions that a finish hands an agent are opened at the container root
   * with full access, `off` when each keeps the directory that reaches the git metadata
   * and asks before writing outside it.
   *
   * Optional for the same reason as {@link TaskPreference.archiveDocumentsStrategy}: a
   * Host that predates the setting answers without it, and absent reads as `off`, which
   * is what such a Host does.
   */
  handoffFullAccess?: string
  /**
   * `on` when the audit log is being written, `off` when it is not.
   *
   * Optional for the same reason as {@link TaskPreference.archiveDocumentsStrategy}:
   * a Host that predates the setting answers without it, and absent reads as `on`,
   * which is what such a Host does.
   */
  auditLog?: string
}

/** The sessions service face (`ctx.sessions`). */
export type SessionsService = ISessions

/**
 * The workspace navigation face (`ctx.uiWorkspace`).
 *
 * `ISessions.open()` was removed after 0.1.5, so opening a Session is this
 * service's job: `openWorkspace` connects the Workspace (reusing or creating its
 * blank Session) and shows it in one action.
 */
export type WorkspaceNavigation = UiWorkspace

/** Minimal connection face the worktree API needs from `ctx.connection`. */
export interface ConnectionService {
  rpc: {
    call(channel: string, endpoint: string, payload?: unknown, signal?: AbortSignal): Promise<unknown>
  }
}

/** The workspace service face (`ctx.workspaces`). */
export type WorkspacesService = IWorkspaces

/** One running container of a task's deployment, as the live docker query answered. */
export interface DeploymentContainer {
  name: string
  state: string
}

/**
 * A task's deployment, as the panel renders it: what the deploy recorded in its
 * state file, and what docker says is running right now, by the `dsh.env-id` label.
 */
export interface DeploymentStatus {
  envId: string
  target: string
  /** The policy's verification mode, so the finish press knows whether an ack is owed. */
  verification: string
  url: string | null
  /**
   * Where the URL came from: the state a deploy recorded, a one-off read of the
   * deploy root's own `status` command, or nowhere. A derived URL is not a
   * recorded deployment, and the card says so.
   */
  urlSource: "state" | "derived" | "none"
  lastSmoke: { at: string; result: string } | null
  humanAck: { at: string; by?: string } | null
  destroyedAt: string | null
  stateFound: boolean
  statePath: string | null
  containers: DeploymentContainer[]
}

/** What tearing a deployment down answered. */
export interface DeployDestroyResult {
  removed: boolean
  containers: number
  warning?: HostWarning
}

/** What re-running the smoke through the deploy script answered. A failed smoke is a result, not an error. */
export interface DeploySmokeResult {
  output: string
  exitCode: number | null
  status: DeploymentStatus
}

/** What rebuilding the environment through the deploy script answered. */
export interface DeployUpResult {
  /** The tail of the deploy script's output, for a failure to name itself. */
  output: string
  status: DeploymentStatus
}

/** What recording a human acceptance answered. */
export interface DeployAcceptResult {
  statePath: string
  humanAck: { at: string; by?: string }
}

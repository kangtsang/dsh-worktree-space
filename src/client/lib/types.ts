import type { WorkspaceView, IWorkspaces } from "@deepseek-ai/dsh-api-workspace-controller/client"
import type { UiWorkspace } from "@deepseek-ai/dsh-client-ui-workspace/client"
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client"

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
  statusError?: string
}

export interface WorktreeStatus {
  branchLine: string
  changedFiles: number
  output: string
}

export interface WorktreeList {
  repoPath: string
  commonDir: string
  defaultBranch?: string
  defaultRef?: string
  currentBranch?: string
  worktrees: Worktree[]
}

/** One repository a task would span. */
export interface SourceRepository {
  name: string
  path: string
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
  branch: string
  path: string
  tasksRoot: string
  baseRef?: string
  repositories: Array<{ name: string; path: string }>
  warnings: string[]
}

/** Per-repository outcome of `task.done`. */
export interface FinishTaskRepository {
  name: string
  path: string
  branch?: string
  /** The branch this repository was merged into, when a merge was attempted. */
  target?: string
  merged: boolean
  removed: boolean
  branchDeleted: boolean
  /** Why this repository was left alone; the worktree and branch stay put. */
  error?: string
}

/** Answer of `task.inspect`: whether a directory is a task container. */
export interface TaskInspection {
  path: string
  isTask: boolean
  /** The task's name, from its breadcrumb when it has one. */
  task: string
  /** The container root the task sits in, which `task.done` takes as `tasksRoot`. */
  tasksRoot: string
  branch?: string
  sourceRoot?: string
  repositories: string[]
}

/** One repository's part of `task.plan`. */
export interface TaskPlanRepository {
  name: string
  path: string
  branch?: string
  /** The branch this repository's branch would merge into. */
  target?: string
  /** Commits that merge would bring. */
  commits: number
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
  warnings: string[]
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

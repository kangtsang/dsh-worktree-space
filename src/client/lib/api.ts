import type {
  ConnectionService,
  CreateTaskResult,
  FinishTaskResult,
  RememberedScan,
  SourceRootClassification,
  TaskInspection,
  TaskPlan,
  TaskRootSuggestion,
  WorktreeList,
  WorktreeStatus,
} from "./types"

export const CHANNEL = "/api"

function classifyError(code: unknown, message: string): string | undefined {
  if (code === "not-git-repository" || /not a git repository/i.test(message)) return "not-git-repository"
  if (code === "worktree-unavailable" || /is not a working tree|No such file or directory/i.test(message)) return "worktree-unavailable"
  return undefined
}

export function createWorktreeApi(connection: ConnectionService) {
  async function call<T>(endpoint: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const args = [CHANNEL, `dsh-worktree-space/${endpoint}`, payload] as const
    const result = await (signal ? connection.rpc.call(...args, signal) : connection.rpc.call(...args)) as any
    if (!result?.ok) {
      const message = result?.error?.message ?? "worktree operation failed"
      const code = classifyError(result?.error?.code, message)
      const error = new Error(code ?? message)
      ;(error as Error & { code?: string }).code = code ?? result?.error?.code
      throw error
    }
    return result.value as T
  }

  // Bound read-only work. Mutating calls deliberately do not time out here:
  // a timeout must not encourage retrying a creation that may have succeeded.
  async function read<T>(endpoint: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    const timeoutError = new Error('Worktree request timed out. Refresh or select a more specific Workspace.')
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: () => void = () => {}
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => { controller.abort(); reject(new Error('Worktree request cancelled.')) }
      timer = setTimeout(() => { controller.abort(); reject(timeoutError) }, 15000)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
    try { return await Promise.race([call<T>(endpoint, payload, controller.signal), cancelled]) }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
  }

  return {
    scan: (paths: string[], signal?: AbortSignal) => read<WorktreeList[]>("worktree.scan", { paths }, signal),
    /**
     * What the Host remembers of the last scan of these Workspaces.
     *
     * Reading it is a memory lookup on the Host, not a scan: it is what lets a
     * reopened panel paint the previous result at once, while the fresh scan it
     * starts alongside it is still running. `null` means this Host holds nothing.
     */
    cachedScan: (paths: string[], signal?: AbortSignal) => read<RememberedScan | null>("worktree.cached", { paths }, signal),
    status: (path: string, signal?: AbortSignal) => read<WorktreeStatus>("worktree.status", { path }, signal),

    /** Whether a workspace can hold a task, and which repositories it would span. */
    classifyRoot: (sourceRoot: string, signal?: AbortSignal) => read<SourceRootClassification>("task.classify-root", { sourceRoot }, signal),
    /** The recommended container location for a source root, before creating anything. */
    suggestRoot: (sourceRoot: string, tasksRoot?: string, signal?: AbortSignal) => read<TaskRootSuggestion>("task.suggest-root", { sourceRoot, tasksRoot }, signal),
    /** Create the task: one worktree per repository, all on one branch. */
    createTask: (payload: { sourceRoot: string; task: string; tasksRoot?: string; repos: string[]; baseRef?: string }) => call<CreateTaskResult>("task.create", payload),
    /** Whether a directory is a task container, and what it holds. */
    inspectTask: (path: string, signal?: AbortSignal) => read<TaskInspection>("task.inspect", { path }, signal),
    /** What archiving a task would do, before doing any of it. */
    planTask: (payload: { task: string; tasksRoot: string }, signal?: AbortSignal) => read<TaskPlan>("task.plan", payload, signal),
    /** Finish a task: remove its worktrees, keeping the branches unless asked otherwise. */
    doneTask: (payload: { task: string; tasksRoot: string; merge?: boolean; target?: string; deleteBranch?: boolean; force?: boolean; cleanStray?: boolean; keep?: string[]; documentsDirectory?: string; discardDocuments?: boolean }) => call<FinishTaskResult>("task.done", payload),
  }
}

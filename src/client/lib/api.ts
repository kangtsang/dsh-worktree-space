import { failure } from "./error-text"
import type {
  AddRepositoriesResult,
  ConnectionService,
  CreateTaskResult,
  DeployAcceptResult,
  DeployDestroyResult,
  DeploySmokeResult,
  DeployUpResult,
  DeploymentStatus,
  FinishTaskResult,
  RememberedScan,
  SourceRootClassification,
  TaskInspection,
  TaskPlan,
  ScanAnswer,
  TaskPreference,
  TaskRootSuggestion,
  WorktreeStatus,
} from "./types"

export const CHANNEL = "/api"

/**
 * Map a Host failure onto a code the dialog can act on.
 *
 * The Host sends `E` and four digits - `task/codes.js` is the index, and every
 * code is written literally at the throw site so it can be grepped for. Only the
 * ones that change what the dialog does are named here; the rest stay on the
 * error as themselves and are shown as the Host's message.
 *
 * The message patterns are a fallback for a Host older than the codes, and for
 * E9001 - the code that means "nothing here classifies this". Both leave only the
 * wording to match on, which is why it is trusted only when no specific code came.
 * @param code - the code the Host sent, if any.
 * @param message - its message, used when no specific code came.
 * @returns the code to put on the error, or undefined to leave it alone.
 */
function classifyError(code: unknown, message: string): string | undefined {
  const unclassified = code === undefined || code === "E9001"
  if (code === "E3004" || (unclassified && /not a git repository/i.test(message))) return "E3004"
  if (code === "E3005" || (unclassified && /is not a working tree|No such file or directory/i.test(message))) return "E3005"
  // Set by the host, never by matching wording: the container on disk is this
  // task's own, left behind by a create that could not register its Workspace.
  if (code === "E2002") return "task-space-unregistered"
  if (code === "E2001") return "task-space-exists"
  if (code === "E3001") return "branch-exists"
  return undefined
}

export function createWorktreeApi(connection: ConnectionService) {
  async function call<T>(endpoint: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const args = [CHANNEL, `dsh-worktree-space/${endpoint}`, payload] as const
    const result = await (signal ? connection.rpc.call(...args, signal) : connection.rpc.call(...args)) as any
    if (!result?.ok) {
      // The Host's own message, because that is the sentence the dialog shows and it
      // is the one written for a person to read. The code is a separate field, not
      // the message: it is for deciding what to do, and a dialog that renders it as
      // the message shows someone "E3004" and nothing else. The two are deliberately
      // different jobs - the message may be reworded or translated, the code may not,
      // which is why it is the thing to grep the log with.
      const sent = result?.error?.message
      if (sent === undefined) {
        // A Host that answered with no sentence at all leaves nothing to translate and
        // nothing to show; the failure is named instead, and said in the interface
        // language where it is displayed.
        throw failure("worktree-failed")
      }
      const code = classifyError(result?.error?.code, String(sent)) ?? result?.error?.code
      const error = new Error(String(sent))
      ;(error as Error & { code?: string }).code = code
      // The values the Host built its sentence from travel with the failure, so a screen
      // can say the same thing in the reader's language: the sentence above is what the
      // Host logged, and it is not reworded here.
      ;(error as Error & { details?: unknown }).details = result?.error?.details
      throw error
    }
    return result.value as T
  }

  // Bound read-only work. Mutating calls deliberately do not time out here:
  // a timeout must not encourage retrying a creation that may have succeeded.
  async function read<T>(endpoint: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    // Named rather than worded: there is no dictionary down here to word it in, and
    // these two are shown in whatever language the interface is in.
    const timeoutError = failure("worktree-timeout")
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: () => void = () => {}
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => { controller.abort(); reject(failure("worktree-cancelled")) }
      timer = setTimeout(() => { controller.abort(); reject(timeoutError) }, 15000)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
    try { return await Promise.race([call<T>(endpoint, payload, controller.signal), cancelled]) }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
  }

  return {
    scan: (paths: string[], signal?: AbortSignal, depth?: number) =>
      read<ScanAnswer>("worktree.scan", depth === undefined ? { paths } : { paths, depth }, signal),
    /**
     * What the Host remembers of the last scan of these Workspaces.
     *
     * Reading it is a memory lookup on the Host, not a scan: it is what lets a
     * reopened panel paint the previous result at once, while the fresh scan it
     * starts alongside it is still running. `null` means this Host holds nothing.
     */
    cachedScan: (paths: string[], signal?: AbortSignal) => read<RememberedScan | null>("worktree.cached", { paths }, signal),
    /**
     * One worktree's status. `target` names the branch the commits are counted
     * against - the one the source checkout sits on, which is where finishing
     * merges - and is optional: without it the answer carries no commit count.
     */
    status: (path: string, target?: string, signal?: AbortSignal) => read<WorktreeStatus>("worktree.status", target ? { path, target } : { path }, signal),

    /** Whether a workspace can hold a task, and which repositories it would span. */
    classifyRoot: (sourceRoot: string, signal?: AbortSignal) => read<SourceRootClassification>("task.classify-root", { sourceRoot }, signal),
    /**
     * Several source roots, classified as one request.
     *
     * The same walk the singular form performs, taken now for every path -
     * nothing here is cached or reused across calls, because a user who has
     * since made a repository must not be told it is not one. What it saves is
     * the round trip and the wait between walks, not the reading.
     * @param sourceRoots - the paths to classify.
     * @param signal - an abort signal, when the caller has one.
     * @returns one classification per path, in the order asked.
     */
    classifyRoots: (sourceRoots: string[], signal?: AbortSignal) => read<SourceRootClassification[]>("task.classify-roots", { paths: sourceRoots }, signal),
    /** The recommended container location for a source root, before creating anything. */
    suggestRoot: (sourceRoot: string, tasksRoot?: string, signal?: AbortSignal) => read<TaskRootSuggestion>("task.suggest-root", { sourceRoot, tasksRoot }, signal),
    /**
     * This Host's preference for a new task space's branch prefix.
     *
     * Read rather than assumed: the value is the plugin configuration's, which the
     * user edits on the Plugins page, and the dialog starts from whatever is in
     * force. The write path is the configuration form itself.
     */
    preferences: (signal?: AbortSignal) => read<TaskPreference>("task.preference", {}, signal),
    /** Create the task: one worktree per repository, all on one branch. */
    createTask: (payload: { sourceRoot: string; task: string; tasksRoot?: string; repos: string[]; baseRef?: string; branchPrefix?: string }) => call<CreateTaskResult>("task.create", payload),
    /**
     * Add repositories to a task that already exists.
     *
     * `repositories` are absolute paths rather than names under a source root: a
     * repository added to a running task need not sit beside the ones it started
     * with, so there is no directory to resolve a name against. They may be on
     * another volume — the merge at the end reads each worktree's own source
     * repository, so where it is makes no difference to that.
     */
    addRepositories: (payload: { task: string; project: string; tasksRoot: string; repositories: string[]; baseRef?: string }) => call<AddRepositoriesResult>("task.add-repositories", payload),
    /** Whether a directory is a task container, and what it holds. */
    inspectTask: (path: string, signal?: AbortSignal) => read<TaskInspection>("task.inspect", { path }, signal),
    /**
     * What archiving a task would do, before doing any of it.
     *
     * `project` is the layer the task is filed under, one directory below the
     * container root; the three together name the task space exactly, which is
     * what keeps a raw path out of the protocol.
     */
    planTask: (payload: { task: string; project: string; tasksRoot: string; targets?: Record<string, string> }, signal?: AbortSignal) => read<TaskPlan>("task.plan", payload, signal),
    /** Finish a task: remove its worktrees, keeping the branches unless asked otherwise. */
    doneTask: (payload: { task: string; project: string; tasksRoot: string; targets?: Record<string, string>; merge?: boolean; target?: string; deleteBranch?: boolean; force?: boolean; cleanStray?: boolean; keep?: string[]; documentsDirectory?: string; discardDocuments?: boolean; cause?: string; acknowledgeDelivery?: boolean }) => call<FinishTaskResult>("task.done", payload),
    /**
     * A task's deployment, read live: docker by the `dsh.env-id` label for what runs
     * right now, the deploy's state file for the URL, the smoke and the human ack.
     * A dynamic port changes with every deploy, so this is asked, never remembered.
     */
    deployStatus: (path: string, signal?: AbortSignal) => read<DeploymentStatus>("task.deploy-status", { path }, signal),
    /**
     * Tear the task's environment down, best effort by the same label: compose first
     * (the containers carry the file and directory to use), then whatever is still
     * standing. Answers what it could not remove rather than raising.
     */
    destroyDeployment: (path: string) => call<DeployDestroyResult>("task.deploy-destroy", { path }),
    /**
     * Rebuild the environment through the task space's own deploy script — the
     * one-click 「部署验收」 behind a destroyed card. The acceptance facts the
     * previous environment earned (its smoke, its ack) stay on the task; only a
     * new smoke, when the task's flow runs one, renews them.
     */
    deployUp: (path: string) => call<DeployUpResult>("task.deploy-up", { path }),
    /**
     * Re-run the smoke through the task's own script. A failed smoke comes back
     * as a result (the red badge), not as a thrown error.
     */
    deploySmoke: (path: string) => call<DeploySmokeResult>("task.deploy-smoke", { path }),
    /**
     * Record the user's acceptance on the deployment state — the one act that turns
     * a green smoke into a deliverable task under the agent-then-human policy.
     */
    acceptDeployment: (path: string) => call<DeployAcceptResult>("task.deploy-accept", { path }),
  }
}

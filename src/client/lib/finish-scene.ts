import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client"
import { cleanPath } from "./paths"
import type { FinishTaskResult } from "./types"

/** One session a finish opened, as the report remembers it. */
export interface FinishSceneSession {
  name: string
  /** The worktree the conflict is standing in. */
  site: string
  /**
   * The session's working directory, which is its write boundary.
   *
   * A linked worktree keeps its git metadata inside the source repository, and the
   * commit that settles the work is a git command: this is the narrowest directory
   * that reaches both, so that command is allowed where it has to write.
   */
  boundary: string
  /**
   * Whether that directory really reaches the git metadata of every repository it covers.
   *
   * A commit writes into that metadata, and only a directory that reaches it can carry the
   * command out: a session opened on the task space because the worktrees share no directory
   * does not reach it, and there the panel says the elevation is the user's to approve.
   */
  wide: boolean
  /**
   * Whether the session was opened with full access, which is the other way it can be
   * allowed to write a repository's git metadata.
   *
   * A session opened on the container root is not `wide` - that directory does not reach
   * the metadata - and is allowed to write it because the setting gave it the whole
   * disk. The panel says which of the two applies rather than inferring it from `wide`,
   * and the sentence the agent is handed says it too.
   *
   * Optional because a scene written by an earlier build has no such field, and a scene
   * comes back from the page's own memory rather than from the Host: absent means the
   * directory the session was opened on was the one expected to reach the metadata.
   */
  fullAccess?: boolean
  /** What the session was opened to do, which is what the panel calls it. */
  kind: "commit" | "conflict"
  sessionId: Awaited<ReturnType<ISessions["create"]>>
}

/** What the finish report needs to be put back after its dialog was unmounted. */
export interface FinishScene {
  /** The answer from the Host, or null while the agents it handed work to are running. */
  result: FinishTaskResult | null
  handoff: FinishSceneSession[]
}

/**
 * The finish reports that are still waiting on the user, by task path.
 *
 * Opening a handed-off session replaces the view the dialog lives in, so the report —
 * and with it the record of which sessions were opened — would be gone exactly when
 * the user comes back from approving one. It is held in the module for the life of the
 * page: nothing here is durable, and a reload starts clean, which is what keeps a stale
 * report from reappearing over a task that has been dealt with since.
 */
const scenes = new Map<string, FinishScene>()

/** Keep a report for a task, replacing whatever it held before. */
export function saveFinishScene(path: string, scene: FinishScene) {
  scenes.set(cleanPath(path), scene)
}

/** The report held for a task, if it still has one. */
export function readFinishScene(path: string) {
  return scenes.get(cleanPath(path))
}

/** Forget a task's report: the finish it describes is over. */
export function clearFinishScene(path: string) {
  scenes.delete(cleanPath(path))
}

/** The tasks with a report still to show, so the page can reopen one. */
export function finishScenes() {
  return [...scenes.keys()]
}

/** Forget every report. The page keeps none across a reload, and tests none across a case. */
export function clearFinishScenes() {
  scenes.clear()
}

import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client"
import { cleanPath } from "./paths"
import type { FinishTaskResult } from "./types"

/** One session a finish opened, as the report remembers it. */
export interface FinishSceneSession {
  name: string
  /** The worktree the merge is standing in. */
  site: string
  /** The session's working directory, which is its write boundary. */
  boundary: string
  sessionId: Awaited<ReturnType<ISessions["create"]>>
}

/** What the finish report needs to be put back after its dialog was unmounted. */
export interface FinishScene {
  result: FinishTaskResult
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

/**
 * The props the two changes tabs draw from.
 *
 * The tab's own identity, address and actions arrive through the slot-owned
 * `useTabInfo` hook; `api` is the plugin's injected Host face. The real slot
 * declaration lives in the shell's sidebar package, which this plugin does not
 * depend on, so the shape is written out here rather than imported.
 */
import type { createWorktreeApi } from "./api"

/** The part of a tab record the changes tabs read. */
export interface ChangesTabRecord {
  id: string
  contentId: string
  kind: string
  actions: {
    openResource(address: string, options?: unknown): void
  }
}

/**
 * Replace the comment block this plugin wrote into a session's input.
 * @param sessionId - the session whose input receives it.
 * @param block - the whole block; empty removes the previous one.
 * @returns false when the session has no input face to write to.
 */
export type CommentSyncer = (sessionId: string, block: string) => boolean

/** Composed props of a changes tab body. */
export type ChangesTabProps = {
  useTabInfo: () => { tab: ChangesTabRecord }
  api: ReturnType<typeof createWorktreeApi>
  /** The session whose input the comment block is kept in. */
  sessionId: string
  /** Replaces the comment block in that session's input. */
  syncComments: CommentSyncer
}
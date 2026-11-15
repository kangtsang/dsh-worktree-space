import { useSyncExternalStore } from "react"
import type { CommentSide } from "./review-quote"

/**
 * The review comments a session keeps, and the text they contribute to its input.
 *
 * A comment is written into this buffer first and the input is rebuilt from the
 * whole buffer afterwards. That is what makes "edit a comment" possible at all:
 * the conversation input can insert a quote but cannot address one later, so the
 * only reliable way to keep an edited comment in step with the draft is to own
 * the text here and replace the block this plugin previously wrote.
 *
 * The comments belong to the session, not to one tab: two changes tabs of the
 * same session write into one input, and flushing either must keep the other's
 * comments. `address` still travels with each comment so a tab only draws its
 * own.
 */
export type { CommentSide }

export interface ReviewComment {
  id: string
  /** The tab address the comment was written in, so that tab can draw it. */
  address: string
  repoPath: string
  base: string
  path: string
  side: CommentSide
  line: number
  /** The hunk the comment quotes; kept so a later edit does not need the diff again. */
  hunk: string
  body: string
  createdAt: number
}

/** The block this plugin last wrote into one session's input. */
const BLOCK_KEY = "dsh-worktree-space.changes.flushed.v1"
const COMMENTS_KEY = "dsh-worktree-space.changes.comments.v1"

type Stored = Record<string, readonly ReviewComment[]>

const listeners = new Set<() => void>()
let cache: Stored | undefined

const EMPTY: readonly ReviewComment[] = Object.freeze([])

function read(): Stored {
  try {
    const raw = localStorage.getItem(COMMENTS_KEY)
    if (raw === null || raw === "") return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const stored: Stored = {}
    for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue
      stored[sessionId] = value.filter(isComment)
    }
    return stored
  } catch {
    return {}
  }
}

function isComment(value: unknown): value is ReviewComment {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const comment = value as Record<string, unknown>
  return typeof comment.id === "string"
    && typeof comment.address === "string"
    && typeof comment.repoPath === "string"
    && typeof comment.base === "string"
    && typeof comment.path === "string"
    && (comment.side === "L" || comment.side === "R")
    && typeof comment.line === "number"
    && typeof comment.hunk === "string"
    && typeof comment.body === "string"
    && typeof comment.createdAt === "number"
}

function write(next: Stored): void {
  cache = next
  try { localStorage.setItem(COMMENTS_KEY, JSON.stringify(next)) } catch { /* in-memory answers stay */ }
  for (const listener of listeners) listener()
}

function stored(): Stored {
  if (cache === undefined) cache = read()
  return cache
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * The comments of one session, in insertion order.
 * @param sessionId - the session whose input they feed.
 * @returns the comments; the same array identity until one changes.
 */
export function commentsFor(sessionId: string): readonly ReviewComment[] {
  return stored()[sessionId] ?? EMPTY
}

/** Subscribe a component to one session's comments. */
export function useReviewComments(sessionId: string): readonly ReviewComment[] {
  return useSyncExternalStore(subscribe, () => commentsFor(sessionId), () => commentsFor(sessionId))
}

/**
 * Add one comment, then let the input block be rebuilt by the caller.
 * @param sessionId - the owning session.
 * @param comment - the complete comment, including the hunk it quotes.
 */
export function addReviewComment(sessionId: string, comment: ReviewComment): void {
  const all = { ...stored(), [sessionId]: [...commentsFor(sessionId), comment] }
  write(all)
}

/**
 * Replace one comment's body.
 * @param sessionId - the owning session.
 * @param id - the comment.
 * @param body - the new text; an empty body leaves the comment unchanged.
 */
export function updateReviewComment(sessionId: string, id: string, body: string): void {
  if (body.trim() === "") return
  const next = commentsFor(sessionId).map((comment) => comment.id === id ? { ...comment, body } : comment)
  write({ ...stored(), [sessionId]: next })
}

/**
 * Remove one comment.
 * @param sessionId - the owning session.
 * @param id - the comment.
 */
export function removeReviewComment(sessionId: string, id: string): void {
  write({ ...stored(), [sessionId]: commentsFor(sessionId).filter((comment) => comment.id !== id) })
}

/**
 * The session's whole comment block, as the input carries it.
 * @param sessionId - the owning session.
 * @param render - formats one comment; the one-based position numbers it.
 * @returns the Markdown block, empty when the session has no comments.
 */
export function commentsBlock(sessionId: string, render: (comment: ReviewComment, index: number) => string): string {
  return commentsFor(sessionId).map((comment, index) => render(comment, index + 1)).join("\n\n")
}

/** The exact block this plugin last flushed into a session's input. */
export function lastFlushedBlock(sessionId: string): string {
  try {
    const raw = localStorage.getItem(BLOCK_KEY)
    if (raw === null) return ""
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return ""
    const value = (parsed as Record<string, unknown>)[sessionId]
    return typeof value === "string" ? value : ""
  } catch {
    return ""
  }
}

/** Remember the block written into a session's input. */
export function rememberFlushedBlock(sessionId: string, block: string): void {
  try {
    const raw = localStorage.getItem(BLOCK_KEY)
    const parsed: unknown = raw === null ? {} : JSON.parse(raw)
    const all = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    localStorage.setItem(BLOCK_KEY, JSON.stringify({ ...all, [sessionId]: block }))
  } catch {
    // Losing the memory costs the next flush its exact removal; the block match
    // falls back to appending, which the reader can clean up in the input.
  }
}
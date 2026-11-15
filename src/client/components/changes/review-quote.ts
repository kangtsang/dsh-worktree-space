/**
 * The frozen reference a line comment becomes when it is added to the input.
 *
 * The shape is the shell's own (`## User Comment N`, then File, Side, Lines,
 * a source line, the diff hunk and the comment), because the model has learned
 * to read that block and because the conversation input renders it as a quote
 * chip from the summary below. One field is added to the shell's list: the
 * repository, since a worktree-space session sits above several checkouts and
 * a repository-relative `File:` alone would be ambiguous.
 */
import type { ChangeHunk } from "../../lib/types"

/** Which side of the diff a line belongs to: old (L) or new (R). */
export type CommentSide = "L" | "R"

/** One line a reader wants to comment on. */
export interface CommentTarget {
  path: string
  side: CommentSide
  line: number
}

/** Where the change lives, as the quote names it. */
export interface CommentSource {
  repoPath: string
  branch: string
  base: string
}

/** The one-line name of a commented line, such as `R603`. */
export function commentRange(target: CommentTarget): string {
  return `${target.side}${target.line}`
}

/**
 * Which line one drawn row comments as.
 *
 * The rule the view shows:
 * - an added line names the new side (R) and its new number;
 * - a removed line names the old side (L) and its old number;
 * - an unchanged line names the old side (L) when both sides carry the same
 *   number, and the new side (R) when an insertion or removal before it moved
 *   the two apart — so the quote always names the number the reader sees for
 *   the side the row belongs to.
 * @param row - a drawn row's kind and its two line numbers.
 * @param path - the file the row belongs to.
 * @returns the comment target, or undefined for a gap row.
 */
export function targetForRow(row: { kind: "add" | "del" | "context" | "gap"; oldLine?: number; newLine?: number }, path: string): CommentTarget | undefined {
  if (row.kind === "add") return row.newLine === undefined ? undefined : { path, side: "R", line: row.newLine }
  if (row.kind === "del") return row.oldLine === undefined ? undefined : { path, side: "L", line: row.oldLine }
  if (row.kind === "gap") return undefined
  if (row.oldLine !== undefined && row.newLine !== undefined) {
    return row.oldLine === row.newLine
      ? { path, side: "L", line: row.oldLine }
      : { path, side: "R", line: row.newLine }
  }
  return row.newLine === undefined
    ? (row.oldLine === undefined ? undefined : { path, side: "L", line: row.oldLine })
    : { path, side: "R", line: row.newLine }
}

/**
 * The hunk containing one line of a side.
 * @param hunks - the file's hunks.
 * @param target - the side and line.
 * @returns the hunk, or undefined when the line is not in one.
 */
export function hunkAt(hunks: readonly ChangeHunk[], target: CommentTarget): ChangeHunk | undefined {
  for (const hunk of hunks) {
    const start = target.side === "L" ? hunk.oldStart : hunk.newStart
    const count = target.side === "L" ? hunk.oldLines : hunk.newLines
    if (target.line >= start && target.line < start + Math.max(count, 1)) return hunk
  }
  return undefined
}

/** The hunk as the quote carries it: its header and every line with its own marker. */
export function hunkText(hunk: ChangeHunk): string {
  return [hunk.header, ...hunk.lines].join("\n")
}

/**
 * Format the frozen reference one comment becomes.
 * @param target - the file, side and line the comment was written on.
 * @param hunk - the containing hunk's text.
 * @param source - the repository and the comparison it is read against.
 * @param body - the comment itself.
 * @param index - one-based number among the quotes already in the input.
 * @returns the Markdown block the input stores as one quote.
 */
export function formatCommentQuote(target: CommentTarget, hunk: string, source: CommentSource, body: string, index: number): string {
  const fence = "`".repeat(Math.max(3, ...Array.from(hunk.matchAll(/`+/g), (match) => match[0].length + 1)))
  const base = source.base === "" ? "" : `\nBase: ${source.base}`
  return [
    `## User Comment ${index}`,
    `File: ${target.path}`,
    `Repository: ${source.repoPath}`,
    `Side: ${target.side}`,
    `Lines: ${target.line}`,
    `Source: Local (branch)${base}`,
    "Diff hunk:",
    `${fence}diff`,
    hunk,
    fence,
    "Comment:",
    body,
  ].join("\n")
}
/**
 * Turns a file's hunks into the rows the view draws.
 *
 * A hunk carries its own line numbers, so the two columns are counted from the
 * hunk header rather than from the previous row: an added line moves the new
 * column only, a removed line the old one, and unchanged text moves both. The
 * unchanged lines between two hunks are left out by git; they become one row
 * that says how many were hidden, which is what the reader clicks to widen the
 * context.
 */
import type { ChangeHunk } from "../../lib/types"

/** One drawn row: a line of the patch, or the gap between two hunks. */
export interface DiffRow {
  kind: "add" | "del" | "context" | "gap"
  oldLine?: number
  newLine?: number
  text: string
  /** Unchanged lines hidden between the previous hunk and this one. */
  gap?: number
}

/**
 * Build the rows of one file.
 * @param hunks - the file's hunks, in order.
 * @returns the rows, gaps included.
 */
export function diffRows(hunks: readonly ChangeHunk[]): DiffRow[] {
  const rows: DiffRow[] = []
  let previousOldEnd: number | undefined
  for (const hunk of hunks) {
    if (previousOldEnd !== undefined) {
      const gap = hunk.oldStart - previousOldEnd
      if (gap > 0) rows.push({ kind: "gap", text: "", gap })
    }
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    for (const line of hunk.lines) {
      if (line === "") continue
      const marker = line.charAt(0)
      const text = line.slice(1)
      if (marker === "+") {
        rows.push({ kind: "add", newLine, text })
        newLine += 1
        continue
      }
      if (marker === "-") {
        rows.push({ kind: "del", oldLine, text })
        oldLine += 1
        continue
      }
      if (marker === " ") {
        rows.push({ kind: "context", oldLine, newLine, text })
        oldLine += 1
        newLine += 1
      }
    }
    previousOldEnd = oldLine
  }
  return rows
}

/** The next context a gap's click asks for, or undefined when it is already the widest. */
export function widenedContext(hunks: readonly ChangeHunk[]): number {
  let widest = 3
  for (const hunk of hunks) {
    const span = Math.max(hunk.oldLines, hunk.newLines)
    if (span > widest) widest = span
  }
  return Math.min(200, widest + 40)
}

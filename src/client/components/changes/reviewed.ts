/**
 * Which files a reader has marked reviewed.
 *
 * The marks are this browser's, not the Host's: there is nothing to write back
 * in a working-tree comparison, and the shell's own local-changes view keeps the
 * same kind of mark in local storage for the same reason. A mark records the
 * change it was made on — a file whose shape changes afterwards is a different
 * change, and reads as unmarked with a "new changes" note rather than as
 * reviewed work nobody looked at.
 */
import { useCallback, useEffect, useState } from "react"
import type { ChangeFile } from "../../lib/types"

/** One browser's marks, by the tab address they were made in. */
type Stored = Record<string, Readonly<Record<string, string>>>

/** Where the marks live. Versioned so a changed shape never half-reads an old one. */
const STORAGE_KEY = "dsh-worktree-space.changes.reviewed.v1"

/** A file's path-to-signature map inside one address. */
export type ReviewedMarks = Readonly<Record<string, string>>

/**
 * The change a mark belongs to.
 *
 * Path, type, both line counts and the old path of a rename are what the view
 * draws before a file is opened; a comparison whose shape changed has different
 * numbers and so is not the change that was marked.
 * @param file - one changed file.
 * @returns a stable string for this change of this path.
 */
export function signatureOf(file: ChangeFile): string {
  return [
    file.status,
    String(file.insertions),
    String(file.deletions),
    file.oldPath ?? "",
    file.untracked === true ? "untracked" : "",
    file.binary === true ? "binary" : "",
  ].join("|")
}

/**
 * Whether the file's current change is the one that was marked.
 * @param marks - the address's marks.
 * @param file - the file as the list reports it now.
 * @returns whether it is marked.
 */
export function isReviewed(marks: ReviewedMarks, file: ChangeFile): boolean {
  return marks[file.path] === signatureOf(file)
}

/**
 * Whether the path was marked, on a change that is no longer the current one.
 * @param marks - the address's marks.
 * @param file - the file as the list reports it now.
 * @returns whether the mark is stale.
 */
export function hasNewChanges(marks: ReviewedMarks, file: ChangeFile): boolean {
  const marked = marks[file.path]
  return marked !== undefined && marked !== signatureOf(file)
}

/** Read every address's marks, treating an unavailable storage as no marks. */
function readAll(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null || raw === "") return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const stored: Stored = {}
    for (const [address, marks] of Object.entries(parsed as Record<string, unknown>)) {
      if (marks === null || typeof marks !== "object" || Array.isArray(marks)) continue
      const kept: Record<string, string> = {}
      for (const [path, signature] of Object.entries(marks as Record<string, unknown>)) {
        if (typeof signature === "string") kept[path] = signature
      }
      stored[address] = kept
    }
    return stored
  } catch {
    return {}
  }
}

/** Write one address's marks back, keeping every other address's. */
function writeAll(address: string, marks: ReviewedMarks): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readAll(), [address]: marks }))
  } catch {
    // A storage that refuses the write (quota, private mode) costs persistence,
    // not the marks on screen: the caller keeps them in state.
  }
}

/**
 * The marks of one tab, read once and kept in this browser.
 * @param address - the tab's content address, which scopes the marks.
 * @returns the marks and the action that flips one file.
 */
export function useReviewedMarks(address: string): { marks: ReviewedMarks; toggle: (file: ChangeFile) => void } {
  const [marks, setMarks] = useState<ReviewedMarks>(() => readAll()[address] ?? {})
  useEffect(() => { writeAll(address, marks) }, [address, marks])
  const toggle = useCallback((file: ChangeFile) => {
    setMarks((previous) => {
      const next = { ...previous }
      if (next[file.path] === signatureOf(file)) delete next[file.path]
      else next[file.path] = signatureOf(file)
      return next
    })
  }, [])
  return { marks, toggle }
}
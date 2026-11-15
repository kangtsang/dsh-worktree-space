/**
 * The reviewed marks' rule.
 *
 * A mark belongs to one change of one path, not to the path for ever: the file
 * list can be re-read at any time, and a mark that survived a changed file
 * would read as reviewed work nobody looked at. These cases pin the binding
 * between a mark and the shape it was made on, and the stale answer that the
 * card shows instead of silently dropping the mark.
 */
import { describe, expect, it } from "vitest"
import { hasNewChanges, isReviewed, signatureOf } from "../src/client/components/changes/reviewed"
import type { ChangeFile } from "../src/client/lib/types"

function file(overrides: Partial<ChangeFile> = {}): ChangeFile {
  return { path: "src/app.ts", status: "modified", insertions: 4, deletions: 1, ...overrides }
}

describe("reviewed marks", () => {
  it("binds a mark to the change it was made on", () => {
    const marks = { [file().path]: signatureOf(file()) }
    expect(isReviewed(marks, file())).toBe(true)
    expect(isReviewed(marks, file({ insertions: 5 }))).toBe(false)
    expect(isReviewed(marks, file({ status: "added", insertions: 4, deletions: 0 }))).toBe(false)
  })

  it("tells a stale mark from no mark at all", () => {
    const marks = { [file().path]: signatureOf(file()) }
    expect(hasNewChanges(marks, file({ deletions: 3 }))).toBe(true)
    expect(hasNewChanges(marks, file())).toBe(false)
    expect(hasNewChanges({}, file())).toBe(false)
  })

  it("includes what the list draws before the file is opened", () => {
    const renamed = file({ status: "renamed", oldPath: "src/old.ts" })
    expect(signatureOf(renamed)).toContain("src/old.ts")
    expect(signatureOf(file({ untracked: true }))).toContain("untracked")
    expect(signatureOf(file({ binary: true }))).toContain("binary")
    expect(signatureOf(renamed)).not.toBe(signatureOf(file()))
  })
})
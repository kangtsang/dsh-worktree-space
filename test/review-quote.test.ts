/**
 * What a line comment becomes in the input.
 *
 * The block is read by the model and rendered as a quote chip by the composer,
 * so its field order and its fence are both part of the contract: a hunk that
 * itself contains a Markdown fence must not be able to close the quote early.
 */
import { describe, expect, it } from "vitest"
import { commentRange, formatCommentQuote, hunkAt, hunkText, targetForRow } from "../src/client/components/changes/review-quote"
import type { ChangeHunk } from "../src/client/lib/types"

const hunk: ChangeHunk = {
  header: "@@ -2,2 +2,3 @@",
  oldStart: 2,
  oldLines: 2,
  newStart: 2,
  newLines: 3,
  lines: [" unchanged", "-old", "+new", "+another"],
}

const source = { repoPath: "E:/tasks/sample/app", branch: "task/sample", base: "main" }
const target = { path: "src/app.ts", side: "R" as const, line: 4 }

describe("comment quote", () => {
  it("names the repository, the side and the line, then the hunk and the comment", () => {
    const quote = formatCommentQuote(target, hunkText(hunk), source, "为什么加这两行？", 2)
    expect(quote).toContain("## User Comment 2")
    expect(quote).toContain("File: src/app.ts")
    expect(quote).toContain("Repository: E:/tasks/sample/app")
    expect(quote).toContain("Side: R")
    expect(quote).toContain("Lines: 4")
    expect(quote).toContain("Source: Local (branch)")
    expect(quote).toContain("Base: main")
    expect(quote).toContain("Comment:\n为什么加这两行？")
    expect(quote).toContain("```diff")
  })

  it("keeps a fence longer than any run inside the hunk", () => {
    const fenced = { ...hunk, lines: [" unchanged", "+```js", "+two", "+```"] }
    const quote = formatCommentQuote(target, hunkText(fenced), source, "code inside", 1)
    expect(quote).toContain("````diff")
    expect(quote).toContain("\n````\n")
    expect(quote).not.toContain("\n```\n")
  })

  it("finds the hunk a line belongs to, on the side it was clicked", () => {
    expect(hunkAt([hunk], { path: "a", side: "R", line: 4 })).toBe(hunk)
    expect(hunkAt([hunk], { path: "a", side: "L", line: 3 })).toBe(hunk)
    expect(hunkAt([hunk], { path: "a", side: "L", line: 0 })).toBeUndefined()
  })

  it("names the range of a commented line", () => {
    expect(commentRange(target)).toBe("R4")
  })

  it("comments an unchanged row on the side its number matches, a removal on the old side, an addition on the new side", () => {
    // Both sides carry the same number: the old side is the one named.
    expect(targetForRow({ kind: "context", oldLine: 7, newLine: 7 }, "a.ts")).toEqual({ path: "a.ts", side: "L", line: 7 })
    // An insertion before it moved the numbers apart: the row belongs to the new side.
    expect(targetForRow({ kind: "context", oldLine: 16, newLine: 19 }, "a.ts")).toEqual({ path: "a.ts", side: "R", line: 19 })
    expect(targetForRow({ kind: "del", oldLine: 3 }, "a.ts")).toEqual({ path: "a.ts", side: "L", line: 3 })
    expect(targetForRow({ kind: "add", newLine: 19 }, "a.ts")).toEqual({ path: "a.ts", side: "R", line: 19 })
    expect(targetForRow({ kind: "gap" }, "a.ts")).toBeUndefined()
  })
})
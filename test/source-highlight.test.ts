/**
 * The changes view's token mapping.
 *
 * The highlighter itself belongs to the shell; what this file owns is putting
 * its per-line answers back onto the right line numbers of a hunk, where a line
 * may belong to the old side, the new side, or both. A wrong mapping paints a
 * neighbouring line's colours, which is worse than no colours, so it is checked
 * here without the shell's shiki instance.
 */
import { describe, expect, it } from "vitest"
import { spansForHunks, type CodeHighlighter, type HighlightSpan } from "../src/client/components/changes/source-highlight"
import type { ChangeHunk } from "../src/client/lib/types"

/** One hunk whose sides are both numbered from 1. */
function hunk(lines: string[]): ChangeHunk {
  return { header: "@@ -1,3 +1,3 @@", oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines }
}

/** One token per line, carrying the line's own text, so a misplaced line is visible. */
const textSpans: CodeHighlighter = (code) => code.split("\n").map((text): HighlightSpan[] => [{ text }])

describe("spansForHunks", () => {
  it("puts each side's tokens on its own line numbers", () => {
    const spans = spansForHunks([hunk([" one", "-two", "+TWO", " three"])], textSpans)
    expect(spans.old.get(1)?.[0]?.text).toBe("one")
    expect(spans.old.get(2)?.[0]?.text).toBe("two")
    expect(spans.old.get(3)?.[0]?.text).toBe("three")
    expect(spans.next.get(1)?.[0]?.text).toBe("one")
    expect(spans.next.get(2)?.[0]?.text).toBe("TWO")
    expect(spans.next.get(3)?.[0]?.text).toBe("three")
  })

  it("highlights each side as one fragment, so a multi-line token keeps its state", () => {
    const seen: string[] = []
    spansForHunks([hunk([" one", "-two", "+TWO"])], (code) => { seen.push(code); return undefined })
    expect(seen).toEqual(["one\ntwo", "one\nTWO"])
  })

  it("leaves both maps empty when the shell answers plain text", () => {
    const spans = spansForHunks([hunk([" one", "+TWO"])], () => undefined)
    expect(spans.old.size).toBe(0)
    expect(spans.next.size).toBe(0)
  })
})
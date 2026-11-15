// @vitest-environment jsdom
/**
 * The review comment buffer.
 *
 * The input cannot address a quote it once inserted, so the plugin writes the
 * whole comment block on every change. These cases pin the buffer the block is
 * built from: insertion order, edits, removal, and the exact previous block the
 * next flush must take out of the draft.
 */
import { beforeEach, describe, expect, it } from "vitest"
import {
  addReviewComment, commentsBlock, commentsFor, lastFlushedBlock, removeReviewComment,
  rememberFlushedBlock, updateReviewComment,
} from "../src/client/components/changes/review-buffer"
import type { ReviewComment } from "../src/client/components/changes/review-buffer"

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: "c1",
    address: "dsh-resource://wts-changes-view/repo?base=main",
    repoPath: "E:/tasks/sample/app",
    base: "main",
    path: "src/app.ts",
    side: "R",
    line: 19,
    hunk: "@@ -16,3 +19,4 @@\n line\n+added\n line",
    body: "为什么加这一行？",
    createdAt: 1,
    ...overrides,
  }
}

beforeEach(() => {
  // The buffer keeps an in-memory copy for snapshot stability; clearing storage
  // alone would leave the previous case's comments in it.
  for (const entry of commentsFor("s1")) removeReviewComment("s1", entry.id)
  localStorage.clear()
  rememberFlushedBlock("s1", "")
})

describe("review comment buffer", () => {
  it("keeps comments in insertion order and edits them in place", () => {
    addReviewComment("s1", comment())
    addReviewComment("s1", comment({ id: "c2", line: 20 }))
    expect(commentsFor("s1").map((entry) => entry.id)).toEqual(["c1", "c2"])

    updateReviewComment("s1", "c1", "改过的评论")
    expect(commentsFor("s1")[0].body).toBe("改过的评论")
    expect(commentsFor("s2")).toHaveLength(0)
  })

  it("removes one comment and persists the rest", () => {
    addReviewComment("s1", comment())
    addReviewComment("s1", comment({ id: "c2", line: 20 }))
    removeReviewComment("s1", "c1")
    expect(commentsFor("s1").map((entry) => entry.id)).toEqual(["c2"])
  })

  it("builds one block from the whole session, numbered in order", () => {
    addReviewComment("s1", comment())
    addReviewComment("s1", comment({ id: "c2", line: 20, body: "第二处" }))
    const block = commentsBlock("s1", (entry, index) => `${index}:${entry.body}`)
    expect(block).toBe("1:为什么加这一行？\n\n2:第二处")
  })

  it("remembers the block it wrote, per session", () => {
    rememberFlushedBlock("s1", "## User Comment 1")
    expect(lastFlushedBlock("s1")).toBe("## User Comment 1")
    expect(lastFlushedBlock("s2")).toBe("")
  })
})
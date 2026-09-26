import { describe, expect, it } from "vitest"
import { documentsDirectoryFor, folderStamp, safeFolderName } from "../src/client/lib/documents"

/** 2026-09-26 02:09:33, the moment from the request that shaped the name. */
const moment = new Date(2026, 8, 26, 2, 9, 33)

describe("archived documents naming", () => {
  it("writes the moment as one date run and one time run", () => {
    expect(folderStamp(moment)).toBe("20260926-020933")
    // Single digits are padded, so names sort in time order.
    expect(folderStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102-030405")
  })

  it("replaces the characters a folder name may not hold", () => {
    expect(safeFolderName("kratos-admin/testb")).toBe("kratos-admin-testb")
    expect(safeFolderName("a:b*c?d")).toBe("a-b-c-d")
    expect(safeFolderName("  trailing. ")).toBe("trailing")
  })

  it("names the folder after the Workspace, which already carries the task", () => {
    expect(documentsDirectoryFor("E:\\worktree-space\\testb", "kratos-admin/testb", moment))
      .toBe("E:\\worktree-space\\archived-docs\\kratos-admin-testb-20260926-020933")
    // With no registered Workspace, the task's own folder name has to do.
    expect(documentsDirectoryFor("/tasks/testb", undefined, moment))
      .toBe("/tasks/archived-docs/testb-20260926-020933")
  })
})

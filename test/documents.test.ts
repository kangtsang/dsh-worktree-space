import { describe, expect, it } from "vitest"
import { DEFAULT_ARCHIVE_PREFERENCE, documentsDirectoryFor, folderStamp, safeFolderName } from "../src/client/lib/documents"

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
    // No registered Workspace: the task's own container name has to do.
    expect(documentsDirectoryFor("E:\\worktree-space\\testb", undefined, moment))
      .toBe("E:\\worktree-space\\archived-docs\\testb-20260926-020933")
    expect(documentsDirectoryFor("/tasks/testb", "kratos-admin/testb", moment))
      .toBe("/tasks/archived-docs/kratos-admin-testb-20260926-020933")
  })
})

describe("the root an archive is filed under", () => {
  /** A container one level below the volume root, where the three roots differ. */
  const nested = "E:\\work\\worktree-space\\demo"

  it("anchors on the container's volume by default", () => {
    expect(DEFAULT_ARCHIVE_PREFERENCE).toEqual({ strategy: "drive", directory: "" })
    expect(documentsDirectoryFor(nested, "kratos-admin/demo", moment))
      .toBe("E:\\worktree-space\\archived-docs\\kratos-admin-demo-20260926-020933")
    // Where the container sits below the volume makes no difference: that is the point
    // of the anchor, and it is what keeps the archive from following the container.
    expect(documentsDirectoryFor("E:\\repo\\wt-space\\demo", "kratos-admin/demo", moment, { strategy: "drive", directory: "" }))
      .toBe("E:\\worktree-space\\archived-docs\\kratos-admin-demo-20260926-020933")
  })

  it("keeps the documents beside the task space when asked to", () => {
    expect(documentsDirectoryFor(nested, "kratos-admin/demo", moment, { strategy: "container", directory: "" }))
      .toBe("E:\\work\\worktree-space\\archived-docs\\kratos-admin-demo-20260926-020933")
  })

  it("files into the named directory under the custom strategy, and nowhere else", () => {
    expect(documentsDirectoryFor("/tasks/testb", "kratos-admin/testb", moment, { strategy: "custom", directory: "E:\\archived-docs" }))
      .toBe("E:\\archived-docs\\kratos-admin-testb-20260926-020933")
    // A directory left in the setting from an earlier choice is read only by the custom
    // strategy: the other two name a root of their own, and the settings row that names
    // them would be lying if a directory still steered the archive.
    for (const strategy of ["drive", "container"] as const) {
      expect(documentsDirectoryFor(nested, "kratos-admin/demo", moment, { strategy, directory: "E:\\archived-docs" }))
        .toBe(documentsDirectoryFor(nested, "kratos-admin/demo", moment, { strategy, directory: "" }))
    }
  })

  it("falls back to the anchor when the custom directory is not filled in", () => {
    for (const directory of ["", "   "]) {
      expect(documentsDirectoryFor(nested, "kratos-admin/demo", moment, { strategy: "custom", directory }))
        .toBe("E:\\worktree-space\\archived-docs\\kratos-admin-demo-20260926-020933")
    }
  })

  it("falls back to the container where the path names no volume to anchor on", () => {
    // A POSIX path and a UNC share have no drive root to build, and the volume a share
    // resolves to is not a directory this plugin should be writing into.
    for (const path of ["/tasks/testb", "\\\\server\\share\\testb"]) {
      expect(documentsDirectoryFor(path, "kratos-admin/testb", moment, { strategy: "drive", directory: "" }))
        .toBe(documentsDirectoryFor(path, "kratos-admin/testb", moment, { strategy: "container", directory: "" }))
    }
  })

  it("keeps the per-task folder under every root, so two tasks never mix", () => {
    // The folder is what tells one task's documents from another's, which matters most
    // where every task on a volume shares one directory.
    for (const strategy of ["drive", "container", "custom"] as const) {
      const preference = { strategy, directory: strategy === "custom" ? "E:\\archived-docs" : "" }
      expect(documentsDirectoryFor(nested, "a/one", moment, preference)).not.toBe(documentsDirectoryFor(nested, "b/two", moment, preference))
      expect(documentsDirectoryFor(nested, "a/one", moment, preference)).toMatch(/one-\d{8}-\d{6}$/)
    }
  })
})

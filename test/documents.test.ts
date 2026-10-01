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
    expect(safeFolderName("a:b*c?d")).toBe("a-b-c-d")
    expect(safeFolderName("  trailing. ")).toBe("trailing")
  })

  it("names the per-task folder after the project and the task, both read off the path", () => {
    expect(documentsDirectoryFor("E:\\work\\worktree-space\\kratos-admin\\demo", moment))
      .toBe("E:\\work\\worktree-space\\archived-docs\\kratos-admin\\demo-20260926-020933")
    expect(documentsDirectoryFor("/tasks/kratos-admin/testb", moment))
      .toBe("/tasks/archived-docs/kratos-admin/testb-20260926-020933")
  })

  it("keeps a project directory's space, which a task name may not have", () => {
    expect(documentsDirectoryFor("E:\\work\\worktree-space\\my project\\demo", moment))
      .toBe("E:\\work\\worktree-space\\archived-docs\\my project\\demo-20260926-020933")
  })
})

describe("the root an archive is filed under", () => {
  /** A task space in a container below the volume root, where the roots could differ. */
  const nested = "E:\\work\\worktree-space\\kratos-admin\\demo"

  it("stays in the container root by default", () => {
    expect(DEFAULT_ARCHIVE_PREFERENCE).toEqual({ strategy: "container", directory: "" })
    expect(documentsDirectoryFor(nested, moment))
      .toBe("E:\\work\\worktree-space\\archived-docs\\kratos-admin\\demo-20260926-020933")
    // The default adds no directory of its own: the documents land under the one
    // root the plugin already names, wherever that root was put.
    expect(documentsDirectoryFor("E:\\repo\\worktree-space\\kratos-admin\\demo", moment))
      .toBe("E:\\repo\\worktree-space\\archived-docs\\kratos-admin\\demo-20260926-020933")
  })

  it("serves every project in one container from the same root", () => {
    // One archived-docs, not one per project: the project folder below is what
    // keeps two projects' archives apart, and it mirrors the layer the task space
    // itself is filed under.
    expect(documentsDirectoryFor("E:\\work\\worktree-space\\kratos-api\\demo", moment, { strategy: "container", directory: "" }))
      .toBe("E:\\work\\worktree-space\\archived-docs\\kratos-api\\demo-20260926-020933")
  })

  it("files into the named directory under the custom strategy, and nowhere else", () => {
    expect(documentsDirectoryFor(nested, moment, { strategy: "custom", directory: "E:\\archived-docs" }))
      .toBe("E:\\archived-docs\\kratos-admin\\demo-20260926-020933")
    // A directory left in the setting from an earlier choice is read only by the
    // custom strategy: the other names a root of its own, and the settings row that
    // names it would be lying if a directory still steered the archive.
    expect(documentsDirectoryFor(nested, moment, { strategy: "container", directory: "E:\\archived-docs" }))
      .toBe(documentsDirectoryFor(nested, moment, { strategy: "container", directory: "" }))
  })

  it("falls back to the container root when the custom directory is not filled in", () => {
    for (const directory of ["", "   "]) {
      expect(documentsDirectoryFor(nested, moment, { strategy: "custom", directory }))
        .toBe(documentsDirectoryFor(nested, moment, { strategy: "container", directory: "" }))
    }
  })

  it("keeps the per-task folder under every root, so two tasks never mix", () => {
    // The folder is what tells one task's documents from another's, which matters
    // most where every task in a container shares one directory.
    for (const strategy of ["container", "custom"] as const) {
      const preference = { strategy, directory: strategy === "custom" ? "E:\\archived-docs" : "" }
      const container = (project: string, task: string) => `E:\\work\\worktree-space\\${project}\\${task}`
      expect(documentsDirectoryFor(container("kratos-admin", "one"), moment, preference))
        .not.toBe(documentsDirectoryFor(container("kratos-admin", "two"), moment, preference))
      expect(documentsDirectoryFor(container("kratos-admin", "one"), moment, preference))
        .not.toBe(documentsDirectoryFor(container("kratos-api", "one"), moment, preference))
      expect(documentsDirectoryFor(container("kratos-admin", "one"), moment, preference))
        .toMatch(/one-\d{8}-\d{6}$/)
    }
  })
})

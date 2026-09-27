import { describe, expect, it } from "vitest"
import {
  branchNameFor,
  DEFAULT_BRANCH_PREFIX,
  TaskNameError,
  validateBranchPrefix,
  validateTaskName,
} from "../src/host/task/naming.js"

describe("validateTaskName", () => {
  it("accepts a plain kebab-case name", () => {
    expect(validateTaskName("fix-login")).toBe("fix-login")
  })

  it("accepts dots and underscores", () => {
    expect(validateTaskName("fix_login.v2")).toBe("fix_login.v2")
  })

  it("rejects an empty or missing name", () => {
    expect(() => validateTaskName("")).toThrow(TaskNameError)
    expect(() => validateTaskName(undefined)).toThrow(TaskNameError)
  })

  it("rejects a forward slash", () => {
    expect(() => validateTaskName("feat/login")).toThrow(TaskNameError)
  })

  it("rejects a backslash", () => {
    expect(() => validateTaskName("feat\\login")).toThrow(TaskNameError)
  })

  it("rejects whitespace", () => {
    expect(() => validateTaskName("fix login")).toThrow(TaskNameError)
    expect(() => validateTaskName("fix\tlogin")).toThrow(TaskNameError)
  })

  it("names the offending value so the caller can report it", () => {
    expect(() => validateTaskName("bad name")).toThrow(/bad name/)
  })
})

describe("branchNameFor", () => {
  it("shares one prefixed branch across every repository by default", () => {
    expect(DEFAULT_BRANCH_PREFIX).toBe("task/")
    expect(branchNameFor("fix-login")).toBe("task/fix-login")
  })

  it("honours a configured prefix", () => {
    expect(branchNameFor("fix-login", "feat/")).toBe("feat/fix-login")
  })
})

describe("validateBranchPrefix", () => {
  it("falls back to the default when nothing is requested", () => {
    expect(validateBranchPrefix(undefined)).toBe(DEFAULT_BRANCH_PREFIX)
    expect(validateBranchPrefix("")).toBe(DEFAULT_BRANCH_PREFIX)
    expect(validateBranchPrefix("   ")).toBe(DEFAULT_BRANCH_PREFIX)
  })

  it("keeps a chosen prefix verbatim, separator and all", () => {
    expect(validateBranchPrefix("feat/")).toBe("feat/")
    expect(validateBranchPrefix("  release-  ")).toBe("release-")
    expect(validateBranchPrefix("team/task/")).toBe("team/task/")
  })

  it.each([
    ["fix login"],
    ["task /"],
    ["task~1/"],
    ["task^/"],
    ["task:/"],
    ["task?/"],
    ["task*/"],
    ["task[/"],
    ["task\\"],
    ["task//login"],
    ["task../"],
    ["task@{1}/"],
    ["/task"],
    ["-task"],
  ])("refuses %j, which Git would not accept in a ref", (prefix) => {
    expect(() => validateBranchPrefix(prefix)).toThrow(TaskNameError)
  })
})

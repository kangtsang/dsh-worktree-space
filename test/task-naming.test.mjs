import { describe, expect, it } from "vitest"
import {
  branchNameFor,
  DEFAULT_BRANCH_PREFIX,
  TaskNameError,
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
    expect(DEFAULT_BRANCH_PREFIX).toBe("feat/")
    expect(branchNameFor("fix-login")).toBe("feat/fix-login")
  })

  it("honours a configured prefix", () => {
    expect(branchNameFor("fix-login", "task/")).toBe("task/fix-login")
  })
})

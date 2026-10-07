import { describe, expect, it } from "vitest"
import { basename, join } from "node:path"
import {
  branchNameFor,
  DEFAULT_BRANCH_PREFIX,
  deploymentEnvIdFor,
  projectNameFor,
  TaskNameError,
  validateBranchPrefix,
  validateProjectName,
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

describe("validateProjectName", () => {
  it("keeps the name verbatim", () => {
    expect(validateProjectName("kratos-admin")).toBe("kratos-admin")
    expect(validateProjectName("fix_login.v2")).toBe("fix_login.v2")
  })

  it("allows whitespace, which a real directory may carry", () => {
    // The name comes from a directory that already exists, so refusing a space
    // would refuse the user's own workspace rather than protect anything.
    expect(validateProjectName("my project")).toBe("my project")
  })

  it("rejects an empty or relative name", () => {
    expect(() => validateProjectName("")).toThrow(TaskNameError)
    expect(() => validateProjectName(undefined)).toThrow(TaskNameError)
    expect(() => validateProjectName(".")).toThrow(TaskNameError)
    expect(() => validateProjectName("..")).toThrow(TaskNameError)
  })

  it("rejects either separator, which would add a level", () => {
    expect(() => validateProjectName("feat/login")).toThrow(TaskNameError)
    expect(() => validateProjectName("feat\\login")).toThrow(TaskNameError)
  })
})

describe("projectNameFor", () => {
  it("is the source root's own directory name", () => {
    expect(projectNameFor(join("E:\\", "workspace", "kratos-admin"))).toBe("kratos-admin")
    expect(projectNameFor("/home/me/workspace/kratos-admin/")).toBe("kratos-admin")
  })

  it("answers the repository's name for a source root that is one", () => {
    // `E:\workspace\repo-x` is both the project and the repository inside it, so
    // the name repeats one level down - `repo-x/<task>/repo-x`.
    const sourceRoot = join("E:\\", "workspace", "repo-x")
    expect(projectNameFor(sourceRoot)).toBe("repo-x")
  })

  it("is never empty for a path that names a directory", () => {
    const sourceRoot = join("E:\\", "workspace", "kratos-admin")
    expect(projectNameFor(sourceRoot)).toBe(basename(sourceRoot))
  })

  it("refuses a path whose own name cannot be a segment", () => {
    // A volume root has no last segment to name the layer after.
    expect(() => projectNameFor("/")).toThrow(TaskNameError)
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

describe("deploymentEnvIdFor", () => {
  it("derives one id from the two names the task already has", () => {
    expect(deploymentEnvIdFor("kratos-admin", "fix-login")).toBe("dsh-kratos-admin-fix-login")
  })

  it("keeps dashes and digits that are already legal", () => {
    // The real shape: a project whose own name carries a dash, nesting a task of it.
    expect(deploymentEnvIdFor("dsh-worktree-space", "docker")).toBe("dsh-dsh-worktree-space-docker")
  })

  it("folds what compose would refuse into a dash", () => {
    // A project name may carry spaces and capitals - the directory the user
    // already has - while a compose project name may not.
    expect(deploymentEnvIdFor("My Project", "fix-login")).toBe("dsh-my-project-fix-login")
  })

  it("falls back per layer when a name folds away entirely", () => {
    // A name made only of characters outside the alphabet would otherwise fold
    // to nothing and leave a dangling dash behind.
    expect(deploymentEnvIdFor("我的项目", "登录")).toBe("dsh-project-task")
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

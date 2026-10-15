import { describe, expect, it } from "vitest"
import { basename, join } from "node:path"
import {
  branchNameFor,
  DEFAULT_BRANCH_PREFIX,
  deploymentEnvIdFor,
  projectNameFor,
  TASK_OWNED_ENTRY_NAMES,
  TaskNameError,
  validateBranchPrefix,
  validateProjectName,
  validateRepositoryDirectoryName,
  validateTaskName,
} from "../src/host/task/naming.js"
import { BREADCRUMB, PLUGIN_ROOT, TASK_OWNED_ENTRIES, TASK_README } from "../src/host/task/shared.js"

describe("validateRepositoryDirectoryName", () => {
  // A repository contributes its directory name as one entry in the task space, so
  // the name is checked as a directory name before any worktree is cut. Each refusal
  // below is a way a checkout could land on something that is not a worktree.
  it("accepts an ordinary repository directory name", () => {
    expect(validateRepositoryDirectoryName("alpha")).toBe("alpha")
    expect(validateRepositoryDirectoryName("my-repo.js")).toBe("my-repo.js")
  })

  it("refuses the plugin's own entry names, which a checkout must not occupy", () => {
    expect(() => validateRepositoryDirectoryName(PLUGIN_ROOT)).toThrow(/belongs to this plugin/)
    expect(() => validateRepositoryDirectoryName(BREADCRUMB)).toThrow(/belongs to this plugin/)
    // Written inside the plugin's directory now, but a task space made before the
    // JSON existed carries it at the top level, and it is this plugin's note rather
    // than the user's file to have overwritten.
    expect(() => validateRepositoryDirectoryName(TASK_README)).toThrow(/belongs to this plugin/)
  })

  it("refuses the two relative names `basename` can return", () => {
    // The shape that reaches here is a raw path whose last segment is the relative
    // name - `basename('/tmp/ws/proj/task/..')` is `..` - because `create` takes the
    // repository path as the caller sent it and asks `basename` before anything has
    // normalised it. `join` would collapse it first, which is why the assertion below
    // uses a raw string rather than `join`: the point is what an unnormalised caller
    // path yields, not what a joined one does.
    expect(basename("/tmp/ws/proj/task/..")).toBe("..")
    expect(basename("/tmp/ws/proj/task/.")).toBe(".")
    expect(() => validateRepositoryDirectoryName("..")).toThrow(/must not be '\.' or '\.\.'/)
    expect(() => validateRepositoryDirectoryName(".")).toThrow(/must not be '\.' or '\.\.'/)
  })

  it("refuses a name that is a path rather than a single segment", () => {
    expect(() => validateRepositoryDirectoryName("a/b")).toThrow(/must not contain/)
    expect(() => validateRepositoryDirectoryName("a\\b")).toThrow(/must not contain/)
  })

  it("is exact about case, because the plugin writes these names in one spelling", () => {
    // `.Worktree-Space` is a different directory from `.worktree-space` on a
    // case-sensitive volume, so it is a name of its own rather than a collision.
    // Refusing it would take a legitimate repository name away on Linux for a
    // problem that does not exist there.
    expect(validateRepositoryDirectoryName(".Worktree-Space")).toBe(".Worktree-Space")
  })
})

// The two lists answer different questions and are not copies of each other, so
// what is pinned here is the *relationship*, not equality. Asserting they are equal
// would be wrong twice over: it would fail on `worktree-space.md` (correctly absent
// from the removable set), and it would invite the next reader to "fix" one list to
// match the other.
describe("the names a checkout may not take, against the names a finish may remove", () => {
  it("covers every name a finish removes without asking", () => {
    // Anything a finish would delete on its own is certainly not a place a checkout
    // may stand, so this direction has to hold in full.
    for (const name of TASK_OWNED_ENTRIES) {
      expect(TASK_OWNED_ENTRY_NAMES, `${name} is removable but not reserved`).toContain(name)
    }
  })

  it("reserves the note that a finish removes by name rather than by list", () => {
    // The one name that belongs to the second list and not the first, and the reason
    // the two cannot be one list: `archive.js` removes `BREADCRUMB` explicitly, so
    // `TASK_OWNED_ENTRIES` has no reason to name it - while a repository directory
    // called `worktree-space.md` would still collide with the note on a task space
    // made before the JSON existed.
    expect(TASK_OWNED_ENTRY_NAMES).toContain(TASK_README)
    expect(TASK_OWNED_ENTRIES).not.toContain(TASK_README)
    // And the note really is this plugin's, written inside the plugin's directory.
    expect(TASK_README).not.toBe(BREADCRUMB)
  })
})

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

  it("still accepts the names a real task is actually given", () => {
    // The control for the tightening below: a rule that refused any of these would
    // refuse the names this plugin's own tests and users create tasks under.
    for (const name of ["login", "fix-login", "v1.2.3", "fix_login.v2", "alpha"]) {
      expect(validateTaskName(name)).toBe(name)
    }
  })

  it.each([
    ["login.", "a trailing dot, which Win32 folds away"],
    ["login ", "a trailing space, which Win32 folds away"],
    ["CON", "a Windows device name"],
    ["con", "a Windows device name, in another case"],
    ["CON.txt", "a Windows device name with an extension Win32 strips"],
    ["NUL", "a Windows device name"],
    ["COM1", "a Windows serial port name"],
    ["LPT9", "a Windows printer port name"],
    ["a:b", "a colon, which git refuses in a ref"],
    ["a~b", "a tilde, which git refuses in a ref"],
    ["a^b", "a caret, which git refuses in a ref"],
    ["a?b", "a question mark, which git refuses in a ref"],
    ["a*b", "an asterisk, which git refuses in a ref"],
    ["a[b", "a bracket, which git refuses in a ref"],
    ["a.lock", "a suffix git keeps for itself"],
    ["a@{b}", "the start of a reflog expression"],
    ["a..b", "a double dot, which git refuses in a ref"],
  ])("refuses %j, %s", (name) => {
    expect(() => validateTaskName(name)).toThrow(TaskNameError)
  })

  it("refuses a control character, which would reach git as an unprintable ref", () => {
    expect(() => validateTaskName("a\u0001b")).toThrow(TaskNameError)
    expect(() => validateTaskName("a\u007fb")).toThrow(TaskNameError)
  })

  it("keeps the read-back half looser than the create half, on purpose", async () => {
    // The two directions are deliberately not one rule, and this is the assertion that
    // pins the difference so a later "cleanup" cannot quietly unify them.
    //
    // `validateTaskName` refuses a request, so it may refuse anything. `isUsableTaskName`
    // judges a name already written in a record, which an older version of this plugin
    // may have written under a looser rule. Refusing such a name would not refuse a
    // create - it would take a real task's name away from the session reporting on it.
    // What both have always refused is a separator or a space.
    const { isUsableTaskName } = await import("../src/host/task/naming.js")
    for (const name of ["login.", "CON", "a:b", "a.lock", "a@{b}", "a..b", "a\u0001b"]) {
      expect(() => validateTaskName(name)).toThrow(TaskNameError)
      expect(isUsableTaskName(name), `${name} is no longer reported at all`).toBe(true)
    }
    // The control: a name neither direction has ever allowed stays refused by both, so
    // the assertion above is not just "everything is usable".
    for (const name of ["", "feat/login", "fix login", ".."]) {
      expect(() => validateTaskName(name)).toThrow(TaskNameError)
      expect(isUsableTaskName(name), `${name} is reported as a task name`).toBe(false)
    }
    for (const name of ["login", "fix-login", "v1.2.3"]) {
      expect(isUsableTaskName(name)).toBe(true)
    }
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

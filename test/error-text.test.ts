// @vitest-environment node
import { describe, expect, it } from "vitest"
import { errorText, failure } from "../src/client/lib/error-text"
import { format, t } from "../src/client/lib/i18n"

/**
 * What a failure is said with, and who says it.
 *
 * The Host writes its own sentences and this plugin keeps them: the Host's copy is
 * what its log holds, and it is not this plugin's to translate. What this plugin
 * raises itself is said here instead, because the layers that raise it run below
 * every page and have no dictionary to word anything in.
 */
describe("the sentence a failure is shown with", () => {
  it("says this plugin's own failures through the dictionary in force", () => {
    // The copy is named here rather than in the caller, so a new failure cannot be
    // added without a sentence to show for it: these keys resolve, because the
    // interface language is the only place that knows what any of them says.
    expect(errorText(t, failure("worktree-timeout"))).toBe(t("worktreeRequestTimedOut"))
    expect(errorText(t, failure("worktree-cancelled"))).toBe(t("worktreeRequestCancelled"))
    expect(errorText(t, failure("worktree-failed"))).toBe(t("worktreeOperationFailed"))
    expect(errorText(t, failure("repository-path-required"))).toBe(t("repositoryPathRequired"))
    expect(errorText(t, failure("not-a-git-repository", { path: "/notes" })))
      .toBe(format(t("repositoryNotGitRepository"), { path: "/notes" }))
    // A refusal that names a directory says which one, or the sentence is a rule
    // rather than an answer.
    expect(errorText(t, failure("not-a-git-repository", { path: "/notes" }))).toContain("/notes")
  })

  it("leaves the Host's own sentences exactly as it sent them", () => {
    // Reworded here they would stop matching what the Host logged, and a failure the
    // user can match against the log is worth more than one in their own language.
    expect(errorText(t, new Error("the task space already holds a repository named 'beta'"))).toBe("the task space already holds a repository named 'beta'")
    // A Host code stays on the error and is not read as a sentence of its own.
    expect(errorText(t, Object.assign(new Error("fatal: not a git repository"), { code: "E3004" }))).toBe("fatal: not a git repository")
    // And something thrown that is not an Error at all is still shown as itself.
    expect(errorText(t, "EPERM")).toBe("EPERM")
  })
})

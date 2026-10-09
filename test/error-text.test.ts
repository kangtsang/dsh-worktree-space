// @vitest-environment node
import { describe, expect, it } from "vitest"
import { errorText, failure } from "../src/client/lib/error-text"
import { format, t } from "../src/client/lib/i18n"

/**
 * What a failure is said with, and who says it.
 *
 * The Host writes each failure once, in English, because that copy is what its log
 * holds and what anything showing it verbatim prints. This plugin says the same failure
 * itself wherever it has a sentence for the code, from the values the Host sends beside
 * it; everything else is left exactly as the Host wrote it.
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

  it("says a Host failure itself, from the values sent beside the code", () => {
    // The one path where the Host's sentence is not what the reader sees: a code this
    // plugin has words for, said from the values - never read out of the prose, which is
    // the whole reason the values travel.
    const held = Object.assign(new Error("one worktree is held by something outside this process"), {
      code: "E5011",
      details: { held: [{ path: "/w/a", reason: "EBUSY: resource busy or locked" }] },
    })
    expect(errorText(t, held)).toBe(format(t("hostE5011"), { count: "1", held: "  /w/a\n    EBUSY: resource busy or locked" }))
    expect(errorText(t, held)).toContain("/w/a")

    // The code is what it goes by, not the wording: the same failure sent in another
    // language would still be said here.
    const translated = Object.assign(new Error("ein Worktree wird festgehalten"), {
      code: "E5011",
      details: { held: [{ path: "/w/a", reason: "EBUSY" }] },
    })
    expect(errorText(t, translated)).toContain("/w/a")
    expect(errorText(t, translated)).not.toContain("festgehalten")
  })
})

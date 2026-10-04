import { format } from "./i18n"

/**
 * What a failure this plugin raises is named by, rather than what it says.
 *
 * The transport layer and the repository list both run below every page, where there
 * is no `t` to hand. Anything either of them assembles as a sentence is therefore
 * English, and it reaches a Chinese interface verbatim — so they do not assemble one.
 * A failure is a code, plus the few values the sentence needs, and the sentence is
 * built where the interface language is known.
 */
export type FailureCode =
  | "worktree-timeout"
  | "worktree-cancelled"
  | "worktree-failed"
  | "repository-path-required"
  | "not-a-git-repository"

/**
 * A failure this plugin raised, carrying what the interface needs to say it.
 *
 * The message is the code rather than a sentence on purpose: anything that shows a
 * failure without going through {@link errorText} then prints an identifier, which is
 * visibly wrong, where a sentence of the wrong language is not.
 * @param code - what went wrong, named so a caller can match on it.
 * @param values - the parts of the sentence that are not fixed, such as a path.
 * @returns the error to throw.
 */
export function failure(code: FailureCode, values: Record<string, string> = {}): Error {
  return Object.assign(new Error(code), { code, values })
}

/**
 * The sentence a failure is shown with, in the interface language.
 *
 * Most failures arrive from the Host carrying a sentence it wrote for a person, and
 * that sentence is what is shown: reworded here it would stop matching what the Host
 * logged, and the Host's copy is not this plugin's to translate. So those fall
 * through untouched, and only the codes above — the ones this plugin raised — are
 * said here.
 * @param t - the translation function in force.
 * @param reason - whatever the call rejected with.
 * @returns the sentence to put on screen.
 */
export function errorText(t: (key: string) => string, reason: unknown): string {
  const coded = reason as { code?: unknown; values?: Record<string, string> } | null | undefined
  switch (String(coded?.code ?? "")) {
    case "worktree-timeout":
      return t("worktreeRequestTimedOut")
    case "worktree-cancelled":
      return t("worktreeRequestCancelled")
    case "worktree-failed":
      return t("worktreeOperationFailed")
    case "repository-path-required":
      return t("repositoryPathRequired")
    case "not-a-git-repository":
      return format(t("repositoryNotGitRepository"), { path: coded?.values?.path ?? "" })
    default:
      // The Host's own sentence, or whatever a rejection carried that was not one of
      // ours — exactly what was shown before this function existed.
      return String((reason as { message?: unknown } | null)?.message ?? reason)
  }
}

// @vitest-environment node
import { describe, expect, it } from "vitest"
import { hostFailureText, hostWarningText, type HostValues, type HostWarning } from "../src/client/lib/host-messages"
import { format, installLocale, t } from "../src/client/lib/i18n"

/**
 * The sentences themselves, taken from the locale service the plugin registers them with,
 * so both languages can be checked rather than only the one `t` happens to resolve to.
 *
 * `bind` answers in Chinese, which is what `t` does with no locale service at all - so
 * installing this leaves every other assertion in this file reading exactly as it did.
 */
let dictionaries: Record<string, Record<string, string>> = {}
installLocale({
  get: () => ({
    register: (_ns: string, dicts: Record<string, Record<string, string>>) => { dictionaries = dicts; return () => {} },
    bind: () => (key: string) => dictionaries.zh?.[key] ?? key,
  }),
})

/** The translation function a given interface language would use. */
const inLanguage = (language: "zh" | "en") => (key: string) => dictionaries[language]?.[key] ?? key

/** A placeholder the renderer did not fill in: the one way a template fails visibly. */
const UNFILLED = /\{[a-zA-Z]\w*\}/

/**
 * The Host's failures and warnings, said in the reader's language.
 *
 * Every one of these arrives from the Host as an English sentence plus the values it was
 * built from. What is asserted here is that the sentence shown comes from the code and
 * those values - so it is in the interface language, and it still names the paths.
 */
describe("a Host failure said here", () => {
  it("picks the situation out of the values, not out of the wording", () => {
    // One code, three situations, and the reader is told to do something different in
    // each - which is why the situation travels as a value.
    const base = { path: "/w/login" }
    expect(hostFailureText(t, "E2004", { ...base, reason: "no-worktrees-to-extend" }))
      .toBe(format(t("hostE2004NoWorktreesToExtend"), { path: "/w/login" }))
    expect(hostFailureText(t, "E2004", { ...base, reason: "branches-disagree" }))
      .toBe(format(t("hostE2004BranchesDisagree"), { path: "/w/login" }))
    expect(hostFailureText(t, "E2004", { ...base }))
      .toBe(format(t("hostE2004NoWorktrees"), { path: "/w/login" }))
  })

  it("names what a delivery gate is waiting for in this language", () => {
    // The Host names each one by key: a phrase translated word by word is not a phrase.
    expect(hostFailureText(t, "E5007", { missing: ["smoke"] }))
      .toBe(format(t("hostE5007"), { missing: t("gateMissingSmoke") }))
    expect(hostFailureText(t, "E5007", { missing: ["smoke", "human-ack"] }))
      .toBe(format(t("hostE5007"), { missing: `${t("gateMissingSmoke")}${t("gateMissingJoin")}${t("gateMissingHumanAck")}` }))
  })

  it("lists the worktrees a finish could not remove, and says how many", () => {
    const held = [{ path: "/w/a", reason: "EBUSY" }, { path: "/w/b", reason: "EPERM" }]
    expect(hostFailureText(t, "E5011", { held }))
      .toBe(format(t("hostE5011Many"), { count: "2", held: "  /w/a\n    EBUSY\n  /w/b\n    EPERM" }))
  })

  it("has nothing to say for a code it does not know", () => {
    // Undefined is the whole contract: the caller falls back to the Host's own sentence,
    // so a failure is never lost for want of a translation.
    expect(hostFailureText(t, "E3004", {})).toBeUndefined()
    expect(hostFailureText(t, "", {})).toBeUndefined()
  })
})

describe("a Host warning said here", () => {
  it("names the entries that were in the way", () => {
    const warning: HostWarning = {
      code: "leftover-holds-links",
      message: "could not archive 'deploy' to '/archive': it holds 4 links (a, b, c, and 1 more) ...",
      values: { name: "deploy", destination: "/archive", links: ["a", "b", "c", "d"], shown: 3 },
    }
    expect(hostWarningText(t, warning))
      .toBe(format(t("warnLeftoverHoldsLinks"), { name: "deploy", destination: "/archive", count: "4", links: `a, b, c${format(t("warnLeftoverHoldsLinksMore"), { more: "1" })}` }))
    // How many are named is the Host's bound, not this side's.
    const all: HostWarning = { ...warning, values: { ...warning.values, shown: 10 } }
    expect(hostWarningText(t, all)).toContain("a, b, c, d")
  })

  it("says which way a gate was bypassed", () => {
    expect(hostWarningText(t, { code: "delivery-gate-bypassed", message: "…", values: { target: "docker" } }))
      .toBe(format(t("warnDeliveryGateBypassedWithoutDeployment"), { target: "docker" }))
    expect(hostWarningText(t, { code: "delivery-gate-bypassed", message: "…", values: { missing: ["human-ack"] } }))
      .toBe(format(t("warnDeliveryGateBypassedMissing"), { missing: t("gateMissingHumanAck") }))
  })

  it("falls back to the Host's sentence rather than losing the warning", () => {
    // A warning is not worth losing to a missing translation: an unknown code, and a
    // warning that carries no code at all, are both shown as the Host wrote them.
    const sentence = "could not remove 2 containers of environment demo: docker failed"
    expect(hostWarningText(t, { code: "something-new", message: sentence })).toBe(sentence)
    expect(hostWarningText(t, { message: sentence })).toBe(sentence)
    expect(hostWarningText(t, sentence)).toBe(sentence)
  })
})

describe("every sentence the Host's codes are said with", () => {
  /**
   * One row per code: the values the Host sends, and something the sentence has to name.
   *
   * The table in `host-messages.ts` is a switch, so a case can be added and never
   * exercised - and the placeholders live in the dictionaries, so a misspelled one
   * renders as `{destinaton}` on a failure path, which reads as a broken sentence rather
   * than as a missing test. Both are caught here, in both languages at once.
   */
  const failures: [string, HostValues, string][] = [
    ["E2003", { path: "/w/login" }, "/w/login"],
    ["E2004", { path: "/w/login", reason: "none" }, "/w/login"],
    ["E2004", { path: "/w/login", reason: "no-worktrees-to-extend" }, "/w/login"],
    ["E2004", { path: "/w/login", reason: "branches-disagree" }, "/w/login"],
    ["E2005", { path: "/w/login", missing: "/w/login/worktree-space.json" }, "worktree-space.json"],
    ["E4011", {}, ""],
    ["E4012", {}, ""],
    ["E4013", {}, ""],
    ["E5005", { target: "docker", envId: "demo" }, "docker"],
    // The environment is named only when there is one.
    ["E5005", { target: "docker", envId: "" }, "docker"],
    ["E5006", { missing: ["smoke"] }, ""],
    ["E5007", { missing: ["smoke", "human-ack"] }, ""],
    ["E5011", { held: [{ path: "/w/a", reason: "EBUSY" }] }, "/w/a"],
    ["E5011", { held: [{ path: "/w/a", reason: "EBUSY" }, { path: "/w/b", reason: "EPERM" }] }, "/w/b"],
  ]

  const warnings: [string, HostValues, string][] = [
    ["no-task-branch", { path: "/w/login" }, "/w/login"],
    ["delivery-gate-bypassed", { target: "docker" }, "docker"],
    ["delivery-gate-bypassed", { missing: ["human-ack"] }, ""],
    ["human-ack-waived", {}, ""],
    ["branch-left-alone", { name: "alpha", mainRepo: "/s/alpha", branch: "", taskBranch: "task/x" }, "alpha"],
    ["branch-left-alone", { name: "alpha", mainRepo: "/s/alpha", branch: "other", taskBranch: "task/x" }, "other"],
    ["branch-not-deleted", { branch: "task/x", name: "alpha" }, "task/x"],
    ["leftover-refused", { name: "notes.md", path: "/w/notes.md" }, "notes.md"],
    ["leftover-holds-links", { name: "deploy", destination: "/a/deploy", links: ["a", "b"], shown: 3 }, "deploy"],
    // More links than the sentence names: the count is what the reader gets.
    ["leftover-holds-links", { name: "deploy", destination: "/a/deploy", links: ["a", "b", "c", "d"], shown: 2 }, "2"],
    ["leftover-copy-failed", { name: "docs", destination: "/a/docs", reason: "EPERM" }, "EPERM"],
    ["no-deployment-recorded", {}, ""],
    ["deploy-destroy-failed", { output: "docker: not found" }, "docker: not found"],
    ["deploy-containers-left", { count: 2, envId: "demo", reason: "docker failed" }, "demo"],
    ["deploy-cleanup-failed", { envId: "demo", reason: "docker failed" }, "demo"],
  ]

  for (const language of ["zh", "en"] as const) {
    it(`says all of them in ${language}, with nothing left unfilled`, () => {
      const say = inLanguage(language)
      for (const [code, values, names] of failures) {
        const said = hostFailureText(say, code, values)
        expect(said, `${code} has no sentence`).toBeTruthy()
        expect(said, `${code} left a placeholder in ${language}: ${said}`).not.toMatch(UNFILLED)
        if (names !== "") expect(said, `${code} did not name '${names}': ${said}`).toContain(names)
      }
      for (const [code, values, names] of warnings) {
        const said = hostWarningText(say, { code, message: `the Host's own sentence for ${code}`, values })
        expect(said, `${code} fell through instead of being said`).not.toBe(`the Host's own sentence for ${code}`)
        expect(said, `${code} left a placeholder in ${language}: ${said}`).not.toMatch(UNFILLED)
        if (names !== "") expect(said, `${code} did not name '${names}': ${said}`).toContain(names)
      }
    })
  }
})

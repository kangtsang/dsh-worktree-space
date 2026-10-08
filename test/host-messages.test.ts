// @vitest-environment node
import { describe, expect, it } from "vitest"
import { hostFailureText, hostWarningText, type HostWarning } from "../src/client/lib/host-messages"
import { format, t } from "../src/client/lib/i18n"

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

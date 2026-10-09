import { format } from "./i18n"

/**
 * What the Host sends beside a sentence, so a screen can build its own.
 *
 * The Host writes each failure and each warning once, in English, because that copy is
 * what its audit log keeps and what anything showing it verbatim prints. A path, a
 * branch name or a count cannot be recovered from that sentence without reading English
 * prose, so the values travel beside it as data, and the sentences below are the same
 * things said in the language the reader is using.
 */
export type HostValues = Record<string, unknown>

/** A warning as the Host reports it: the sentence for the log, and the values a screen needs. */
export type HostWarning = { code?: string; message: string; values?: HostValues }

/** The translation function in force, as `i18n` hands it out. */
type Translate = (key: string) => string

/**
 * A value from the Host as text.
 * @param value - whatever the Host sent.
 * @returns the value as a string, empty when there is nothing to show.
 */
const text = (value: unknown): string => (typeof value === "string" ? value : value === undefined || value === null ? "" : String(value))

/**
 * A value from the Host as a list of strings.
 * @param value - whatever the Host sent.
 * @returns the list, empty when it is not one.
 */
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(text) : [])

/**
 * What the delivery gate is waiting for, in the reader's language.
 *
 * The Host names each one by key - `smoke`, `human-ack` - rather than by the phrase it
 * puts in its own sentence, because a phrase translated word by word is not a phrase.
 * @param t - the translation function in force.
 * @param keys - the keys the Host sent.
 * @returns them joined the way this language joins a list of two.
 */
function missingText(t: Translate, keys: string[]): string {
  return keys
    .map((key) => (key === "smoke" ? t("gateMissingSmoke") : key === "human-ack" ? t("gateMissingHumanAck") : key))
    .join(t("gateMissingJoin"))
}

/**
 * A failure said in the reader's language, when this plugin has a sentence for its code.
 *
 * Undefined means it does not: the Host's own words are then what the reader sees, which
 * is what every failure did before any of this existed.
 * @param t - the translation function in force.
 * @param code - the code the Host sent.
 * @param values - the values it sent beside the failure.
 * @returns the sentence, or undefined to leave the Host's message alone.
 */
export function hostFailureText(t: Translate, code: string, values: HostValues): string | undefined {
  switch (code) {
    case "E2003":
      return format(t("hostE2003"), { path: text(values.path) })
    case "E2004": {
      // One code, three situations: which one it is decides what the reader is told to
      // do about it, so it is sent as data rather than left to be read out of a sentence.
      const path = text(values.path)
      const reason = text(values.reason)
      if (reason === "no-worktrees-to-extend") return format(t("hostE2004NoWorktreesToExtend"), { path })
      if (reason === "branches-disagree") return format(t("hostE2004BranchesDisagree"), { path })
      return format(t("hostE2004NoWorktrees"), { path })
    }
    case "E2005":
      return format(t("hostE2005"), { path: text(values.path), missing: text(values.missing) })
    case "E4011":
      return t("hostE4011")
    case "E4012":
      return t("hostE4012")
    case "E4013":
      return t("hostE4013")
    case "E4014":
      return t("hostE4014")
    case "E5005": {
      const envId = text(values.envId)
      return format(t("hostE5005"), {
        target: text(values.target),
        env: envId === "" ? "" : format(t("hostE5005Env"), { envId }),
      })
    }
    case "E5006":
      return t("hostE5006")
    case "E5007":
      return format(t("hostE5007"), { missing: missingText(t, strings(values.missing)) })
    case "E5011": {
      const held = (Array.isArray(values.held) ? values.held : []) as HostValues[]
      return format(t(held.length === 1 ? "hostE5011" : "hostE5011Many"), {
        count: String(held.length),
        held: held.map((entry) => `  ${text(entry.path)}\n    ${text(entry.reason)}`).join("\n"),
      })
    }
    default:
      return undefined
  }
}

/**
 * A warning said in the reader's language, over the Host's own sentence.
 *
 * A warning with no code, or one this plugin has no sentence for, is shown as the Host
 * wrote it: a warning is not worth losing to a missing translation.
 * @param t - the translation function in force.
 * @param warning - the warning the Host sent.
 * @returns the sentence to put on screen.
 */
export function hostWarningText(t: Translate, warning: HostWarning | string): string {
  if (typeof warning === "string") return warning
  const values = warning.values ?? {}
  switch (warning.code) {
    case "no-task-branch":
      return format(t("warnNoTaskBranch"), { path: text(values.path) })
    case "delivery-gate-bypassed": {
      const missing = strings(values.missing)
      return missing.length > 0
        ? format(t("warnDeliveryGateBypassedMissing"), { missing: missingText(t, missing) })
        : format(t("warnDeliveryGateBypassedWithoutDeployment"), { target: text(values.target) })
    }
    case "human-ack-waived":
      return t("warnHumanAckWaived")
    case "branch-left-alone":
      return text(values.branch) === ""
        ? format(t("warnBranchLeftAloneNone"), { name: text(values.name), mainRepo: text(values.mainRepo) })
        : format(t("warnBranchLeftAloneOther"), {
          name: text(values.name),
          branch: text(values.branch),
          taskBranch: text(values.taskBranch),
          mainRepo: text(values.mainRepo),
        })
    case "branch-not-deleted":
      return format(t("warnBranchNotDeleted"), { branch: text(values.branch), name: text(values.name) })
    case "leftover-refused":
      return format(t("warnLeftoverRefused"), { name: text(values.name) })
    case "leftover-holds-links": {
      const links = strings(values.links)
      // How many are named is the Host's decision - it is the same bound its own sentence
      // uses - so it is read rather than assumed.
      const shown = typeof values.shown === "number" && values.shown > 0 ? values.shown : links.length
      const listed = links.slice(0, shown).join(", ")
        + (links.length > shown ? format(t("warnLeftoverHoldsLinksMore"), { more: String(links.length - shown) }) : "")
      return format(t("warnLeftoverHoldsLinks"), {
        name: text(values.name),
        destination: text(values.destination),
        count: String(links.length),
        links: listed,
      })
    }
    case "leftover-copy-failed":
      return format(t("warnLeftoverCopyFailed"), { name: text(values.name), destination: text(values.destination), reason: text(values.reason) })
    case "no-deployment-recorded":
      return t("warnNoDeploymentRecorded")
    case "deploy-destroy-failed":
      return format(t("warnDeployDestroyFailed"), { output: text(values.output) })
    case "deploy-containers-left":
      return format(t("warnDeployContainersLeft"), { count: text(values.count), envId: text(values.envId), reason: text(values.reason) })
    case "deploy-cleanup-failed":
      return format(t("warnDeployCleanupFailed"), { envId: text(values.envId), reason: text(values.reason) })
    default:
      return warning.message
  }
}

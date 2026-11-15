/**
 * The two tab types of the changes sidebar, and how their addresses are minted.
 *
 * 变更总览 is the overview of one task space or Workspace: one row per
 * repository, with the base it is compared against. 变更查看 is one repository's
 * files, opened from a row of the overview. They are two tab types rather than
 * two states of one, because the reader opens the second one on top of the
 * first, exactly as the shell's own "变更请求" and "本地变更" tabs do.
 */
import { t } from "./i18n"

/** Registry kind of the overview tab. */
export const CHANGES_OVERVIEW_KIND = "wts-changes-overview"

/** Registry kind of the file view tab. */
export const CHANGES_VIEW_KIND = "wts-changes-view"

const OVERVIEW_PREFIX = "dsh-resource://wts-changes-overview/"
const VIEW_PREFIX = "dsh-resource://wts-changes-view/"

/** The resource glob each type claims. */
export const CHANGES_OVERVIEW_PATTERN = `${OVERVIEW_PREFIX}**`
export const CHANGES_VIEW_PATTERN = `${VIEW_PREFIX}**`

/** One repository the view reads, and the base its row names. */
export interface ChangesViewTarget {
  path: string
  /** Empty means the Host resolves the branch's upstream, the same as the row. */
  base: string
}

/** The address of one task space or Workspace's overview. */
export function changesOverviewAddress(path: string): string {
  return OVERVIEW_PREFIX + encodeURIComponent(path)
}

/** The address of one repository's file view. */
export function changesViewAddress(path: string, base: string): string {
  const query = base === "" ? "" : `?base=${encodeURIComponent(base)}`
  return VIEW_PREFIX + encodeURIComponent(path) + query
}

/** Read an overview address back, or undefined for one this package did not mint. */
export function parseChangesOverviewAddress(address: string): { path: string } | undefined {
  if (!address.startsWith(OVERVIEW_PREFIX)) return undefined
  const rest = address.slice(OVERVIEW_PREFIX.length)
  if (rest === "" || rest.includes("/") || rest.includes("?")) return undefined
  try {
    return { path: decodeURIComponent(rest) }
  } catch {
    return undefined
  }
}

/** Read a file view address back, or undefined for one this package did not mint. */
export function parseChangesViewAddress(address: string): ChangesViewTarget | undefined {
  if (!address.startsWith(VIEW_PREFIX)) return undefined
  const [encoded = "", query = ""] = address.slice(VIEW_PREFIX.length).split("?", 2)
  if (encoded === "") return undefined
  try {
    const base = new URLSearchParams(query).get("base") ?? ""
    return { path: decodeURIComponent(encoded), base }
  } catch {
    return undefined
  }
}

/** The chip of the overview tab. */
export function changesOverviewTitle(): string {
  return t("changesOverviewTab")
}

/** The chip of the file view tab. */
export function changesViewTitle(): string {
  return t("changesViewTab")
}

/** The last segment of a path, for a title that has no room for the whole one. */
export function entryName(path: string): string {
  const parts = String(path ?? "").split(/[\\/]/).filter((part) => part !== "")
  return parts.length === 0 ? String(path ?? "") : parts[parts.length - 1]
}

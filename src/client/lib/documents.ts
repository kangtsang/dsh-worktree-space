import { cleanPath, nameOf, parentOf, taskDirectory } from "./paths"

/** Folder, under a container root, that archived documents are filed into. */
export const DOCUMENTS_FOLDER = "archived-docs"

/**
 * The container's own directory name, which the fixed anchor is built from.
 *
 * It repeats `CONTAINER_NAME` in the Host's `src/host/task/paths.js` rather than
 * importing it: the two halves of this plugin are built as separate bundles, so
 * nothing crosses between them. Both being `worktree-space` is what makes the
 * anchor land beside a container that sits directly under a volume root.
 */
const CONTAINER_FOLDER = "worktree-space"

/** Characters no file name may hold on Windows, plus the separators. */
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/g

/**
 * The three places archived documents may be rooted, as the setting names them.
 *
 * `custom` is the user's own directory, which wins whenever one is filled in;
 * `drive` is the fixed anchor beside the volume root; `container` keeps the
 * documents with the task space, which is what this plugin did before the
 * setting existed.
 */
export type ArchiveStrategy = "drive" | "container" | "custom"

/** Where archived documents are rooted, as the configuration states it. */
export interface ArchivePreference {
  strategy: ArchiveStrategy
  /** The chosen root, read only by the `custom` strategy. */
  directory: string
}

/**
 * What an unread or unstated preference means.
 *
 * It is the shipped default, so a Host that answers nothing - or a dialog that
 * has not heard back yet - paints the same destination the Host would use.
 */
export const DEFAULT_ARCHIVE_PREFERENCE: ArchivePreference = { strategy: "drive", directory: "" }

/**
 * Make one folder-name part out of arbitrary text.
 * @param value - the text, such as a Workspace title.
 * @returns the text with separators and forbidden characters replaced.
 */
export function safeFolderName(value: string): string {
  return value.replace(FORBIDDEN, "-").replace(/-+/g, "-").replace(/^[-. ]+|[-. ]+$/g, "")
}

/**
 * The moment, written the way a folder name needs it.
 *
 * Date and time each run together, joined by one dash: `20260926-020933`. That
 * also keeps the colons of `HH:MM:SS` out of a Windows file name.
 * @param now - the moment to write.
 * @returns `20260926-020933`.
 */
export function folderStamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${date}-${time}`
}

/**
 * The volume root a path sits on.
 *
 * Read from the path itself rather than from the platform, because the container
 * being archived may live on a volume the plugin process is not running on and
 * the only path in hand is the container's.
 * @param path - a path in either separator style.
 * @returns `E:\`, or an empty string when the path names no volume - a POSIX
 * path, or a UNC share, whose root is not a place this plugin should write to.
 */
function driveRootOf(path: string): string {
  const match = /^([A-Za-z]:)[\\/]/.exec(cleanPath(path))
  return match === null ? "" : `${match[1]}\\`
}

/**
 * The directory the per-task archive folders are filed under.
 *
 * The three strategies differ only here; the per-task folder below is the same
 * for all of them, so two tasks filed into one root never mix their documents.
 *
 * A `custom` root with nothing in the box falls back to the fixed anchor rather
 * than to the task space: the box is empty because the setting is not filled in
 * yet, and the anchor is what the setting means by default. A path carrying no
 * volume has no anchor to build and falls back to the container instead, which is
 * the one destination that always exists.
 * @param path - the task container being archived.
 * @param preference - the configured strategy, and the directory it may read.
 * @returns the absolute directory the per-task folders go under.
 */
function archiveRootFor(path: string, preference: ArchivePreference): string {
  const chosen = preference.directory.trim()
  if (preference.strategy === "custom" && chosen !== "") return chosen
  if (preference.strategy !== "container") {
    const drive = driveRootOf(path)
    if (drive !== "") return `${drive}${CONTAINER_FOLDER}\\${DOCUMENTS_FOLDER}`
  }
  return taskDirectory(parentOf(path), DOCUMENTS_FOLDER)
}

/**
 * Where a task's own documents are archived to.
 *
 * A folder of its own, named after the Workspace - which already carries the
 * task, so `kratos-admin/testb` becomes `kratos-admin-testb` - and the moment it
 * was archived, under the root the configured strategy names. The folder name has
 * no space, so it needs no quoting in a shell on any platform.
 *
 * Why the root is a strategy rather than one fixed rule: the container follows
 * the repositories, because that is what keeps a session from having to be
 * approved to write there, so a single container-shaped rule would scatter the
 * archive across every place a task space was ever made. The fixed anchor trades
 * that for one well-known directory per volume, and a user who wants the
 * documents somewhere particular can say so.
 * @param path - the task container being archived.
 * @param title - the registered Workspace's title, when there is one.
 * @param now - the moment to name the folder after.
 * @param preference - the configured strategy and directory; the shipped default
 * anchors under the task container's volume root.
 * @returns the absolute directory to file the documents into.
 */
export function documentsDirectoryFor(
  path: string,
  title: string | undefined,
  now: Date,
  preference: ArchivePreference = DEFAULT_ARCHIVE_PREFERENCE,
): string {
  const task = nameOf(path)
  const named = title === undefined || title.trim() === "" ? task : title.trim()
  const folder = `${safeFolderName(named)}-${folderStamp(now)}`
  return taskDirectory(archiveRootFor(path, preference), folder)
}

import { containerRootOf, nameOf, projectOf, taskDirectory } from "./paths"

/** Folder, under a container root, that archived documents are filed into. */
export const DOCUMENTS_FOLDER = "archived-docs"

/** Characters no file name may hold on Windows, plus the separators. */
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/g

/**
 * The two places archived documents may be rooted, as the setting names them.
 *
 * `container` keeps them in the container root, which is what the setting ships
 * as: everything this plugin writes then lives under the one directory it names,
 * and nothing appears a second time elsewhere on the volume. `custom` is the
 * user's own directory, which wins whenever one is filled in.
 */
export type ArchiveStrategy = "container" | "custom"

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
export const DEFAULT_ARCHIVE_PREFERENCE: ArchivePreference = { strategy: "container", directory: "" }

/**
 * Make one folder-name part out of arbitrary text.
 * @param value - the text, such as a project directory's name.
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
 * The directory the per-task archive folders are filed under.
 *
 * The two strategies differ only here; the project and per-task folders below are
 * the same for both, so two tasks filed into one root never mix their documents.
 *
 * A `custom` root with nothing in the box falls back to the container root rather
 * than to an anchor of its own: the box is empty because the setting is not
 * filled in yet, and the container root is where the shipped default files. That
 * also keeps this the one destination that always exists - a path carrying no
 * volume has no anchor to build either.
 *
 * The container root is reached by depth through {@link containerRootOf}, because
 * the task space is `<container root>/<project>/<task>`.
 * @param path - the task container being archived.
 * @param preference - the configured strategy, and the directory it may read.
 * @returns the absolute directory the project and task folders go under.
 */
function archiveRootFor(path: string, preference: ArchivePreference): string {
  const chosen = preference.directory.trim()
  if (preference.strategy === "custom" && chosen !== "") return chosen
  return taskDirectory(containerRootOf(path), DOCUMENTS_FOLDER)
}

/**
 * Where a task's own documents are archived to.
 *
 * Two folders of its own under the root the configured strategy names: the
 * project the task belongs to, and then the task with the moment it was archived
 * - `project1/hotfix-20260926-020933`. The project folder mirrors the layer the
 * container root already files the task under, so one project's archives collect
 * in one place rather than beside every other project's.
 *
 * Both names are read off the task space's own path, so an archive is never named
 * after anything the caller has to supply and cannot disagree with where the task
 * actually lives. A project directory's name may carry a space - unlike a task
 * name, which may not - so the folder can too.
 * @param path - the task container being archived.
 * @param now - the moment to name the folder after.
 * @param preference - the configured strategy and directory; the shipped default
 * files under the container root's `archived-docs`.
 * @returns the absolute directory to file the documents into.
 */
export function documentsDirectoryFor(
  path: string,
  now: Date,
  preference: ArchivePreference = DEFAULT_ARCHIVE_PREFERENCE,
): string {
  const folder = `${safeFolderName(nameOf(path))}-${folderStamp(now)}`
  return taskDirectory(taskDirectory(archiveRootFor(path, preference), safeFolderName(projectOf(path))), folder)
}

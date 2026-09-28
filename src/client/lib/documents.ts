import { nameOf, parentOf, taskDirectory } from "./paths"

/** Folder, under a container root, that archived documents are filed into. */
export const DOCUMENTS_FOLDER = "archived-docs"

/** Characters no file name may hold on Windows, plus the separators. */
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/g

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
 * Where a task's own documents are archived to.
 *
 * A folder of its own under `<container root>/archived-docs`, named after the
 * Workspace — which already carries the task, so `kratos-admin/testb` becomes
 * `kratos-admin-testb` — and the moment it was archived. The folder name has no
 * space, so it needs no quoting in a shell on any platform.
 *
 * A configured destination replaces the whole of that: it is where every task's
 * documents go, so the per-task folder adding the title and the moment would
 * scatter one destination into a new folder per archive. Empty is the setting's
 * own "not set" and keeps the computed default, which is the behaviour of a Host
 * that has never had the setting written to it.
 * @param path - the task container being archived.
 * @param title - the registered Workspace's title, when there is one.
 * @param now - the moment to name the folder after.
 * @param configured - the destination from the configuration, when one is set.
 * @returns the absolute directory to file the documents into.
 */
export function documentsDirectoryFor(path: string, title: string | undefined, now: Date, configured = ""): string {
  const chosen = configured.trim()
  if (chosen !== "") return chosen
  const task = nameOf(path)
  const named = title === undefined || title.trim() === "" ? task : title.trim()
  const folder = `${safeFolderName(named)}-${folderStamp(now)}`
  return taskDirectory(taskDirectory(parentOf(path), DOCUMENTS_FOLDER), folder)
}

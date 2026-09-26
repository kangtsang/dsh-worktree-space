export function cleanPath(value: unknown) {
  const text = String(value ?? "")
  return text.length > 1 ? text.replace(/[\\/]+$/, "") : text
}

export function slugOf(value: unknown) {
  return String(value || "task").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "task"
}

/**
 * The task directory inside a container root, in the container's own separator
 * style, so the preview reads like the path the host will create.
 * @param tasksRoot - the container root.
 * @param slug - the task name.
 * @returns the task directory path.
 */
export function taskDirectory(tasksRoot: string, slug: string) {
  const separator = tasksRoot.includes("\\") ? "\\" : "/"
  return `${cleanPath(tasksRoot)}${separator}${slug}`
}

/**
 * Parent directory of a path, keeping its original separator style.
 * @param value - a path, with or without a trailing separator.
 * @returns the parent path.
 */
export function parentOf(value: unknown) {
  const trimmed = cleanPath(value)
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return index <= 0 ? trimmed : trimmed.slice(0, index)
}

/**
 * Final segment of a path — the directory or file name.
 * @param value - a path, with or without a trailing separator.
 * @returns the last segment.
 */
export function nameOf(value: unknown) {
  const trimmed = cleanPath(value)
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return index < 0 ? trimmed : trimmed.slice(index + 1)
}

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

/**
 * The project layer a task space is filed under.
 *
 * A task space is `<container root>/<project>/<task>`, and the project is the
 * source root's own directory name. Nothing carries it in a path, so it is read
 * back from the depth: the directory one above the task.
 * @param taskPath - a task space directory.
 * @returns the project name.
 */
export function projectOf(taskPath: unknown) {
  return nameOf(parentOf(taskPath))
}

/**
 * The container root a task space is filed under — the directory every project
 * and every task of this container sits in.
 *
 * Read from the depth rather than carried around, and read through this one
 * function so that the archive root, the plan request and the panel's grouping
 * cannot disagree about where the container begins. The Host writes the same
 * layout in `taskSpacePath`; the two halves are separate bundles, so the depth is
 * the only thing that can be shared and this is where it is written down.
 * @param taskPath - a task space directory.
 * @returns the container root.
 */
export function containerRootOf(taskPath: unknown) {
  return parentOf(parentOf(taskPath))
}

/**
 * A path as this plugin displays it: forward slashes, whichever separator the
 * host or the user reported. Windows accepts both, so showing one style keeps
 * the panel and the dialogs from mixing them.
 * @param value - a path in either separator style.
 * @returns the path with every backslash replaced by a forward slash.
 */
export function slashPath(value: unknown) {
  return String(value ?? "").split(/\\/).join("/")
}

/**
 * The deepest directory that contains both paths.
 *
 * A linked worktree keeps its git metadata inside the source repository, so a
 * session that has to commit there needs a working directory reaching both: this is
 * that directory - the narrowest one that reaches the worktree and the repository,
 * and therefore the narrowest write boundary that finishes the job without an approval.
 * @param left - one path.
 * @param right - the other path.
 * @returns the common ancestor, or undefined when they share only a volume root — a
 * boundary that wide would make the whole disk writable, which is worse than the
 * approval it avoids.
 */
export function commonAncestor(left: unknown, right: unknown) {
  const first = slashPath(cleanPath(left)).split("/")
  const second = slashPath(cleanPath(right)).split("/")
  const shared: string[] = []
  for (let index = 0; index < Math.min(first.length, second.length); index += 1) {
    // Compared without case: Windows is case-insensitive, and the two paths reach
    // here from different sources - the Host's answer and the git command output.
    if (first[index].toLowerCase() !== second[index].toLowerCase()) break
    shared.push(first[index])
  }
  return shared.length < 2 ? undefined : shared.join("/")
}

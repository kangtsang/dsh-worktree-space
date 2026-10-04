export function cleanPath(value: unknown) {
  const text = String(value ?? "")
  return text.length > 1 ? text.replace(/[\\/]+$/, "") : text
}

/**
 * A name reduced to what a Git ref and a directory may both be called.
 *
 * Everything that is not a letter, a digit, a dot, a hyphen or an underscore becomes
 * a hyphen, and hyphens are trimmed off both ends. This is the one rule, and
 * `slugOf` is this plus the placeholder a caller that insists on a name needs: the
 * two used to spell the same regex out separately, so a form that validated against
 * one and asked the other whether anything was left could drift and end up showing
 * a name as valid while submitting a different one.
 * @param value - the name as typed.
 * @returns the normalized name, or "" when nothing usable is left.
 */
export function normalizedSlugOf(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
}

/**
 * {@link normalizedSlugOf}, with a placeholder in place of an empty name.
 * @param value - the name as typed.
 * @returns the normalized name, or "task" when nothing usable is left.
 */
export function slugOf(value: unknown) {
  return normalizedSlugOf(value) || "task"
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
 * Whether two paths are Windows-shaped, and case therefore cannot tell two spellings
 * of one directory apart from two different directories.
 *
 * This is decided from the paths, never from `process.platform`. The client bundle
 * runs in a browser and has no idea what the Host it is talking to runs on - that
 * value would describe the browser. A drive letter is the thing that carries the
 * answer across the wire: `C:\Repo` only reaches us from a Windows Host, and on one,
 * `Repo` and `repo` are one directory spelled two ways.
 *
 * The cost of getting it backwards is not symmetric. Folding case where the
 * filesystem does not treats `/Work` and `/work` as one directory, which can drop a
 * repository the session was about to touch, or hand a commit a write boundary that
 * spans two unrelated trees. Failing to fold on Windows is a duplicate listing. So
 * every comparison in this module goes through here rather than calling toLowerCase
 * on its own — two of the three did, and the two disagreed with the third.
 * @param left - one path, already separator-normalised.
 * @param right - the other.
 * @returns whether both carry a drive letter.
 */
function bothWindowsPaths(left: string, right: string): boolean {
  return /^[a-zA-Z]:/.test(left) && /^[a-zA-Z]:/.test(right)
}

/**
 * Whether two paths name the same location.
 *
 * Compared after the separator style and trailing separators are settled, because
 * the same directory reaches this code spelled more than one way: the Host answers
 * with the platform's own, git reports forward slashes, and a user types either.
 * @param left - one path.
 * @param right - the other.
 * @returns whether both name one location.
 */
export function sameLocation(left: unknown, right: unknown) {
  const first = slashPath(cleanPath(left))
  const second = slashPath(cleanPath(right))
  if (first === second) return true
  return bothWindowsPaths(first, second) && first.toLowerCase() === second.toLowerCase()
}

/**
 * Whether `child` sits strictly below `parent`.
 *
 * The layout rules ask this of two directories that must stay outside one another,
 * and the answer has to be about location rather than about spelling for the same
 * reason {@link sameLocation} folds what it folds: `isInsideDirectory` answered from
 * spelling alone, so on a case-sensitive filesystem `/WORKSPACE/public` came back as
 * sitting inside `/workspace` and the layout rule that uses this would have rejected
 * a container for no reason.
 * @param parent - the containing directory.
 * @param child - the candidate descendant.
 * @returns whether `child` sits below `parent`, and is not `parent`.
 */
export function isInsideDirectory(parent: unknown, child: unknown) {
  const outer = slashPath(cleanPath(parent)).replace(/\/+$/, "")
  const inner = slashPath(cleanPath(child)).replace(/\/+$/, "")
  if (sameLocation(outer, inner)) return false
  const prefix = outer.endsWith("/") ? outer : `${outer}/`
  // Two branches, not one. Folding is a decision about spelling, and answering
  // "these are not Windows paths" as though it were the answer to "is the child below
  // the parent" makes every POSIX directory look like a root: `/workspace/public`
  // came back as not inside `/workspace`.
  if (bothWindowsPaths(inner, prefix)) return inner.toLowerCase().startsWith(prefix.toLowerCase())
  return inner.startsWith(prefix)
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
  const leftPath = slashPath(cleanPath(left))
  const rightPath = slashPath(cleanPath(right))
  const first = leftPath.split("/")
  const second = rightPath.split("/")
  // Case folds only on Windows-shaped paths, for the reason `bothWindowsPaths` gives.
  // Unconditionally, this function handed the caller a directory shared by two trees
  // that have nothing to do with each other: `/Work/task/alpha` and `/work/repos/alpha`
  // came back as `/Work`, and that answer is used as a write boundary when a session
  // commits - so on a case-sensitive Host it would have widened the boundary to a
  // directory neither repository is under, or to nothing at all and then fallen back
  // to asking for approval.
  const fold = bothWindowsPaths(leftPath, rightPath)
  const key = (segment: string) => (fold ? segment.toLowerCase() : segment)
  const shared: string[] = []
  for (let index = 0; index < Math.min(first.length, second.length); index += 1) {
    if (key(first[index]) !== key(second[index])) break
    shared.push(first[index])
  }
  return shared.length < 2 ? undefined : shared.join("/")
}

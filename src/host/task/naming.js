/**
 * Task naming rules, ported from the source skill's `task-new.sh`.
 *
 * A task name becomes both a directory name inside the task container and the
 * branch suffix every repository in the workspace shares, so it may not carry
 * separators or whitespace.
 */

/** Branch prefix a task uses in every repository by default. */
export const DEFAULT_BRANCH_PREFIX = 'task/'

/** Raised when a task name or a branch prefix cannot become a directory and a branch. */
export class TaskNameError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TaskNameError'
  }
}

/** Characters a task name may not carry: they would change the layout or the ref. */
const FORBIDDEN = /[/\\\s]/

/** Characters Git refuses in a ref name, wherever they appear. */
const ILLEGAL_BRANCH_CHARACTERS = /[\s~^:?*\[\]\\\u0000-\u001f\u007f]/

/**
 * Validate a task name.
 * @param task - the requested task name.
 * @returns the validated name, unchanged.
 * @throws TaskNameError when the name is empty or carries a forbidden character.
 */
export function validateTaskName(task) {
  const name = String(task ?? '')
  if (name === '') throw new TaskNameError('a task name is required')
  if (FORBIDDEN.test(name)) {
    throw new TaskNameError(`task name must not contain /, \\ or whitespace: ${name}`)
  }
  return name
}

/**
 * Validate a caller-supplied branch prefix.
 *
 * The prefix is taken verbatim — a caller choosing `hotfix/` gets `hotfix/<task>`
 * and one choosing `release-` gets `release-<task>` — because the dialog previews
 * exactly what this returns. Only what Git would refuse, or what would silently
 * change the ref the caller asked for, is rejected here rather than reported later
 * by a failing `worktree add`.
 * @param prefix - the requested prefix; empty or absent means the default.
 * @returns the prefix to use, with surrounding whitespace removed.
 * @throws TaskNameError when the prefix cannot precede a task name in a ref.
 */
export function validateBranchPrefix(prefix) {
  const value = String(prefix ?? '').trim()
  if (value === '') return DEFAULT_BRANCH_PREFIX
  if (ILLEGAL_BRANCH_CHARACTERS.test(value)) {
    throw new TaskNameError(`branch prefix must not contain whitespace or any of ~ ^ : ? * [ ] \\ : ${value}`)
  }
  if (value.includes('..')) throw new TaskNameError(`branch prefix must not contain '..': ${value}`)
  if (value.includes('@{')) throw new TaskNameError(`branch prefix must not contain '@{': ${value}`)
  if (value.includes('//')) throw new TaskNameError(`branch prefix must not contain an empty path segment: ${value}`)
  if (value.startsWith('/') || value.startsWith('-')) {
    throw new TaskNameError(`branch prefix must not start with '/' or '-': ${value}`)
  }
  return value
}

/**
 * Branch name a task uses in every repository.
 * @param task - a task name validated by {@link validateTaskName}.
 * @param prefix - branch prefix; defaults to `task/`.
 * @returns the branch name shared by every repository in the task.
 */
export function branchNameFor(task, prefix = DEFAULT_BRANCH_PREFIX) {
  return `${prefix}${task}`
}

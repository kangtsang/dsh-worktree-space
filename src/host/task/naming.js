/**
 * Task naming rules, ported from the source skill's `task-new.sh`.
 *
 * A task name becomes both a directory name inside the task container and the
 * branch suffix every repository in the workspace shares, so it may not carry
 * separators or whitespace.
 */

/** Branch prefix a task uses in every repository by default. */
export const DEFAULT_BRANCH_PREFIX = 'feat/'

/** Raised when a task name cannot become a directory and a branch. */
export class TaskNameError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TaskNameError'
  }
}

/** Characters a task name may not carry: they would change the layout or the ref. */
const FORBIDDEN = /[/\\\s]/

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
 * Branch name a task uses in every repository.
 * @param task - a task name validated by {@link validateTaskName}.
 * @param prefix - branch prefix; defaults to `feat/`.
 * @returns the branch name shared by every repository in the task.
 */
export function branchNameFor(task, prefix = DEFAULT_BRANCH_PREFIX) {
  return `${prefix}${task}`
}

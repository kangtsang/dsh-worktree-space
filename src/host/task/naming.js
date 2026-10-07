/**
 * Task naming rules, ported from the source skill's `task-new.sh`.
 *
 * A task name becomes both a directory name inside the task container and the
 * branch suffix every repository in the workspace shares, so it may not carry
 * separators or whitespace.
 *
 * A project name is a directory name too - the layer a task space sits under -
 * but it is not a branch suffix and it comes from a directory that already
 * exists, so it is held to what would change the layout and nothing more: an
 * empty name, the two relative names, or a separator. Whitespace is allowed,
 * because refusing a name the user's own filesystem already carries would make
 * the source root unusable rather than safe.
 */
import { basename, resolve } from 'node:path'

/** Branch prefix a task uses in every repository by default. */
export const DEFAULT_BRANCH_PREFIX = 'task/'

/**
 * Raised when a task name or a branch prefix cannot become a directory and a branch.
 *
 * One code for the class: every case here is the same thing from a caller's point
 * of view - a name that cannot be used, fix the name - and the message says which
 * character is at fault. Splitting it further would make codes for distinctions no
 * caller acts on.
 */
export class TaskNameError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TaskNameError'
    this.code = 'E4009'
  }
}

/** Characters a task name may not carry: they would change the layout or the ref. */
const FORBIDDEN = /[/\\\s]/

/**
 * Characters a project name may not carry: the two separators, and nothing else.
 *
 * Deliberately not {@link FORBIDDEN}: a task name also becomes a branch suffix and
 * so cannot hold a space, while a project name is only a directory segment taken
 * from a directory that already exists on disk. Rejecting whitespace there would
 * refuse a workspace the user really has (`E:\workspace\my project`) and leave
 * them no way to create a task in it.
 */
const FORBIDDEN_IN_PROJECT = /[/\\]/

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
  // The two relative names, which {@link validateProjectName} already refuses and
  // which FORBIDDEN cannot catch because they carry neither a separator nor a
  // space. `taskSpacePath` joins this straight into `<root>/<project>/<task>`, so
  // a task named `..` resolves back to the container root and one named `.` to the
  // project layer - and finishing a task deletes what it finds under that path.
  if (name === '.' || name === '..') throw new TaskNameError(`task name must not be '.' or '..': ${name}`)
  if (FORBIDDEN.test(name)) {
    throw new TaskNameError(`task name must not contain /, \\ or whitespace: ${name}`)
  }
  return name
}

/**
 * Validate the project layer's name.
 *
 * The name is one directory segment between the container root and a task name.
 * It is not trimmed and not otherwise rewritten: it names a directory that must
 * already exist on disk, so the value that goes into the path has to be the
 * value the caller reported, character for character.
 * @param project - the project name, as `basename` of a source root.
 * @returns the name, unchanged.
 * @throws TaskNameError when the name is empty, relative, or carries a separator.
 */
export function validateProjectName(project) {
  const name = String(project ?? '')
  if (name === '') throw new TaskNameError('a project name is required')
  if (name === '.' || name === '..') throw new TaskNameError(`project name must not be '.' or '..': ${name}`)
  if (FORBIDDEN_IN_PROJECT.test(name)) throw new TaskNameError(`project name must not contain / or \\: ${name}`)
  return name
}

/**
 * The project a source root belongs to: the source root's own directory name.
 *
 * One source root is one project, so this is derived rather than asked for -
 * the dialog never has to name it, and the layout cannot drift from what the
 * user sees on disk. A source root that is itself the repository answers with
 * that repository's name, which is also the name of the worktree one level
 * below it; the repetition is the honest consequence of one directory being both.
 * @param sourceRoot - the directory holding the source repositories.
 * @returns the project name.
 * @throws TaskNameError when the source root's own name cannot be a segment.
 */
export function projectNameFor(sourceRoot) {
  return validateProjectName(basename(resolve(String(sourceRoot ?? ''))))
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

/**
 * Docker environment id a task's deployments carry.
 *
 * A deployed task is one compose project — one network, one teardown — so it needs
 * an id unique to the task that every side spells the same way: the note prints it
 * for the session, the deploy script takes it as `DSH_ENV_ID`, and a cleanup that
 * runs after the fact matches containers by the `dsh.env-id` label carrying it.
 * Deriving it here, from the two names the task already has, is what keeps those
 * sides agreeing without a fourth name to ask for or to mistype.
 *
 * A compose project name is held to a narrower alphabet than a directory name is —
 * lowercase letters, digits, dash and underscore — while a project name may carry
 * spaces or any other character the user's filesystem really has. Everything
 * outside the alphabet folds to a dash, and a segment that folds away entirely
 * falls back to its layer's name, so the id stays legal for every project the user
 * has. The fold is many-to-one: two names differing only outside the alphabet
 * collapse to one id, which for cleanup is the safe direction — an over-broad match
 * tears down at worst a task that spells the same.
 * @param project - the project layer's name.
 * @param task - the task name.
 * @returns the environment id, e.g. `dsh-my-project-fix-login`.
 */
export function deploymentEnvIdFor(project, task) {
  const slug = (value, fallback) => {
    const folded = String(value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
    return folded === '' ? fallback : folded
  }
  return ['dsh', slug(project, 'project'), slug(task, 'task')].join('-')
}

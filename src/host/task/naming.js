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
 * Device names Win32 resolves whatever the extension, so no directory of one can
 * round-trip.
 *
 * `CON`, `PRN`, `AUX` and `NUL` name devices on their own, and `COM1`-`COM9` and
 * `LPT1`-`LPT9` name ports. Win32 strips a trailing extension before it compares,
 * so `CON.txt` is the same name as `CON` - which is why the extension is optional
 * here rather than required. Case is folded for the same reason: `con` is `CON`.
 */
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i

/**
 * Why a value cannot be a task name, or `''` when it can.
 *
 * The rule {@link validateTaskName} applies, written once so the reason can be read
 * rather than inferred from a chain of throws.
 *
 * The name becomes two things at once: a directory segment inside the container, and the
 * suffix of a git branch in every repository. So it has to survive both, and these rules
 * are the union of what each of them refuses.
 *
 * Why this is stricter than "no separators": a name that cannot round-trip through the
 * filesystem does not merely look wrong, it collides with another name. Win32 collapses
 * a trailing dot, so `login.` and `login` are two accepted names that resolve to one
 * directory - and finishing the first would then read the second's record and remove the
 * second's worktrees and branch, which is an irreversible removal of the wrong task. The
 * same holds for a trailing space. A name carrying a character git refuses in a ref is
 * the other half: the create would get as far as `git worktree add -b task/a:b` and fail
 * there with a raw git error, after making a container, instead of refusing the name
 * before anything is made.
 *
 * Deliberately NOT the rule {@link isUsableTaskName} applies. That one answers the
 * read-back direction and is looser on purpose; see it for why the two are not one rule.
 * @param name - the candidate name, already stringified.
 * @returns the reason it is unusable, or `''`.
 */
function taskNameProblem(name) {
  if (name === '') return 'a task name is required'
  // The two relative names, which {@link validateProjectName} already refuses and which
  // FORBIDDEN cannot catch because they carry neither a separator nor a space.
  // `taskSpacePath` joins this straight into `<root>/<project>/<task>`, so a task named
  // `..` resolves back to the container root and one named `.` to the project layer -
  // and finishing a task deletes what it finds under that path.
  if (name === '.' || name === '..') return `task name must not be '.' or '..': ${name}`
  // A trailing dot is the Win32 collision above, and it is named before the general
  // ref-character rule because it is the more specific answer for a name like `login.`.
  if (name.endsWith('.')) return `task name must not end with a dot: ${name}`
  // A trailing space is caught by FORBIDDEN below, and named here for the reader who
  // cannot see it: a name that looks like `login` and is not is exactly the collision
  // this exists to refuse, so the message says which end is wrong.
  if (name.endsWith(' ')) return `task name must not end with a space: ${name}`
  if (FORBIDDEN.test(name)) return `task name must not contain /, \\ or whitespace: ${name}`
  // The characters git refuses in a ref, control characters included: the branch is
  // `<prefix><name>`, so a name carrying one produces a ref git will not create.
  if (ILLEGAL_BRANCH_CHARACTERS.test(name)) {
    return `task name must not contain a character git refuses in a branch name (space, ~ ^ : ? * [ ] \\ or a control character): ${name}`
  }
  // `..` anywhere is refused by git in a ref, and `@{` starts a reflog expression.
  if (name.includes('..')) return `task name must not contain '..': ${name}`
  if (name.includes('@{')) return `task name must not contain '@{': ${name}`
  // git refuses a ref ending in `.lock`, because that is a file it keeps itself.
  if (name.endsWith('.lock')) return `task name must not end with '.lock': ${name}`
  // A name Win32 resolves to a device cannot be a directory on that platform at all, so
  // a task named one could be created on Linux and then be unreachable on Windows.
  if (WINDOWS_RESERVED_NAME.test(name)) return `task name must not be a Windows reserved device name: ${name}`
  return ''
}

/**
 * The entry names a repository directory must not take inside a task space.
 *
 * Declared here rather than imported from `shared.js`, which owns
 * `TASK_OWNED_ENTRIES`, because `shared.js` imports this module - so the names a
 * repository directory has to avoid cannot be read from the other side of that
 * edge.
 *
 * **This is a different list from `TASK_OWNED_ENTRIES`, not a copy of it, and the
 * two are deliberately not asserted equal.** They answer different questions:
 *
 *   - `TASK_OWNED_ENTRIES` is "which top-level names may a finish remove without
 *     asking", which is why it holds `.worktree-space` (the record, the note and the
 *     deploy root) and the legacy `README.en.md`, and why it holds nothing else.
 *   - this list is "which top-level names must a checkout never occupy", because a
 *     worktree standing there would put a repository where the plugin's own
 *     bookkeeping goes.
 *
 * `worktree-space.md` is in the second and not the first, and both placements are
 * right. It is written inside `.worktree-space`, so a finish never meets it at the
 * top level and `TASK_OWNED_ENTRIES` has no business naming it. But a repository
 * directory called `worktree-space.md` would still collide with the note on any
 * task space made before the JSON existed - and the note is this plugin's, not the
 * user's to have overwritten - so a name a checkout may not take has to include it.
 *
 * The overlap is `.worktree-space` and `README.en.md`, and it is an overlap rather
 * than a shared definition: neither list is derived from the other, and a name may
 * belong to one without belonging to the other.
 *
 * The other two names this plugin writes - `worktree-space.json` and the `deploy`
 * root - are deliberately absent, and the reason is where they live rather than what
 * they are. Both sit inside `.worktree-space` (`taskMetadataPath` and
 * `taskDeployRootPath` both join through `pluginRootPath`), and a worktree is cut at
 * `<task space>/<repository name>`, so a repository called either of those names
 * produces `<task space>/worktree-space.json` beside the plugin's directory rather
 * than inside it. Two entries at the top level with the same name cannot exist on any
 * filesystem, so there is no collision to refuse - and reserving the name anyway
 * would take it from repositories for no reason, since the plugin's own file is
 * somewhere else.
 */
export const TASK_OWNED_ENTRY_NAMES = ['.worktree-space', 'README.en.md', 'worktree-space.md']

/**
 * Validate the directory name a repository contributes to a task space.
 *
 * A worktree is named after its source repository, and that name is one entry in
 * the task space - which means it can collide with the entries this plugin puts
 * there itself. Two collisions are refused, and neither is cosmetic:
 *
 *   - `.worktree-space` is the plugin's own directory: the record, the note and
 *     the deploy root live in it, and a worktree by that name would put a checkout
 *     where the plugin's bookkeeping goes. The create would write its record into
 *     a directory git believes it owns, and the finish reads that directory to
 *     decide what the task was - so the two would each be reading the other's
 *     files with no way to tell them apart.
 *   - the legacy note (`worktree-space.md`) is the same collision one version back,
 *     and is refused for the same reason.
 *
 * `.` and `..` are refused because `basename` returns them for a path that ends in
 * one, and `join(taskPath, '..')` is the project layer rather than a worktree. The
 * delete fence lets that through - it is inside the container - and today only
 * git's own "the destination directory is not empty" happens to stop it. That is
 * the wrong thing to be relying on.
 * @param name - the repository's directory name.
 * @returns the name, unchanged.
 * @throws TaskNameError when the name collides with a plugin-owned entry or is a relative name.
 */
export function validateRepositoryDirectoryName(name) {
  const value = String(name ?? '')
  if (value === '') throw new TaskNameError('a repository directory name is required')
  // Exact comparison rather than case-folded: these are the names this plugin
  // writes, and it writes them in this spelling. A repository called
  // `.Worktree-Space` lands beside the plugin's directory on a case-sensitive
  // volume, which is a name of its own and not a collision.
  if (TASK_OWNED_ENTRY_NAMES.includes(value)) {
    throw new TaskNameError(`a repository directory cannot be named '${value}': that name belongs to this plugin inside a task space`)
  }
  if (value === '.' || value === '..') {
    throw new TaskNameError(`a repository directory name must not be '.' or '..': ${value}`)
  }
  // The separators cannot survive `basename` in practice, but the rule is stated
  // here rather than assumed: this value is joined onto a task space path, and a
  // name that is a path is a way out of it.
  if (FORBIDDEN_IN_PROJECT.test(value)) {
    throw new TaskNameError(`a repository directory name must not contain / or \\: ${value}`)
  }
  return value
}

/**
 * Validate a task name.
 * @param task - the requested task name.
 * @returns the validated name, unchanged.
 * @throws TaskNameError when the name is empty or cannot become a directory and a ref.
 */
export function validateTaskName(task) {
  const name = String(task ?? '')
  const problem = taskNameProblem(name)
  if (problem !== '') throw new TaskNameError(problem)
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
 * Whether a value could be a task name at all, by this repository's own rule.
 *
 * The read-back half of {@link validateTaskName}, which throws because it is answering
 * a request. Here the value already exists in a file, and the caller is deciding
 * whether to repeat it rather than whether to allow it - so the answer is a boolean.
 * A name this rejects could not have been created by this plugin, which is what makes
 * it not a name to show a reader.
 *
 * Deliberately looser than {@link validateTaskName}, and the difference is the point
 * rather than an oversight. That one refuses a request, so it may refuse anything it
 * likes; this one judges a name already written in a file, which an older version of
 * this plugin may have written under a rule it has since tightened. Refusing such a
 * name here would not refuse a create - it would take a real task's name away from the
 * session reporting on it, and the reader would see a task with no name at all. So the
 * question is only the one that was always true: does it hold a separator or a space,
 * which no version of this rule ever allowed. A control character is folded out of the
 * value by the caller instead of being made into a reason to drop the whole name.
 * @param task - the candidate name.
 * @returns whether it is usable as a task name.
 */
export function isUsableTaskName(task) {
  const name = String(task ?? '')
  if (name === '' || name === '.' || name === '..') return false
  return !FORBIDDEN.test(name)
}

/**
 * Whether a value could be a branch name at all, by this repository's own rule.
 *
 * The same checks {@link validateBranchPrefix} makes, applied to a whole ref rather
 * than a prefix. It exists for the read-back direction: a task's own record carries a
 * branch name, that record is a file the task session can write, and the name is
 * shown to a reader - so a value that could never have been a ref is not one to
 * report. Asking rather than throwing, because the caller is describing something
 * that already exists rather than refusing a request.
 * @param branch - the candidate ref.
 * @returns whether it is usable as a branch name.
 */
export function isUsableBranchName(branch) {
  const value = String(branch ?? '')
  if (value === '' || value === '@') return false
  if (ILLEGAL_BRANCH_CHARACTERS.test(value)) return false
  if (value.includes('..') || value.includes('@{') || value.includes('//')) return false
  if (value.startsWith('/') || value.startsWith('-') || value.endsWith('/') || value.endsWith('.')) return false
  if (value.endsWith('.lock')) return false
  return true
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
 * for the session, the deploy script takes it as `DEPLOY_ENV_ID`, and a cleanup that
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

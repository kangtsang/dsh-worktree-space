/**
 * Task creation
 *
 * Creating a task: the container, the branch, one worktree per repository, and the file that tells a session what the task is.
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { auditEnter, recordError, recordEvent } from './audit-log.js'
import { ERROR_CODES, coded } from './codes.js'
import { prepareContainerRoot } from './container.js'
import { discoverSourceRepos, resolveSourceRepos } from './discover.js'
import { gitSucceeded, runGit, tryRunGit } from './git.js'
import { branchNameFor, DEFAULT_BRANCH_PREFIX, projectNameFor, validateBranchPrefix, validateTaskName } from './naming.js'
import { assertIsolated, refuseDelete } from './paths.js'

import { TASK_OWNED_FILES, readTaskMetadata, resolveTasksRoot, taskMetadata, taskSpacePath, writeTaskMetadata } from './shared.js'

/**
 * The facts only the source repository can answer, read before a worktree is
 * cut from it: the branch its HEAD is on, and the exact commit the new branch
 * will start from. Recorded so the task can still be described when the source
 * checkout is somewhere else, or gone.
 *
 * Exported because adding a repository to an existing task cuts its worktree the
 * same way a create does, and has to record the same two facts about it.
 * @param subprocess - the profile's subprocess service.
 * @param repoPath - the source repository.
 * @returns the branch name and the starting commit, either possibly absent.
 */
export async function sourceFacts(subprocess, repoPath) {
  const [branch, commit] = await Promise.all([
    tryRunGit(subprocess, repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    tryRunGit(subprocess, repoPath, ['rev-parse', 'HEAD']),
  ])
  return {
    // A detached HEAD prints `HEAD`, which is no branch to name.
    ...(branch === '' || branch === 'HEAD' ? {} : { sourceBranch: branch }),
    ...(commit === '' ? {} : { startCommit: commit }),
  }
}

/**
 * Whether a container holds nothing but what this plugin put there.
 * @param leftovers - the container's entries.
 * @param created - the worktrees this call created.
 * @returns whether a failed create may remove the container.
 */
function holdsOnlyOurs(leftovers, created) {
  return leftovers.every((name) => TASK_OWNED_FILES.includes(name) || created.some((entry) => basename(entry.path) === name))
}

async function rollbackTask(subprocess, tasksRoot, taskPath, branch, created) {
  const stranded = []
  for (const entry of created) {
    // The worktree was created by this call and never handed to a caller, so a
    // forced removal is safe and is the only reliable way to clean a
    // half-registered worktree - but only while it is still the directory this
    // call put there, so it is asked first.
    const refused = refuseDelete(tasksRoot, entry.path, `the worktree '${entry.name}'`)
    if (refused !== '') { stranded.push(entry.name); continue }
    if (!(await gitSucceeded(subprocess, entry.repoPath, ['worktree', 'remove', '--force', entry.path]))) {
      stranded.push(entry.name)
      continue
    }
    // Removing the worktree is half of what has to go back: the branch was made
    // by `worktree add -b`, and git does not delete it with the checkout that
    // held it. Left behind it takes the name, and the same task cannot be
    // created again - which is the opposite of what the record below then says.
    //
    // Deleting it is safe because it cannot be anybody else's: this create
    // refused every repository that already had this branch before it made
    // anything, and the worktree that was holding it is gone. `-D` because it
    // has no commits and can have none now, and `--` for the reason archive.js
    // gives - this is the one call here that leaves the container.
    if (!(await gitSucceeded(subprocess, entry.repoPath, ['branch', '-D', '--', branch]))) {
      stranded.push(`${entry.name}'s branch ${branch}`)
    }
  }
  if (stranded.length > 0) return stranded

  // The container is the last thing standing, and "no task space was left behind"
  // is a claim about it, so the claim is made only when it is demonstrably gone.
  // Four ways that fails, and only the first is a clean no-op: a readdir failing
  // because the directory is already absent PROVES it is gone, while one failing
  // for any other reason proves nothing and has to be reported; a container holding
  // something this call did not put there is left alone on purpose, which still
  // takes the name; and a removal that throws leaves it.
  const container = `the task space ${basename(taskPath)}`
  let leftovers
  try {
    leftovers = await readdir(taskPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') stranded.push(container)
    return stranded
  }
  if (!holdsOnlyOurs(leftovers, created)) {
    stranded.push(container)
    return stranded
  }
  try {
    await rm(taskPath, { recursive: true, force: true })
  } catch {
    stranded.push(container)
  }
  return stranded
}


export async function createTask(subprocess, options) {
  const {
    sourceRoot,
    task,
    tasksRoot: requestedRoot,
    repos,
    baseRef,
    branchPrefix = DEFAULT_BRANCH_PREFIX,
    configuredRoot = '',
    // How far to look for the repositories a task covers. The same bounds the
    // classification and the suggestion used, so the count on the Workspace card,
    // the list in the create dialog, and what this actually takes are one number
    // rather than three that happen to disagree.
    scanBounds = {},
  } = options

  const name = validateTaskName(task)
  // Resolved before anything is touched: an unusable prefix must fail as a
  // request, not halfway through a worktree.
  const prefix = validateBranchPrefix(branchPrefix)
  const tasksRoot = resolveTasksRoot(sourceRoot, requestedRoot, configuredRoot)
  assertIsolated(sourceRoot, tasksRoot)
  // The layer this source root's task spaces live under, so one container holding
  // several projects never mixes their tasks. Derived from the source root rather
  // than asked for: the dialog never has to name it, and the layout cannot drift
  // from the directory the user sees on disk.
  const project = projectNameFor(sourceRoot)

  // An absent list means "every discovered repository"; an explicitly empty one
  // is a caller that selected nothing, which must not silently become all.
  if (Array.isArray(repos) && repos.length === 0) {
    throw coded('E4001', 'select at least one repository for the task')
  }
  const selected = Array.isArray(repos)
    ? await resolveSourceRepos(sourceRoot, repos)
    : await discoverSourceRepos(sourceRoot, scanBounds)
  if (selected.length === 0) {
    throw coded(
      'E6001',
      `no source repositories found under ${sourceRoot}: expected a repository, or .git directories within ${scanBounds.maxDepth ?? 1} level(s) below it`,
    )
  }

  const names = selected.map((repoPath) => basename(repoPath))
  const duplicate = names.find((entry, index) => names.indexOf(entry) !== index)
  if (duplicate !== undefined) {
    throw coded('E4002', `two selected repositories are both named '${duplicate}'; select repositories with distinct names`)
  }

  const branch = branchNameFor(name, prefix)
  const taskPath = taskSpacePath(tasksRoot, project, name)
  // What every record this create writes carries, entered before the guards
  // below so that a refused create is still attributable to this task, project
  // and container root. Entered before the container root exists on purpose: the
  // probes below are worth having, and an append that finds no directory to write
  // in drops the line rather than creating one.
  auditEnter({ task: name, project, tasksRoot })
  // A task space that is already there is not a plain name clash: when its
  // breadcrumb names this task, this project and this branch, it is a create
  // whose Workspace registration failed and left the container behind. The code
  // lets the dialog tell the two apart and offer recovery instead of a dead end.
  if (existsSync(taskPath)) {
    const existing = await readTaskMetadata(taskPath).catch(() => undefined)
    const ours = existing !== undefined
      && existing.task === name
      && existing.project === project
      && existing.branch === branch
    const error = coded('E2001', `task space already exists: ${taskPath}`)
    // E2001 and E2002 are two situations behind one guard, and they are read
    // apart by the dialog: one is a name clash to report, the other is a recovery
    // it can offer. The code says which; the sentence says what it means and what
    // can be done about it, which the message alone cannot.
    if (ours) error.code = 'E2002'
    error.msg = ours
      ? `Nothing was created. A task space for exactly this task, project and branch is already on disk at ${taskPath}, which means an earlier create got as far as making it and stopped before its Workspace was registered. Creating again under this name will keep failing until that one is registered, finished or removed.`
      : `Nothing was created. The name is already taken by a different task space at ${taskPath}, so this create would have overwritten somebody else's work. Pick another task name, or finish the existing task first.`
    throw error
  }

  for (const repoPath of selected) {
    if (await gitSucceeded(subprocess, repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) {
      throw coded(
        'E3001',
        `branch '${branch}' already exists in '${basename(repoPath)}'; pick another task name`,
      ).withMsg(
        `Nothing was created. The branch ${branch} already exists in ${basename(repoPath)}, so a new worktree could not be named after it and cutting one would have pointed this task's work at work already in progress. Pick another task name, or start from a branch that is free.`,
      )
    }
  }
  if (baseRef !== undefined && `${baseRef}`.trim() !== '') {
    for (const repoPath of selected) {
      if (!(await gitSucceeded(subprocess, repoPath, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]))) {
        throw coded('E3002', `base '${baseRef}' not found in '${basename(repoPath)}'`)
      }
    }
  }

  await prepareContainerRoot(tasksRoot)
  // The project directory may already hold other tasks, so only the task's own
  // directory is asked for strictly: a second one with the same name is reported
  // rather than silently reused.
  await mkdir(join(tasksRoot, project), { recursive: true })
  await mkdir(taskPath)

  const created = []
  try {
    for (const repoPath of selected) {
      const worktreePath = join(taskPath, basename(repoPath))
      // Read the source facts before the branch exists, so they describe the
      // checkout the worktree was cut from rather than the worktree itself.
      const facts = await sourceFacts(subprocess, repoPath)
      const args = baseRef === undefined || `${baseRef}`.trim() === ''
        ? ['worktree', 'add', worktreePath, '-b', branch]
        : ['worktree', 'add', worktreePath, '-b', branch, `${baseRef}`]
      await runGit(subprocess, repoPath, args)
      created.push({ name: basename(repoPath), path: worktreePath, repoPath, ...facts })
    }

    await writeTaskMetadata(taskPath, taskMetadata({
      task: name,
      project,
      tasksRoot,
      sourceRoot,
      branch,
      baseRef: baseRef === undefined || `${baseRef}`.trim() === '' ? undefined : `${baseRef}`,
      repositories: created.map((entry) => ({
        name: entry.name,
        sourcePath: entry.repoPath,
        branch,
        ...(entry.sourceBranch === undefined ? {} : { sourceBranch: entry.sourceBranch }),
        ...(entry.startCommit === undefined ? {} : { startCommit: entry.startCommit }),
      })),
    }))
  } catch (error) {
    const stranded = await rollbackTask(subprocess, tasksRoot, taskPath, branch, created)
    const suffix = stranded.length === 0 ? '' : ` (could not roll back: ${stranded.join(', ')})`
    // The code is decided once, here, and goes into the two places that must not
    // disagree: the record below and the error the caller reads. `recover` takes
    // the code off the error and no caller hands it a classifier, so an error
    // rebuilt without one reaches the caller as E9001 - which names nothing the
    // log does not, but names it a different way from the record written here.
    //
    // A failure that carries one of ours keeps it: which git call failed, and why,
    // is more use to a caller than the fact that a rollback ran, and the client
    // already tells E3004 from E3005. A code from outside the table is not kept -
    // a Node filesystem error brings a `code` of its own (`EISDIR`), and passing
    // that on would put a second vocabulary in the log and on the wire, which
    // `recover` would flatten to E9001 anyway. So those answer for what the
    // rollback managed, which is the only distinction left to make there.
    const own = typeof error?.code === 'string' && Object.hasOwn(ERROR_CODES, error.code) ? error.code : ''
    const code = own !== '' ? own : (stranded.length === 0 ? 'E2005' : 'E2006')
    // What the rollback could not undo is the part a create that failed leaves
    // behind, and it is not in the message the caller reads - so it is here.
    // The sentence says which of the two outcomes this is, because "rolled back"
    // and "left something behind" call for different amounts of attention and
    // neither is visible in `exit` or `code` on their own.
    await recordError(error, {
      phase: 'create',
      code,
      msg: stranded.length === 0
        ? 'Creating the task space failed. The rollback removed the worktrees, the branch and the task space this call had made, so the same name can be used again.'
        : 'Creating the task space failed and the rollback could not remove everything. The leftovers named in `stranded` are still on disk and have to be dealt with by hand.',
      ...(created.length === 0 ? {} : { created: created.map((entry) => entry.name) }),
      ...(stranded.length === 0 ? {} : { stranded }),
    })
    // Rebuilt rather than rethrown, because the rollback's outcome is part of what
    // the caller has to be told. The code is carried over for the reason above:
    // an error rebuilt without one is one the caller learns nothing from.
    const rolled = new Error(`${error.message}${suffix}`)
    rolled.code = code
    throw rolled
  }

  await recordEvent(
    'info',
    `Created the task space. Every selected repository has a worktree on ${branch} and the task metadata is written, so this is the point from which the task exists.`,
    { phase: 'create', branch, path: taskPath, worktrees: created.map((entry) => entry.name) },
  )

  return {
    task: name,
    project,
    branch,
    path: taskPath,
    tasksRoot,
    baseRef: baseRef === undefined || `${baseRef}`.trim() === '' ? undefined : `${baseRef}`,
    repositories: created.map((entry) => ({ name: entry.name, path: entry.path })),
  }
}



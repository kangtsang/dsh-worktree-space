/**
 * Task creation
 *
 * Creating a task: the container, the branch, one worktree per repository, and the file that tells a session what the task is.
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { prepareContainerRoot } from './container.js'
import { discoverSourceRepos, isSourceRepository, resolveSourceRepos } from './discover.js'
import { gitSucceeded, parseWorktrees, runGit, tryRunGit } from './git.js'
import { branchNameFor, DEFAULT_BRANCH_PREFIX, projectNameFor, validateBranchPrefix, validateTaskName } from './naming.js'
import { assertIsolated } from './paths.js'

import { TASK_OWNED_FILES, readTaskMetadata, resolveTasksRoot, taskMetadata, taskSpacePath, writeTaskMetadata } from './shared.js'

export function breadcrumb(details) {
  const { task, branch, baseRef, sourceRoot, repositories } = details
  return [
    `# Task: ${task}`,
    '',
    `- Branch: \`${branch}\` (one branch per repository below)`,
    `- Base: ${baseRef === undefined ? "each repository's current HEAD" : `\`${baseRef}\``}`,
    `- Created: ${new Date().toISOString()}`,
    `- Source root: \`${sourceRoot}\``,
    '- This folder is the agent session working directory.',
    '',
    '## Repositories',
    ...repositories.map((name) => `- \`${name}\``),
    '',
    '## Conventions',
    '- Commit in each repository separately (the same branch name everywhere).',
    '- Source repositories are read-only: never edit or commit there.',
    '- Merging back to the main branch is the user\'s action, not the agent\'s.',
    '',
  ].join('\n')
}


/**
 * The facts only the source repository can answer, read before a worktree is
 * cut from it: the branch its HEAD is on, and the exact commit the new branch
 * will start from. Recorded so the task can still be described when the source
 * checkout is somewhere else, or gone.
 * @param subprocess - the profile's subprocess service.
 * @param repoPath - the source repository.
 * @returns the branch name and the starting commit, either possibly absent.
 */
async function sourceFacts(subprocess, repoPath) {
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

async function rollbackTask(subprocess, taskPath, created) {
  const stranded = []
  for (const entry of created) {
    // The worktree was created by this call and never handed to a caller, so a
    // forced removal is safe and is the only reliable way to clean a
    // half-registered worktree.
    if (!(await gitSucceeded(subprocess, entry.repoPath, ['worktree', 'remove', '--force', entry.path]))) {
      stranded.push(entry.name)
    }
  }
  if (stranded.length > 0) return stranded

  try {
    const leftovers = await readdir(taskPath)
    if (holdsOnlyOurs(leftovers, created)) await rm(taskPath, { recursive: true, force: true })
  } catch {
    // A container that cannot be removed is reported by the caller's outcome,
    // not here.
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
    push = false,
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
    throw new Error('select at least one repository for the task')
  }
  const selected = Array.isArray(repos)
    ? await resolveSourceRepos(sourceRoot, repos)
    : await discoverSourceRepos(sourceRoot)
  if (selected.length === 0) {
    throw new Error(
      `no source repositories found under ${sourceRoot}: expected a repository, or .git directories in its top-level subdirectories`,
    )
  }

  const names = selected.map((repoPath) => basename(repoPath))
  const duplicate = names.find((entry, index) => names.indexOf(entry) !== index)
  if (duplicate !== undefined) {
    throw new Error(`two selected repositories are both named '${duplicate}'; select repositories with distinct names`)
  }

  const branch = branchNameFor(name, prefix)
  const taskPath = taskSpacePath(tasksRoot, project, name)
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
    const error = new Error(`task space already exists: ${taskPath}`)
    error.code = ours ? 'task-space-unregistered' : 'task-space-exists'
    throw error
  }

  for (const repoPath of selected) {
    if (await gitSucceeded(subprocess, repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) {
      throw new Error(`branch '${branch}' already exists in '${basename(repoPath)}'; pick another task name`)
    }
  }
  if (baseRef !== undefined && `${baseRef}`.trim() !== '') {
    for (const repoPath of selected) {
      if (!(await gitSucceeded(subprocess, repoPath, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]))) {
        throw new Error(`base '${baseRef}' not found in '${basename(repoPath)}'`)
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
  const warnings = []
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

    if (push) {
      for (const entry of created) {
        if (!(await gitSucceeded(subprocess, entry.repoPath, ['push', '-u', 'origin', branch]))) {
          warnings.push(`push to origin failed for '${entry.name}'; the branch is kept locally`)
        }
      }
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
    const stranded = await rollbackTask(subprocess, taskPath, created)
    const suffix = stranded.length === 0 ? '' : ` (could not roll back: ${stranded.join(', ')})`
    throw new Error(`${error.message}${suffix}`)
  }

  return {
    task: name,
    project,
    branch,
    path: taskPath,
    tasksRoot,
    baseRef: baseRef === undefined || `${baseRef}`.trim() === '' ? undefined : `${baseRef}`,
    repositories: created.map((entry) => ({ name: entry.name, path: entry.path })),
    warnings,
  }
}



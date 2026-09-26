/**
 * Task creation
 *
 * Creating a task: the container, the branch, one worktree per repository, and the file that tells a session what the task is.
 */
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rmdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { discoverSourceRepos, isSourceRepository, resolveSourceRepos } from './discover.js'
import { gitSucceeded, parseWorktrees, runGit, tryRunGit } from './git.js'
import { branchNameFor, DEFAULT_BRANCH_PREFIX, validateTaskName } from './naming.js'
import { assertIsolated, recommendTasksRoot } from './paths.js'

import { BREADCRUMB, resolveTasksRoot } from './shared.js'

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
    const ours = leftovers.every((name) => name === BREADCRUMB || created.some((entry) => basename(entry.path) === name))
    if (ours) await rm(taskPath, { recursive: true, force: true })
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
    push = false,
  } = options

  const name = validateTaskName(task)
  const tasksRoot = resolveTasksRoot(sourceRoot, requestedRoot)
  assertIsolated(sourceRoot, tasksRoot)

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

  const branch = branchNameFor(name, branchPrefix)
  const taskPath = join(tasksRoot, name)
  if (existsSync(taskPath)) throw new Error(`task space already exists: ${taskPath}`)

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

  await mkdir(tasksRoot, { recursive: true })
  await mkdir(taskPath)

  const created = []
  const warnings = []
  try {
    for (const repoPath of selected) {
      const worktreePath = join(taskPath, basename(repoPath))
      const args = baseRef === undefined || `${baseRef}`.trim() === ''
        ? ['worktree', 'add', worktreePath, '-b', branch]
        : ['worktree', 'add', worktreePath, '-b', branch, `${baseRef}`]
      await runGit(subprocess, repoPath, args)
      created.push({ name: basename(repoPath), path: worktreePath, repoPath })
    }

    if (push) {
      for (const entry of created) {
        if (!(await gitSucceeded(subprocess, entry.repoPath, ['push', '-u', 'origin', branch]))) {
          warnings.push(`push to origin failed for '${entry.name}'; the branch is kept locally`)
        }
      }
    }

    await writeFile(
      join(taskPath, BREADCRUMB),
      breadcrumb({ task: name, branch, baseRef: baseRef === undefined || `${baseRef}`.trim() === '' ? undefined : `${baseRef}`, sourceRoot, repositories: created.map((entry) => entry.name) }),
      'utf8',
    )
  } catch (error) {
    const stranded = await rollbackTask(subprocess, taskPath, created)
    const suffix = stranded.length === 0 ? '' : ` (could not roll back: ${stranded.join(', ')})`
    throw new Error(`${error.message}${suffix}`)
  }

  return {
    task: name,
    branch,
    path: taskPath,
    tasksRoot,
    baseRef: baseRef === undefined || `${baseRef}`.trim() === '' ? undefined : `${baseRef}`,
    repositories: created.map((entry) => ({ name: entry.name, path: entry.path })),
    warnings,
  }
}



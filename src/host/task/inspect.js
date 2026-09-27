/**
 * Task inspection
 *
 * Looking at a workspace or a task: what it is, what it holds, and whether it is a source root or a task container.
 */
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rmdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { discoverSourceRepos, isSourceRepository, resolveSourceRepos } from './discover.js'
import { gitSucceeded, parseWorktrees, runGit, tryRunGit } from './git.js'
import { branchNameFor, DEFAULT_BRANCH_PREFIX, validateBranchPrefix, validateTaskName } from './naming.js'
import { assertIsolated, recommendTasksRoot } from './paths.js'

import { breadcrumb } from './create.js'
import { BREADCRUMB, isLinkedWorktree, listTaskWorktrees, resolveTasksRoot } from './shared.js'

export async function classifySourceRoot(sourceRoot) {
  const repositories = await discoverSourceRepos(sourceRoot)
  return {
    path: sourceRoot,
    isRepository: await isSourceRepository(sourceRoot),
    isSourceRoot: repositories.length > 0,
    repositoryCount: repositories.length,
    repositories: repositories.map((repoPath) => ({ name: basename(repoPath), path: repoPath })),
  }
}


export async function suggestTaskRoot(subprocess, sourceRoot, { tasksRoot, branchPrefix = DEFAULT_BRANCH_PREFIX } = {}) {
  const requested = typeof tasksRoot === 'string' ? tasksRoot.trim() : ''
  const suggested = resolveTasksRoot(sourceRoot, requested)
  assertIsolated(sourceRoot, suggested)
  const repositories = await discoverSourceRepos(sourceRoot)
  return {
    sourceRoot,
    suggested,
    explicit: requested !== '',
    // The same resolution a create performs, so the preview the dialog shows and
    // the branch the host would make cannot disagree.
    branchPrefix: validateBranchPrefix(branchPrefix),
    // One git call per repository, in parallel: the dialog's cards name the branch
    // each HEAD is on, which is the fact the repository view shows for its main
    // worktree.
    repositories: await Promise.all(repositories.map(async (repoPath) => {
      const branch = await currentBranchOf(subprocess, repoPath)
      return {
        name: basename(repoPath),
        path: repoPath,
        ...(branch === undefined ? {} : { branch }),
      }
    })),
  }
}


/**
 * The branch a repository's HEAD is on.
 *
 * `git rev-parse --abbrev-ref HEAD` prints `HEAD` for a detached HEAD, which is
 * no branch at all, and prints nothing when the call fails — both leave the
 * caller with no branch to name rather than with a made-up one.
 * @param subprocess - the profile's subprocess service.
 * @param repoPath - the repository to inspect.
 * @returns the branch name, or undefined when HEAD is detached or unreadable.
 */
async function currentBranchOf(subprocess, repoPath) {
  const branch = await tryRunGit(subprocess, repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return branch === '' || branch === 'HEAD' ? undefined : branch
}


export function parseBreadcrumb(text) {
  const source = String(text ?? '')
  const task = /^# Task:\s*(.+)$/m.exec(source)?.[1]?.trim()
  if (task === undefined || task === '') return undefined
  const branch = /^-\s*Branch:\s*`([^`]+)`/m.exec(source)?.[1]?.trim()
  const sourceRoot = /^-\s*Source root:\s*`([^`]+)`/m.exec(source)?.[1]?.trim()
  return {
    task,
    ...(branch === undefined || branch === '' ? {} : { branch }),
    ...(sourceRoot === undefined || sourceRoot === '' ? {} : { sourceRoot }),
  }
}


export async function inspectTask(taskPath) {
  const path = String(taskPath ?? '').trim()
  const name = basename(path)
  const notATask = { path, isTask: false, task: name, tasksRoot: dirname(path), repositories: [] }
  if (path === '') return notATask

  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return notATask
  }
  const repositories = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (await isLinkedWorktree(join(path, entry.name))) repositories.push(entry.name)
  }
  const details = parseBreadcrumb(await readFile(join(path, BREADCRUMB), 'utf8').catch(() => ''))
  // Either signal is enough: a container whose breadcrumb was deleted is still a
  // task, and a breadcrumb with no worktrees left is a task mid-archive.
  if (details === undefined && repositories.length === 0) return notATask
  return {
    path,
    isTask: true,
    task: details?.task ?? name,
    tasksRoot: dirname(path),
    ...(details?.branch === undefined ? {} : { branch: details.branch }),
    ...(details?.sourceRoot === undefined ? {} : { sourceRoot: details.sourceRoot }),
    repositories: repositories.sort(),
  }
}


export async function listTasks(subprocess, { tasksRoot } = {}) {
  if (typeof tasksRoot !== 'string' || tasksRoot.trim() === '') throw new Error('a tasks root is required')
  const root = tasksRoot.trim()
  if (!existsSync(root)) return { tasksRoot: root, tasks: [] }

  const entries = await readdir(root, { withFileTypes: true })
  const tasks = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const taskPath = join(root, entry.name)
    tasks.push({ name: entry.name, path: taskPath, repositories: await listTaskWorktrees(subprocess, taskPath) })
  }
  tasks.sort((left, right) => left.name.localeCompare(right.name))
  return { tasksRoot: root, tasks }
}



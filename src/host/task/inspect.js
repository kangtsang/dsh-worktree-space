/**
 * Task inspection
 *
 * Looking at a workspace or a task: what it is, what it holds, and whether it is a source root or a task container.
 */
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { CONTAINER_ARCHIVE_FOLDER } from './container.js'
import { coded } from './codes.js'
import { discoverSourceRepos, isSourceRepository } from './discover.js'
import { tryRunGit } from './git.js'
import { DEFAULT_BRANCH_PREFIX, validateBranchPrefix } from './naming.js'
import { assertIsolated } from './paths.js'

import { isLinkedWorktree, listTaskWorktrees, readTaskMetadata, resolveTasksRoot } from './shared.js'

export async function classifySourceRoot(sourceRoot) {
  const repositories = await discoverSourceRepos(sourceRoot)
  return {
    path: sourceRoot,
    // Whether the path is a directory at all. `isSourceRoot` cannot answer it: a
    // directory that holds no repositories and a path that is not there both come
    // back as false, and a caller registering a Workspace needs to tell those two
    // apart before it makes one out of the path.
    isDirectory: await isExistingDirectory(sourceRoot),
    isRepository: await isSourceRepository(sourceRoot),
    isSourceRoot: repositories.length > 0,
    repositoryCount: repositories.length,
    repositories: repositories.map((repoPath) => ({ name: basename(repoPath), path: repoPath })),
  }
}

/**
 * Whether a path is a directory that exists.
 * @param {string} directory - the candidate path.
 * @returns {Promise<boolean>} whether it is a directory.
 */
async function isExistingDirectory(directory) {
  try {
    return (await stat(directory)).isDirectory()
  } catch {
    return false
  }
}


export async function suggestTaskRoot(subprocess, sourceRoot, { tasksRoot, branchPrefix = DEFAULT_BRANCH_PREFIX, configuredRoot = '' } = {}) {
  const requested = typeof tasksRoot === 'string' ? tasksRoot.trim() : ''
  const suggested = resolveTasksRoot(sourceRoot, requested, configuredRoot)
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
  // Two levels up: a task space is `<container root>/<project>/<task>`.
  const containerRoot = dirname(dirname(path))
  const notATask = { path, isTask: false, task: name, project: basename(dirname(path)), tasksRoot: containerRoot, repositories: [] }
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
  // The JSON record is the identity now; a container made before it existed
  // still answers through its Markdown note. Either signal is enough: a
  // container whose metadata was deleted is still a task, and metadata with no
  // worktrees left is a task mid-archive.
  const details = await readTaskMetadata(path)
  if (details === undefined && repositories.length === 0) return notATask
  return {
    path,
    isTask: true,
    task: details?.task ?? name,
    // The record knows where it was filed. A space made before the project layer
    // existed has neither field, and its path answers for both: the directory it
    // sits in is its project, and the one above that the container root.
    project: typeof details?.project === 'string' && details.project !== '' ? details.project : basename(dirname(path)),
    tasksRoot: typeof details?.tasksRoot === 'string' && details.tasksRoot !== '' ? details.tasksRoot : containerRoot,
    ...(details?.branch === undefined ? {} : { branch: details.branch }),
    ...(details?.sourceRoot === undefined ? {} : { sourceRoot: details.sourceRoot }),
    ...(details?.baseRef === undefined || details.baseRef === null ? {} : { baseRef: details.baseRef }),
    ...(details?.createdAt === undefined ? {} : { createdAt: details.createdAt }),
    repositories: repositories.sort(),
  }
}


export async function listTasks(subprocess, { tasksRoot } = {}) {
  if (typeof tasksRoot !== 'string' || tasksRoot.trim() === '') throw coded('E1004', 'a tasks root is required')
  const root = tasksRoot.trim()
  if (!existsSync(root)) return { tasksRoot: root, tasks: [] }

  // Two levels: the container root holds one directory per project, and a project
  // holds one per task. The archive folder is the one directory at the root that
  // is neither - it is where the `container` strategy files documents, and its
  // own subdirectories are named after tasks without being any.
  const projects = await readdir(root, { withFileTypes: true })
  const tasks = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    if (project.name === CONTAINER_ARCHIVE_FOLDER) continue
    const projectPath = join(root, project.name)
    for (const entry of await readdir(projectPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const taskPath = join(projectPath, entry.name)
      tasks.push({
        name: entry.name,
        project: project.name,
        path: taskPath,
        repositories: await listTaskWorktrees(subprocess, taskPath),
      })
    }
  }
  tasks.sort((left, right) => left.project.localeCompare(right.project) || left.name.localeCompare(right.name))
  return { tasksRoot: root, tasks }
}



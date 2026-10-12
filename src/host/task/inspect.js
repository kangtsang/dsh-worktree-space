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
import { mapWithLimit } from './concurrency.js'
import { discoverSourceRepos, isSourceRepository } from './discover.js'
import { tryRunGit } from './git.js'
import { DEFAULT_BRANCH_PREFIX, validateBranchPrefix } from './naming.js'
import { assertIsolated, isInside } from './paths.js'
import { deliveryStateSummary } from './deploy.js'

import { isLinkedWorktree, listTaskWorktrees, readTaskMetadata, resolveTasksRoot, taskSessionsOf } from './shared.js'

export async function classifySourceRoot(sourceRoot, { signal, ...bounds } = {}) {
  const repositories = await discoverSourceRepos(sourceRoot, { signal, ...bounds })
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
 * A trailing separator is noise for path identity.
 *
 * The entry module's `cleanPath` would say the same, but importing it from here
 * would close a cycle back from the module that owns this one - the same reason
 * `scan-cache.js` carries its own.
 * @param value - the path a caller named.
 * @returns the key two spellings of one path agree on.
 */
const pathKey = (value) => {
  const text = String(value ?? '')
  return text.length > 1 ? text.replace(/[\\/]+$/, '') : text
}

/**
 * Classify several source roots as one question rather than as several.
 *
 * This is a batch of the same work, not a cache of it. Every path is walked now
 * and answered now: the callers that ask for a page of Workspaces want to know
 * what all of them hold this second, and what they cannot have is an answer from
 * the last time they looked - a user who has since made a repository would be
 * told it is not one. So nothing here is remembered, and the only thing that
 * changes is that N walks cost one round trip instead of N, and run beside each
 * other rather than one after another.
 *
 * Duplicates are dropped by identity rather than by spelling, so `C:\src` and
 * `C:\src\` are one walk - the same rule the scan applies. What the answer carries
 * is the path as the caller spelled it, because that is what the caller matches
 * its rows against; the cleaning is for deciding what to walk, not what to say.
 *
 * The order is the caller's, so the rows they asked about come back in the order
 * they listed them.
 *
 * A path that cannot be classified is left OUT of the answer rather than
 * reported as an empty one. Reporting it as empty would tell the caller a
 * directory that could not be read holds no repositories, which is a claim about
 * a read that never happened - and the caller needs to draw those two apart,
 * because "no repositories here" rules a Workspace out where "could not tell"
 * does not. Leaving it out is what tells them: an asked-for path missing from
 * the answer is the one that failed.
 * @param paths - the source roots to classify.
 * @param signal - an abort signal, when the caller has one.
 * @returns one classification per path that could be classified, in the order asked.
 */
export async function classifySourceRoots(paths, { signal, concurrency = 6, ...bounds } = {}) {
  const asked = []
  const seen = new Set()
  for (const raw of paths ?? []) {
    const path = String(raw ?? '').trim()
    if (path === '') continue
    const key = pathKey(path)
    if (seen.has(key)) continue
    seen.add(key)
    asked.push(path)
  }
  const classified = await mapWithLimit(asked, concurrency, async (path) => {
    try {
      // Every path asked about is classified, including one that sits inside
      // another - that Workspace needs its own answer, because `isSourceRoot` is
      // what decides whether a task space can be started from it. What it does not
      // need is its repositories discovered a second time inside the parent's
      // walk, so the parent's walk steps over it.
      const nested = asked.filter((other) => other !== path && isInside(path, other))
      return await classifySourceRoot(path, { signal, ...bounds, exclude: nested })
    } catch {
      // The same reasoning the scan follows: a directory that cannot be read is
      // not a reason to abandon the other twenty.
      return undefined
    }
  })
  return classified.filter((entry) => entry !== undefined)
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


export async function suggestTaskRoot(subprocess, sourceRoot, { tasksRoot, branchPrefix = DEFAULT_BRANCH_PREFIX, configuredRoot = '', ...bounds } = {}) {
  const requested = typeof tasksRoot === 'string' ? tasksRoot.trim() : ''
  const suggested = resolveTasksRoot(sourceRoot, requested, configuredRoot)
  assertIsolated(sourceRoot, suggested)
  // The same walk the classification and the create perform, with the same bounds:
  // this dialog lists what a create would take, and a preview of 94 repositories
  // beside a create that finds none is worse than either number alone.
  const repositories = await discoverSourceRepos(sourceRoot, bounds)
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
      // The record is read for every task, so a caller listing a container also
      // learns which session is on each task and what each one's deployment
      // recorded - two facts that otherwise cost a round trip per task. Both are
      // read from the same files the panel reads, so the two can never disagree.
      const recorded = await readTaskMetadata(taskPath)
      const sessions = taskSessionsOf(recorded)
      tasks.push({
        name: entry.name,
        project: project.name,
        path: taskPath,
        // A container that holds no record and no worktree is not a task this
        // plugin made; it is still listed (the dialog needs to see it to offer
        // recovery), and it simply answers with no sessions and no deployment.
        ...(sessions.length === 0 ? {} : { sessions }),
        delivery: await deliveryStateSummary(taskPath),
        repositories: await listTaskWorktrees(subprocess, taskPath),
      })
    }
  }
  tasks.sort((left, right) => left.project.localeCompare(right.project) || left.name.localeCompare(right.name))
  return { tasksRoot: root, tasks }
}



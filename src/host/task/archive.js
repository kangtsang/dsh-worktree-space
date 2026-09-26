/**
 * Task archiving
 *
 * Finishing a task: what merging would do, which files are the user's own, and the merge, removal, and filing that follow.
 */
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rmdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { discoverSourceRepos, isSourceRepository, resolveSourceRepos } from './discover.js'
import { gitSucceeded, parseWorktrees, runGit, tryRunGit } from './git.js'
import { branchNameFor, DEFAULT_BRANCH_PREFIX, validateTaskName } from './naming.js'
import { assertIsolated, recommendTasksRoot } from './paths.js'

import { breadcrumb } from './create.js'
import { BREADCRUMB, MERGE_TARGET_CANDIDATES, isLinkedWorktree } from './shared.js'

export async function resolveMergeTarget(subprocess, mainRepo, requested) {
  const explicit = typeof requested === 'string' ? requested.trim() : ''
  if (explicit !== '') {
    if (!(await gitSucceeded(subprocess, mainRepo, ['show-ref', '--verify', '--quiet', `refs/heads/${explicit}`]))) {
      throw new Error(`merge target '${explicit}' is not a local branch of '${basename(mainRepo)}'`)
    }
    return explicit
  }

  const remoteHead = await tryRunGit(subprocess, mainRepo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  if (remoteHead !== '') {
    const derived = remoteHead.replace(/^refs\/remotes\/[^/]+\//, '')
    if (await gitSucceeded(subprocess, mainRepo, ['show-ref', '--verify', '--quiet', `refs/heads/${derived}`])) {
      return derived
    }
  }

  for (const candidate of MERGE_TARGET_CANDIDATES) {
    if (await gitSucceeded(subprocess, mainRepo, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`])) {
      return candidate
    }
  }
  throw new Error(`cannot determine the merge target of '${basename(mainRepo)}' (tried origin/HEAD, main, master); name one explicitly`)
}


export async function planTask(subprocess, { task, tasksRoot } = {}) {
  if (typeof tasksRoot !== 'string' || tasksRoot.trim() === '') throw new Error('a tasks root is required')
  const taskPath = join(tasksRoot.trim(), validateTaskName(task))
  if (!existsSync(taskPath)) throw new Error(`no such task space: ${taskPath}`)

  const entries = await readdir(taskPath, { withFileTypes: true })
  const worktrees = []
  // What the container holds besides its worktrees. `finishTask` always clears
  // the breadcrumb this plugin wrote and keeps the rest unless `cleanStray` is
  // asked for, so this is exactly what that option would remove — minus the
  // breadcrumb, which is never a surprise.
  const strays = []
  for (const entry of entries) {
    const entryPath = join(taskPath, entry.name)
    if (entry.isDirectory() && await isLinkedWorktree(entryPath)) {
      worktrees.push(entryPath)
      continue
    }
    if (entry.name === BREADCRUMB) continue
    const kind = strayKind(entry.name, entry.isDirectory())
    strays.push({
      name: entry.name,
      directory: entry.isDirectory(),
      // Only the user's own directories are worth walking: nobody needs a
      // document count of `node_modules`.
      documents: kind !== 'content' ? 0 : entry.isDirectory() ? await countDocuments(entryPath) : (isDocument(entry.name) ? 1 : 0),
      kind,
    })
  }
  if (worktrees.length === 0) throw new Error(`no git worktrees found in ${taskPath}`)

  const repositories = []
  let mergeTarget
  let changedFiles = 0
  let commits = 0
  for (const worktreePath of worktrees) {
    const name = basename(worktreePath)
    const branch = await tryRunGit(subprocess, worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const status = await tryRunGit(subprocess, worktreePath, ['status', '--short', '--branch'])
    const lines = status === '' ? [] : status.split(/\r?\n/)
    const changed = lines.filter((line) => line !== '' && !line.startsWith('## ')).length
    const plan = { name, path: worktreePath, branch, changedFiles: changed, commits: 0 }

    const porcelain = await tryRunGit(subprocess, worktreePath, ['worktree', 'list', '--porcelain'])
    const mainRepo = parseWorktrees(porcelain).find((row) => row.isMain)?.path ?? ''
    if (mainRepo === '') plan.error = 'cannot locate the source repository'
    else {
      try {
        plan.target = await resolveMergeTarget(subprocess, mainRepo, undefined)
        const ahead = await tryRunGit(subprocess, worktreePath, ['rev-list', '--count', `${plan.target}..HEAD`])
        plan.commits = Number.parseInt(ahead, 10) || 0
        mergeTarget = mergeTarget ?? plan.target
      } catch (error) {
        plan.error = error.message
      }
    }

    changedFiles += plan.changedFiles
    commits += plan.commits
    repositories.push(plan)
  }

  return { task, path: taskPath, tasksRoot: tasksRoot.trim(), mergeTarget, changedFiles, commits, repositories, strays }
}


export const DOCUMENT_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc'])


const BUILD_DIRECTORIES = new Set([
  'node_modules', 'dist', 'build', 'out', 'output', 'target', 'bin', 'obj', 'coverage',
  '.cache', '.next', '.nuxt', '.turbo', '.parcel-cache', '__pycache__', '.pytest_cache',
  '.gradle', '.m2', '.venv', 'venv', 'vendor',
])


const EDITOR_DIRECTORIES = new Set(['.idea', '.vscode', '.vs'])


const EDITOR_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])


const BUILD_FILE_SUFFIXES = ['.o', '.obj', '.pyc', '.pyo', '.class', '.tsbuildinfo', '.tmp', '.orig', '.rej']

const EDITOR_FILE_SUFFIXES = ['.iml', '.swp', '.swo', '~']


function strayKind(name, directory) {
  if (directory) {
    if (BUILD_DIRECTORIES.has(name)) return 'build'
    if (EDITOR_DIRECTORIES.has(name)) return 'editor'
    return 'content'
  }
  if (EDITOR_FILES.has(name) || EDITOR_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))) return 'editor'
  if (BUILD_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))) return 'build'
  return 'content'
}


function isDocument(name) {
  const dot = name.lastIndexOf('.')
  return dot > 0 && DOCUMENT_EXTENSIONS.has(name.slice(dot).toLowerCase())
}


async function countDocuments(directory, { maxEntries = 200 } = {}) {
  let seen = 0
  let found = 0
  const queue = [directory]
  while (queue.length > 0 && seen < maxEntries) {
    const current = queue.shift()
    let children
    try {
      children = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      seen += 1
      if (seen > maxEntries) break
      if (child.isDirectory()) queue.push(join(current, child.name))
      else if (isDocument(child.name)) found += 1
    }
  }
  return found
}


export async function finishTask(subprocess, options) {
  const {
    task,
    tasksRoot,
    merge = false,
    target,
    deleteBranch = false,
    force = false,
    cleanStray = false,
    keep = [],
    documentsDirectory,
    discardDocuments = false,
  } = options

  if (deleteBranch && !merge) {
    throw new Error('deleting a branch requires merging it first')
  }
  if (typeof tasksRoot !== 'string' || tasksRoot.trim() === '') throw new Error('a tasks root is required')

  // Resolved and checked before anything is touched: when the documents are
  // archived the originals leave the container, which is then removed — so a
  // destination inside the container would be deleted moments after the copy.
  const destination = typeof documentsDirectory === 'string' ? documentsDirectory.trim() : ''
  if (destination !== '') assertIsolated(join(tasksRoot.trim(), validateTaskName(task)), destination)

  const taskPath = join(tasksRoot.trim(), validateTaskName(task))
  if (!existsSync(taskPath)) throw new Error(`no such task space: ${taskPath}`)

  const entries = await readdir(taskPath, { withFileTypes: true })
  const worktrees = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const worktreePath = join(taskPath, entry.name)
    if (await isLinkedWorktree(worktreePath)) worktrees.push(worktreePath)
  }
  if (worktrees.length === 0) throw new Error(`no git worktrees found in ${taskPath}`)

  const repositories = []
  const warnings = []
  let failed = false

  for (const worktreePath of worktrees) {
    const name = basename(worktreePath)
    const branch = await tryRunGit(subprocess, worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const porcelain = await tryRunGit(subprocess, worktreePath, ['worktree', 'list', '--porcelain'])
    // `git worktree list` always prints the main working tree first.
    const mainRepo = parseWorktrees(porcelain).find((row) => row.isMain)?.path ?? ''
    if (mainRepo === '') {
      repositories.push({ name, path: worktreePath, branch, merged: false, removed: false, branchDeleted: false, error: 'cannot locate the source repository' })
      failed = true
      continue
    }

    const outcome = { name, path: worktreePath, branch, merged: false, removed: false, branchDeleted: false }

    if (merge) {
      try {
        const mergeTarget = await resolveMergeTarget(subprocess, mainRepo, target)
        outcome.target = mergeTarget
        await runGit(subprocess, mainRepo, ['merge', '--no-ff', '--no-edit', branch])
        outcome.merged = true
      } catch (error) {
        // Leave the worktree and branch in place for manual handling.
        await gitSucceeded(subprocess, mainRepo, ['merge', '--abort'])
        outcome.error = `${error.message}; worktree and branch kept`
        repositories.push(outcome)
        failed = true
        continue
      }
    }

    const removeArgs = force ? ['worktree', 'remove', '--force', worktreePath] : ['worktree', 'remove', worktreePath]
    if (!(await gitSucceeded(subprocess, mainRepo, removeArgs))) {
      outcome.error = 'failed to remove the worktree (uncommitted changes? force it deliberately)'
      repositories.push(outcome)
      failed = true
      continue
    }
    outcome.removed = true

    if (deleteBranch) {
      const deleted = await gitSucceeded(
        subprocess,
        mainRepo,
        force ? ['branch', '-D', branch] : ['branch', '-d', branch],
      )
      outcome.branchDeleted = deleted
      if (!deleted) warnings.push(`branch '${branch}' was not deleted in '${name}'`)
    }
    repositories.push(outcome)
  }

  // The container's own breadcrumb is always cleared; other leftovers are kept
  // unless the caller asked for them to go, minus whatever it named to keep.
  await rm(join(taskPath, BREADCRUMB), { force: true })

  const leftovers = await readdir(taskPath, { withFileTypes: true })
  const strays = []
  const content = []
  for (const entry of leftovers) {
    if (entry.isDirectory() && await isLinkedWorktree(join(taskPath, entry.name))) continue
    strays.push(entry.name)
    if (strayKind(entry.name, entry.isDirectory()) === 'content') content.push(entry.name)
  }

  // The user's own content always leaves the container: filed into the documents
  // directory when one was named, discarded outright when it was not but the
  // caller said to discard. Build output and editor state are neither, and stay
  // unless `cleanStray` asks for them.
  const removedStrays = []
  const archivedStrays = []
  const keptByFailure = []
  for (const name of content) {
    if (keep.includes(name)) continue
    if (destination === '') {
      if (!discardDocuments) continue
    } else {
      try {
        await mkdir(destination, { recursive: true })
        await cp(join(taskPath, name), join(destination, name), { recursive: true, force: false, errorOnExist: true })
      } catch (error) {
        // Kept, not cleaned: a copy that failed must not cost the original, so
        // this is excluded from the clean-up below and reported as still there.
        warnings.push(`could not archive '${name}' to '${destination}': ${error.message}`)
        keptByFailure.push(name)
        continue
      }
      archivedStrays.push(name)
    }
    await rm(join(taskPath, name), { recursive: true, force: true })
    if (destination === '') removedStrays.push(name)
  }

  if (cleanStray) {
    for (const name of strays) {
      if (keep.includes(name) || keptByFailure.includes(name)) continue
      if (archivedStrays.includes(name) || removedStrays.includes(name)) continue
      await rm(join(taskPath, name), { recursive: true, force: true })
      removedStrays.push(name)
    }
  }

  const remaining = await readdir(taskPath)
  let containerRemoved = false
  if (remaining.length === 0) {
    containerRemoved = true
    try {
      await rmdir(taskPath)
    } catch {
      containerRemoved = false
    }
  }

  return {
    task,
    path: taskPath,
    mergeTarget: repositories.find((entry) => entry.target)?.target,
    repositories,
    strays: strays.filter((name) => !removedStrays.includes(name) && !archivedStrays.includes(name)),
    archivedStrays,
    removedStrays,
    containerRemoved,
    failed,
    warnings,
  }
}



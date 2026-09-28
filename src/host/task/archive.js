/**
 * Task archiving
 *
 * Finishing a task: what merging would do, which files are the user's own, and the merge, removal, and filing that follow.
 */
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rmdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { discoverSourceRepos, isSourceRepository, resolveSourceRepos } from './discover.js'
import { gitSucceeded, parseWorktrees, runGit, tryRunGit } from './git.js'
import { branchNameFor, DEFAULT_BRANCH_PREFIX, validateTaskName } from './naming.js'
import { assertIsolated, recommendTasksRoot } from './paths.js'

import { TASK_OWNED_FILES, isLinkedWorktree } from './shared.js'

/**
 * The branch a finished task merges into.
 *
 * An explicitly named target wins, as long as it is a local branch: the merge
 * mechanism can honour one that is not checked out anywhere, by checking it out in
 * a worktree of its own. Otherwise the target is the branch the source repository
 * has checked out — the branch a plain `git merge` there would write, and in the
 * ordinary case the branch the task was started from. Supporting documents: the
 * dialog offers exactly the candidates {@link mergeCandidates} returns, so what it
 * shows and what this resolves are the same set.
 * @param subprocess - the profile's subprocess service.
 * @param mainRepo - the source repository.
 * @param requested - an explicitly requested target, possibly empty.
 * @param taskBranch - the branch being merged, which can never be the target.
 * @returns the local branch name to merge into.
 * @throws Error when no branch can be determined, or the request names another.
 */
export async function resolveMergeTarget(subprocess, mainRepo, requested, taskBranch) {
  const name = basename(mainRepo)
  const checkedOut = await tryRunGit(subprocess, mainRepo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  // Git answers `HEAD` for a detached checkout, and nothing at all in a repository
  // with no commits yet: neither names a branch a merge could land on by itself.
  const onBranch = checkedOut !== '' && checkedOut !== 'HEAD'

  const explicit = typeof requested === 'string' ? requested.trim() : ''
  if (explicit !== '') {
    if (explicit === taskBranch) {
      throw new Error(`merge target '${explicit}' is the branch being merged, so it cannot be the branch merged into`)
    }
    if (!(await gitSucceeded(subprocess, mainRepo, ['show-ref', '--verify', '--quiet', `refs/heads/${explicit}`]))) {
      throw new Error(`merge target '${explicit}' is not a local branch of '${name}'`)
    }
    return explicit
  }

  if (!onBranch) {
    throw new Error(`'${name}' has no branch checked out; name the branch to merge into`)
  }
  return checkedOut
}

/**
 * The branches a repository's task branch could be merged into.
 *
 * Every local branch, minus the task branch itself and minus the ones a worktree
 * already holds: a branch can only be checked out once, so those could only be
 * merged in by moving a checkout someone else is using. The branch the source
 * repository is on comes first, because it is the default and the one that merges
 * without the detour below.
 * @param subprocess - the profile's subprocess service.
 * @param mainRepo - the source repository.
 * @param listed - its worktrees, as `git worktree list --porcelain` reported them.
 * @param taskBranch - the branch being merged, which is never a candidate.
 * @param checkedOut - the branch the source repository is on, put first.
 * @returns the candidate branch names; empty when git cannot list them.
 */
async function mergeCandidates(subprocess, mainRepo, listed, taskBranch, checkedOut) {
  const output = await tryRunGit(subprocess, mainRepo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  const taken = new Set(listed.filter((row) => !row.isMain).map((row) => row.branch).filter(Boolean))
  if (taskBranch) taken.add(taskBranch)
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((branch) => branch !== '' && !taken.has(branch))
    .sort((left, right) => (left === checkedOut ? -1 : right === checkedOut ? 1 : left.localeCompare(right)))
}

/**
 * Merge a task branch into a target branch, without moving the source checkout.
 *
 * A merge lands on whatever branch is checked out, so the one case that needs no
 * ceremony is a target the source repository is already on: that is a plain
 * `git merge` where the repository stands. Any other target is merged in a
 * temporary linked worktree — a checkout of that branch that exists only for this
 * merge and is discarded afterwards, which is what keeps the source repository's
 * own checkout where its user left it and what leaves a conflicting target branch
 * exactly as it was.
 * @param subprocess - the profile's subprocess service.
 * @param mainRepo - the source repository.
 * @param branch - the task branch to merge.
 * @param target - the local branch to merge it into.
 * @throws Error from git, with the repository left as it was found.
 */
async function mergeIntoBranch(subprocess, mainRepo, branch, target) {
  const checkedOut = await tryRunGit(subprocess, mainRepo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (target === checkedOut) {
    await runGit(subprocess, mainRepo, ['merge', '--no-ff', '--no-edit', branch])
    return
  }

  // The holder is this process's own temporary directory, so the checkout cannot
  // land inside the source tree, and the worktree path below it does not exist yet
  // - which is what `git worktree add` requires.
  const holder = await mkdtemp(join(tmpdir(), 'dsh-worktree-space-merge-'))
  const worktree = join(holder, 'worktree')
  const drop = async ({ aborted }) => {
    // Best effort by design: a merge that succeeded must not be reported as failed
    // because its scratch checkout would not go away. A registration git will not
    // remove is pruned instead, and the directory is removed either way.
    if (aborted) await gitSucceeded(subprocess, worktree, ['merge', '--abort'])
    if (!(await gitSucceeded(subprocess, mainRepo, ['worktree', 'remove', '--force', worktree]))) {
      await gitSucceeded(subprocess, mainRepo, ['worktree', 'prune'])
    }
    await rm(holder, { recursive: true, force: true })
  }

  try {
    // A branch another worktree holds is refused here, by git, naming that path:
    // that is the error worth reporting rather than one of our own.
    await runGit(subprocess, mainRepo, ['worktree', 'add', worktree, target])
    await runGit(subprocess, worktree, ['merge', '--no-ff', '--no-edit', branch])
  } catch (error) {
    // The merge commit is what moves the target branch, and it was never made, so
    // aborting and dropping the checkout leaves the branch untouched.
    await drop({ aborted: true })
    throw error
  }
  await drop({ aborted: false })
}


/**
 * Report what archiving a task would do, without doing any of it.
 *
 * Each repository reports the branch its worktree is on, the branch that branch
 * would merge into, how many commits that merge would bring, and how many files
 * are uncommitted — which is what the archive dialog shows before the user
 * chooses. `targets` names a branch per repository, which is how the dialog
 * previews a choice the user just made: the target and the commit count it gets
 * back are the ones {@link finishTask} would act on.
 * @param subprocess - the profile's subprocess service.
 * @param options - `task`, `tasksRoot`, and the optional per-repository `targets`.
 * @returns the per-repository plan and its totals.
 * @throws Error when the task directory or its worktrees cannot be found.
 */
export async function planTask(subprocess, { task, tasksRoot, targets } = {}) {
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
    if (TASK_OWNED_FILES.includes(entry.name)) continue
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
    const plan = { name, path: worktreePath, branch, changedFiles: changed, commits: 0, branches: [] }

    const porcelain = await tryRunGit(subprocess, worktreePath, ['worktree', 'list', '--porcelain'])
    const listed = parseWorktrees(porcelain)
    const mainRepo = listed.find((row) => row.isMain)?.path ?? ''
    if (mainRepo === '') plan.error = 'cannot locate the source repository'
    else {
      const checkedOut = await tryRunGit(subprocess, mainRepo, ['rev-parse', '--abbrev-ref', 'HEAD'])
      if (checkedOut !== '' && checkedOut !== 'HEAD') plan.checkedOut = checkedOut
      // Offered even when no target resolves on its own: a repository sitting on a
      // detached HEAD has no default, but naming one of these still merges.
      plan.branches = await mergeCandidates(subprocess, mainRepo, listed, branch, plan.checkedOut)
      try {
        plan.target = await resolveMergeTarget(subprocess, mainRepo, targets?.[name], branch)
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
    targets,
    deleteBranch = false,
    force = false,
    cleanStray = false,
    keep = [],
    documentsDirectory,
    discardDocuments = false,
  } = options

  // Deleting a branch that was merged is routine; deleting one that was not throws
  // its commits away, so it has to be asked for twice - with `deleteBranch` and with
  // `force`, which is also what makes git delete it without complaint.
  if (deleteBranch && !merge && !force) {
    throw new Error('deleting a branch that was never merged requires force')
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
        // A branch named for this repository wins; `target` names one for all of
        // them, which is how the tool asks for a single branch across a task.
        const mergeTarget = await resolveMergeTarget(subprocess, mainRepo, targets?.[name] ?? target, branch)
        outcome.target = mergeTarget
        await mergeIntoBranch(subprocess, mainRepo, branch, mergeTarget)
        outcome.merged = true
      } catch (error) {
        // Leave the worktree and branch in place for manual handling. `error` stays
        // git's own words: the page explains the conflict in the user's language and
        // shows this behind a disclosure, and the answer's `conflict` flag plus
        // `removed: false` tell a caller the worktree and branch are still there.
        outcome.conflict = true
        await gitSucceeded(subprocess, mainRepo, ['merge', '--abort'])
        outcome.error = error.message
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

  // The files this plugin wrote into the container - the JSON record, the note
  // rendered from it, and the note older containers still carry - are always
  // cleared; other leftovers are kept unless the caller asked for them to go,
  // minus whatever it named to keep. Both metadata files go: the JSON describes
  // a task space that is being removed, and the Markdown is generated from it.
  for (const name of TASK_OWNED_FILES) await rm(join(taskPath, name), { force: true })

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



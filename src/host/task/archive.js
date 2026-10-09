/**
 * Task archiving
 *
 * Finishing a task: what merging would do, which files are the user's own, and the merge, removal, and filing that follow.
 */
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, open, readdir, rename, rmdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { auditEnter, recordError, recordEvent, recordWarning } from './audit-log.js'
import { coded, warned } from './codes.js'
import { assertDeliveryGate, destroyDeployment } from './deploy.js'
import { applyStraysPolicy, deliveryPolicyOf } from './delivery.js'
import { gitSucceeded, parseWorktrees, runGit, tryRunGit } from './git.js'
import { validateProjectName } from './naming.js'
import { assertIsolated, refuseDelete, samePathLocation } from './paths.js'

import { TASK_METADATA, TASK_OWNED_FILES, isLinkedWorktree, readTaskMetadata, taskSpacePath } from './shared.js'

/**
 * Whether a merge is waiting to be concluded in a checkout.
 *
 * `MERGE_HEAD` exists exactly while a merge has been started and not committed, so
 * this is what separates a conflict - which leaves work for someone - from every
 * other reason a `git merge` fails, which leaves none.
 * @param subprocess - the profile's subprocess service.
 * @param site - the checkout the merge ran in.
 * @returns true while the merge is unresolved.
 */
async function mergeInProgress(subprocess, site) {
  return gitSucceeded(subprocess, site, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
}

/**
 * The files a merge could not reconcile.
 * @param subprocess - the profile's subprocess service.
 * @param site - the checkout the merge is standing in.
 * @returns their paths, relative to that checkout.
 */
async function conflictedFiles(subprocess, site) {
  const output = await tryRunGit(subprocess, site, ['diff', '--name-only', '--diff-filter=U'])
  return output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
}

/**
 * How many bytes of a changed file are read looking for conflict markers.
 *
 * Markers sit in the lines somebody edited by hand, and a file past this is a
 * payload - a bundle, a lock file, a dump - rather than a resolution in progress.
 * The window bounds what is held in memory, not which files are asked: what it
 * decides is which of two sentences describes the merge, and both of them stop the
 * finish the same way, so a file too large to look at whole costs the reader no more
 * than one it was readable to find markers in.
 */
const MARKER_SCAN_MAX_BYTES = 1024 * 1024

/**
 * Read the head of a file, refusing to let its size decide how much is held.
 *
 * `readFile` sizes its buffer from the file and there is no way to bound that, so
 * the read is opened and asked for a fixed window instead - the pattern
 * `readBounded` in skill.js already uses, for the same reason. A file that does not
 * fill the window is read whole; one that overflows it is read as far as the window
 * goes, because a half-read file here still answers "no markers in this part", and
 * refusing it outright would answer that for a file nothing looked at.
 * @param path - the file to read.
 * @returns the first {@link MARKER_SCAN_MAX_BYTES} bytes of the file.
 */
async function readHead(path) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(MARKER_SCAN_MAX_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * The paths an unfinished merge still has conflict markers in.
 *
 * Resolving a conflict means editing files under the worktree, and this is what says
 * whether that is done: every path the merge has changed is read back - staged or not,
 * since a resolution may have been staged already - and a line beginning `<<<<<<<`,
 * `=======` or `>>>>>>>` marks the merge as unfinished. Nothing else about the file's
 * contents is judged here, and each read stops at {@link MARKER_SCAN_MAX_BYTES}.
 * @param subprocess - the profile's subprocess service.
 * @param site - the checkout the merge is standing in.
 * @returns the paths that still carry markers, relative to that checkout.
 */
async function conflictMarkers(subprocess, site) {
  const changed = await tryRunGit(subprocess, site, ['diff', '--name-only', 'HEAD'])
  const listed = [...new Set([...changed.split(/\r?\n/), ...await conflictedFiles(subprocess, site)])]
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const marked = []
  for (const file of listed) {
    let text = ''
    try {
      text = await readHead(join(site, file))
    } catch {
      // A path git lists that cannot be read - a submodule, a directory - carries no
      // markers this could find, and is not a reason to refuse the finish.
      continue
    }
    if (/^(<{7}|={7}|>{7})(\s|$)/m.test(text)) marked.push(file)
  }
  return marked
}

/**
 * How many paths a worktree has changed but not committed.
 * @param subprocess - the profile's subprocess service.
 * @param worktreePath - the worktree to read.
 * @returns the number of reported paths.
 */
async function uncommittedCount(subprocess, worktreePath) {
  const status = await tryRunGit(subprocess, worktreePath, ['status', '--short'])
  return status === '' ? 0 : status.split(/\r?\n/).filter((line) => line.trim() !== '').length
}

/**
 * One record of a `status --porcelain=v1 -z` stream: the two status columns, then
 * the path. Porcelain v1 always writes both columns and a blank between them and the
 * path, so anything that does not have that shape is a record `runGit` trimmed.
 */
const STATUS_RECORD = /^([ MADRCU?!]{2}) ([\s\S]+)$/

/**
 * The tracked paths a checkout has changed but not committed.
 *
 * `git status --porcelain=v1 -z` is read and its untracked lines are dropped, because
 * those are the one kind of dirt a merge does not mind: git writes a tree of tracked
 * files and leaves `??` alone. A build output that was never going to be in the way
 * is not one of the paths a refusal should name.
 *
 * Staged and unstaged both count, and both are reported: `A` against the first
 * column is staged, `M` against the second is not, and a merge refuses over either.
 *
 * `-z` is what makes the paths usable at all. The line-oriented report is not a list
 * of paths: a rename reads `R  old -> new`, which is neither of the paths - the file
 * is at `new`, and `old -> new` matches nothing a merge writes - and a non-ASCII
 * path is C-quoted, so `文.txt` arrives as `"\346\226\207.txt"` and is compared
 * against itself for as long as the pre-check runs. With `-z` git writes each path
 * verbatim and separates records with NUL, so a rename names its two paths as two
 * records and nothing in a path can end the record early.
 *
 * The columns are not read at a fixed offset, because `runGit` trims what it returns
 * and the first status record of a dirty checkout begins with the blank in ` M path`
 * - that leading blank is the unstaged column, and trimming the stream eats it. It is
 * put back on whichever record does not have two columns, and that can only ever be
 * the first one: trimming reaches no further than the front of the stream.
 * @param subprocess - the profile's subprocess service.
 * @param site - the checkout to read.
 * @returns the paths, which is empty for a clean checkout.
 */
async function dirtyPaths(subprocess, site) {
  const status = await tryRunGit(subprocess, site, ['status', '--porcelain=v1', '-z'])
  if (status === '') return []
  const records = status.split('\0')
  const dirty = []
  for (let index = 0; index < records.length; index += 1) {
    const parsed = STATUS_RECORD.exec(records[index]) ?? STATUS_RECORD.exec(` ${records[index]}`)
    if (parsed === null) continue
    const [, columns, path] = parsed
    // `??` is the only two-column marker that means "not tracked", and it is asked of
    // the two columns rather than of a prefix of the raw record, so the answer does
    // not depend on which of them the trim took.
    if (columns === '??') continue
    // A rename or a copy is two records: the path the working tree has, which is the
    // one a merge can be in the way of, and the one it came from, which it does not
    // have any more. Both are read off; only the first is a path on disk.
    if (columns.includes('R') || columns.includes('C')) index += 1
    dirty.push(path)
  }
  return dirty
}

/**
 * The dirty paths a merge of `branch` into `target` would actually overwrite.
 *
 * Git refuses such a merge only when the checkout holds changes in a file the merge
 * writes. Refusing on every dirty path instead blocks merges git would have made
 * perfectly well: a repository carrying unrelated work in progress cannot finish a
 * task that touches none of it, and the reader is told to commit or stash work that
 * has nothing to do with the merge.
 *
 * What the merge writes is the paths the task branch changed since the two diverged:
 * those are the ones the merge brings across into the target's working tree. A path
 * only the target changed is not written - the merge result for it is what is
 * already checked out - so uncommitted work in one of those rides straight through,
 * which is exactly what git does with it.
 *
 * A repository with no merge base between the two - unrelated histories - reports
 * nothing here, and the merge that follows is git's to accept or refuse.
 * @param subprocess - the profile's subprocess service.
 * @param site - the source repository, where the merge would run.
 * @param branch - the task branch being merged.
 * @param target - the local branch merged into.
 * @returns the paths that are both dirty and written, empty when none are.
 */
async function dirtyPathsInTheWay(subprocess, site, branch, target) {
  const dirty = await dirtyPaths(subprocess, site)
  if (dirty.length === 0) return []
  const base = await tryRunGit(subprocess, site, ['merge-base', target, branch])
  if (base === '') return []
  const written = new Set(
    (await tryRunGit(subprocess, site, ['diff', '--name-only', base, branch]))
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter((path) => path !== ''),
  )
  return dirty.filter((path) => written.has(path))
}

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
      throw coded('E4008', `merge target '${explicit}' is the branch being merged, so it cannot be the branch merged into`)
    }
    if (!(await gitSucceeded(subprocess, mainRepo, ['show-ref', '--verify', '--quiet', `refs/heads/${explicit}`]))) {
      throw coded('E4008', `merge target '${explicit}' is not a local branch of '${name}'`)
    }
    return explicit
  }

  if (!onBranch) {
    throw coded('E4008', `'${name}' has no branch checked out; name the branch to merge into`)
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
 * exactly as it was. A conflict here is aborted rather than kept: this merge has
 * already been rehearsed in the task's own worktree, so anything left standing here
 * is a race with a commit someone else made, not the conflict a caller can resolve.
 * @param subprocess - the profile's subprocess service.
 * @param mainRepo - the source repository.
 * @param branch - the task branch to merge.
 * @param target - the local branch to merge it into.
 * @throws Error from git, with the repository left as it was found.
 */
async function mergeIntoBranch(subprocess, mainRepo, branch, target) {
  const checkedOut = await tryRunGit(subprocess, mainRepo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (target === checkedOut) {
    // Git refuses this merge when the checkout holds changes the merge would
    // overwrite, and refuses it in words that name a conflict nobody created. Left
    // to itself that refusal reaches the caller as a conflict: a file to resolve, a
    // merge to conclude, an agent to send - none of which applies, because what is
    // standing in the way is uncommitted work in the repository the user works in.
    // So it is caught here, where the distinction is still visible, and named for
    // what it is.
    //
    // Only the files the merge writes count. Git would carry unrelated work in the
    // checkout through untouched, and refusing there too would stop a task that had
    // nothing to do with that work, on the reader's word to commit or stash it.
    //
    // Only this branch needs it. A target the source repository is not on is merged
    // in a temporary worktree below, which never touches these files at all.
    const pending = await dirtyPathsInTheWay(subprocess, mainRepo, branch, target)
    if (pending.length > 0) {
      // English here, as every other message this host produces: it reaches the
      // page as-is behind a disclosure, and the page is not always in English. The
      // code is what a caller should branch on; the sentence is for whoever is
      // reading it.
      throw coded(
        'E5004',
        `the checkout at ${mainRepo} has uncommitted work that this merge would overwrite: ${pending.join(', ')}. Commit or stash it, then finish the task.`,
      )
    }
    try {
      await runGit(subprocess, mainRepo, ['merge', '--no-ff', '--no-edit', branch])
    } catch (error) {
      // The merge commit is what moves the branch, and it was never made, so
      // aborting leaves the branch exactly as the merge found it.
      await gitSucceeded(subprocess, mainRepo, ['merge', '--abort'])
      throw error
    }
    return
  }

  // The holder is this process's own temporary directory, so the checkout cannot
  // land inside the source tree.
  const holder = await mkdtemp(join(tmpdir(), 'dsh-worktree-space-merge-'))
  const worktree = join(holder, 'worktree')
  const drop = async ({ aborted }) => {
    // Best effort by design: a merge that succeeded must not be reported as failed
    // because the checkout it ran in would not go away. A registration git will not
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
 * Record what a plan or a finish could not do.
 *
 * Both carry on past a repository that stopped and report it in that
 * repository's own `error` field, so none of it reaches the caller's failure
 * path and a single record around the call would never see it. The warnings are
 * the softer half of the same report: a branch that was not deleted, a copy
 * that failed and therefore kept the original.
 * @param repositories - the per-repository rows the operation returned.
 * @param warnings - the operation's own warnings.
 * @param phase - `plan` or `done`, so a reader can group them.
 */
async function auditOutcome(repositories, warnings, phase) {
  for (const entry of repositories) {
    if (typeof entry?.error !== 'string' || entry.error === '') continue
    await recordError(entry.error, {
      phase,
      repository: entry.name ?? '',
      worktree: entry.path ?? '',
      mainRepo: entry.mainRepo ?? '',
      branch: entry.branch ?? '',
      // E5001 is the case with a way forward that is not "try again" - a merge
      // has to be settled first - and E5003 is a plain failure to retry. They
      // read alike in the message, which is why they are two codes.
      code: entry.conflict === true ? 'E5001' : 'E5003',
      msg: entry.conflict === true
        ? `Finishing ${entry.name ?? 'this repository'} stopped on unmerged work, so nothing of that worktree was removed. The conflict has to be settled, or the branch deleted by hand, before the task space can be finished.`
        : `Finishing ${entry.name ?? 'this repository'} failed, so that worktree and its branch are still on disk. The rest of the task space went as planned; this one needs a second attempt.`,
      ...(entry.conflict === true ? { conflict: true } : {}),
      ...(typeof entry.mergeSite === 'string' && entry.mergeSite !== '' ? { mergeSite: entry.mergeSite } : {}),
      ...(Array.isArray(entry.conflictedFiles) && entry.conflictedFiles.length > 0 ? { conflictedFiles: entry.conflictedFiles } : {}),
    })
  }
  for (const warning of warnings) await recordWarning(warning, { phase })
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
 *
 * A repository git would not answer about carries no `commits` at all rather than a
 * zero: its `error` says why, and a caller reading that number can tell it was not
 * counted from one that was counted as empty.
 * @param subprocess - the profile's subprocess service.
 * @param options - `task`, `project`, `tasksRoot`, and the optional per-repository `targets`.
 * @returns the per-repository plan and its totals.
 * @throws Error when the task directory or its worktrees cannot be found.
 */
export async function planTask(subprocess, { task, project, tasksRoot, targets } = {}) {
  if (typeof tasksRoot !== 'string' || tasksRoot.trim() === '') throw coded('E1004', 'a tasks root is required')
  const projectName = validateProjectName(project)
  const taskPath = taskSpacePath(tasksRoot, projectName, task)
  if (!existsSync(taskPath)) throw coded('E2003', `no such task space: ${taskPath}`, { path: taskPath })
  auditEnter({ task, project: projectName, tasksRoot })

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
  if (worktrees.length === 0) throw coded('E2004', `no git worktrees found in ${taskPath}`, { path: taskPath, reason: 'none' })

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
    const plan = { name, path: worktreePath, mainRepo: '', branch, changedFiles: changed, branches: [] }

    const porcelain = await tryRunGit(subprocess, worktreePath, ['worktree', 'list', '--porcelain'])
    const listed = parseWorktrees(porcelain)
    const mainRepo = listed.find((row) => row.isMain)?.path ?? ''
    plan.mainRepo = mainRepo
    if (mainRepo === '') plan.error = 'cannot locate the source repository'
    else {
      const checkedOut = await tryRunGit(subprocess, mainRepo, ['rev-parse', '--abbrev-ref', 'HEAD'])
      if (checkedOut !== '' && checkedOut !== 'HEAD') plan.checkedOut = checkedOut
      // Offered even when no target resolves on its own: a repository sitting on a
      // detached HEAD has no default, but naming one of these still merges.
      plan.branches = await mergeCandidates(subprocess, mainRepo, listed, branch, plan.checkedOut)
      try {
        plan.target = await resolveMergeTarget(subprocess, mainRepo, targets?.[name], branch)
        // Left out rather than claimed as zero when git will not answer the count:
        // "no commits" is a fact about the branch, and a repository that could not be
        // asked is not one holding none. This is the rule the status endpoint follows
        // for the same number, and the two answers sit side by side on one page.
        const ahead = await tryRunGit(subprocess, worktreePath, ['rev-list', '--count', `${plan.target}..HEAD`])
        const counted = Number.parseInt(ahead, 10)
        if (Number.isFinite(counted)) plan.commits = counted
        mergeTarget = mergeTarget ?? plan.target
      } catch (error) {
        plan.error = error.message
      }
    }

    changedFiles += plan.changedFiles
    // A total is a sum, so a repository that could not be counted is left out of it
    // rather than counted as nothing - and the top level keeps its number, because
    // the dialog prints it as the headline of what this would bring.
    commits += plan.commits ?? 0
    repositories.push(plan)
  }

  await auditOutcome(repositories, [], 'plan')
  return { task, project: projectName, path: taskPath, tasksRoot: tasksRoot.trim(), mergeTarget, changedFiles, commits, repositories, strays }
}


export const DOCUMENT_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc'])

/** How many links a warning names before it says how many more there are. */
const LINK_NAMES_SHOWN = 3


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

/**
 * Whether this process is refused the right to create a symbolic link.
 *
 * Windows needs `SeCreateSymbolicLinkPrivilege` for that: Developer Mode grants it to
 * an ordinary user, an ordinary installation does not. The answer decides whether a
 * stray holding a link can be filed at all, because `fs.cp` recreates links rather
 * than copying what they point at - on a machine that refuses, the copy stops part-way
 * with an `EPERM` about the link and leaves half an archive behind. Probed rather than
 * assumed, and asked once: nothing about the process's token changes while it runs.
 * @returns whether a link could not be created here.
 */
function symlinksRefused() {
  linkProbe ??= (async () => {
    const probe = await mkdtemp(join(tmpdir(), 'dsh-worktree-link-'))
    try {
      await symlink(join(probe, 'target'), join(probe, 'link'))
      return false
    } catch {
      return true
    } finally {
      await rm(probe, { recursive: true, force: true }).catch(() => {})
    }
  })()
  return linkProbe
}

/** The one probe {@link symlinksRefused} keeps, so the question is asked once. */
let linkProbe

/**
 * Remove what an archive has just copied, leaving every link where it stands.
 *
 * A link inside a stray is the one thing this machine may refuse to recreate, and it is a
 * name for somewhere else rather than content of its own - so it is not this side's to
 * delete, and neither is a directory that holds one. Everything else in the stray was
 * filed into the archive and comes out of the task space here, bottom-up, so a directory
 * the removal left empty goes with it and one still holding a link stays.
 * @param directory - the stray, after what could be filed was copied.
 * @returns whether anything was kept, so a caller can tell a full from a partial removal.
 */
async function removeCopiedLeavingLinks(directory) {
  let kept = false
  let children
  try {
    children = await readdir(directory, { withFileTypes: true })
  } catch {
    // Unreadable is not a reason to delete anything: it stays, and says so by being kept.
    return true
  }
  for (const child of children) {
    const path = join(directory, child.name)
    if (child.isSymbolicLink()) { kept = true; continue }
    if (child.isDirectory()) {
      if (await removeCopiedLeavingLinks(path)) kept = true
      else await rmdir(path).catch(() => {})
      continue
    }
    await rm(path, { force: true }).catch(() => {})
  }
  return kept
}

/**
 * Every link below a directory, as paths relative to it.
 *
 * The listing is what the reader is given when a stray cannot be filed whole, so it names
 * entries the way the task space shows them rather than as absolute paths. Links are not
 * descended into: a link is a name for somewhere else, and walking one would both leave
 * the directory being filed and, where links point back into their own tree -
 * `node_modules/.pnpm` is full of them - never come back. A junction is a link here as
 * much as a symbolic link is: `readdir` reports one as a directory, and
 * `Dirent.isSymbolicLink` is what tells the two apart.
 * @param directory - the stray to look through.
 * @param options - `maxEntries` bounds the walk.
 * @returns the relative paths, in the order they were found.
 */
async function findLinks(directory, { maxEntries = 2000 } = {}) {
  const found = []
  const queue = [directory]
  let seen = 0
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
      const path = join(current, child.name)
      if (child.isSymbolicLink()) {
        found.push(relative(directory, path))
        continue
      }
      if (child.isDirectory()) queue.push(path)
    }
  }
  return found
}

/**
 * Whether git still has this worktree registered.
 *
 * The question a failed removal turns on, and the reason it is asked of git rather
 * than of the directory: `git worktree remove` unregisters a worktree *before* it
 * deletes the directory, so a delete that failed leaves a checkout whose `.git` file
 * is already gone. Asking git is the same answer in one call and does not assume that
 * the file and the registration cannot come apart - this is exactly the case where
 * they do.
 * @param subprocess - the profile's subprocess service.
 * @param mainRepo - the source repository the worktree belongs to.
 * @param worktreePath - the worktree's directory.
 * @returns whether git still knows about it.
 */
async function worktreeRegistered(subprocess, mainRepo, worktreePath) {
  const porcelain = await tryRunGit(subprocess, mainRepo, ['worktree', 'list', '--porcelain'])
  return parseWorktrees(porcelain).some((row) => samePathLocation(row.path, worktreePath))
}

/** What a directory is renamed to while it is being asked whether it can be removed. */
const REMOVAL_PROBE_SUFFIX = '.dsh-removal-probe'

/**
 * Whether this directory can be removed right now, asked without removing anything.
 *
 * The question is answered by renaming the directory and renaming it straight back,
 * which is the cheapest operation that Windows refuses for the same reason it refuses
 * a delete: a directory that is some process's working directory, or that holds a file
 * another process opened without sharing delete, cannot be renamed either. Measured
 * against a file held open: the rename fails with `EPERM` and so does the delete; once
 * the handle is released both succeed. On Linux an open file blocks neither, so a
 * rename there means exactly what it says - the delete would work too.
 *
 * This is a probe and nothing else: it writes no file, deletes nothing, and puts the
 * name back before it answers. The one state it can leave behind is a directory still
 * under the probe name, which it reports instead of hiding - that is a directory the
 * caller has to rename back by hand, and saying so is the only honest answer.
 * @param directory - the directory that would be removed.
 * @returns an empty string when it can be removed, else why it cannot.
 */
async function removableNow(directory) {
  const probe = `${directory}${REMOVAL_PROBE_SUFFIX}`
  try {
    await rename(directory, probe)
  } catch (error) {
    return `${error?.code ?? 'unremovable'}: ${error?.message ?? error}`
  }
  try {
    await rename(probe, directory)
  } catch (error) {
    return `the check renamed it and could not put it back: it is now at ${probe} (${error?.message ?? error})`
  }
  return ''
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


/**
 * Finish a task: merge each worktree's branch as asked, remove the worktrees, and file
 * what the task left behind.
 *
 * Every commit a finish needs is an agent's, made from a session opened in the task
 * space before this runs: work nobody committed is what a merge cannot carry and what a
 * worktree removal refuses, and a message written by whoever read the changes says more
 * than one this side would invent. So a worktree still holding uncommitted work stops
 * the finish and says so - the caller sends an agent, then asks again. Where a merge
 * stops is fixed too. Before a branch is merged into its target, the target is merged
 * into it inside the task's own worktree - a rehearsal that either proves the real merge
 * clean, in which case it is undone and the merge proceeds, or leaves the conflict
 * standing there, with `mergeSite` and `conflictedFiles` on that repository for the agent
 * to resolve and commit. A merge still standing when this runs is therefore unfinished
 * work: it is reported in the state it is in, never aborted, and no side is ever picked.
 * Merging the resolved branch into the source repository is the step this side owns, and
 * it runs outside any session, where git's own directory is in reach.
 *
 * A worktree that is on no branch stops the merge before any of that, because a merge
 * needs a name and git answers a detached checkout's name - the literal `HEAD` - by
 * resolving it against the checkout doing the merging. Nothing is merged, nothing is
 * removed and no branch is deleted: the answer carries `merged: false`, `removed:
 * false` and the reason, so no caller can read it as a finish that went through.
 * @param subprocess - the profile's subprocess service.
 * @param options - the task, its project, its root, and what to do with branches, documents and worktrees.
 *   `cause` is a sentence saying why the dialog is finishing a task the user never
 *   saw - "its Workspace registration failed" - so the log can say that instead of
 *   only showing a task space disappearing.
 * @returns what each repository's worktree, branch and merge ended up as.
 * @throws Error when the task space is missing or the request contradicts itself.
 */
export async function finishTask(subprocess, options) {
  const {
    task,
    project,
    tasksRoot,
    merge: askedMerge,
    target,
    targets,
    deleteBranch: askedDeleteBranch,
    force = false,
    cleanStray = false,
    keep = [],
    documentsDirectory,
    discardDocuments = false,
    cause,
    acknowledgeDelivery = false,
    deliveryArchive,
  } = options

  if (typeof tasksRoot !== 'string' || tasksRoot.trim() === '') throw coded('E1004', 'a tasks root is required')

  const projectName = validateProjectName(project)
  const taskPath = taskSpacePath(tasksRoot, projectName, task)

  if (!existsSync(taskPath)) throw coded('E2003', `no such task space: ${taskPath}`, { path: taskPath })
  auditEnter({ task, project: projectName, tasksRoot })

  // The record is what makes this directory one of ours, and it is asked before
  // anything else because everything below this line removes something. Without
  // it the only thing standing between a finish and an arbitrary directory is
  // that the directory happens to hold a linked worktree - which is a fact about
  // a path the caller named, not a claim on it. The record is a claim this
  // plugin wrote, and it lives inside the directory, so no registry anywhere can
  // be stale about it: a reinstall, a moved container and a copied task space
  // all answer the same.
  //
  // Presence is the question, not parseability: `readTaskMetadata` below still
  // reports a half-written or hand-edited file as no branch recorded, and that
  // narrows the finish to the merges and the removals a merge already justified.
  if (!existsSync(join(taskPath, TASK_METADATA))) {
    throw coded(
      'E2005',
      `${taskPath} holds no ${TASK_METADATA}, so this plugin has no record of creating it and nothing in it will be deleted.\n`
      + `  What is missing: ${join(taskPath, TASK_METADATA)}\n`
      + '  If this really is a task space this plugin made and its record was removed by hand, restore the file from a backup before finishing it.',
      { path: taskPath, missing: join(taskPath, TASK_METADATA) },
    )
  }

  // The branch this container was made for, as the record in the container says.
  // It is the only branch a finish may delete: `git branch -D` runs in the source
  // repository, outside the fence, so the name to delete is taken from what this
  // plugin wrote rather than from whatever the worktree has checked out now. A
  // container with no readable record deletes no branch at all, and says so.
  const warnings = []
  const recorded = await readTaskMetadata(taskPath)
  // What the caller said, and then what the task's own record says. `auto` is the record
  // answering "this merge happens by itself", and an absent request is a caller that said
  // nothing about it - which is what lets the policy fill either one in. An explicit `false`
  // - the panel's unticked box, an agent that was told not to merge - stays a no: the hand
  // that said it outranks the record. `deleteBranch` follows the same rule, and defaults to
  // keeping the branch, because that is the reversible half.
  const policyMerge = deliveryPolicyOf(recorded).merge
  const merge = askedMerge === undefined ? policyMerge.mode === 'auto' : askedMerge === true
  const deleteBranch = askedDeleteBranch === undefined
    ? merge && policyMerge.deleteBranch === true
    : askedDeleteBranch === true
  // Deleting a branch that was merged is routine; deleting one that was not throws
  // its commits away, so it has to be asked for twice - with `deleteBranch` and with
  // `force`, which is also what makes git delete it without complaint.
  if (deleteBranch && !merge && !force) {
    throw coded('E4007', 'deleting a branch that was never merged requires force')
  }
  const taskBranch = typeof recorded?.branch === 'string' ? recorded.branch : ''
  if (taskBranch === '') {
    warnings.push(warned('no-task-branch', `no task branch is recorded in ${taskPath}; no branch was deleted in any repository`, { path: taskPath }))
  }

  // The strays policy fills the gaps a caller left: a finish that named no
  // cleanStray, no directory and no discard takes its handling from the task's
  // own delivery policy. A caller that decided anything is honoured verbatim,
  // and `discard` without force stays dead - see applyStraysPolicy. Everything
  // it decides still passes the isolation check a caller-named directory would.
  const strayed = applyStraysPolicy(deliveryPolicyOf(recorded), {
    cleanStray,
    discardDocuments,
    documentsDirectory,
    keep,
    force,
  }, deliveryArchive, taskPath)
  const strayCleanStray = strayed.cleanStray
  const strayDiscardDocuments = strayed.discardDocuments
  const strayDestination = strayed.documentsDirectory
  if (strayDestination !== '') assertIsolated(taskPath, strayDestination)

  // The delivery gate is the one check here that reads the task's policy rather
  // than the caller's request. Its default is the hard refusal, which is what a
  // model-facing tool call meets; the panel can carry the user's own overrule
  // (`acknowledgeDelivery`), because the user's instruction outranks the policy -
  // and a bypassed gate is recorded as a warning, never silently.
  const gateWarning = await assertDeliveryGate(recorded, taskPath, { merge, bypass: acknowledgeDelivery === true })
  if (gateWarning !== undefined) warnings.push(gateWarning)

  const entries = await readdir(taskPath, { withFileTypes: true })
  // The repositories the container's own record names. It is what still recognises a
  // repository whose directory git has stopped calling a worktree - see below - and it
  // is read before anything is removed, so the names survive the run that removes them.
  const recordedNames = new Set(
    (Array.isArray(recorded?.repositories) ? recorded.repositories : [])
      .map((entry) => (typeof entry?.name === 'string' ? entry.name : ''))
      .filter((name) => name !== ''),
  )
  const worktrees = []
  // A directory this task recorded as a repository, whose `.git` is gone: git
  // unregisters a worktree before it deletes the directory, so a removal that failed
  // halfway leaves exactly this - a checkout git no longer knows about, holding the
  // worktree's files. Left unrecognised it reads as the user's own content, gets filed
  // into the documents directory (a whole checkout, `node_modules` and all), and no
  // later finish will ever remove it. The record is the only thing that can still tell
  // the two apart, and that is what it is for.
  const remains = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const worktreePath = join(taskPath, entry.name)
    if (await isLinkedWorktree(worktreePath)) { worktrees.push(worktreePath); continue }
    if (recordedNames.has(entry.name)) remains.push(worktreePath)
  }
  if (worktrees.length === 0 && remains.length === 0) throw coded('E2004', `no git worktrees found in ${taskPath}`, { path: taskPath, reason: 'none' })

  // Asked before anything is merged, removed or filed, because the removal is what
  // cannot be undone: a worktree some other process is holding cannot be deleted, and
  // deleting it happens after the merge. Left to fail there it costs a half-finished
  // task, and on the git measured here (`2.28.0.windows.1`) it also leaves a checkout
  // git has already unregistered and can never delete. So the whole finish is refused
  // while anything is in the way, and refusing costs nothing: nothing has happened yet,
  // which is what makes "close it and finish again" true rather than hopeful.
  const held = []
  for (const worktreePath of worktrees) {
    const reason = await removableNow(worktreePath)
    if (reason !== '') held.push({ path: worktreePath, reason })
  }
  if (held.length > 0) {
    throw coded(
      'E5011',
      `${held.length === 1 ? 'one worktree is' : `${held.length} worktrees are`} held by something outside this process and cannot be `
      + `removed, so nothing has been merged, removed or filed yet:\n`
      + held.map((entry) => `  ${entry.path}\n    ${entry.reason}`).join('\n') + '\n'
      + '  A dev server, a browser or an editor started in the task space is the usual one; close it, then finish the task again.',
      { held },
    )
  }

  const repositories = []
  let failed = false
  // Directories this run must leave exactly as they are: a repository of this task that
  // could not be removed. They are reported as repositories, and the stray pass below
  // skips them by name - a checkout that survived a removal is not something to file
  // away or to delete as a leftover.
  const strandedByRemoval = new Set()

  for (const worktreePath of worktrees) {
    const name = basename(worktreePath)
    const branch = await tryRunGit(subprocess, worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const porcelain = await tryRunGit(subprocess, worktreePath, ['worktree', 'list', '--porcelain'])
    // `git worktree list` always prints the main working tree first.
    const mainRepo = parseWorktrees(porcelain).find((row) => row.isMain)?.path ?? ''
    const outcome = { name, path: worktreePath, mainRepo, branch, merged: false, removed: false, branchDeleted: false, mergeInProgress: false, mergeSite: '', conflictedFiles: [] }
    if (mainRepo === '') {
      outcome.error = 'cannot locate the source repository'
      repositories.push(outcome)
      failed = true
      continue
    }

    // Work nobody committed is what a merge cannot carry and what a worktree removal
    // refuses. Who writes that commit is not this side's to assume - the caller may commit
    // it by hand, or hand it to a session that has read the changes and can say what they
    // were for - so what is left here is the refusal: a finish that skipped that step stops,
    // names the checkout, and says the one thing that clears it, instead of committing over
    // the work with a message this side made up. Force is the caller saying the work is not
    // wanted - it is discarded as the worktree goes - and an abandonment deletes the branch
    // and the work with it, which the caller asked for by name; a merge still standing is
    // the next step's business.
    const midMerge = await mergeInProgress(subprocess, worktreePath)
    if ((merge || !deleteBranch) && !force && !midMerge && await uncommittedCount(subprocess, worktreePath) > 0) {
      outcome.error = `uncommitted work is waiting in ${worktreePath}; commit it before the task can be finished`
      repositories.push(outcome)
      failed = true
      continue
    }

    // A merge standing in the worktree is one somebody has been resolving by editing files
    // in the task space, and the commit that concludes it is not this side's either: whoever
    // resolved it has read both sides and can say what the resolution kept. So nothing here
    // commits: the merge is reported as still waiting, with the files it waits on, and the
    // worktree is left exactly as it stands. Markers still in a file and a resolution that
    // was never committed are told apart, because they ask for different things from
    // whoever returns to it.
    if (merge && midMerge) {
      const pending = await conflictMarkers(subprocess, worktreePath)
      outcome.conflict = true
      outcome.mergeSite = worktreePath
      outcome.mergeInProgress = true
      outcome.conflictedFiles = pending.length > 0 ? pending : await conflictedFiles(subprocess, worktreePath)
      outcome.error = pending.length > 0
        ? `the resolved merge still has conflict markers in ${pending.join(', ')}`
        : `the merge in ${worktreePath} is resolved but not committed`
      repositories.push(outcome)
      failed = true
      continue
    }

    // A worktree on no branch has nothing to merge from. `git merge` needs a name to
    // merge, and the name a detached checkout reports is the literal `HEAD` - which
    // git resolves against the checkout running the merge, so the merge target is
    // merged into itself: "Already up to date", exit 0. The finish would report a
    // merge that never happened, remove a worktree that is clean because it was never
    // merged into, and leave the task's commits behind as objects nothing points at.
    // The deletion path below refuses these two answers too - `branch !== taskBranch`
    // is true of both - for the same reason: a name that is not a branch cannot be
    // what the caller meant.
    //
    // Refused the way uncommitted work is, because it is the same shape of answer:
    // nothing was merged, nothing was removed, no branch was deleted, the worktree is
    // still there, and `conflict` stays unset - there is no merge standing to settle.
    if (merge && (branch === '' || branch === 'HEAD')) {
      outcome.error = branch === ''
        ? `'${name}' reports no branch, so there is nothing in it to merge; check that ${worktreePath} is still the worktree this task made`
        : `'${name}' is on a detached HEAD, so its commits belong to no branch and there is nothing to merge them from. Check a branch out in ${worktreePath}, or move the work onto one, before the task can be finished.`
      repositories.push(outcome)
      failed = true
      continue
    }

    if (merge) {
      try {
        // A branch named for this repository wins; `target` names one for all of
        // them, which is how the tool asks for a single branch across a task.
        const mergeTarget = await resolveMergeTarget(subprocess, mainRepo, targets?.[name] ?? target, branch)
        outcome.target = mergeTarget
        // Rehearsed in the worktree being finished: that is the checkout this plugin
        // owns, and the one a conflict is meant to be resolved in. A target already
        // contained in the branch skips the rehearsal, which is also how a resumed
        // finish reads a conflict someone has since resolved and committed.
        if (!(await gitSucceeded(subprocess, worktreePath, ['merge-base', '--is-ancestor', mergeTarget, branch]))) {
          const rehearsalBase = await runGit(subprocess, worktreePath, ['rev-parse', 'HEAD'])
          try {
            await runGit(subprocess, worktreePath, ['merge', '--no-ff', '--no-edit', mergeTarget])
          } catch (error) {
            // The one failure in here that leaves work for someone: the merge is
            // standing in this worktree, unresolved, and is left exactly that way.
            if (await mergeInProgress(subprocess, worktreePath)) {
              outcome.conflict = true
              outcome.mergeSite = worktreePath
              outcome.mergeInProgress = true
              outcome.conflictedFiles = await conflictedFiles(subprocess, worktreePath)
              outcome.error = error.message
              repositories.push(outcome)
              failed = true
              continue
            }
            await gitSucceeded(subprocess, worktreePath, ['merge', '--abort'])
            outcome.error = error.message
            repositories.push(outcome)
            failed = true
            continue
          }
          // Clean, so the rehearsal has done its job and is undone here - the worktree
          // was clean when it started - leaving the merge into the target branch to
          // record the merge commit the ordinary way, with the target's own commits
          // still first in its history.
          await runGit(subprocess, worktreePath, ['reset', '--hard', rehearsalBase])
        }
        await mergeIntoBranch(subprocess, mainRepo, branch, mergeTarget)
        outcome.merged = true
      } catch (error) {
        // Leave the worktree and branch in place for manual handling. `error` stays
        // git's own words: the page explains the conflict in the user's language and
        // shows this behind a disclosure, and the answer's `conflict` flag plus
        // `removed: false` tell a caller the worktree and branch are still there.
        //
        // E5004 is the exception to that rule, and it is checked first because it is
        // not a conflict at all. Marking it one sends the reader after conflict
        // markers and a merge to conclude, in a checkout where no merge was ever
        // started - the thing standing in the way is uncommitted work in the
        // repository they work in. `mergeIntoBranch` refuses it by name; this
        // recognises it even where that guard did not run.
        //
        // Both of git's wordings for that end in the same three words, and both mean
        // it here. "Your local changes to the following files would be overwritten by
        // merge" is the one the guard above usually pre-empts; "The following
        // untracked working tree files would be overwritten by merge" is the one it
        // cannot, because an untracked file is not a dirty path unless the merge
        // happens to write it - which is git's to notice, not this side's. Matching
        // the first wording alone answered that one as a conflict: nothing was
        // reconciled and there is no merge to conclude, yet the page said to go and
        // reconcile it.
        const dirtyCheckout = error?.code === 'E5004' || /would be overwritten by merge/i.test(String(error?.message ?? ''))
        outcome.conflict = !dirtyCheckout
        await gitSucceeded(subprocess, mainRepo, ['merge', '--abort'])
        outcome.error = error.message
        repositories.push(outcome)
        failed = true
        continue
      }
    }

    const removeArgs = force ? ['worktree', 'remove', '--force', worktreePath] : ['worktree', 'remove', worktreePath]
    // Fence. This is the one removal here performed by git rather than by this
    // plugin, so none of the checks that guard the `rm` calls below reach it: git
    // deletes the directory it is handed, and a link in that place would carry the
    // delete straight out of the container. Refused the same way any other
    // per-repository failure is - named, skipped, and reported - so one impossible
    // path cannot strand the repositories after it half-finished.
    const refused = refuseDelete(tasksRoot, worktreePath, `the worktree '${name}'`)
    if (refused !== '') {
      outcome.error = refused
      repositories.push(outcome)
      failed = true
      continue
    }
    if (!(await gitSucceeded(subprocess, mainRepo, removeArgs))) {
      // git unregisters a worktree before it deletes the directory, so a delete that
      // failed leaves a checkout git no longer knows about: no `.git` file, no
      // administrative directory, and nothing on disk that says this is a worktree
      // rather than the user's own file. What git did not finish is finished here -
      // under the fence checked above, and only once git itself is done with the path,
      // which is what "no longer registered" says. A refusal git made up front
      // (uncommitted work, a lock, a submodule) leaves the worktree registered, and is
      // reported as it always was rather than worked around: those are exactly the
      // refusals that must not be bypassed.
      if (await worktreeRegistered(subprocess, mainRepo, worktreePath)) {
        outcome.error = 'failed to remove the worktree (uncommitted changes? force it deliberately)'
        repositories.push(outcome)
        failed = true
        continue
      }
      try {
        await rm(worktreePath, { recursive: true, force: true })
      } catch (error) {
        // Both deletes failed, so the directory is held by something outside this
        // process. It is named as a repository that is still there - not left to the
        // stray pass, which would file the checkout away as documents.
        outcome.error = `git unregistered this worktree but could not delete it, and the plugin could not either (${error.message}); it is still on disk at ${worktreePath} and has to be removed by hand`
        repositories.push(outcome)
        failed = true
        strandedByRemoval.add(name)
        continue
      }
      // Whatever git left of its own bookkeeping goes with it. Measured on the git
      // that produced this case (`2.28.0.windows.1`) the administrative directory is
      // already gone; a version that kept it would otherwise leave the source
      // repository holding an entry for a directory that is not there.
      await gitSucceeded(subprocess, mainRepo, ['worktree', 'prune', '--expire', 'now'])
    }
    outcome.removed = true

    if (deleteBranch) {
      // Only ever the branch this task made. `branch` is whatever the worktree
      // happens to have checked out - it can be switched by hand, and a worktree
      // that merged cleanly is no proof of which branch was merged - and
      // `git branch -D` runs in the source repository, which is outside the
      // container this fence covers. So the name has to match what the container
      // recorded before it goes; anything else is named and left alone.
      if (branch !== taskBranch) {
        outcome.branchDeleted = false
        warnings.push(warned(
          'branch-left-alone',
          branch === ''
            ? `'${name}' has no branch checked out, so no branch was deleted in '${mainRepo}'`
            : `'${name}' is on '${branch}', not on the task branch '${taskBranch}', so that branch was left alone in '${mainRepo}'`,
          { name, mainRepo, branch, taskBranch },
        ))
      } else {
        const deleted = await gitSucceeded(
          subprocess,
          mainRepo,
          // `--` because this is the one git call that leaves the container: a
          // branch name git itself will not start with a dash is read here, but
          // `--` costs nothing and closes the shape of argument where a
          // different name someday might.
          force ? ['branch', '-D', '--', branch] : ['branch', '-d', '--', branch],
        )
        outcome.branchDeleted = deleted
        if (!deleted) warnings.push(warned('branch-not-deleted', `branch '${branch}' was not deleted in '${name}'`, { branch, name }))
      }
    }
    repositories.push(outcome)
  }

  // A repository of this task whose directory is still there and whose worktree git no
  // longer knows about. Nothing this run can do finishes it, and saying so is the whole
  // of what is left: it is reported as a repository, which is also what keeps it out of
  // the stray pass below rather than filed away as the user's documents.
  for (const worktreePath of remains) {
    const name = basename(worktreePath)
    strandedByRemoval.add(name)
    failed = true
    repositories.push({
      name,
      path: worktreePath,
      mainRepo: '',
      branch: '',
      merged: false,
      removed: false,
      branchDeleted: false,
      mergeInProgress: false,
      mergeSite: '',
      conflictedFiles: [],
      error: `this worktree is no longer registered in its source repository and is still on disk at ${worktreePath}; git unregistered it but could not delete it, so it has to be removed by hand before the task space can be cleared`,
    })
  }

  const leftovers = await readdir(taskPath, { withFileTypes: true })

  // The files this plugin wrote into the container - the JSON record, the note
  // rendered from it, and the note older containers still carry - go once nothing
  // this plugin opened is still open. The JSON describes a task space that is being
  // taken down, and the Markdown is generated from it, so neither outlives the last
  // worktree it accounts for.
  //
  // A repository that stopped keeps its worktree, and that worktree is what the
  // reader comes back to. Clearing the record while it is still there strands the
  // task: the answer invites a second attempt, and the second attempt cannot start
  // because nothing is left saying what this directory is or which branch it was
  // filed under. Clearing on a finish that failed some repositories made every
  // partial finish permanent - and a partial finish is the ordinary way one ends
  // badly, not an edge case.
  let stillOpen = false
  for (const entry of leftovers) {
    if (!entry.isDirectory()) continue
    // A repository whose directory survived its removal keeps the record too. The
    // record is what says this task had that repository and which branch it was on -
    // the only thing left that can tell the remains apart from the user's own files,
    // and therefore the only thing a later finish could recognise them by.
    if (strandedByRemoval.has(entry.name) || await isLinkedWorktree(join(taskPath, entry.name))) { stillOpen = true; break }
  }
  if (!stillOpen) {
    for (const name of TASK_OWNED_FILES) await rm(join(taskPath, name), { force: true })
  }
  // Re-read either way, so the cleanup below reasons about what is actually left
  // rather than about files that may have just gone.
  const remainingEntries = await readdir(taskPath, { withFileTypes: true })

  const strays = []
  // A set, so that taking a name back out is a removal of that name rather
  // than an index lookup that can miss: `splice(indexOf(x), 1)` on a name that
  // was never in the list removes the *last* element instead, and the list here
  // is built and pruned in the same loop.
  const content = new Set()
  for (const entry of remainingEntries) {
    if (entry.isDirectory() && await isLinkedWorktree(join(taskPath, entry.name))) continue
    // A repository that could not be removed is not a leftover of anything. It was
    // reported above as a repository, and filing a checkout away as documents - or
    // deleting it as build output - would be this side's own decision to make about
    // work that is not its. It stays until the user removes it.
    if (entry.isDirectory() && strandedByRemoval.has(entry.name)) continue
    // The plugin's own files are not leftovers of anything. The record is kept on
    // purpose - a repository that stopped still needs it to be finished a second
    // time - and `strayKind` files it as content, so without this it would be
    // swept into the disposal below: filed into the documents directory or
    // discarded, either of which ends the task the same way clearing it does.
    // `planTask` skips them for the same reason and has always had to.
    if (TASK_OWNED_FILES.includes(entry.name)) continue
    strays.push(entry.name)
    if (strayKind(entry.name, entry.isDirectory()) === 'content') content.add(entry.name)
    // Fence. A leftover is named, not vetted: it is whatever happens to sit in
    // the task directory, and two of the three ways it is disposed of remove it
    // recursively. `readdir` said it is a directory, which on Windows a junction
    // also is, so it is asked directly whether it is a link - and a link is kept
    // and named rather than deleted, because it is a name for somewhere else.
    if (entry.isDirectory()) {
      const refused = refuseDelete(tasksRoot, join(taskPath, entry.name), `the leftover '${entry.name}'`)
      if (refused !== '') {
        keep.push(entry.name)
        // The fence's own sentence is what the log keeps; a screen says the same thing
        // from the name alone, because the refusal is always one of two things and the
        // reader needs the name, not the wording.
        warnings.push(warned('leftover-refused', refused, { name: entry.name, path: join(taskPath, entry.name) }))
        strays.pop()
        content.delete(entry.name)
        continue
      }
    }
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
    if (strayDestination === '') {
      if (!strayDiscardDocuments) continue
    } else {
      const source = join(taskPath, name)
      const destination = join(strayDestination, name)
      // Asked before the copy rather than after it has failed: `fs.cp` recreates a link
      // instead of copying what it points at, so on a machine that will not create one
      // the copy stops part-way with an `EPERM` naming a link and leaves half an archive
      // behind - which is what the caller then has to notice and clean up. And filling a
      // link in with whatever it points at is not this side's decision to make about
      // somebody's files: a link is a name for somewhere else, and that somewhere can be
      // outside the task space entirely. So the links are left out of the copy and stay
      // where they are, named, and everything else in the stray is filed as usual.
      const links = await symlinksRefused() ? await findLinks(source) : []
      try {
        await mkdir(strayDestination, { recursive: true })
        if (links.length === 0) {
          await cp(source, destination, { recursive: true, force: false, errorOnExist: true })
        } else {
          const skip = new Set(links.map((entry) => join(source, entry)))
          await cp(source, destination, {
            recursive: true,
            force: false,
            errorOnExist: true,
            filter: (from) => !skip.has(from),
          })
        }
      } catch (error) {
        // Kept, not cleaned: a copy that failed must not cost the original, so
        // this is excluded from the clean-up below and reported as still there.
        //
        // What the failed copy left is not an archive and is taken back out - but only
        // when it is this call's own. `errorOnExist` is what makes that true: an
        // `EEXIST` means the destination was already there, which is somebody else's
        // directory and is left exactly as it is.
        if (error?.code !== 'EEXIST') await rm(destination, { recursive: true, force: true }).catch(() => {})
        warnings.push(warned('leftover-copy-failed', `could not archive '${name}' to '${strayDestination}': ${error.message}`, { name, destination: strayDestination, reason: error.message }))
        keptByFailure.push(name)
        continue
      }
      if (links.length > 0) {
        const named = links.slice(0, LINK_NAMES_SHOWN).join(', ')
        const more = links.length > LINK_NAMES_SHOWN ? `, and ${links.length - LINK_NAMES_SHOWN} more` : ''
        warnings.push(warned(
          'leftover-holds-links',
          `filed '${name}' into '${strayDestination}' except for ${links.length === 1 ? 'a link' : `${links.length} links`} `
          + `(${named}${more}): this machine will not let DSH create one, so the link and the directories holding it were `
          + 'left in the task space exactly as they stand - removing or moving those entries out is what lets the finish complete',
          { name, destination: strayDestination, links, shown: LINK_NAMES_SHOWN },
        ))
        // What was filed comes out of the task space; what was not stays, links and the
        // directories holding them. It is also in `keptByFailure`, so `cleanStray` will not
        // delete it either: the entry was not filed, and removing it is the user's to do.
        await removeCopiedLeavingLinks(source)
        keptByFailure.push(name)
        archivedStrays.push(name)
        continue
      }
      archivedStrays.push(name)
    }
    await rm(join(taskPath, name), { recursive: true, force: true })
    if (strayDestination === '') removedStrays.push(name)
  }

  if (strayCleanStray) {
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

  await auditOutcome(repositories, warnings, 'done')

  // The one line that says what finishing a task actually did. The repositories
  // and their errors are above it, but "three worktrees removed, the branch kept,
  // the task space directory still there because documents were filed" is a
  // conclusion, and this file records conclusions as well as facts.
  const removedCount = repositories.filter((entry) => entry?.removed === true).length
  if (!failed) {
    await recordEvent(
      cause ? 'warn' : 'info',
      cause
        ? `The task space was taken down because ${cause} The create had already made this work, so removing it is what makes the whole create fail as one thing: nothing of it is left behind.`
        : `Finished the task: ${removedCount} worktree${removedCount === 1 ? '' : 's'} removed`
          + `${deleteBranch ? ' and the branches deleted' : ', the branches kept'}`
          + `${containerRemoved ? ', and the task space directory itself is gone' : ', with the task space directory left in place for what it still holds'}.`,
      {
        phase: 'done',
        ...(cause ? { cause } : {}),
        removed: repositories.filter((entry) => entry?.removed === true).map((entry) => entry.name),
        ...(deleteBranch ? { branchesDeleted: true } : { branchesKept: true }),
        ...(containerRemoved ? { containerRemoved: true } : {}),
      },
    )
    // The deployment, if the task ever had one, is a compose project named by the
    // environment id in the record. It is torn down here rather than left to the
    // deploy script or the user's memory, because nothing runs after the task
    // space is gone: a cleanup someone has to remember is a cleanup that leaks.
    // Best effort by contract — a missing docker, an unreachable engine or a
    // refused removal becomes a warning this finish still carries, never a
    // failure, and it is skipped outright when the policy deployed nothing.
    if (cause === undefined) {
      const policy = deliveryPolicyOf(recorded)
      const envId = typeof recorded?.deploymentEnvId === 'string' ? recorded.deploymentEnvId : ''
      if (policy.deploy.target !== 'none' && envId !== '') {
        try {
          const outcome = await destroyDeployment(subprocess, taskPath, envId)
          if (outcome.warning !== undefined) warnings.push(outcome.warning)
        } catch (error) {
          warnings.push(warned('deploy-cleanup-failed', `deployment cleanup failed for ${envId}: ${error.message}`, { envId, reason: error.message }))
        }
      }
    }
  } else {
    const stuck = repositories.filter((entry) => entry?.removed !== true).map((entry) => entry.name)
    await recordEvent(
      'error',
      `Finishing the task did not complete. ${stuck.length} of ${repositories.length} repositories could not be finished and are still on disk; the rest went as planned.`,
      {
        phase: 'done',
        code: 'E5002',
        ...(cause ? { cause } : {}),
        ...(stuck.length > 0 ? { notRemoved: stuck } : {}),
      },
    )
  }

  return {
    task,
    project: projectName,
    path: taskPath,
    mergeTarget: repositories.find((entry) => entry.target)?.target,
    repositories,
    // What is left in the task space: kept because a copy failed, kept because a link could
    // not be recreated and only part of it could be filed, kept because the fence refused to
    // remove it, or simply never disposed of. A partly filed stray belongs here even though
    // it is also in `archivedStrays` - the link it could not file is still on disk.
    strays: strays.filter((name) => keptByFailure.includes(name)
      || (!removedStrays.includes(name) && !archivedStrays.includes(name))),
    archivedStrays,
    removedStrays,
    containerRemoved,
    failed,
    warnings,
  }
}



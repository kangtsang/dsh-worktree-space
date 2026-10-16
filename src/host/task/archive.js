/**
 * Task archiving
 *
 * Finishing a task: what merging would do, which files are the user's own, and the merge, removal, and filing that follow.
 */
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, open, readdir, rename, rmdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { auditEnter, recordError, recordEvent, recordWarning } from './audit-log.js'
import { coded, warned } from './codes.js'
import { assertDeliveryGate, deliveryGatePreview, destroyDeployment } from './deploy.js'
import { applyStraysPolicy, deliveryPolicyOf } from './delivery.js'
import { gitSucceeded, parseWorktrees, runGit, tryRunGit } from './git.js'
import { findLinks, symlinksRefused } from './links.js'
import { validateProjectName } from './naming.js'
import { assertIsolated, isInside, refuseDelete, samePathLocation } from './paths.js'
import { refuseWhileSessionsWork } from './session-guard.js'
import { withTaskLock } from './task-lock.js'

import { BREADCRUMB, PLUGIN_ROOT, TASK_METADATA, TASK_OWNED_ENTRIES, isLinkedWorktree, pluginRootPath, readTaskMetadata, taskMetadataPath, taskSessionsOf, taskSpacePath } from './shared.js'
import { archiveSourceTaskIndex, sourceTaskIndexPath, writeSourceTaskIndex } from './source-index.js'

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
 *
 * `-z`, for the reason {@link dirtyPaths} gives at length: without it git C-quotes a
 * path holding a non-ASCII byte, so `文.txt` arrives as `"\346\226\207.txt"` - a name
 * that does not exist on disk. The caller reads these paths off the checkout to look
 * for conflict markers, so a quoted one is a file that cannot be opened, silently
 * skipped, and the merge is then reported as resolved while its markers are still
 * there.
 * @param subprocess - the profile's subprocess service.
 * @param site - the checkout the merge is standing in.
 * @returns their paths, relative to that checkout.
 */
async function conflictedFiles(subprocess, site) {
  const output = await tryRunGit(subprocess, site, ['diff', '--name-only', '-z', '--diff-filter=U'])
  return output.split('\0').filter((line) => line !== '')
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
 *
 * Both listings are read with `-z`, and that is what makes this answer trustworthy
 * rather than merely usually right. The default quoting C-quotes a path with a
 * non-ASCII byte (`文.txt` becomes `"\346\226\207.txt"`), and every such path then
 * fails `readHead` - landing in the `catch` below, which exists for submodules and
 * directories. The failure mode is the dangerous direction: a file whose markers are
 * still in it is skipped, the merge is reported as resolved, and the finish goes on to
 * a commit that contains `<<<<<<<`. `-z` writes each path verbatim and separates
 * records with NUL, so nothing in a path can be altered or end a record early.
 * @param subprocess - the profile's subprocess service.
 * @param site - the checkout the merge is standing in.
 * @returns the paths that still carry markers, relative to that checkout.
 */
async function conflictMarkers(subprocess, site) {
  const changed = await tryRunGit(subprocess, site, ['diff', '--name-only', '-z', 'HEAD'])
  const listed = [...new Set([...changed.split('\0'), ...await conflictedFiles(subprocess, site)])]
    .filter((line) => line !== '')
  const marked = []
  for (const file of listed) {
    let text = ''
    try {
      text = await readHead(join(site, file))
    } catch {
      // A path git lists that cannot be read - a submodule, a directory - carries no
      // markers this could find, and is not a reason to refuse the finish. With `-z`
      // this cannot also be swallowing a path that was merely quoted.
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
  // `-z` here is not tidiness: this set is compared against `dirtyPaths`, which already
  // reads its paths verbatim. A quoted path on this side would simply never match the
  // unquoted one on that side, so a non-ASCII file the merge is about to overwrite would
  // not be seen - and this is the check that stops the merge before it clobbers the
  // user's uncommitted work in their own checkout.
  const written = new Set(
    (await tryRunGit(subprocess, site, ['diff', '--name-only', '-z', base, branch]))
      .split('\0')
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
    // A merge of the user's own that has been started and not concluded. This is
    // checked before anything else, and before the dirty-path guard below, because
    // that guard cannot see it in general: it only refuses over paths this merge
    // writes, while an unfinished merge holds MERGE_HEAD whatever its files are.
    //
    // Left alone, git refuses the merge below with "You have not concluded your
    // merge (MERGE_HEAD exists)" - and the catch that follows aborts, which throws
    // away a resolution the user may have already written and staged by hand. That
    // work has no reflog entry and no stash behind it, so aborting is the one thing
    // here that cannot be undone. Named as the user's own checkout standing in the
    // way (E5004) rather than as a conflict: there is nothing this side can
    // reconcile, and the merge to conclude is theirs.
    if (await mergeInProgress(subprocess, mainRepo)) {
      throw coded(
        'E5004',
        `the checkout at ${mainRepo} has a merge of its own in progress, so this merge was not started and nothing there was aborted: ${mainRepo}. Conclude or abort that merge yourself, then finish the task.`,
      )
    }
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

  // Where this task's repositories came from, as the record says. A plan follows
  // `git worktree list` out of the container and runs the next git call in whatever
  // `mainRepo` it names - so without this, a task space whose record was edited (or a
  // worktree whose `.git` file was) sends the plugin into any repository on the machine,
  // and every question after that is asked of a repository this task has nothing to do
  // with. The record is the same proof `finishTask` asks for before it removes anything;
  // a plan removes nothing, so it is only the one fact that keeps the walk inside the
  // trees this task was made from.
  //
  // Two ways a repository is this task's own, and BOTH are needed. A `sourceRoot` that
  // contains it is the ordinary create. A `sourcePath` the record names explicitly is
  // the `add-repositories` case, which may deliberately take a repository from anywhere -
  // anywhere at all, including another volume - so a rule that only knew about
  // `sourceRoot` would refuse exactly the feature the review says not to restrict. The
  // recorded paths are what the create and the add both wrote, so they are the task's own
  // answer to which repositories it holds.
  //
  // Absent rather than wrong is not a mismatch: a container made before the JSON existed
  // has no `sourceRoot` at all, and a space is never demoted for being old.
  const recorded = await readTaskMetadata(taskPath)
  const recordedSourceRoot = typeof recorded?.sourceRoot === 'string' ? recorded.sourceRoot.trim() : ''
  const recordedRepos = (Array.isArray(recorded?.repositories) ? recorded.repositories : [])
    .map((entry) => (typeof entry?.sourcePath === 'string' ? entry.sourcePath.trim() : ''))
    .filter((path) => path !== '')
  // Whether the plan may leave the container for this repository. Only asked when the
  // record names a source root or repositories at all: a record with neither is an old
  // container, and refusing it would demote a space for being old.
  const ownsRepo = (mainRepo) => {
    if (recordedRepos.some((path) => samePathLocation(path, mainRepo))) return true
    if (recordedSourceRoot === '') return recordedRepos.length === 0
    return samePathLocation(recordedSourceRoot, mainRepo) || isInside(recordedSourceRoot, mainRepo)
  }

  const entries = await readdir(taskPath, { withFileTypes: true })
  const worktrees = []
  // What the container holds besides its worktrees. `finishTask` always clears
  // the plugin's own directory and keeps the rest unless the caller's `strays`
  // choice clears them, so this is exactly what `archive`/`discard` would remove —
  // minus that directory, which is never a surprise.
  const strays = []
  for (const entry of entries) {
    const entryPath = join(taskPath, entry.name)
    if (entry.isDirectory() && await isLinkedWorktree(entryPath)) {
      worktrees.push(entryPath)
      continue
    }
    if (TASK_OWNED_ENTRIES.includes(entry.name)) continue
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
    else if (!ownsRepo(mainRepo)) {
      // Refused rather than reported as an error row: this is not a repository that
      // could not be asked, it is a repository this task does not own. Answering with a
      // row would let the dialog offer it as a merge target and let `finishTask` act on
      // it; the plan is the read that has to stop first.
      throw coded(
        'E1006',
        `${worktreePath} is a worktree of ${mainRepo}, which is not one of the repositories this task recorded`
        + `${recordedSourceRoot === '' ? '' : ` (source root ${recordedSourceRoot})`}\n`
        + '  a task may only merge and delete inside the repositories it was created from or added',
        { path: worktreePath, mainRepo, sourceRoot: recordedSourceRoot, repositories: recordedRepos },
      )
    } else {
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
  // What the delivery gate would say about a merge of this task, computed here rather than
  // by the panel. The panel used to derive it from a deployment status read, and derived it
  // differently from the gate - it asked whether a state file *existed* and whether its
  // smoke was green, so a task whose deploy script never wrote one was reported as fine and
  // then refused at the finish with no way for the user to answer. One judgement, one place:
  // the same function the refusal itself uses.
  const gate = await deliveryGatePreview(await readTaskMetadata(taskPath), taskPath)
  return { task, project: projectName, path: taskPath, tasksRoot: tasksRoot.trim(), mergeTarget, changedFiles, commits, repositories, strays, gate }
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
 * Put back any directory an earlier probe left under the probe name.
 *
 * The probe renames a worktree and renames it straight back, and a process killed
 * between those two steps leaves the checkout under `<name>.dsh-removal-probe`. That is
 * not a cosmetic leftover. A linked worktree is recognised by the `.git` inside it, and
 * the rename carries that file along, so the next finish finds a repository named
 * `<name>.dsh-removal-probe` - a name git has never heard of, whose removal it refuses
 * and whose branch it cannot attribute. The task's own repository would finish under a
 * name nobody chose, and the name it was filed under would never come back.
 *
 * So the names are put back before anything is read, which is the only point at which
 * that is still possible: once the directory scan has run, the leftover has already been
 * taken for a worktree of its own.
 *
 * Best effort, one directory at a time. A name already occupied by something else is
 * left exactly as it stands rather than guessed at, and the probe below still reports
 * what it could not put back.
 * @param taskPath - the task space whose entries are checked.
 */
async function recoverRemovalProbes(taskPath) {
  let entries
  try {
    entries = await readdir(taskPath, { withFileTypes: true })
  } catch {
    // Unreadable is the caller's own problem to report, and it is about to: the scan
    // that follows reads the same directory and answers an empty task space.
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.endsWith(REMOVAL_PROBE_SUFFIX)) continue
    const name = entry.name.slice(0, -REMOVAL_PROBE_SUFFIX.length)
    // The suffix is the plugin's own marker and carries the whole name it belongs to, so
    // an entry that is nothing but the suffix names nothing and is left alone.
    if (name === '') continue
    await rename(join(taskPath, entry.name), join(taskPath, name)).catch(() => {})
  }
}

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
 * caller has to rename back by hand, and saying so is the only honest answer. A run that
 * dies at that exact moment is recovered by {@link recoverRemovalProbes} on the next
 * finish, so the state this reports is one a live caller can still clear by hand rather
 * than the permanent rename it used to be.
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
  // The name goes back from a `finally`, and the shape is the point rather than a
  // detail: whatever the probe comes to do between taking the name and giving it back,
  // the restore runs. A throw in the middle would otherwise leave the directory under
  // the probe name - the one outcome this function must not produce.
  let putBack = ''
  try {
    // The probe itself: nothing beyond the rename above today, which is the whole of the
    // question - a directory Windows will not rename is one it will not delete either.
    // Written as its own step so that anything added here later is covered by the restore.
  } finally {
    try {
      await rename(probe, directory)
    } catch (error) {
      putBack = `the check renamed it and could not put it back: it is now at ${probe} (${error?.message ?? error})`
    }
  }
  return putBack
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
 *   only showing a task space disappearing. `ctx` and `callerSessionId`, when given,
 *   are what let the finish ask again - inside its own lock - whether a session is
 *   still working in the space it is about to remove.
 * @returns what each repository's worktree, branch and merge ended up as.
 * @throws Error when the task space is missing or the request contradicts itself.
 */
export async function finishTask(subprocess, options) {
  const { ctx, callerSessionId = '', ...rest } = options ?? {}

  if (typeof rest.tasksRoot !== 'string' || rest.tasksRoot.trim() === '') throw coded('E1004', 'a tasks root is required')
  const projectName = validateProjectName(rest.project)
  const taskPath = taskSpacePath(rest.tasksRoot, projectName, rest.task)

  // The cheap early refusal, before the queue: a caller that can be told "no" without
  // waiting behind another finish is told immediately, and a finish that will be
  // refused never occupies the lock. It is not the real check - the answer can change
  // while this call waits its turn, which is exactly what the one inside the lock is
  // for - but it is the one that answers in the common case, and it costs a registry
  // read rather than a wait.
  if (ctx !== undefined) refuseWhileSessionsWork(ctx, taskPath, callerSessionId)

  // One finish at a time, per task space. Everything below reads the directory, merges,
  // removes and deletes, and two of those interleaved is how a panel double-press ends up
  // with two runs each merging and each deleting what the other is holding. A second
  // caller waits for the first and then runs; by then the space is usually gone, which is
  // the correct outcome and is reported by the E2003 below like any other missing space.
  return withTaskLock(taskPath, async () => {
    // The real guard, and it is inside the lock on purpose. The one above ran before this
    // call was queued, so a session that started working while it waited would not be in
    // its answer; here nothing can start between the question and the removal, because
    // every other finish of this space is behind the same lock. Still best effort - a
    // deployment with no agent registry answers "nothing found" - but no longer a
    // check-then-act with an unbounded gap in the middle.
    if (ctx !== undefined) refuseWhileSessionsWork(ctx, taskPath, callerSessionId)
    return finishTaskLocked(subprocess, options)
  })
}

/**
 * {@link finishTask}'s body, with the task space already resolved and the lock held.
 *
 * Split out only so the lock wrapper above can be read on its own: nothing here is
 * meant to be called from anywhere but that wrapper, and the ordering inside it is
 * the whole of what a finish is.
 * @param subprocess - the profile's subprocess service.
 * @param options - as {@link finishTask}.
 * @returns as {@link finishTask}.
 */
async function finishTaskLocked(subprocess, options) {
  const {
    task,
    project,
    tasksRoot,
    merge: askedMerge,
    target,
    targets,
    deleteBranch: askedDeleteBranch,
    force = false,
    // The caller's choice for what happens to untracked files. Bound to a distinct
    // name here because `strays` below is the list of entries themselves, and a
    // parameter and a local of one name in one scope is a collision the parser
    // refuses - which is the language catching what would otherwise read as one
    // variable doing two jobs.
    strays: strayChoice,
    keepEntries = [],
    documentsDirectory,
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
  if (!existsSync(taskMetadataPath(taskPath))) {
    throw coded(
      'E2005',
      `${taskPath} holds no ${PLUGIN_ROOT}/${TASK_METADATA}, so this plugin has no record of creating it and nothing in it will be deleted.\n`
      + `  What is missing: ${taskMetadataPath(taskPath)}\n`
      + '  If this really is a task space this plugin made and its record was removed by hand, restore the file from a backup before finishing it.',
      { path: taskPath, missing: taskMetadataPath(taskPath) },
    )
  }

  // The branch this container was made for, as the record in the container says.
  // It is the only branch a finish may delete: `git branch -D` runs in the source
  // repository, outside the fence, so the name to delete is taken from what this
  // plugin wrote rather than from whatever the worktree has checked out now. A
  // container with no readable record deletes no branch at all, and says so.
  const warnings = []
  const recorded = await readTaskMetadata(taskPath)

  // The record says which task this directory is, and the request says which task is
  // being finished. They have to be the same task, because everything below removes
  // what the record describes: a mismatch means this call is about to delete another
  // task's worktrees and branch, which nothing later in the run can walk back.
  //
  // The path is not proof of identity on its own. `taskSpacePath` joins the caller's
  // words into `<root>/<project>/<task>` and `existsSync` answers for whatever the
  // filesystem resolves that to - so on a case-insensitive filesystem `Login` reaches
  // the directory of `login`, and a name Win32 folds (a trailing dot, a trailing space)
  // reaches a different task's directory than the one it spells. The record is a claim
  // this plugin wrote into the directory itself, so it is the one answer no registry
  // can be stale about, and comparing it exactly is what turns a lookalike name into a
  // refusal instead of a removal of the wrong task.
  //
  // Exact, not case-folded: the record is the authority, and a name that differs from it
  // in any character is not the task the record describes. Refusing is recoverable - the
  // caller is told the recorded spelling and can ask again with it - while removing the
  // wrong task is not.
  //
  // Only when the record carries the field. A container made before the JSON existed
  // answers with three facts parsed from its note and has no `project` at all, and a
  // space is never demoted for being old: a missing value is "unknown", not "different".
  // `tasksRoot` is deliberately not compared: a moved or copied container is a supported
  // shape, and its record keeps the root it was made under.
  if (typeof recorded?.task === 'string' && recorded.task !== '' && recorded.task !== task) {
    throw coded(
      'E2007',
      `${taskPath} holds the record of task '${recorded.task}', not of '${task}', so nothing in it will be deleted.\n`
      + `  Recorded: ${recorded.task}\n`
      + `  Requested: ${task}\n`
      + '  If you meant that task, ask for it under the name its record uses.',
      { path: taskPath, recorded: recorded.task, requested: task },
    )
  }
  if (typeof recorded?.project === 'string' && recorded.project !== '' && recorded.project !== projectName) {
    throw coded(
      'E2007',
      `${taskPath} holds the record of a task in project '${recorded.project}', not in '${projectName}', so nothing in it will be deleted.\n`
      + `  Recorded: ${recorded.project}\n`
      + `  Requested: ${projectName}`,
      { path: taskPath, recorded: recorded.project, requested: projectName },
    )
  }
  // The caller's own answer, and nothing else. There is no policy to fall back on
  // any more: the tool refuses a `done` that does not say (E7006), and the panel
  // always says, so a merge happens exactly when the hand that called this asked
  // for one. `deleteBranch` keeps its conservative default - not deleting is the
  // half that can be walked back - so only an explicit true deletes.
  const merge = askedMerge === true
  const deleteBranch = askedDeleteBranch === true
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

  // What happens to the files git never tracked. The choice is this call's, and an
  // absent one is archive: the answer that neither loses the user's writing nor
  // leaves the task space standing. Everything it decides still passes the
  // isolation check a caller-named directory would.
  const strayed = applyStraysPolicy({
    strays: strayChoice,
    documentsDirectory,
    keepEntries,
  }, deliveryArchive, taskPath)
  const strayCleanStray = strayed.cleanStray
  const strayDiscardDocuments = strayed.discardDocuments
  const strayDestination = strayed.documentsDirectory
  // The entries this finish must leave where they are, whether the caller named
  // them or the removal fence refused them. `keep` is the name the loops below
  // have always used for it; the request parameter is `keepEntries` so that it
  // cannot be confused with `strays: 'keep'`, which is a different decision.
  const keep = strayed.keep
  if (strayDestination !== '') assertIsolated(taskPath, strayDestination)

  // The delivery gate is the one check here that reads the task's policy rather
  // than the caller's request. Its default is the hard refusal, which is what a
  // model-facing tool call meets; the panel can carry the user's own overrule
  // (`acknowledgeDelivery`), because the user's instruction outranks the policy -
  // and a bypassed gate is recorded as a warning, never silently.
  const gateWarning = await assertDeliveryGate(recorded, taskPath, { merge, bypass: acknowledgeDelivery === true })
  if (gateWarning !== undefined) warnings.push(gateWarning)

  // Before anything is read, so a checkout left under the probe name by a run that died
  // is recognised as the repository it is rather than taken for a worktree of its own.
  await recoverRemovalProbes(taskPath)

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
    // `needsCommit` and `dirtyCheckout` are the two ways a finish stops on work that is
    // not this side's to write, told apart from every other failure as a flag rather than
    // left to be recovered from the sentence. A caller that means to act on the stop - by
    // handing the work to a session - has to tell them from a conflict and from a plain
    // failure, and matching English is not a contract.
    const outcome = { name, path: worktreePath, mainRepo, branch, merged: false, removed: false, branchDeleted: false, conflict: false, mergeInProgress: false, mergeSite: '', conflictedFiles: [], needsCommit: false, dirtyCheckout: false }
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
      // Flagged, not just described: this is the stop the panel answers with "hand the
      // commits to the agent", and a tool caller has to reach the same answer.
      outcome.needsCommit = true
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
        // The other stop that is not this side's to write: the user's own checkout has
        // work a merge would overwrite. Flagged so a caller can tell it from a conflict -
        // there are no markers to reconcile here, and sending someone after them wastes
        // the trip.
        outcome.dirtyCheckout = dirtyCheckout
        // Whether a merge is genuinely unfinished, asked of git rather than inferred from
        // "the error was not E5004" - which is what this used to do, and it made every
        // failure a conflict. `resolveMergeTarget` throws E4008 from inside this `try`,
        // before any merge is started, and so do a `rev-parse` that would not answer and
        // the rehearsal in the task's own worktree when it fails without leaving a merge
        // behind. None of those has a MERGE_HEAD or a conflicted file to reconcile, so
        // marking them a conflict sent the reader after markers that do not exist, filed
        // the audit record as E5001 ("unmerged work") instead of E5003 (a plain failure),
        // and - through `summarize` - told the model the task had finished while dropping
        // the actual reason out of the summary entirely.
        //
        // Both checkouts are asked, because a merge can be left standing in either: the
        // task's own worktree is where the rehearsal runs, and the source repository is
        // where the real merge runs when it is the target. A merge standing in the
        // source checkout is the user's own and `mergeIntoBranch` refuses that as E5004
        // above, but asking here costs one `rev-parse` and keeps this answer the same
        // whichever path reached it.
        const standingInWorktree = !dirtyCheckout && await mergeInProgress(subprocess, worktreePath)
        const standingInMain = !dirtyCheckout && !standingInWorktree && mainRepo !== ''
          && await mergeInProgress(subprocess, mainRepo)
        outcome.mergeInProgress = standingInWorktree || standingInMain
        outcome.conflict = outcome.mergeInProgress
        if (outcome.mergeInProgress) {
          outcome.mergeSite = standingInWorktree ? worktreePath : mainRepo
          outcome.conflictedFiles = await conflictedFiles(subprocess, outcome.mergeSite)
        }
        // No abort here, and the reason is the whole of this guard. Everything that can
        // reach this catch either failed before a merge was ever started - `E4008` from
        // `resolveMergeTarget`, a `rev-parse` that would not answer, the rehearsal in the
        // task's own worktree, the unfinished-merge refusal above - or was already
        // aborted where it ran (`mergeIntoBranch` aborts its own merge in the source
        // checkout, and drops the temporary worktree it made for any other target).
        //
        // An `merge --abort` here would therefore only ever hit a checkout where this
        // call started nothing - and a checkout where the user has a merge of their own
        // standing is exactly such a checkout. Aborting that one discards a resolution
        // they may have written and staged by hand, with no reflog entry and no stash
        // behind it. This used to be unconditional, and it was the one irreversible loss
        // in this file.
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

  // The plugin's own directory - the JSON record, the note rendered from it, and the deploy
  // root the source root's scripts were copied into - goes once nothing this plugin opened is
  // still open. It goes whole and in one step: the record describes a task space that is being
  // taken down, the Markdown is generated from it, and the deploy root is a copied tree the
  // source root still has, so none of it outlives the last worktree it accounts for.
  //
  // Walking away from it is what leaves it out of the strays below: it is this plugin's own
  // bookkeeping rather than the user's writing, and filing a copy of the source root's scripts
  // into their documents directory would file something they already have. It is also the one
  // entry a finish must not leave standing by accident - a copied `deploy/` tree would hold the
  // task space open over nothing of the user's at all.
  //
  // `strays: 'keep'` is the one choice that leaves it, and it is deliberate: that caller asked
  // for the space exactly as it stands, and this directory is part of what stands there - so
  // the container stays with it, exactly as the caller asked. The legacy breadcrumb is a file
  // at the top level and goes on its own account.
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
  // The source root's index is a snapshot of this record, and the record can be written
  // after the index last was. The case that matters is a member's final report: it arrives
  // at the end, often while a finish is already running, and it is written beside a record
  // that is about to be removed. Taken again here - the last moment before the record goes -
  // so what this finish files into the archive is the state the task actually ended in,
  // rather than one an earlier write happened to capture. Best-effort, exactly like every
  // other write to that index: nothing below depends on it.
  const latest = await readTaskMetadata(taskPath).catch(() => undefined)
  if (latest !== undefined && latest !== null && typeof latest === 'object') {
    await writeSourceTaskIndex(taskPath, latest, taskSessionsOf(latest)).catch(() => false)
  }
  if (!stillOpen && strayCleanStray) {
    await rm(pluginRootPath(taskPath), { recursive: true, force: true })
    await rm(join(taskPath, BREADCRUMB), { force: true })
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
    // The plugin's own entries are not leftovers of anything - the record and the deploy
    // root alike. The record is kept on purpose when a repository stopped (a second
    // finish needs it), and the deploy root is a copied tree the source root still has,
    // so neither is the user's writing to file away or to discard. `planTask` skips them
    // for the same reason and has always had to.
    if (TASK_OWNED_ENTRIES.includes(entry.name)) continue
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
  // directory when one was named, discarded outright when the caller chose
  // `discard`. Build output and editor state are neither, and stay unless the
  // choice clears them - which `archive` and `discard` both do, and `keep` does not.
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
      //
      // A listing that stopped at its bound is not usable as a skip set, and the
      // difference matters more than it looks: the set is what the copy filters by, so a
      // link missing from it is a link `cp` then tries to recreate - the exact EPERM this
      // branch exists to avoid, arriving through the branch that was meant to prevent it.
      // "I found some links" and "I found every link" are different answers, and only the
      // second makes a filter safe, so the truncated case is told apart and handled
      // rather than treated as a short list.
      const seenLinks = await symlinksRefused() ? await findLinks(source) : { links: [], truncated: false }
      const links = seenLinks.truncated ? [] : seenLinks.links
      try {
        await mkdir(strayDestination, { recursive: true })
        if (seenLinks.truncated) {
          // Not filed at all, and said so. The stray is left where it is - which is the
          // same outcome as a failed copy, and for the same reason: half an archive is
          // worse than none, and the original is the thing that must survive.
          //
          // Completeness could be had by raising `maxEntries` until the walk finishes,
          // and that is deliberately not done here: the bound exists because this runs
          // while a person waits, and a tree with more entries than the bound is a tree
          // whose copy was never going to be quick. Refusing is honest about that;
          // walking it anyway would just move the wait.
          warnings.push(warned(
            'leftover-holds-links',
            `could not archive '${name}' into '${strayDestination}': it holds more entries than the link scan will walk, `
            + 'so whether it holds a link could not be settled - and a copy that cannot account for every link may stop part-way '
            + 'on one. It is left in the task space exactly as it stands.',
            { name, destination: strayDestination, links: [], truncated: true },
          ))
          keptByFailure.push(name)
          continue
        }
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
        // directories holding them. It is also in `keptByFailure`, so the clearing pass
        // will not delete it either: the entry was not filed, and removing it is the
        // user's to do.
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

  // The task's index, under the root it was cut from, is filed into that root's archive
  // and the live entry dropped. Filed rather than deleted because a finished task should
  // leave a trace: the archived copy keeps the task's basics, every session that worked
  // in it, when it was created and when it was finished. The facts come from the record
  // read above rather than from a caller's arguments - a member finishing its own work
  // passes no source root at all, and the record is where both flows agree. Best-effort:
  // the space is already gone, so a file that cannot be filed is a pointer left behind,
  // not a failed finish. Left alone when the space is still standing (documented files, a
  // stray kept), because then the task is still there and the live index is still true.
  if (containerRemoved) {
    const recordedSourceRoot = typeof recorded?.sourceRoot === 'string' ? recorded.sourceRoot : ''
    const recordedProject = typeof recorded?.project === 'string' && recorded.project !== '' ? recorded.project : projectName
    const recordedTask = typeof recorded?.task === 'string' && recorded.task !== '' ? recorded.task : task
    const indexFile = sourceTaskIndexPath(recordedSourceRoot, recordedProject, recordedTask)
    try {
      await archiveSourceTaskIndex(taskPath, {
        ...recorded,
        sourceRoot: recordedSourceRoot,
        project: recordedProject,
        task: recordedTask,
      })
    } catch {
      // `path` is the live index file, not the task space: the message is that this file
      // is still there pointing at a directory that is not, and a reader who wants to act
      // on it needs the file's own location.
      warnings.push(warned('task-index-left',
        `the task space was removed but its index could not be filed into the archive: ${indexFile} still points at a directory that is gone`,
        { path: indexFile, sourceRoot: recordedSourceRoot }))
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



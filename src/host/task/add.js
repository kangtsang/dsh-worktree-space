/**
 * Adding a repository to a task that already exists.
 *
 * A create answers "which repositories does this task span"; this answers "it
 * needs one more", which is the same work done against a container somebody is
 * already working in. So the guards are `createTask`'s, re-read against what the
 * container holds now, and the rollback is the one thing that cannot be the same:
 * a create that fails rolls back everything it made because everything it made is
 * new, while a failure here must leave every worktree the task already had exactly
 * where it was. Only what this call made is taken back.
 *
 * A repository added this way is named by an absolute path rather than by a name
 * under the task's source root, because it need not be under it: a task can reach
 * a repository that shares no directory with the ones it started from, and one on
 * another volume entirely. Nothing downstream depends on where it is — a finish
 * re-derives the source repository from the worktree itself — so the path is
 * recorded per repository and the task's own `sourceRoot` keeps describing where
 * the task began.
 */
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { auditEnter, recordError, recordEvent } from './audit-log.js'
import { ERROR_CODES, coded } from './codes.js'
import { sourceFacts } from './create.js'
import { isSourceRepository } from './discover.js'
import { gitSucceeded, parseWorktrees, runGit, tryRunGit } from './git.js'
import { validateProjectName, validateRepositoryDirectoryName } from './naming.js'
import { isInside, refuseDelete, samePathLocation } from './paths.js'

import { TASK_METADATA, TASK_README, isLinkedWorktree, listTaskWorktrees, pluginRootPath, readTaskMetadata, taskSpacePath, writeTaskMetadata } from './shared.js'

/**
 * The branch every repository of a task shares, read from the container itself.
 *
 * The metadata names it, and a space made before the JSON existed still names it
 * in the Markdown note, so this is a fallback rather than the usual answer — but
 * it is the answer when the record has been edited or deleted, and it comes from
 * the worktrees rather than from the task name: the branch is a ref, and a
 * container whose worktrees agree on one has named it whether or not anything
 * wrote it down. Disagreement or silence means nothing here can name it.
 * @param subprocess - the profile's subprocess service.
 * @param metadata - the record the container carries, if any.
 * @param worktrees - the container's worktrees as the filesystem reports them.
 * @returns the branch name, or undefined when the container does not name one.
 */
async function branchOf(subprocess, metadata, worktrees) {
  const recorded = typeof metadata?.branch === 'string' ? metadata.branch.trim() : ''
  if (recorded !== '') return recorded
  const seen = new Set(worktrees.map((entry) => entry.branch).filter(Boolean))
  return seen.size === 1 ? [...seen][0] : undefined
}

/**
 * Read the container's record, filling in what an older one cannot say.
 *
 * A space made before the JSON existed answers with three facts parsed out of its
 * Markdown note, and its repositories were never written down at all. Rather than
 * write that thin record back — which would replace a full list with one entry and
 * make the loss permanent — the missing part is read off the worktrees on disk,
 * which is where the truth is either way.
 * @param subprocess - the profile's subprocess service.
 * @param taskPath - the task space directory.
 * @param identity - `task`, `project` and `tasksRoot` as the caller named them.
 * @param metadata - what the container's record said, if it had one.
 * @param worktrees - the container's worktrees as the filesystem reports them.
 * @returns a record carrying every field this plugin writes.
 */
async function hydrated(subprocess, taskPath, identity, metadata, worktrees) {
  if (Array.isArray(metadata?.repositories) && metadata.repositories.length > 0) {
    // `version` after the spread, not before it: the record being upgraded is
    // itself the one that would otherwise put its own version back.
    return { ...metadata, version: 1, task: identity.task, project: identity.project, tasksRoot: identity.tasksRoot }
  }
  const repositories = []
  for (const entry of worktrees) {
    const porcelain = await tryRunGit(subprocess, entry.path, ['worktree', 'list', '--porcelain'])
    const mainRepo = parseWorktrees(porcelain).find((row) => row.isMain)?.path ?? ''
    const facts = await sourceFacts(subprocess, mainRepo === '' ? entry.path : mainRepo)
    repositories.push({
      name: entry.name,
      sourcePath: mainRepo,
      ...(facts.sourceBranch === undefined ? {} : { sourceBranch: facts.sourceBranch }),
      ...(facts.startCommit === undefined ? {} : { startCommit: facts.startCommit }),
      branch: entry.branch ?? '',
    })
  }
  return {
    ...metadata,
    version: 1,
    task: identity.task,
    project: identity.project,
    tasksRoot: identity.tasksRoot,
    baseRef: metadata?.baseRef ?? null,
    repositories,
  }
}

/**
 * Reject a repository whose worktree would land inside it.
 *
 * `assertIsolated` refuses the same two shapes, but it is phrased for a create:
 * these are two directories inside one another whichever way round they are named,
 * and the reader here needs to know which is inside which.
 * @param taskPath - the task space directory the worktree would go into.
 * @param repoPath - the source repository.
 * @param name - the repository's directory name, for the message.
 * @throws IsolationError-shaped errors E1002 and E1003.
 */
function assertAddIsolated(taskPath, repoPath, name) {
  if (samePathLocation(taskPath, repoPath)) {
    throw coded('E1002', `'${name}' is the task space itself, so its worktree would be written inside it`)
  }
  if (isInside(taskPath, repoPath)) {
    throw coded('E1002', `'${name}' sits inside the task space at ${repoPath}, so its worktree would be written into the task space; add a source repository instead`)
  }
  if (isInside(repoPath, taskPath)) {
    throw coded('E1003', `'${name}' at ${repoPath} holds the task space, so a worktree cut from it would be part of itself`)
  }
}

/**
 * Take back only what this call made.
 *
 * Each worktree was created seconds ago by this call and handed to nobody, so a
 * forced removal is safe and is the only reliable way to clean a half-registered
 * worktree. The task's own worktrees are not touched, and neither is its metadata:
 * the record is only written once every worktree exists, so a failure before that
 * leaves nothing to undo.
 *
 * Removing the worktree is only half of what has to go back. `worktree add -b` made
 * the branch, and git does not delete a branch with the checkout that held it, so the
 * branch is deleted here too - the same second step `create.js` takes. Left behind it
 * keeps the name, and the name is the one thing a later create or add cannot work
 * around: the next attempt at this task is refused as a branch already in use, in
 * every repository the branch reached, with nothing in the plugin able to clear it.
 * @param subprocess - the profile's subprocess service.
 * @param tasksRoot - the container root, the fence every removal is held to.
 * @param branch - the branch this call created with `worktree add -b`.
 * @param created - the worktrees this call made, in the order it made them.
 * @returns the names of the worktrees, or branches, that could not be taken back.
 */
async function rollbackAdded(subprocess, tasksRoot, branch, created) {
  const stranded = []
  for (const entry of created) {
    // Same fence as everywhere else: git does this removal, so nothing else in
    // this plugin stands between it and a directory that is no longer the one
    // this call created.
    const refused = refuseDelete(tasksRoot, entry.path, `the worktree '${entry.name}'`)
    if (refused !== '') { stranded.push(entry.name); continue }
    const removed = await gitSucceeded(subprocess, entry.repoPath, ['worktree', 'remove', '--force', entry.path])
    if (!removed && await isLinkedWorktree(entry.path)) {
      // A checkout git really made that this call could not take back: a leftover in its
      // own right, and still holding the branch, so the branch is left alone - git refuses
      // to delete one a worktree has checked out, and claiming otherwise would report a
      // removal that did not happen.
      //
      // The disk is what decides this, and that is the correction to the obvious reading
      // of "a worktree git never created is simply reported as stranded". The entry is in
      // this list because it was pushed BEFORE `worktree add` ran - so a checkout git made
      // and then failed on is inside this rollback's scope - and that also puts entries
      // here for a refusal before anything was made at all. Reporting one of those as
      // stranded names a leftover that is not on disk, and `create.js` has the sharper
      // version of the same consequence: a non-empty `stranded` keeps the container, which
      // with no record takes the name for good. So only a real checkout is a leftover.
      stranded.push(entry.name)
      continue
    }
    if (!removed) {
      // No checkout on disk, so git never got as far as registering one - but git creates
      // the ref BEFORE the checkout, so a branch with this name can still have been left
      // behind, and an orphan branch takes the name exactly as an orphan worktree does.
      // Whether it is really there is asked rather than assumed: with nothing holding it,
      // `-D` fails for the only reason it ever fails there - no such branch - which is the
      // ordinary answer for a refusal that never began, and not a leftover to report.
      if (await gitSucceeded(subprocess, entry.repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
        && !(await gitSucceeded(subprocess, entry.repoPath, ['branch', '-D', '--', branch]))) {
        stranded.push(`${entry.name}'s branch ${branch}`)
      }
      continue
    }
    // Only after the worktree is gone: a worktree still on disk is still holding this
    // branch, and git would refuse to delete it. The removal succeeded, so this call's own
    // `worktree add` did make the branch, and `-D` is unconditional rather than gated on a
    // second question. `-D` because the branch has no commits of its own yet and can have
    // none now, and `--` for the reason archive.js gives - this is one of the calls here
    // that leaves the container.
    if (!(await gitSucceeded(subprocess, entry.repoPath, ['branch', '-D', '--', branch]))) {
      stranded.push(`${entry.name}'s branch ${branch}`)
    }
  }
  return stranded
}

/**
 * Put the container's record back the way it was.
 *
 * The record is written after the worktrees, so a failure there can leave it
 * describing repositories whose worktrees are about to be taken back, and the two
 * files that make up that record are written one after the other - which is what
 * makes "there was no record before this call" its own case rather than an easy
 * one. The record this call wrote would then be the only one there is, naming a
 * repository the task no longer has, and the next request to add that repository
 * is refused as a name already taken against a task space that never took it.
 *
 * So each file is put back on its own account: one this call found is rewritten
 * byte for byte, one this call made is taken away again. Best effort, because a
 * container that cannot be written to is a container the write already failed in.
 * @param taskPath - the task space directory.
 * @param previousJson - the JSON file's contents before this call, or undefined.
 * @param previousReadme - the note's contents before this call, or undefined.
 */
async function restoreMetadata(taskPath, previousJson, previousReadme) {
  for (const [name, before] of [[TASK_METADATA, previousJson], [TASK_README, previousReadme]]) {
    try {
      if (before === undefined) {
        // `force`, not `recursive`: what came out of here is a file this plugin
        // wrote, and a directory sitting where it belongs is that path's own
        // problem to have, not this rollback's to clear by force.
        await rm(join(pluginRootPath(taskPath), name), { force: true })
      } else {
        await writeFile(join(pluginRootPath(taskPath), name), before, 'utf8')
      }
    } catch {
      // Reported by the caller's own outcome, not here: the worktrees are already
      // gone either way, and a record that could not be rewritten is the next
      // person's problem to see rather than this one's to mask. Each file is done
      // on its own so that one that cannot be written does not strand the other.
    }
  }
}

/**
 * Add repositories to a task space that already exists.
 *
 * Everything is checked before anything is made: every named path is a source
 * repository, none of them is the task space or inside it or holding it, none of
 * them is named like a worktree the task already has, the task's branch is free in
 * each, and the base is one each of them has. Only then are the worktrees cut.
 *
 * The worktrees join the branch the task is already on, not a new one — that
 * shared branch is what links a task's commits across repositories — and they
 * start from `baseRef` when one is given and from each repository's own HEAD when
 * it is not, which is the same rule a create follows.
 * @param subprocess - the profile's subprocess service.
 * @param options - `task`, `project` and `tasksRoot` name the task space;
 *   `repositories` are absolute paths to source repositories, which may sit
 *   anywhere on disk and need share nothing with each other; `baseRef` is the
 *   optional commit to start from.
 * @returns the task's branch, container path, and the repositories this call added.
 * @throws Error when the task space is missing, unusable, or any guard above
 *   refuses; after taking back the worktrees this call made, when it fails partway.
 */
export async function addTaskRepositories(subprocess, options) {
  const { task, project, tasksRoot, repositories, baseRef } = options

  if (typeof tasksRoot !== 'string' || tasksRoot.trim() === '') throw coded('E1004', 'a tasks root is required')
  if (!Array.isArray(repositories) || repositories.length === 0) {
    throw coded('E4001', 'name at least one repository to add to the task')
  }
  const projectName = validateProjectName(project)
  const taskPath = taskSpacePath(tasksRoot, projectName, task)
  if (!existsSync(taskPath)) throw coded('E2003', `no such task space: ${taskPath}`, { path: taskPath })
  auditEnter({ task, project: projectName, tasksRoot: tasksRoot.trim() })

  const worktrees = await listTaskWorktrees(subprocess, taskPath)
  if (worktrees.length === 0) {
    throw coded('E2004', `no git worktrees found in ${taskPath}, so there is no branch this task can be extended on`, { path: taskPath, reason: 'no-worktrees-to-extend' })
  }
  const metadata = await readTaskMetadata(taskPath)
  const branch = await branchOf(subprocess, metadata, worktrees)
  if (branch === undefined) {
    throw coded('E2004', `the worktrees in ${taskPath} do not agree on a branch, so this task cannot be extended; finish it or name a new task`, { path: taskPath, reason: 'branches-disagree' })
  }
  const recorded = await hydrated(subprocess, taskPath, { task, project: projectName, tasksRoot: tasksRoot.trim() }, metadata, worktrees)

  // The names already in use: what the record lists, plus what the directory holds
  // right now. A container whose metadata was deleted or hand-edited still has its
  // worktrees, and a name is taken by either.
  const taken = new Set([
    ...worktrees.map((entry) => entry.name),
    ...(Array.isArray(recorded.repositories) ? recorded.repositories.map((entry) => entry?.name) : []),
  ])

  const start = typeof baseRef === 'string' && baseRef.trim() !== '' ? baseRef.trim() : undefined
  const selected = []
  for (const raw of repositories) {
    const repoPath = typeof raw === 'string' ? raw.trim() : ''
    if (repoPath === '') throw coded('E4005', 'a repository path is required')
    // The name this repository would take in the task space, checked as the
    // directory name it is before anything else is asked about it. `taken` below
    // catches a collision with a worktree the task already has, but it cannot catch
    // a collision with the plugin's *own* entries - `.worktree-space` is not a
    // worktree, so nothing in that set is it, and a repository by that name would
    // put a checkout where the record and the deploy root live. `basename` returning
    // `.` or `..` is refused for the same reason: `join(taskPath, '..')` is the
    // project layer, one level above the task space.
    const name = validateRepositoryDirectoryName(basename(repoPath))
    // Two of the repositories being added, before the ones the task already has:
    // the first is a choice this request made twice, the second is a name the task
    // took before it, and they are fixed differently.
    if (selected.some((entry) => entry.name === name)) {
      throw coded('E4002', `two of the repositories to add are both named '${name}'`)
    }
    if (taken.has(name)) {
      throw coded('E4002', `the task space already holds a repository named '${name}'; every worktree in a task is named after its source repository, so two repositories cannot share one name`)
    }
    if (!(await isSourceRepository(repoPath))) {
      throw coded('E6001', `not a source repository: ${repoPath}`)
    }
    assertAddIsolated(taskPath, repoPath, name)
    if (await gitSucceeded(subprocess, repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) {
      throw coded(
        'E3001',
        `branch '${branch}' already exists in '${name}'; a worktree cannot be named after a branch that is already there, and cutting one would point this task at work already in progress`,
      )
    }
    if (start !== undefined && !(await gitSucceeded(subprocess, repoPath, ['rev-parse', '--verify', '--quiet', `${start}^{commit}`]))) {
      throw coded('E3002', `base '${start}' not found in '${name}'`)
    }
    taken.add(name)
    // The validated name travels with the path rather than being recomputed at the
    // copy: the guard above approved one string, and a second `basename` at the join
    // would be a second answer to the same question.
    selected.push({ repoPath, name })
  }

  // Read before the first worktree exists, so a rollback has the record as it was
  // rather than as it would have been written. The note is read beside it because
  // the two are written one after the other, so a container that held only one of
  // them is a real state and each has to be put back on its own account.
  const previousJson = await readFile(join(pluginRootPath(taskPath), TASK_METADATA), 'utf8').catch(() => undefined)
  const previousReadme = await readFile(join(pluginRootPath(taskPath), TASK_README), 'utf8').catch(() => undefined)

  const created = []
  try {
    for (const { repoPath, name } of selected) {
      const worktreePath = join(taskPath, name)
      // The source facts describe the checkout the worktree is cut from, so they
      // are read before the branch exists, exactly as a create reads them.
      const facts = await sourceFacts(subprocess, repoPath)
      const args = start === undefined
        ? ['worktree', 'add', worktreePath, '-b', branch]
        : ['worktree', 'add', worktreePath, '-b', branch, start]
      // Pushed BEFORE git runs, for the same reason `create.js` does it: `worktree add`
      // can create the branch and the directory and then fail, and a half-made worktree
      // that is not in this list is one the rollback never removes. Here the container
      // belongs to a task that already exists, so the cost is a stray checkout rather
      // than a lost name - but the branch it holds would still be left behind, and the
      // rollback is what reports either. The two call sites are the same omission and
      // are kept in step; see `rollbackAdded` for how an entry git never created is
      // told from one it did.
      created.push({ name, path: worktreePath, repoPath, ...facts })
      await runGit(subprocess, repoPath, args)
    }

    await writeTaskMetadata(taskPath, {
      ...recorded,
      branch,
      // The task's `baseRef` is NOT rewritten by an add, and that is the whole of this
      // line's job. It used to read `start ?? recorded.baseRef ?? null`, which let one
      // add that named a base overwrite the fact the CREATE recorded - so a task created
      // from `main` and later extended with `baseRef: v1.2.0` would have its record say
      // it was based on `v1.2.0`, and the repositories added at create time would be
      // described by a base they were never cut from.
      //
      // It is not that both values are unknowable; it is that the field answers one
      // question - "where did this task start" - and an add does not change the answer.
      // What this call used is a fact about the repositories *this call* added, and it is
      // already recorded on those entries: `startCommit` is the commit each checkout was
      // actually cut from, which is a stronger statement than the ref that named it. A
      // separate per-entry `baseRef` is deliberately NOT written - nothing reads it, and a
      // field that is only ever written is one no test can hold to an interpretation.
      //
      // The field has exactly one writer (the create) and one reader (the note rendered
      // for a session), which is what makes "one question, one writer" true here rather
      // than aspirational. The base this call used is reported to the caller as
      // `result.baseRef` and recorded in the audit line, so the fact is not lost - it is
      // just not written into the task's identity, where it would be a second answer to a
      // question the create already answered.
      //
      // `recorded.baseRef ?? null` is kept rather than dropped: it normalises a record
      // that predates the field, and `null` is what `taskMetadata` writes for "no base was
      // named", so a rewritten record keeps the same shape it was read with.
      baseRef: recorded.baseRef ?? null,
      repositories: [
        ...(Array.isArray(recorded.repositories) ? recorded.repositories : []),
        ...created.map((entry) => ({
          name: entry.name,
          sourcePath: entry.repoPath,
          ...(entry.sourceBranch === undefined ? {} : { sourceBranch: entry.sourceBranch }),
          ...(entry.startCommit === undefined ? {} : { startCommit: entry.startCommit }),
          branch,
          addedAt: new Date().toISOString(),
        })),
      ],
    })
  } catch (error) {
    const stranded = await rollbackAdded(subprocess, tasksRoot, branch, created)
    await restoreMetadata(taskPath, previousJson, previousReadme)
    const suffix = stranded.length === 0 ? '' : ` (could not roll back: ${stranded.join(', ')})`
    // One code, decided here, for the record below and the error the caller
    // reads: `recover` takes the code off the error and no caller hands it a
    // classifier, so an error rebuilt without one reaches the caller as E9001
    // while the log says E2005 - the same failure under two names, which is
    // what these codes exist to prevent. A failure that carries one of ours keeps
    // it, and one from outside the table does not: a Node filesystem error brings
    // a `code` of its own (`EISDIR`), and `recover` would flatten it anyway.
    const own = typeof error?.code === 'string' && Object.hasOwn(ERROR_CODES, error.code) ? error.code : ''
    const code = own !== '' ? own : (stranded.length === 0 ? 'E2005' : 'E2006')
    // The two outcomes again, because "rolled back" and "left something behind"
    // call for different amounts of attention and neither is in the message: the
    // task's own worktrees are untouched either way, and only this call's are named.
    await recordError(error, {
      phase: 'add',
      code,
      msg: stranded.length === 0
        ? `Adding repositories to '${task}' failed. The worktrees this call made were taken back, so the task is exactly as it was and the same repositories can be added again.`
        : `Adding repositories to '${task}' failed and the worktrees this call made could not all be removed. The ones named in \`stranded\` are still on disk; the task's own repositories were not touched.`,
      ...(created.length === 0 ? {} : { created: created.map((entry) => entry.name) }),
      ...(stranded.length === 0 ? {} : { stranded }),
    })
    // Rebuilt rather than rethrown, because what the rollback managed is part of
    // what the caller has to be told; the code rides over for the reason above.
    const rolled = new Error(`${error.message}${suffix}`)
    rolled.code = code
    throw rolled
  }

  await recordEvent(
    'info',
    `Added ${created.length} repositor${created.length === 1 ? 'y' : 'ies'} to the task space. ${created.map((entry) => entry.name).join(', ')} now has a worktree on ${branch} alongside the ones it already had, and the task metadata records where each source repository lives.`,
    { phase: 'add', branch, path: taskPath, added: created.map((entry) => entry.name) },
  )

  return {
    task,
    project: projectName,
    branch,
    path: taskPath,
    tasksRoot: tasksRoot.trim(),
    baseRef: start,
    repositories: created.map((entry) => ({ name: entry.name, path: entry.path, sourcePath: entry.repoPath })),
  }
}
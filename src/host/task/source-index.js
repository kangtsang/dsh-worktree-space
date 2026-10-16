/**
 * The task index a source root keeps, beside the deploy root it already owns.
 *
 * ## What this is for
 *
 * A task's own record lives inside the task space
 * (`<task space>/.worktree-space/worktree-space.json`). That is the authority, and it
 * stays the authority - but reading it means knowing the container root, which is the
 * one thing a session working in the source checkout does not have. So each task is
 * also indexed under the root it was cut from, at
 * `<source root>/.worktree-space/tasks/<project>/<task>.json`, and the file names the
 * task space's absolute path so a reader can go and check it.
 *
 * The index is a **directory of tasks, not a second record**. It carries the task's
 * basics and the sessions that have worked in it, and nothing here is ever the answer
 * to a question the task's own record can answer better. Two consequences follow, and
 * both are deliberate:
 *
 *   - **It is written best-effort.** A record that cannot be written fails an
 *     operation; an index that cannot be written must not, because a read-only checkout
 *     is a supported place to work from and losing a dispatch over bookkeeping would be
 *     the worse trade. Every failure here is silent to the caller and non-fatal.
 *   - **A reader must verify `taskPath`.** The file can outlive the task - a finish that
 *     could not delete it, a container removed by hand - so "the index exists" is not
 *     "the task space exists". {@link readSourceTaskIndex} returns what is on disk and
 *     leaves that check to the caller, which is the only side that can decide what to do
 *     about a stale entry.
 *
 * ## Why it sits beside `deploy/` rather than inside it
 *
 * `<source root>/.worktree-space/deploy/` is the orchestration root the workspace owns,
 * and a create copies it **whole** into every task space made from that root. An index
 * written inside it would therefore travel into every task - naming sessions that are
 * not that task's - and would be copied again from there. `tasks/` is a sibling, so the
 * copy never sees it. The layout is:
 *
 *     <source root>/.worktree-space/
 *     ├── deploy/          the workspace's own scripts, copied into each task space
 *     └── tasks/<project>/<task>.json    this index, never copied anywhere
 *
 * ## What it deliberately is not
 *
 * It is not a way to reach a session. The session tools bound what they may act on to
 * the sessions this plugin wrote down, and a lookup table of ids would let a caller
 * reach anything it could name in a file it can edit. Nothing in the guard reads this.
 * @module dsh-worktree-space/source-index
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { localStamp } from './audit-log.js'

/**
 * The plugin's own directory name, held here rather than imported from `shared.js`.
 *
 * `shared.js` is the module that records sessions, and recording is what writes this index
 * - so this file importing `shared.js` for the constant would close a cycle
 * (`shared.js` -> `source-index.js` -> `shared.js`).
 *
 * It is **exported**, because more than one reader needs it beside the things this file
 * owns: `shared.js` itself and the session tools both look for `.worktree-space/<tasks>`
 * while reading an index. One spelling with two readers is the point; a second copy of
 * the string is what this export exists to prevent.
 */
export const PLUGIN_ROOT = '.worktree-space'

/**
 * The directory the task index lives in, relative to the plugin's own directory.
 *
 * A sibling of `deploy` under {@link PLUGIN_ROOT}, for the reason the module comment
 * gives: the deploy root is copied into task spaces and this must not be.
 */
export const SOURCE_TASKS_DIR = 'tasks'

/**
 * Where one task's index file goes.
 *
 * The project layer repeats the container's own shape (`<container root>/<project>/<task>`),
 * so two projects' tasks of the same name stay apart here exactly as they do there.
 * @param sourceRoot - the root the task was cut from.
 * @param project - the source root's own directory name, as the record spells it.
 * @param task - the task name.
 * @returns the absolute path of the index file.
 */
export function sourceTaskIndexPath(sourceRoot, project, task) {
  return join(sourceRoot, PLUGIN_ROOT, SOURCE_TASKS_DIR, project, `${task}.json`)
}

/**
 * The task's basics plus the sessions that have worked in it.
 *
 * Built from the task's own record rather than from the caller's arguments, so the two
 * cannot disagree about what the task is: whichever side wrote the record is the side
 * this reads. `taskPath` is added because the file sits under a different root than the
 * task space does, and a reader that cannot reach the space cannot act on the entry.
 *
 * `sessions` arrives **already normalized** - `{ sessionId, at?, role }` entries - and
 * is not re-parsed here: the recorder has `normalizeSessions` in hand, and a second
 * parser for one field shape is the drift this repository has been bitten by before.
 * @param taskPath - the task space's absolute path.
 * @param metadata - the task's record, as read from that space.
 * @param sessions - the record's sessions, normalized by the caller.
 * @param previous - the index as it was, for `createdAt`.
 * @returns the index document.
 */
function indexOf(taskPath, metadata, sessions, previous) {
  // Both stamps are the readable local `YYYY-MM-DD HH:MM:SS` the audit log writes - not
  // ISO. A reader of this file is a person looking at a checkout, asking when a task
  // appeared and when it ended, and the same clock for both means the two can be compared
  // by eye. A record whose `createdAt` is present but unreadable falls back to now rather
  // than carrying a shape nothing else in the plugin writes.
  const created = stampToLocal(previous?.createdAt)
    ?? stampToLocal(metadata?.createdAt)
    ?? localStamp()
  return {
    version: 1,
    task: metadata?.task,
    project: metadata?.project,
    taskPath,
    tasksRoot: metadata?.tasksRoot,
    sourceRoot: metadata?.sourceRoot,
    branch: metadata?.branch,
    // The repositories, trimmed to what a reader needs to find them again - the same
    // three facts a record keeps for the same reason.
    repositories: (Array.isArray(metadata?.repositories) ? metadata.repositories : []).map((entry) => ({
      name: entry?.name,
      sourcePath: entry?.sourcePath,
      ...(entry?.branch === undefined ? {} : { branch: entry.branch }),
    })),
    sessions: sessions.map((entry) => ({
      sessionId: entry.sessionId,
      at: entry.at,
      role: entry.role,
      // Carried through, like every other field here, and for a sharper reason than the
      // rest: this file is what a finish archives, so a `reportedAt` dropped here is the
      // one that matters most - the archived copy is all a reader has once the task space
      // is gone, and its absence reads as "this session never reported".
      ...(entry.reportedAt === undefined ? {} : { reportedAt: entry.reportedAt }),
    })),
    createdAt: created,
    updatedAt: localStamp(),
  }
}

/**
 * The readable form of a stamp that may already be readable, or may be ISO.
 *
 * The task's own record writes `createdAt` as `toISOString()`; this file writes the
 * readable local form. Converting rather than copying keeps one shape in one file, which
 * is what makes "sort these by eye" work.
 * @param value - a stamp from either side.
 * @returns the local form, or undefined when the value is not a usable date.
 */
function stampToLocal(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : localStamp(date)
}

/**
 * Write (or refresh) the index for one task.
 *
 * Reads the previous file first, only so `createdAt` describes when the task appeared
 * rather than when the index was last touched. A previous file that cannot be read is
 * not an error: the newest write wins and the timestamp starts again.
 *
 * Every failure is thrown, and the caller decides what to do with it - which for the one
 * production caller means nothing at all (see the module comment). Swallowing the error
 * here instead would leave the caller unable to tell a written index from a failed one,
 * and there is one place where that matters: whether to report it as a warning.
 * @param taskPath - the task space's absolute path.
 * @param metadata - the task's record.
 * @param sessions - the record's sessions, normalized by the caller.
 * @throws when the directory cannot be made or the file cannot be written.
 */
export async function writeSourceTaskIndex(taskPath, metadata, sessions = []) {
  const sourceRoot = typeof metadata?.sourceRoot === 'string' ? metadata.sourceRoot.trim() : ''
  const project = typeof metadata?.project === 'string' ? metadata.project.trim() : ''
  const task = typeof metadata?.task === 'string' ? metadata.task.trim() : ''
  // No root named means no directory this plugin may claim. Guessing one - the task's
  // parent, the container root - would put plugin state somewhere nobody asked for, and
  // an absent `sourceRoot` is a supported shape (a moved space, an `add-repositories`).
  if (sourceRoot === '' || project === '' || task === '') return false
  const file = sourceTaskIndexPath(sourceRoot, project, task)
  const previous = await readSourceTaskIndex(file)
  await mkdir(join(sourceRoot, PLUGIN_ROOT, SOURCE_TASKS_DIR, project), { recursive: true })
  await ensureIgnoreFile(sourceRoot)
  await writeFile(file, `${JSON.stringify(indexOf(taskPath, metadata, sessions, previous), null, 2)}\n`, 'utf8')
  return true
}

/**
 * Make sure the plugin's own directory ignores the files it writes itself - but only
 * when the source root is the root of a git repository.
 *
 * ## Why only then
 *
 * The ignore file exists to keep git from showing plugin state in a checkout's
 * `git status`. A source root that is not a repository has no `git status` to dirty, so
 * a `.gitignore` there would be a file nobody reads, written into a directory this
 * plugin was given only so it could keep an index. So the file is written **only when
 * the root itself is a repository**, and nothing is written otherwise. Note which
 * directory is asked: the repository question is about the **source root**, and the file
 * is written into `<source root>/.worktree-space/`. Asking the plugin's own directory
 * whether it is a repository would always answer no, and the file was silently never
 * written until a test caught it.
 *
 * "The root itself is a repository" is `git rev-parse --show-toplevel` answering this
 * directory, and it is decided here without running git: a top-level repository has its
 * `.git` at exactly this level, as a directory (a `git init`) or as a file (a linked
 * worktree). A root nested inside a repository therefore gets nothing: the index would
 * still be untracked, but an ignore file here cannot change that - git applies the
 * enclosing repository's rules - and inventing state for a directory that is not that
 * repository's own root is not this plugin's call.
 *
 * ## What it ignores, and what it deliberately does not
 *
 *   - `tasks/` and `tasks-archive/` are this plugin's own bookkeeping, ignored;
 *   - `deploy/` is the workspace's own scripts and is **not** ignored: whether that is
 *     versioned is the workspace's decision, not the plugin's.
 *
 * A pattern here is relative to the directory the file sits in, so `tasks/` means
 * `<source root>/.worktree-space/tasks/` and not some other `tasks` directory elsewhere
 * in the checkout - verified against real git rather than assumed.
 *
 * Written only when absent, and never overwritten: a workspace that already has its own
 * opinion here keeps it, and then it is that file which decides.
 * @param sourceRoot - the workspace root (absolute).
 */
async function ensureIgnoreFile(sourceRoot) {
  const file = join(sourceRoot, PLUGIN_ROOT, '.gitignore')
  if (existsSync(file)) return
  // `.git` is a directory for an ordinary repository and a file for a linked worktree,
  // so existence is the question and `statSync().isDirectory()` deliberately is not.
  if (!existsSync(join(sourceRoot, '.git'))) return
  await writeFile(file, `${SOURCE_TASKS_DIR}/\n${SOURCE_TASKS_ARCHIVE_DIR}/\n`, 'utf8')
}

/**
 * The index file for one task, or undefined when there is none to read.
 *
 * Returned as parsed JSON with no validation beyond "it is an object": the file is this
 * plugin's own, and a hand-edited or half-written one is a thing to look at rather than
 * a reason to refuse. A caller that needs a field checks for it.
 * @param file - the index file's absolute path.
 * @returns the document, or undefined.
 */
export async function readSourceTaskIndex(file) {
  const text = await readFile(file, 'utf8').catch(() => '')
  if (text.trim() === '') return undefined
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * The directory finished tasks' indexes are filed into, beside the live ones.
 *
 * The same shape as the task-space archive (`archived-docs/<project>/<task>-<stamp>/`
 * under the container root), one layer along: the indexes live under the source root,
 * so their archive does too, and both are `<project>/<stamp>-<task>` on the inside.
 */
export const SOURCE_TASKS_ARCHIVE_DIR = 'tasks-archive'

/**
 * How many archived indexes one project keeps.
 *
 * Ten is the maintainer's number. The point of the archive is that a finished task
 * leaves a trace rather than vanishing, not that the trace is permanent: every finish
 * files one file, and a source root worked in for a year would otherwise carry hundreds
 * of them. Ten is also small enough that a reader can see the recent history at a glance.
 */
export const SOURCE_TASKS_KEEP = 10

/** The stamp a filename can carry, from the same clock the log's records use. */
function fileStamp(date = new Date()) {
  return localStamp(date).replace(/[: ]/g, '-')
}

/**
 * File a finished task's index into the archive, and drop the oldest beyond the cap.
 *
 * Called where the index used to be deleted. The index is removed afterwards - the
 * task is over, so the live entry must not survive it - and everything a later reader
 * wants is in the archived copy: the task's basics, every session that worked in it,
 * `createdAt`, and now `finishedAt`.
 *
 * `finishedAt` is written in the same local `YYYY-MM-DD HH:MM:SS` form the audit log
 * uses, and the filename carries the same stamp with its `:` and spaces turned into
 * `-`. That is what makes pruning safe rather than clever: the name begins with
 * `YYYY-MM-DD-HH-MM-SS`, so a lexicographic sort **is** a chronological one, and the
 * oldest files are the ones at the front of the sorted list.
 *
 * A task with no index to file is not a failure: the write is best-effort by design, so
 * "finished a task whose index was never written" is an ordinary state. The caller
 * decides whether to say anything about it.
 * @param taskPath - the task space's absolute path.
 * @param metadata - the task's record, as read before the space was removed.
 * @param keep - how many archived indexes to keep for this project; 10 unless a test says otherwise.
 * @returns whether an index was filed.
 * @throws when the archive or the live file cannot be written; the caller decides.
 */
export async function archiveSourceTaskIndex(taskPath, metadata, keep = SOURCE_TASKS_KEEP) {
  const sourceRoot = typeof metadata?.sourceRoot === 'string' ? metadata.sourceRoot.trim() : ''
  const project = typeof metadata?.project === 'string' ? metadata.project.trim() : ''
  const task = typeof metadata?.task === 'string' ? metadata.task.trim() : ''
  if (sourceRoot === '' || project === '' || task === '') return false
  const live = sourceTaskIndexPath(sourceRoot, project, task)
  const record = await readSourceTaskIndex(live)
  if (record === undefined) return false

  const directory = join(sourceRoot, PLUGIN_ROOT, SOURCE_TASKS_ARCHIVE_DIR, project)
  await mkdir(directory, { recursive: true })
  const finishedAt = localStamp()
  // A finish and the archive's own previous run can land in the same second, and two
  // files of one name would mean one of them silently replacing the other - the failure
  // this repository has already met once, in the log rotation.
  let file = join(directory, `${fileStamp()}-${task}.json`)
  for (let counter = 1; existsSync(file); counter += 1) {
    file = join(directory, `${fileStamp()}-${task}-${counter}.json`)
  }
  await writeFile(file, `${JSON.stringify({ ...record, finishedAt }, null, 2)}\n`, 'utf8')
  // The live index goes only once the archive is on disk. The other order would lose the
  // entry outright if the write failed, and this file has no other copy.
  await rm(live, { force: true })
  await pruneSourceTaskArchive(sourceRoot, project, keep)
  return true
}

/**
 * Drop the oldest archived indexes for one project, beyond `keep`.
 *
 * Sorted by modification time, newest first, with the name only breaking a tie: the
 * name is not a reliable clock. It starts with `YYYY-MM-DD-HH-MM-SS`, which sorts
 * chronologically only while the stamps differ - two tasks finished in the same second
 * diverge after the stamp, so the name order between them is the alphabet's and not
 * time's, and pruning on it would drop the wrong file. `mtime` is the fact the archive
 * already has.
 * @param sourceRoot - the root the tasks were cut from.
 * @param project - the project layer.
 * @param keep - how many to leave.
 * @returns the names it removed, oldest first.
 */
export async function pruneSourceTaskArchive(sourceRoot, project, keep = SOURCE_TASKS_KEEP) {
  const root = typeof sourceRoot === 'string' ? sourceRoot.trim() : ''
  const layer = typeof project === 'string' ? project.trim() : ''
  if (root === '' || layer === '' || !Number.isInteger(keep) || keep < 1) return []
  const directory = join(root, PLUGIN_ROOT, SOURCE_TASKS_ARCHIVE_DIR, layer)
  const names = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith('.json'))
  const dated = []
  for (const name of names) {
    const info = await stat(join(directory, name)).catch(() => undefined)
    dated.push({ name, at: info === undefined ? 0 : info.mtimeMs })
  }
  // Newest first. The name breaks a tie so the order cannot depend on how the filesystem
  // reported two files written in the same tick.
  dated.sort((left, right) => (right.at - left.at) || right.name.localeCompare(left.name))
  const doomed = dated.slice(Math.max(0, keep)).map((entry) => entry.name)
  for (const name of doomed) await rm(join(directory, name), { force: true })
  return doomed
}

/**
 * One task's archived sessions, read back for a session the archive names.
 *
 * This is the read that outlives the task space. A `done` files the live index here and
 * removes the space, so a question asked after the finish - "did this session hand over
 * its report?" - has this directory and nothing else to answer it. The entry is returned
 * rather than a boolean because the meaning of its fields belongs to the caller; this
 * reader only reports what the archive says.
 *
 * The newest record naming that session wins. One task name can be used twice, so several
 * archives can carry it, and the session ids are what tell those tasks apart: the file
 * holding this session is the file describing its task. "Newest" is the filename, because
 * the name begins with the `YYYY-MM-DD-HH-MM-SS` stamp {@link archiveSourceTaskIndex}
 * wrote, which sorts chronologically.
 * @param sourceRoot - the root the task was cut from.
 * @param project - the project layer.
 * @param task - the task name.
 * @param sessionId - the session to look for.
 * @returns its entry as the archive holds it, or undefined when no archive names it.
 */
export async function readArchivedTaskSession(sourceRoot, project, task, sessionId) {
  const root = typeof sourceRoot === 'string' ? sourceRoot.trim() : ''
  const layer = typeof project === 'string' ? project.trim() : ''
  const name = typeof task === 'string' ? task.trim() : ''
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (root === '' || layer === '' || name === '' || id === '') return undefined
  const directory = join(root, PLUGIN_ROOT, SOURCE_TASKS_ARCHIVE_DIR, layer)
  const files = (await readdir(directory).catch(() => [])).filter((file) => file.endsWith('.json'))
  files.sort((left, right) => right.localeCompare(left))
  for (const file of files) {
    const record = await readSourceTaskIndex(join(directory, file))
    if (record === undefined || record.task !== name) continue
    const sessions = Array.isArray(record.sessions) ? record.sessions : []
    const entry = sessions.find((one) => one !== null && typeof one === 'object' && one.sessionId === id)
    if (entry !== undefined) return entry
  }
  return undefined
}

/**
 * Delete one task's index, without archiving it.
 *
 * Not the path a finish takes - see {@link archiveSourceTaskIndex} - but it is what a
 * caller wants when the index is simply wrong and there is nothing worth keeping: a
 * task space removed by hand, a test cleaning up, an entry written under the wrong name.
 * A file that is already gone is a success, because the caller's question is whether
 * there is now no index, and the answer is yes.
 * @param sourceRoot - the root the task was cut from.
 * @param project - the project layer.
 * @param task - the task name.
 * @returns whether there is now no index file for that task.
 */
export async function removeSourceTaskIndex(sourceRoot, project, task) {
  const root = typeof sourceRoot === 'string' ? sourceRoot.trim() : ''
  const name = typeof task === 'string' ? task.trim() : ''
  const layer = typeof project === 'string' ? project.trim() : ''
  if (root === '' || name === '' || layer === '') return false
  await rm(sourceTaskIndexPath(root, layer, name), { force: true })
  return true
}

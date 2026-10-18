/**
 * Task layout
 *
 * What more than one of those needs: the layout a task container follows, and the worktrees it holds.
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { localStamp } from './audit-log.js'
import { coded } from './codes.js'
import { tryRunGit } from './git.js'
import { coerceDeliveryPolicy } from './delivery.js'
import { deploymentEnvIdFor, validateProjectName, validateTaskName } from './naming.js'
import { assertTaskSpaceShape } from './paths.js'
import { recommendTasksRoot } from './paths.js'
import { writeSourceTaskIndex } from './source-index.js'

/**
 * The one directory inside a task space this plugin owns.
 *
 * Everything this plugin writes into a task space used to sit at the top level,
 * beside the worktrees: the record, the note rendered from it, and the deploy root
 * it copied or scaffolded. That top level is also where the user's own files go and
 * where every worktree's name is taken, so "which entries are the plugin's?" was a
 * list of names to keep in step. One directory answers it once, and leaves the top
 * level to the worktrees and the user.
 *
 * Nothing is read from the old locations. A task space made by an earlier version
 * is not recognised as one of ours until the files below are moved into this
 * directory by hand - the CHANGELOG's breaking-change note says which. A fallback
 * would be worse than the refusal: it would let a space keep working while the
 * scripts that write its delivery state went on writing to a file this plugin no
 * longer reads, which is a finish gate answering about nothing.
 *
 * The name is dotted for the same reason a lock file is: it sorts away from the
 * worktrees in a listing, and it is not a name a repository or a user's own folder
 * is likely to take.
 */
export const PLUGIN_ROOT = '.worktree-space'

/**
 * The orchestration root's directory name.
 *
 * One name for the two places that must never drift apart: the directory a create
 * copies out of the source root, and the directory it lands in inside the task
 * space ({@link PLUGIN_ROOT}'s own `deploy`). The copy is what every deploy command
 * runs from and where the state file lives; the source root's original is the source
 * side's own and is never moved.
 */
export const DEPLOY_ROOT = 'deploy'

/** File a task container carries so a session finds the task's own rules. */

export const BREADCRUMB = 'README.en.md'

/**
 * The task's metadata, as data, inside {@link PLUGIN_ROOT}.
 *
 * The container used to carry only {@link BREADCRUMB}, a Markdown note written
 * for a session to read. It is read back with a regular expression and, of the
 * five facts it records, only three were ever parsed again — the base and the
 * creation time were written and then lost. The JSON file is the record now:
 * every field below is either the task's identity or a fact captured once, at
 * create time, that cannot be recomputed later. Live state (the branch a
 * worktree is on now, its dirty files, the commits it has not merged) is
 * deliberately absent: it is a git question, and a copy here would rot.
 */
export const TASK_METADATA = 'worktree-space.json'

/**
 * The same metadata rendered for a reader.
 *
 * Generated from {@link TASK_METADATA} every time the JSON is written, so the
 * two cannot disagree; this is the file a session finds when it opens the task
 * space, replacing the note the old extension used to hold.
 *
 * Named after the record it renders rather than `README.md`. {@link PLUGIN_ROOT}
 * is a directory the user opens and puts their own files in, and `README.md` is the
 * first name anyone reaches for: a directory that once carried the plugin's note
 * could not also hold the user's own without one overwriting the other. The
 * shared prefix makes the pair self-evident — the `.json` is the record, this
 * is the same record for a reader — and leaves every conventional name to the
 * user.
 */
export const TASK_README = 'worktree-space.md'

/**
 * Entries at a container's top level that this plugin writes and therefore owns.
 *
 * One entry, because the plugin's bookkeeping is one directory: the record, the note
 * rendered from it and the deploy root are all inside {@link PLUGIN_ROOT}, so the
 * container holds exactly one name that is this plugin's to clear. That is also what
 * a finish needs to know to leave the space empty enough to remove - the deploy root
 * is a whole copied tree of scripts, and one left behind would hold the task space
 * open over a copy of files the source root still has.
 *
 * {@link BREADCRUMB} is the exception, and stays named: versions before the JSON
 * wrote that note at the container's top level, and a space created then is still
 * this plugin's to clear. `README.md` is deliberately absent even though such a
 * space may hold one the plugin itself wrote — by the time a space is archived, a
 * file with that name is as likely to be the user's own, and deleting the user's
 * notes is worse than leaving one stale file behind.
 */
export const TASK_OWNED_ENTRIES = [PLUGIN_ROOT, BREADCRUMB]


/**
 * Whether a directory is a linked worktree, that is, its `.git` is a file
 * pointing back at a source repository. A source repository's `.git` is a
 * directory, so this is what keeps a source root from being mistaken for a task
 * or the reverse.
 * @param directory - the candidate directory.
 * @returns whether the directory is a linked worktree.
 */

export async function isLinkedWorktree(directory) {
  try {
    return (await stat(join(directory, '.git'))).isFile()
  } catch {
    return false
  }
}


/**
 * Resolve the container root to use, preferring an explicit request.
 *
 * Three answers, in the order they win: what the caller named, what the
 * configuration names, and the recommendation derived from the source root. The
 * configured directory sits in the middle because it is a default rather than a
 * rule - a task that names its own container root still goes where it was told -
 * and because it is the user's standing answer to "where do task spaces go",
 * which is what both the create dialog and the tool's own `suggest-root` report.
 *
 * A root the caller or the configuration named is resolved before it is handed back,
 * and that is the whole of the reason this function is a boundary rather than a
 * lookup: the answer goes straight into `assertIsolated`, whose comparisons are
 * lexical by design. `E:/a/x/../b/c/wt` is not lexically inside `E:/a/b/c`, but it
 * resolves to `E:\a\b\c\wt`, which really is - so a root that reaches a comparison
 * unresolved makes the plugin's own "work and source stay isolated" invariant report
 * itself satisfied about a task space sitting inside the source tree.
 * @param sourceRoot - the directory holding the source repositories.
 * @param requestedRoot - a caller-supplied container root, possibly empty.
 * @param configuredRoot - the container root the configuration names, possibly empty.
 * @returns the container root, absolute and in native separators.
 */

export function resolveTasksRoot(sourceRoot, requestedRoot, configuredRoot) {
  const requested = typeof requestedRoot === 'string' ? requestedRoot.trim() : ''
  if (requested !== '') return resolve(requested)
  const configured = typeof configuredRoot === 'string' ? configuredRoot.trim() : ''
  return configured === '' ? recommendTasksRoot(sourceRoot) : resolve(configured)
}


/**
 * The task space directory: the one place the host spells out the layout.
 *
 * `<container root>/<project>/<task>`, with each segment validated as the name it
 * is - the task by the rule a branch suffix also obeys, the project by the
 * weaker rule a directory name obeys. Both are validated here rather than at the
 * call sites so that a path this plugin writes and a path it later reads back
 * can never disagree, and so the two relative names a caller could send cannot
 * walk out of the container root.
 *
 * The root itself is validated here too, because the two checks below only mean
 * something once it is a real container. `''` and `.` join to a path relative to
 * whatever directory the host process happens to be in, and `/` and `C:\` join to a
 * path one level below a volume root - a layout no task space has, and one a finish
 * would then delete inside. None of those is a container root, so none of them is
 * accepted, and the refusal is E1004 - the code that already means "a tasks root is
 * required" - with a sentence saying what the root has to be instead.
 * @param tasksRoot - the container root.
 * @param project - the project layer's name.
 * @param task - the task name.
 * @returns the task space directory.
 * @throws Error carrying E1004 when the root is not an absolute, non-volume directory.
 */
export function taskSpacePath(tasksRoot, project, task) {
  const root = String(tasksRoot ?? '').trim()
  if (!isAbsolute(root) || dirname(root) === root) {
    throw coded(
      'E1004',
      `a tasks root is required, and it must be an absolute directory that is not a volume root: ${root === '' ? '(empty)' : root}`,
    )
  }
  const path = join(root, validateProjectName(project), validateTaskName(task))
  assertTaskSpaceShape(root, path)
  return path
}


/**
 * The plugin's own directory inside a task space.
 * @param taskPath - the task space directory.
 * @returns where every file this plugin writes into the space lives.
 */
export function pluginRootPath(taskPath) {
  return join(taskPath, PLUGIN_ROOT)
}


/**
 * The JSON record, inside the plugin's own directory.
 *
 * Every reader and writer of the record goes through this, so the one place that
 * knows where the record sits is {@link PLUGIN_ROOT}'s declaration above.
 * @param taskPath - the task space directory.
 * @returns the absolute path of the record.
 */
export function taskMetadataPath(taskPath) {
  return join(pluginRootPath(taskPath), TASK_METADATA)
}


/**
 * The task space's own orchestration root, inside the plugin's own directory.
 *
 * The workspace's deploy root is copied here whole, so the entry a record names -
 * a path relative to the WORKSPACE, which is the same relative path here - is found
 * inside this directory, and the state file a deploy writes sits at this directory's top.
 * @param taskPath - the task space directory.
 * @returns the absolute path of the task space's deploy root.
 */
export function taskDeployRootPath(taskPath) {
  return join(pluginRootPath(taskPath), DEPLOY_ROOT)
}


/**
 * The plugin's deploy directory, relative to whichever root it sits in.
 *
 * One spelling for the two sides that must agree: the workspace's deploy root and the
 * task space's are the same relative path, so a single record value resolves correctly
 * in both. It is also what an error message and a note can name without repeating the
 * two constants it is built from.
 */
export const DEPLOY_DIR = `${PLUGIN_ROOT}/${DEPLOY_ROOT}`


/**
 * The entry a deploy root runs when the task's record names none, relative to its own root.
 *
 * Relative, not absolute, and identical on both sides - which is the whole point of the
 * layout: the workspace's `<root>/.worktree-space/deploy/deploy.sh` is copied to the same
 * relative place in the task space, so `./.worktree-space/deploy/deploy.sh up` runs there.
 */
export const DEFAULT_DEPLOY_ENTRY = `${DEPLOY_DIR}/deploy.sh`


/**
 * The workspace's own deploy root, in the same plugin directory a task space uses.
 *
 * The plugin keeps its files in one dotted directory wherever it works, so the source side
 * follows the same layout as the task space: `<workspace>/.worktree-space/deploy/`. That
 * directory is what a create copies whole into the task space's own deploy root, and it is
 * the only place a deploy contract is looked for on the source side - nothing is read from
 * a `deploy/` at the workspace's top level any more, which is what stopped a deploy root
 * from sitting among the user's own folders.
 * @param sourceRoot - the workspace root holding the repositories.
 * @returns the absolute path of the workspace's deploy root.
 */
export function sourceDeployRootPath(sourceRoot) {
  return join(sourceRoot, PLUGIN_ROOT, DEPLOY_ROOT)
}


/**
 * Read the linked worktrees inside a task directory with their branch and dirty
 * state.
 * @param subprocess - the profile's subprocess service.
 * @param taskPath - the task directory.
 * @returns one row per worktree, in directory order.
 */

export async function listTaskWorktrees(subprocess, taskPath) {
  let entries
  try {
    entries = await readdir(taskPath, { withFileTypes: true })
  } catch {
    return []
  }

  const repositories = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const worktreePath = join(taskPath, entry.name)
    if (!(await isLinkedWorktree(worktreePath))) continue
    const branch = await tryRunGit(subprocess, worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const status = await tryRunGit(subprocess, worktreePath, ['status', '--porcelain'])
    repositories.push({
      name: entry.name,
      path: worktreePath,
      branch: branch === '' ? undefined : branch,
      changedFiles: status === '' ? 0 : status.split(/\r?\n/).filter(Boolean).length,
    })
  }
  return repositories
}


/**
 * Build the metadata a container records for itself.
 *
 * `startCommit` is read once per repository, before the branch is created, so
 * the answer belongs to the source checkout rather than to the worktree that
 * was just made from it.
 * @param details - `task`, `tasksRoot`, `sourceRoot`, the shared `branch`, the
 * optional `baseRef`, and the created repositories with their source paths,
 * source branches and starting commits.
 * @returns the document to write as JSON. Alongside the captured facts it
 * carries the `deploymentEnvId` derived from the project and task names — a
 * deployment is not a fact this plugin captures, but the id every deploy
 * command and cleanup later must spell identically, so it is written down
 * rather than recomputed at each end — and the `delivery` policy the task was
 * created under, completed to the defaults where the caller said less, so the
 * note, the gate and the panel read one record instead of three opinions.
 */
export function taskMetadata(details) {
  const { task, project, tasksRoot, sourceRoot, branch, baseRef, repositories = [], delivery, sessions, deployScript } = details
  const known = normalizeSessions(sessions)
  return {
    version: 1,
    task,
    project,
    tasksRoot,
    sourceRoot,
    branch,
    baseRef: baseRef === undefined || `${baseRef}`.trim() === '' ? null : `${baseRef}`,
    deploymentEnvId: deploymentEnvIdFor(project, task),
    delivery: coerceDeliveryPolicy(delivery),
    createdAt: new Date().toISOString(),
    // Optional, and absent rather than empty on a record that has no session yet:
    // every reader treats a missing key as "unknown", which is what a record made
    // before this field existed says, and an empty array would claim the task has
    // no session where the truth is that nobody wrote one down.
    ...(known.length === 0 ? {} : { sessions: known }),
    // Which script under `.worktree-space/deploy/` is this task's entry, when the create
    // named one. Absent means `.worktree-space/deploy/deploy.sh`, which is what every record
    // made before this field existed means too - so a reader falls back rather than refusing.
    ...(typeof deployScript === 'string' && deployScript.trim() !== '' ? { deployScript: deployScript.trim() } : {}),
    repositories: repositories.map((entry) => ({
      name: entry.name,
      sourcePath: entry.sourcePath,
      ...(entry.sourceBranch === undefined ? {} : { sourceBranch: entry.sourceBranch }),
      ...(entry.startCommit === undefined ? {} : { startCommit: entry.startCommit }),
      branch: entry.branch ?? branch,
    })),
  }
}

/**
 * The roles a recorded session can have in a task.
 *
 * `task` is the session the task was dispatched to — the one that does the work;
 * `handoff` is a session this plugin opened for the user's own handoff (a commit,
 * or a conflict to resolve). The distinction is what lets a reader tell the
 * session that is running the task from one that was only ever asked a question
 * about it.
 *
 * `leader` names the session that dispatched the work. This is an **audit fact,
 * not a test the plugin runs**: before it a record could say who was doing the
 * work and never who had asked, so a reader that wanted to name the dispatcher -
 * `list`, the panel, the recipient of a report - had nothing to read and had to
 * guess from directories. It is deliberately not what the report header's role
 * line is built from: that is decided by where a session works, which keeps
 * working for a task space whose record predates this role.
 */
export const TASK_SESSION_ROLES = ['task', 'handoff', 'leader']

/**
 * Normalize the sessions a record carries into the shape this plugin writes.
 *
 * Two shapes are read, because the field is optional and because a record may have
 * been hand-edited: an array of `{ sessionId, at, role }` entries (what this
 * version writes) and a bare `sessionId` string (the shorter spelling a reader
 * might use). A malformed entry is dropped rather than throwing: a record whose
 * session list is partly garbage still names the task, and refusing the whole
 * record over one bad entry would turn a readable task into a stranger.
 * @param value - whatever the record held under `sessions`, or `sessionId`.
 * @returns the normalized entries, possibly empty, each with a non-empty id.
 */
export function normalizeSessions(value) {
  const entries = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value])
  const normalized = []
  for (const raw of entries) {
    const entry = typeof raw === 'string' ? { sessionId: raw } : raw
    if (entry === null || typeof entry !== 'object') continue
    const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId.trim() : ''
    if (sessionId === '') continue
    const role = TASK_SESSION_ROLES.includes(entry.role) ? entry.role : 'task'
    const at = typeof entry.at === 'string' && entry.at !== '' ? entry.at : undefined
    // `reportedAt` is carried through, and that is not a detail: this function *rebuilds*
    // each entry, so a field it does not name is silently dropped when the record is read
    // back. A `reportedAt` that cannot be read is the same as one that was never written -
    // the watcher would then report a session that did hand its report over. Same shape
    // rule as `at`: a non-empty string, and an absent one stays absent rather than becoming
    // an empty string that reads as "reported at no time".
    const reportedAt = typeof entry.reportedAt === 'string' && entry.reportedAt !== '' ? entry.reportedAt : undefined
    normalized.push({
      sessionId,
      ...(at === undefined ? {} : { at }),
      ...(reportedAt === undefined ? {} : { reportedAt }),
      role,
    })
  }
  return normalized
}

/**
 * The sessions a task's record names.
 *
 * Backward compatible in both directions: a record written before this field
 * existed answers an empty list — not an error, and not a claim that the task has
 * no session, only that none was written down — and a record that carries the
 * shorter `sessionId` spelling is read as one entry.
 * @param metadata - a record from {@link readTaskMetadata}, or undefined.
 * @returns the entries, possibly empty.
 */
export function taskSessionsOf(metadata) {
  if (metadata === null || metadata === undefined || typeof metadata !== 'object') return []
  if (Array.isArray(metadata.sessions)) return normalizeSessions(metadata.sessions)
  return normalizeSessions(metadata.sessionId)
}

/**
 * The record a create or a dispatch keeps, with one session added.
 *
 * Written back through {@link writeTaskMetadata}, so the JSON record and the note
 * rendered from it stay one document. The session is appended rather than
 * replaced: a task may have been dispatched to several sessions over its life
 * (the first one lost, a second opened in the same task space), and which of them
 * is current is a question the reader answers by timestamp, not by the record
 * forgetting the earlier ones.
 *
 * Nothing here throws: a record that cannot be written leaves the session
 * unrecorded, which the caller reports as a warning. The session itself is
 * already running — failing the dispatch over a bookkeeping write would lose the
 * work to save the note about it.
 * @param taskPath - the task space directory.
 * @param metadata - the record as it was read.
 * @param sessionId - the session to record.
 * @param role - what that session is doing here; `task` unless said otherwise.
 * @returns whether the record was written.
 */
export async function recordTaskSession(taskPath, metadata, sessionId, role = 'task') {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (id === '' || metadata === null || metadata === undefined || typeof metadata !== 'object') return false
  const known = taskSessionsOf(metadata)
  if (known.some((entry) => entry.sessionId === id)) return true
  const written = {
    ...metadata,
    sessions: [...known, { sessionId: id, at: new Date().toISOString(), role: TASK_SESSION_ROLES.includes(role) ? role : 'task' }],
  }
  try {
    await writeTaskMetadata(taskPath, written)
  } catch {
    return false
  }
  // The same fact, under the root the task was cut from, so a session working in the
  // source checkout can find this task without knowing the container root. Written after
  // the record and best-effort on purpose: the record is the authority, and a checkout
  // that cannot be written to (read-only, gone, a source root nobody named) must not turn
  // a recorded session into a failed dispatch. See `source-index.js`.
  await writeSourceTaskIndex(taskPath, written, taskSessionsOf(written)).catch(() => false)
  return true
}

/**
 * Note that a session has handed over its final report, in the task's own record.
 *
 * `reportedAt` answers exactly one question - "did this session deliver a final report,
 * and when" - and the answer is stored rather than inferred because nothing else can
 * answer it. A session that stops after saying "I am halfway through" has said something
 * without reporting; a session that stops after a full hand-over has reported. The two
 * are the same shape on the event feed, and this field is what separates them.
 *
 * Two consequences of that meaning are load-bearing:
 *
 *   - **`done` never writes it.** Finishing a task without reporting is the case the
 *     watcher exists to catch, so a finish that stamped this field would silence the one
 *     notice this is for.
 *   - **Only an entry the record already names is updated.** Appending one would be
 *     {@link recordTaskSession}'s job with the opposite meaning, and a record that grew a
 *     session because it reported would claim the plugin opened a session it never opened.
 *
 * Nothing here throws, and both writes are best-effort. The report itself already reached
 * the dispatcher by the time this runs; a record that cannot be written is a fact this
 * side failed to keep, not a reason to fail the delivery - the same trade
 * {@link recordTaskSession} makes for the other direction.
 *
 * The source root's index is refreshed beside the record because the index is the copy
 * that outlives the task space: a `done` archives it, and an index still showing the
 * session as unreported would make the watcher report a report that did happen. The
 * order matters for the same reason it does in `recordTaskSession` - the record is the
 * authority, and the index is written after it.
 * @param taskPath - the task space directory.
 * @param sessionId - the session that reported.
 * @returns whether the record now says a report was delivered.
 */
export async function markSessionReported(taskPath, sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (id === '') return false
  const metadata = await readTaskMetadata(taskPath).catch(() => undefined)
  if (metadata === null || metadata === undefined || typeof metadata !== 'object') return false
  const known = taskSessionsOf(metadata)
  const target = known.findIndex((entry) => entry.sessionId === id)
  if (target === -1) return false
  const stamp = localStamp()
  const written = {
    ...metadata,
    sessions: known.map((entry, index) => (index === target ? { ...entry, reportedAt: stamp } : entry)),
  }
  try {
    await writeTaskMetadata(taskPath, written)
  } catch {
    return false
  }
  await writeSourceTaskIndex(taskPath, written, taskSessionsOf(written)).catch(() => false)
  return true
}

/**
 * Read a container's metadata, from JSON when it has one.
 *
 * Containers made before this file existed hold only the Markdown note, so the
 * note is still parsed and its three facts are returned as the identity. The
 * richer fields are then simply absent, which every reader treats as "unknown"
 * rather than as failure — a space is never demoted for being old.
 * @param taskPath - the container directory.
 * @returns the metadata, or undefined when the directory is not one of ours.
 */
export async function readTaskMetadata(taskPath) {
  const text = await readFile(taskMetadataPath(taskPath), 'utf8').catch(() => '')
  if (text.trim() !== '') {
    try {
      const parsed = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.task === 'string' && parsed.task !== '') {
        return parsed
      }
    } catch {
      // A half-written or hand-edited file falls through to the note below
      // rather than turning a task into a stranger.
    }
  }
  const legacy = await parseLegacyBreadcrumb(taskPath)
  return legacy === undefined ? undefined : { version: 0, ...legacy }
}

/**
 * Read the legacy Markdown note, when the container has one.
 * @param taskPath - the container directory.
 * @returns its three facts, or undefined.
 */
async function parseLegacyBreadcrumb(taskPath) {
  const text = await readFile(join(taskPath, BREADCRUMB), 'utf8').catch(() => '')
  if (text.trim() === '') return undefined
  const task = /^#\s*Task:\s*(.+)$/m.exec(text)?.[1]?.trim()
  if (task === undefined || task === '') return undefined
  const branch = /^-\s*Branch:\s*`([^`]+)`/m.exec(text)?.[1]?.trim()
  const sourceRoot = /^-\s*Source root:\s*`([^`]+)`/m.exec(text)?.[1]?.trim()
  return {
    task,
    ...(branch === undefined || branch === '' ? {} : { branch }),
    ...(sourceRoot === undefined || sourceRoot === '' ? {} : { sourceRoot }),
  }
}

/**
 * Render the metadata as the note a session reads.
 *
 * The Deployment section is here, and not only in the bundled skill, because it
 * is the one line a session must copy exactly — the environment id — and a note
 * generated from the same record the cleanup later reads is what keeps the two
 * from drifting. A container old enough to predate the field renders without the
 * section: guidance that names no id would invite a session to guess one.
 * @param metadata - the document {@link taskMetadata} built.
 * @returns the Markdown contents.
 */
export function renderTaskMetadata(metadata) {
  const { task, project, branch, baseRef, createdAt, sourceRoot, repositories = [], deploymentEnvId, delivery, deployScript } = metadata
  // The entry this task runs, as the path a session types from the task space's own root.
  // The record holds a path relative to the WORKSPACE, and it resolves here unchanged: the
  // workspace's `.worktree-space/deploy/` is copied to the same relative place in the task
  // space, so one spelling is valid on both sides and the note cannot disagree with what
  // the deploy code will actually run. A record that names no entry means the default entry,
  // which is what a create produces whenever the caller names none.
  const deployEntry = typeof deployScript === 'string' && deployScript.trim() !== '' ? deployScript.trim() : DEFAULT_DEPLOY_ENTRY
  // The sessions this task was dispatched to, rendered so a reader of the note can
  // name one without searching: `wts_session_tool_status` takes exactly this id.
  // The newest is named first, because that is the one still working.
  const sessions = [...taskSessionsOf(metadata)].reverse()
  const lines = [
    `# Task: ${task}`,
    '',
    ...(typeof project === 'string' && project !== '' ? [`- Project: \`${project}\``] : []),
    `- Branch: \`${branch}\` (one branch per repository below)`,
    `- Base: ${baseRef === undefined || baseRef === null || `${baseRef}`.trim() === '' ? "each repository's current HEAD" : `\`${baseRef}\``}`,
    ...(typeof createdAt === 'string' && createdAt !== '' ? [`- Created: ${createdAt}`] : []),
    `- Source root: \`${sourceRoot}\``,
    ...(sessions.length === 0 ? [] : [`- Sessions: ${sessions.map((entry) => `\`${entry.sessionId}\` (${entry.role})`).join(', ')}`]),
    '- This folder is the agent session working directory.',
    `- The facts above are stored in \`${PLUGIN_ROOT}/${TASK_METADATA}\`; this file is generated from it.`,
    '',
    ...(sessions.length === 0 ? [] : [
      '## Sessions',
      '- The sessions above were opened for this task; the newest is the one that was working most recently.',
      '- Watch one with `wts_session_tool_status` (its `lastActivity` tells "stuck" from "busy with a long step"), read it with `wts_session_tool_read`, and correct it with `wts_session_tool_send` — pass `mode: "steer"` for anything time-sensitive, because `queue` is only read at a turn boundary.',
      '',
    ]),
    '## Repositories',
    ...repositories.map((entry) => `- \`${entry.name}\``),
    '',
    '## Conventions',
    '- Commit in each repository separately (the same branch name everywhere).',
    '- Source repositories are read-only for editing: do the work in this task space, not in the source checkouts.',
    // Who finishes is the user's choice, so this states the two shapes and what each one
    // costs rather than naming one. A note that picked a side would be the plugin deciding an
    // authorisation question it has no standing on, and a session that read the wrong side of
    // it would either strand a finished task or merge without the user having asked.
    '- **Who finishes is the user\'s decision, and both flows work.** Either you call `done` yourself once the work is complete, or you report back and the session that dispatched you - or the user - calls it. Ask which is wanted when the task brief does not say.',
    // The reporting contract, in the note the session reads from disk. The dispatched session
    // is handed the same requirement in its brief, and the two have to agree: a note that
    // stayed quiet about it would leave the one artifact a later reader trusts saying less
    // than the prompt that started the work.
    '- **Report back as you go, and report when you stop.** The session that dispatched you is invisible to you in reverse: it sees nothing - not your commands, not your commits - until you send it something with `wts_session_tool_send` (`mode: "steer"` for anything time-sensitive). Report when each unit that can be committed and handed over on its own has landed, when you are stuck on something only the caller or the user can settle, and when the task is finished - including when you finished it yourself with `done`, which never replaces the report. A final report states the commit hash of each repository, the acceptance URL when there is one, what passed and the evidence for it, and **what you did not verify**. Between those moments, use your own judgement: report what changes what comes next, and skip the reports that would only say nothing happened.',
    '- Finishing is atomic: `done` merges, removes the worktrees and clears the task space in one call. `merge: true` lands the task branch on the target; `merge: false` leaves the branch alone - the commits are kept, but the worktree is removed, so a conflict left over would have to be resolved in the source repository instead of here.',
    '- A merge that lands is the one step a finish cannot take back, so `merge: true` is an authorisation rather than a formality: pass it when the user asked for the work to land, and not otherwise.',
    '',
    ...(typeof deploymentEnvId === 'string' && deploymentEnvId !== '' ? [
      '## Deployment',
      `- If this space holds deployable services — a repository with its own \`deploy/deploy.sh\`, or the \`${PLUGIN_ROOT}/${DEPLOY_ROOT}/\` orchestration root this space was created with — deploy them to an isolated Docker environment rather than starting them on the host.`,
      `- Environment id for this task: \`DEPLOY_ENV_ID=${deploymentEnvId}\`. Pass it to every deploy command: it is what keeps this task's containers, images and acceptance URL apart from every other task's. A command run without it builds containers under the entry's own default id, and the panel then cannot see them: the smoke and destroy buttons disappear, and a finish cannot take the environment down.`,
      // The entry this task actually runs, as the command this task space runs it with.
      // A create that named one says so in the record, and the note has to repeat it:
      // the agent's commands are `./<entry> up`, and a `./deploy.sh up` would run a
      // different script when the two disagree.
      //
      // The id rides along as the entry's second argument, which is not decoration: the
      // line above tells the session to pass it, and a command printed here without it
      // contradicts that instruction with a string the session can copy verbatim. A copy
      // is what sessions actually run, and the entry takes the id from either the
      // environment or this argument - so the printed form has to carry it. An entry that
      // was written before the second argument existed reads it as a service name and
      // falls back to its own default, which is the shape this whole line is preventing.
      `- This task's deploy entry is \`./${deployEntry}\`. Run \`./${deployEntry} up ${deploymentEnvId}\` to build and start the environment; it prints the acceptance URL. Run \`./${deployEntry} smoke ${deploymentEnvId}\` and let it pass before handing the URL to the user.`,
      `- \`./${deployEntry} status --json\` is the machine-readable view. The panel's destroy button finds this task's containers by their \`dsh.env-id\` label and takes them down without the script, so a \`destroy\` subcommand is optional - and if the entry has one, it must set \`url\` to null and stamp \`destroyedAt\`, or the panel will show a dead acceptance URL as if it worked.`,
      `- **The deploy root owns its own delivery state, at a path the plugin names.** The file is \`<task space>/${PLUGIN_ROOT}/${DEPLOY_ROOT}/.state.json\` — fixed, whatever the entry is called and wherever under \`${DEPLOY_ROOT}/\` it sits. Every script this plugin runs is handed that absolute path as \`DEPLOY_STATE_FILE\`, so write \`\${DEPLOY_STATE_FILE}\` and never work out the deploy root yourself. \`./${deployEntry} up ${deploymentEnvId}\` must write \`url\` (one line, plus \`services\` if it likes) once the environment is up, and \`./${deployEntry} smoke ${deploymentEnvId}\` must merge \`lastSmoke: {result, at}\` into that same file **without dropping what is already in it**. Neither \`up\` nor \`smoke\` may write \`destroyedAt\` - that stamp is the plugin\'s to clear, and only the entry\'s own optional \`destroy\` writes it. Without the file the panel can show neither the acceptance URL nor the smoke state, and \`done\` refuses to merge (E5006).`,
      '- Write that state from the script that ran the step and from nothing else: not by hand, not from a transcript of a run that happened elsewhere. The merge gate reads the file as the evidence that the step happened.',
      `- A space this plugin scaffolded (no \`${DEPLOY_ROOT}/\` of its own was copied in) carries \`${PLUGIN_ROOT}/${DEPLOY_ROOT}/write-state.sh\`, run from that directory: \`./write-state.sh url <url>\`, \`./write-state.sh smoke pass|fail\` and \`./write-state.sh services <json>\` each merge one field into \`$DEPLOY_STATE_FILE\`.`,
      '',
    ] : []),
    ...(delivery === undefined ? [] : [
      '## Delivery',
      `- Deployment target: \`${delivery.deploy.target}\`.`,
      '- `done` enforces this: with a target of `docker`, a merge is refused while the deployment state records no passing smoke (E5006 - either no state file at all, or one whose smoke is missing or red). With `none` there is no gate.',
      '- Everything else a finish decides — whether to merge, which branch, whether to delete it, and what happens to untracked files — is passed on the `done` call, not recorded here. `merge` is required; `strays` defaults to `archive`.',
      '',
    ]),
  ]
  return lines.join('\n')
}

/**
 * Write a container's metadata: the JSON record and the note rendered from it.
 * @param taskPath - the container directory.
 * @param metadata - the document {@link taskMetadata} built.
 */
export async function writeTaskMetadata(taskPath, metadata) {
  // The directory is made here rather than left to the caller, because every writer
  // of the record is writing into a space that may have had no plugin directory yet -
  // a create makes one for the deploy copy or not at all - and a record that cannot
  // be written because a directory is missing would fail a dispatch over bookkeeping.
  await mkdir(pluginRootPath(taskPath), { recursive: true })
  await writeFile(taskMetadataPath(taskPath), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
  await writeFile(join(pluginRootPath(taskPath), TASK_README), renderTaskMetadata(metadata), 'utf8')
}

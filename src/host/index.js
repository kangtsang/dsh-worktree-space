import z from '@deepseek-ai/schemastery'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { auditEnter, auditEnabled, recordError, setAuditEnabled, setAuditEnabledReader } from './task/audit-log.js'
import { coded, UNKNOWN } from './task/codes.js'
import { detectDefaultBranch, parseWorktrees, runGit, tryRunGit } from './task/git.js'
import { mapWithLimit } from './task/concurrency.js'
import { isInside } from './task/paths.js'
import { DEFAULT_BRANCH_PREFIX } from './task/naming.js'
import { addTaskRepositories, classifySourceRoot, classifySourceRoots, createTask, finishTask, inspectTask, listTasks, planTask, suggestTaskRoot } from './task/operations.js'
import { recallScan, rememberScan, rememberStatus } from './task/scan-cache.js'
import { registerTaskSkill } from './task/skill.js'
import { registerTaskTool } from './task/tool.js'

// These helpers moved to the git module; they stay part of the entry module's
// public surface because callers and tests import them from here.
export { detectDefaultBranch, parseWorktrees, runGit } from './task/git.js'

const API_PREFIX = '/api/dsh-worktree-space'
const WORKTREE_ENDPOINTS = ['worktree.scan', 'worktree.cached', 'worktree.status']
const TASK_ENDPOINTS = ['task.classify-root', 'task.classify-roots', 'task.suggest-root', 'task.create', 'task.add-repositories', 'task.list', 'task.inspect', 'task.plan', 'task.done', 'task.preference']
const ENDPOINTS = [...WORKTREE_ENDPOINTS, ...TASK_ENDPOINTS]

/**
 * Read the client-request envelope a route accepts.
 *
 * Four fields, checked here rather than with the Connection package's own schema:
 * the built host bundle carries the whole host, Tool presenters included, and a
 * Tool presenter that imports Client/UI code is a store-contract blocker. Keeping
 * the check local also leaves the host half with no Client dependency at all.
 * @param body - the parsed JSON body of an authenticated route call.
 * @returns the envelope, or null when the body is not one.
 */
export function readClientRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const { type, rpcId, method, payload } = body
  if (type !== 'client-request') return null
  if (typeof rpcId !== 'string' || rpcId === '') return null
  if (typeof method !== 'string' || method === '') return null
  const carried = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  return { type, rpcId, method, payload: carried }
}

export const ok = (value) => ({ ok: true, value })
// Every code a caller may be told about. They are the codes in task/codes.js,
// plus the two ends of the range - E9001 for a failure with no code of its own,
// and `cancelled` for a request that was abandoned.
//
// This list is a filter, not a vocabulary: `coded()` writes the codes literally at
// the throw site so that `grep -n E2003` finds the line, and anything missing from
// here is flattened to E9001 on the way out rather than reaching a caller that
// would then have to handle a distinction this side does not maintain. A test
// asserts the two lists stay in step.
export const PUBLIC_ERROR_CODES = new Set([
  'E1001', 'E1002', 'E1003', 'E1004', 'E1005',
  'E2001', 'E2002', 'E2003', 'E2004', 'E2005', 'E2006',
  'E3001', 'E3002', 'E3003', 'E3004', 'E3005',
  'E4001', 'E4002', 'E4003', 'E4004', 'E4005', 'E4006', 'E4007', 'E4008', 'E4009',
  'E5001', 'E5002', 'E5003', 'E5004',
  'E6001', 'E6002',
  'E7001', 'E7002', 'E7003', 'E7004', 'E7005', 'E7006', 'E7007',
  'E9001',
  'cancelled',
])

export const fail = (code, message, details = {}) => ({
  ok: false,
  error: { code: publicCode(code), message, details: { issues: [], ...details } },
})

/**
 * The code a caller is allowed to see.
 *
 * Anything outside the public set becomes E9001, so a code cannot reach a
 * caller that promises a distinction this side does not maintain. `recover` runs
 * this BEFORE writing the record, because a log carrying a code the caller never
 * received is the one drift this arrangement exists to prevent - and a code read
 * off the log would not be the one to act on.
 * @param code - the code asked for.
 * @returns the code to use, public or not.
 */
const publicCode = (code) => (PUBLIC_ERROR_CODES.has(code) ? code : UNKNOWN)

export const cleanPath = (value) => {
  const text = String(value ?? '')
  return text.length > 1 ? text.replace(/[\\/]+$/, '') : text
}

// There is deliberately no cleanup pass here for a worktree directory whose git
// directory is gone. One was drafted as `removeOrphanedWorktree` - it checked
// for a `.git` file naming a metadata directory that no longer exists, and
// removed the directory - and it was never called. Deleting it is the right
// ending: such a directory holds working files that git can no longer reach, so
// there is no `git checkout`, no `git stash` and no `git diff` that would recover
// what is in there, and a recursive delete of it is unrecoverable. A scan is
// asked to report what is on disk, not to decide what should not be.

/**
 * Directory names a scan walks straight past.
 *
 * A build output directory holds no repository the user wants, but it holds a
 * great many directories - `node_modules` alone is tens of thousands - and each
 * one spends a share of {@link MAX_SCAN_DIRECTORIES}. So these are not a
 * nicety; on a Workspace that holds real projects, the difference between
 * skipping them and not is the difference between a scan that answers and one
 * that gives up with E4006.
 *
 * Dot-directories need no entry: {@link discoverGitRoots} already skips anything
 * beginning with `.`, which covers `.venv`, `.gradle`, `.tox`, `.next`,
 * `.dart_tool`, `.stack-work` and the rest of that family. What is here is the
 * half that does not start with a dot.
 *
 * The list is a starting point rather than a rule - the user edits it on the
 * Plugins page - so nothing in it has to be defensible as permanent, only as a
 * good default. Names were left out where the same word is a place people keep
 * source: `bin` holds scripts in too many projects, `env` is a Django
 * `settings` directory as often as a virtual environment, and `out` means
 * whatever the build in front of you says it means.
 */
const DEFAULT_IGNORED_SCAN_DIRECTORIES = [
  // JavaScript and the web
  'node_modules', 'dist', 'build', 'coverage', 'storybook-static',
  // Python
  '__pycache__', 'site-packages',
  // The JVM, Rust, Scala, Clojure: Cargo and Maven agree on the name
  'target',
  // .NET
  'obj', 'packages',
  // Apple
  'Library', 'DerivedData', 'Pods',
  // PHP, and the dependency trees other ecosystems fetch into the project
  'vendor', 'deps', 'elm-stuff',
  // Haskell, Elixir, OCaml, Perl, Zig
  'dist-newstyle', '_build', 'blib', 'zig-out',
  // Unreal, which capitalises its generated directories
  'Binaries', 'Intermediate', 'DerivedDataCache',
]

/**
 * The names above, as the walk compares them.
 *
 * Case-insensitively, because the comparison is against directory names as the
 * filesystem reports them and those differ by platform: `Pods` and `Pods` are
 * different directories on a case-sensitive volume and the same one on macOS.
 * Matching one way would make this list mean different things depending on where
 * DSH runs, and a user who typed `deriveddata` expecting Xcode's folder to be
 * skipped would be right on Windows and wrong on Linux.
 */
export const DEFAULT_IGNORED_SCAN_DIRECTORY_SET = new Set(DEFAULT_IGNORED_SCAN_DIRECTORIES.map((name) => name.toLowerCase()))

/**
 * The names in force: the ones the Host ships, less any that have been turned
 * off, plus any that have been added.
 *
 * Two lists rather than one, because the two directions are not the same act.
 * Adding is a plain addition. Turning one off has to survive a later release that
 * adds more names to the built-in list, so it cannot be expressed as "this is the
 * whole list" - that reading would silently drop every name a future version
 * introduces. A subtraction is also what keeps a hand-edited configuration from
 * being quietly rewritten: what the user took off is recorded as what they took
 * off.
 *
 * Each configured name is added as written and in lower case, so a user who typed
 * `Pods` gets it whether the filesystem capitalises it or not.
 * @param added - the names the configuration adds.
 * @param removed - the built-in names the configuration turns off.
 * @returns the set the walk compares against.
 */
export function ignoredScanDirectorySet(added, removed) {
  const set = new Set()
  for (const name of DEFAULT_IGNORED_SCAN_DIRECTORIES) set.add(name.toLowerCase())
  for (const raw of Array.isArray(removed) ? removed : []) {
    const name = String(raw ?? '').trim().toLowerCase()
    if (name === '') continue
    set.delete(name)
  }
  for (const raw of Array.isArray(added) ? added : []) {
    const name = String(raw ?? '').trim()
    if (name === '') continue
    set.add(name)
    set.add(name.toLowerCase())
  }
  return set
}

/** Scan bounds. The Web UI offers these depths, and the Host enforces them. */
export const MIN_SCAN_DEPTH = 1
export const MAX_SCAN_DEPTH = 5
/**
 * Three, not two.
 *
 * A repository is a leaf of the walk, so depth only costs what sits between the
 * source root and the repositories - the directories that hold none. Two levels
 * finds `E:\work\repos\alpha` and nothing below it, so a Workspace registered one
 * level above a further layout reported none of its repositories and read as an
 * empty directory rather than one holding repositories it could not reach. Three
 * is still bounded by the same ceiling: the cost is the directories walked, and
 * the ceiling is on those, not on the depth.
 */
export const DEFAULT_SCAN_DEPTH = 3
/** Directories one scan may inspect before it refuses to guess any further. */
export const MAX_SCAN_DIRECTORIES = 2000

/**
 * Repositories asked about at once, and classifications the same.
 *
 * Every one of these is a `git` process, or a directory read on a machine whose
 * disk is also running the editor and the build. Enough to stop waiting on the
 * slowest one, few enough that adding repositories costs time rather than
 * throughput.
 */
export const SCAN_CONCURRENCY = 6

/**
 * The configuration this entry is running under, exactly as `apply` was handed it.
 *
 * Held rather than copied into the settings that need it. This is the pattern the
 * branch prefix and the archive strategy further down already use, and the reason
 * it works: these are volatile fields the Plugins page writes while the instance is
 * running, and what `apply` is handed is a live reference, not a value.
 */
let appliedConfig = {}

/**
 * Scan bounds in force right now.
 *
 * Resolved where the walk happens rather than copied into a module by `apply`.
 * Copying was wrong twice over, and both halves had to be true for the symptom to
 * look the way it did:
 *
 *  - A copy taken when the entry loaded still read the old depth after the Plugins
 *    page wrote a new one, because nothing re-took it.
 *  - `resolveScanDepth` is handed the reference itself, and `Number({ get })` is
 *    NaN, which the helper answers with the default. So even a re-taken copy would
 *    have read as the default rather than as the number asked for.
 *
 * Between them a depth of 3 scanned, and reported itself, as 2 - and `Array.isArray`
 * on the ignore-list reference is false too, so the names a user added were not
 * being honoured either. The tell was that the reported depth never moved no
 * matter what was written to the configuration: a setting that reads as ignored.
 *
 * This also matches what the user is told is happening. "The Plugins page writes
 * these while the entry is running, and a scan asked for after the save has to
 * walk past the new names" is only true of a value read at use time.
 * @returns the depth, the directory cap and the ignored-name set, as they stand.
 */
function scanBounds() {
  const directories = Number(settingValue(appliedConfig.maxScanDirectories))
  const added = settingValue(appliedConfig.ignoredScanDirectories)
  const removed = settingValue(appliedConfig.removedScanDirectories)
  return {
    depth: resolveScanDepth(settingValue(appliedConfig.scanDepth)),
    directories: Number.isFinite(directories) ? Math.max(1, Math.trunc(directories)) : MAX_SCAN_DIRECTORIES,
    // A value that is not a list is not a list of names to honour, so the built-in
    // ones stand rather than the walk going past nothing.
    ignored: Array.isArray(added) || Array.isArray(removed)
      ? ignoredScanDirectorySet(Array.isArray(added) ? added : [], Array.isArray(removed) ? removed : [])
      : DEFAULT_IGNORED_SCAN_DIRECTORY_SET,
  }
}

/**
 * The same bounds under the names the task-side walk takes.
 *
 * `scanBounds()` is keyed the way `discoverGitRoots` reads it, so spreading it into
 * a caller that expects `maxDepth` and `maxDirectories` hands over `depth` and
 * `directories` instead - both of which then fall back to their defaults, and the
 * default depth is one. That is silent, and it looks like the old bug: the count
 * stays one level deep while the setting reads as if it had been applied. Spreading
 * this instead of the object is what stops it recurring.
 * @returns the bounds as the task-side discovery names them.
 */
const taskScanBounds = () => {
  const { depth, directories, ignored } = scanBounds()
  return { maxDepth: depth, maxDirectories: directories, ignored }
}

/**
 * The configured branch prefix, as the running entry carries it.
 *
 * `defaultBranchPrefix` is a volatile field, so the Loader hands the plugin a live
 * reference rather than a snapshot: reading it here answers with the value in force
 * at the moment of the request, which is what lets the create dialog and the
 * configuration card agree about the default without a reload in between.
 */
let branchPrefixReference

/**
 * The configured archive destination, as the running entry carries it.
 *
 * Empty is the setting's own "unset": it means the tasks file their documents
 * under whichever root the strategy names. Only the `custom` strategy reads this
 * at all, so an empty value beside that strategy also means "not set". Volatile
 * for the same reason as the prefix above.
 */
let archiveDirectoryReference

/**
 * The configured archive strategy, as the running entry carries it.
 *
 * It decides the root the per-task archive folders go under, and the directory
 * above only narrows it. Volatile for the same reason as the settings above.
 */
let archiveStrategyReference

/**
 * Whether the agent handoff entries are offered, as the running entry carries it.
 *
 * Shown unless the setting says otherwise, which is the schema's own default: what it
 * governs is the plugin's experimental part, and a profile that turns it off gets the
 * standard finish - the commit and the conflict resolution are the user's own then.
 * Volatile for the same reason as the two settings above.
 */
let handoffEntryReference

/**
 * Whether the container root is derived from the source root or named by the user.
 *
 * `default` is the recommendation the plugin has always made; `custom` hands the
 * question to the directory below. Volatile for the same reason as the settings above.
 */
let tasksRootStrategyReference

/**
 * The container root the configuration names, under the `custom` strategy.
 *
 * Volatile for the same reason as the settings above, and read as a live reference
 * because the setting is a default for the *next* task space: a value saved while a
 * session is running has to reach the create that follows it.
 */
let tasksRootDirectoryReference

/**
 * The branch prefix a request that names none should use.
 * @returns the configured prefix, or the built-in default when none is set.
 */
export function configuredBranchPrefix() {
  const value = branchPrefixReference?.get()
  return typeof value === 'string' && value.trim() !== '' ? value : DEFAULT_BRANCH_PREFIX
}

/**
 * The directory the configuration asks archived documents to be filed into.
 *
 * An empty answer is not an error: it is the setting saying "not set", and the
 * caller falls back to the root its strategy names. The value is returned as it
 * was written, without checking that it exists or is isolated - the archive is
 * where such a path is judged, because only there is the task container known and
 * a path inside it would be deleted moments after the copy.
 * @returns the configured directory, or an empty string when none is set.
 */
export function configuredArchiveDirectory() {
  const value = archiveDirectoryReference?.get()
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Which of the two roots archived documents are filed under.
 *
 * A value the schema does not offer is answered with the default rather than
 * passed on: the setting is read by the finish dialog, which has to compute a
 * destination from it, and an unrecognised word there would have to be guessed at
 * anyway. Falling back here keeps the guess in one place.
 * @returns `'container'` or `'custom'`.
 */
export function configuredArchiveStrategy() {
  const value = archiveStrategyReference?.get()
  return value === 'custom' ? value : 'container'
}

/**
 * Whether the configuration offers the agent handoff entries.
 * @returns `'hide'` when the entries are turned off, `'show'` for anything else.
 */
export function configuredHandoffEntry() {
  return handoffEntryReference?.get() === 'hide' ? 'hide' : 'show'
}

/**
 * The container root the configuration names for the next task space.
 *
 * One answer rather than the pair the two fields hold: a strategy of `default` means
 * "derive it from the source root", which is the recommendation with nothing added,
 * and so is a `custom` strategy whose directory was never filled in. Both are
 * reported as "not named" rather than as a path, because that is what the callers
 * need - an empty answer leaves the recommendation in place.
 * @returns the configured directory, or an empty string when the configuration names none.
 */
export function configuredTasksRoot() {
  if (tasksRootStrategyReference?.get() !== 'custom') return ''
  const value = tasksRootDirectoryReference?.get()
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Clamp a requested scan depth into the supported range.
 * @param value - the caller's depth, if it sent one.
 * @returns a whole number of levels between the bounds.
 */
export function resolveScanDepth(value) {
  // Absent means "use the default"; anything else is read as a number and held
  // inside the bounds. `Number(null)` is 0, so an absent value is checked first.
  if (value === undefined || value === null || value === '') return DEFAULT_SCAN_DEPTH
  const depth = Math.trunc(Number(value))
  if (!Number.isFinite(depth)) return DEFAULT_SCAN_DEPTH
  return Math.min(MAX_SCAN_DEPTH, Math.max(MIN_SCAN_DEPTH, depth))
}

// A home-directory Workspace must not crawl every application cache. Explicit
// roots are always inspected, but recursive discovery is bounded and skips noise.
// @param rootPath - the directory to walk.
// @param options - bounds for the walk.
 // @param options.onIssue - called with a sentence describing anything it could not
// read, or could not finish looking through. It never throws: one unreadable
// directory must not cost the caller every other repository, so the walk reports
// the problem and keeps what it found.
// @returns the repositories it reached, sorted. A directory is one of them when its
// `.git` is a directory; a `.git` *file* is a linked worktree, which is a checkout of
// a repository rather than one, and is left out.
export async function discoverGitRoots(rootPath, { signal, maxDepth = DEFAULT_SCAN_DEPTH, maxDirectories = MAX_SCAN_DIRECTORIES, ignored = DEFAULT_IGNORED_SCAN_DIRECTORY_SET, onIssue } = {}) {
  const roots = []
  const start = cleanPath(rootPath)
  // Counted rather than named: a tree can hold thousands of unreadable directories
  // and a panel is not a log file. The first one that could not be read is named,
  // because that is the one that explains the rest.
  let unreadable = 0
  let firstUnreadable = ''
  const noteUnreadable = (path, error) => {
    unreadable += 1
    if (firstUnreadable !== '') return
    firstUnreadable = `${path} (${error?.code ?? error?.message ?? 'unreadable'})`
  }
  const queue = [{ path: start, depth: 0 }]
  let inspected = 0
  for (let cursor = 0; cursor < queue.length;) {
    signal?.throwIfAborted()
    const batch = queue.slice(cursor, cursor + 8)
    cursor += batch.length
    inspected += batch.length
    if (inspected > maxDirectories) {
      // Used to throw, which threw away every other path's results along with the
      // one that hit the ceiling - a Workspace holding three roots would report
      // nothing because the fourth was too deep. The ceiling is a limit on how
      // much was looked at, not a statement that what was looked at does not exist.
      onIssue?.(`Stopped after ${maxDirectories} directories; deeper repositories under ${start} are not shown. Raise the scan limits or point the Workspace at a narrower root.`)
      break
    }
    await Promise.all(batch.map(async ({ path, depth }) => {
      signal?.throwIfAborted()
      let entries
      try {
        entries = await readdir(path, { withFileTypes: true })
      } catch (error) {
        // This is the line that used to say nothing at all, and it is why an
        // unreadable root was indistinguishable from an empty one: the panel said
        // "no repositories", exactly as it would for a folder that genuinely held
        // none. Access denied and not-a-directory both land here, and they mean
        // very different things to whoever has to fix it.
        noteUnreadable(path, error)
        return
      }
      // Only a real `.git` *directory* marks a repository root. A linked worktree
      // carries `.git` as a *file*, and it is a checkout of a repository rather than
      // one: listing it would put the same repository in the panel a second time,
      // under the path of the checkout rather than its own, and registering a task
      // container root as a Workspace would do it for every task space under it.
      // `discoverSourceRepos` draws the same line, for the same reason - it is what
      // keeps a task container from being offered as a source root - so what a
      // Workspace shows and what a create offers cannot come to disagree.
      //
      // Either way the walk stops here rather than descending: what is under a
      // checkout is that repository's own tree, and under a repository there is
      // nothing this plugin makes a repository out of.
      const gitEntry = entries.find((entry) => entry.name === '.git')
      if (gitEntry !== undefined) {
        if (gitEntry.isDirectory()) roots.push(path)
        return
      }
      if (depth >= maxDepth) return
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || ignored.has(entry.name.toLowerCase())) continue
        if (entry.name.startsWith('.') && entry.name !== '.worktrees') continue
        // Join with the platform separator: a hard-coded '/' yields mixed
        // separators on Windows, which breaks path identity against Git output.
        queue.push({ path: join(path, entry.name), depth: depth + 1 })
      }
    }))
  }
  if (unreadable > 0) {
    onIssue?.(unreadable === 1
      ? `Could not read ${firstUnreadable}, so repositories under it are not shown.`
      : `Could not read ${unreadable} directories under ${start}, the first being ${firstUnreadable}. Repositories under them are not shown.`)
  }
  // Sorted, because the walk is not: `roots` is filled from inside a `Promise.all`,
  // so which repository lands first is decided by which directory read came back
  // first. Left alone that makes the panel reshuffle its rows on every refresh,
  // which reads as the repositories moving - the one thing this plugin exists to
  // stop happening. Sorting is not free of meaning either: the same tree always
  // lists the same repositories in the same order, whatever the disk was doing.
  return roots.sort()
}

export async function recover(operation, classify) {
  try {
    return ok(await operation())
  } catch (error) {
    const message = String(error?.message ?? error)
    // The code is decided ONCE, before anything is written down, and the same one
    // goes into the record and into the reply. That is what makes the log and the
    // screen agree: a caller reading `task-space-exists` and a person grepping the
    // log for it are looking at one condition, not at two renderings of a message
    // that may have been reworded. Deciding it first also means the record carries
    // the code the caller actually receives, rather than the pre-flattening one.
    //
    // An error that already carries a code keeps it: that is how an operation
    // distinguishes its own failures from a caller's, rather than from its
    // wording. Everything else falls back to the caller's classifier, then to the
    // catch-all.
    const own = typeof error?.code === 'string' ? error.code : undefined
    const code = publicCode(own ?? classify?.(message) ?? UNKNOWN)
    // The sentence says what the failure means, which only the module that threw
    // it knows - that an unregistered task space is recoverable and a taken name
    // is not. It travels on the error as `msg` so this layer need not know which
    // endpoint was which.
    await recordError(error, {
      phase: 'endpoint',
      code,
      ...(typeof error?.msg === 'string' && error.msg.trim() !== '' ? { msg: error.msg } : {}),
    })
    return fail(code, message)
  }
}

/**
 * The Workspace paths a request carries.
 *
 * Both the scan and the read of what the Host remembers are asked for the same
 * set, and they have to read it the same way for one to answer for the other. The
 * order is kept: it is the caller's, and nothing here depends on it.
 * @param payload - the request payload.
 * @returns the usable paths, empty when none were given.
 */
export function requestedPaths(payload) {
  if (!Array.isArray(payload?.paths)) return []
  return payload.paths.filter((path) => typeof path === 'string').map((path) => path.trim()).filter(Boolean)
}

/**
 * Whether `inner` sits strictly inside `outer`.
 *
 * Windows comparison is case-insensitive and both spellings of a separator count,
 * because the paths arrive from three places - a Workspace registration, a scan
 * answer, a path typed into a dialog - and none of them normalises the others.
 * @param outer - the containing directory.
 * @param inner - the directory that may be inside it.
 * @returns true when `inner` is a descendant of `outer`.
 */
function isInsideDirectory(outer, inner) {
  return isInside(outer, inner)
}

/**
 * The requested paths, with any one that sits inside another dropped.
 *
 * A Workspace registered inside another Workspace - `E:\workspace\public` under
 * `E:\workspace` - is walked on its own account and again as part of its parent, so
 * every repository under it is found twice and every parent pays twice for the same
 * directories. The nested path is the one that goes: it is walked by name either
 * way, so dropping it from the parent's pass loses nothing and stops the duplicate.
 *
 * Both endpoints that walk the requested paths use this, and they have to. The count
 * on a Workspace's badge and the repositories it lists come from two walks over one
 * path list; pruning the scan and not the count would leave the badge reporting
 * repositories the list no longer holds.
 * @param paths - the Workspace paths the request carries.
 * @returns the outermost of them, deduplicated, in the order they were given.
 */
export function topLevelRequestedPaths(paths) {
  const cleaned = [...new Set(paths.map(cleanPath).filter(Boolean))]
  // Shortest first, and that direction is the whole rule. A path is dropped only
  // when something already kept contains it, so the container has to be examined
  // first: sorting longest-first would keep the nested path and then find nothing
  // containing the parent, and both would survive.
  const outermostFirst = [...cleaned].sort((left, right) => left.length - right.length)
  const kept = []
  for (const candidate of outermostFirst) {
    if (kept.some((outer) => isInsideDirectory(outer, candidate))) continue
    kept.push(candidate)
  }
  // Back to the caller's order, which is theirs to have chosen.
  return cleaned.filter((path) => kept.includes(path))
}


/**
 * The branch each named repository should merge into.
 *
 * The dialog chooses per repository and the tool names one branch for all of them,
 * so both shapes reach the Host: this reads the map, and a request without one
 * leaves every repository on its own default.
 * @param value - the request's `targets`.
 * @returns the branch per repository name, or undefined when none were named.
 */
export function branchTargets(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const targets = {}
  for (const [name, branch] of Object.entries(value)) {
    const repository = name.trim()
    const target = typeof branch === 'string' ? branch.trim() : ''
    if (repository !== '' && target !== '') targets[repository] = target
  }
  return Object.keys(targets).length === 0 ? undefined : targets
}


export const name = 'dsh-worktree-space'
export const inject = ['connection', 'subprocess']

/**
 * Plugin configuration, validated by the Loader against this profile row.
 *
 * Declaring it is what makes the plugin configurable: the 0.1.7 Host serves one
 * configuration form per profile entry from the entry's own Config, so these two
 * fields appear in the Plugins page beside every other plugin's. There is no
 * `ctx.settings.installSection` to call any more — `ctx.settings` is now the
 * schema-derived form service (`describe`, `update`, `replace`, `mutate`,
 * `configure`), and it owns no per-plugin section to install.
 *
 * Both fields are volatile, and that is what makes them appear: the Plugins page's
 * live form serves the entry id's namespace from this schema and, of its fields,
 * only the volatile preferences are served and editable. Non-volatile fields are
 * accepted here and left to the profile document, which is why the form stayed
 * empty while these two were plain. The client half reads the values through
 * `configForms.get(name)` and registers the slots from the answer, so a change
 * applies as soon as it is made.
 */
export const Config = z.object({
  panelEntry: z.union(['show', 'hide']).default('hide').loose().volatile()
    .description('Also show the management page as a row in the sidebar panel list, under New session. Hidden by default: the footer shortcut is the one way in.'),
  sidebarEntry: z.union(['show', 'hide']).default('show').loose().volatile()
    .description('Show the Worktree Space shortcut in the sidebar footer.'),
  /**
   * Whether the two entries that hand work to an agent are offered.
   *
   * Shown by default, because that is the finish the plugin has been shipping: a profile
   * that would rather not see an experimental entry sets this to hide, and the standard
   * finish is then the user's own commit and their own conflict resolution. The dialogs
   * read it from `task.preference` rather than from this form, because that is where the
   * other setting they default from already arrives.
   */
  handoffEntry: z.union(['show', 'hide']).default('show').loose().volatile()
    .description('Offer the two experimental entries that hand uncommitted work, and a merge conflict, to an agent. Hidden, the standard flow applies: commit and resolve the conflict yourself, then finish the task again.'),
  /**
   * Whether the audit log is written.
   *
   * On by default, and that is the setting being worth having: the log is the only
   * account of what happened to a task space that survives the terminal, and a
   * setting whose default was "off" would mean nobody had it until something went
   * wrong and they went looking. Switched off, nothing new is written and the file
   * already there is left alone - turning a log off is not a way to delete one,
   * because the records are frequently the only copy.
   *
   * Read through `task.preference` as well, so a dialog that needs to say whether
   * logging is on does not have to reach for the configuration form.
   */
  auditLog: z.union(['on', 'off']).default('on').loose().volatile()
    .description('Write a record of every operation, git call and failure to the container root. Off stops new records and keeps the log already there.'),
  /** The Web UI's control is gone: this is the one place the depth is chosen. */
  scanDepth: z.number().min(MIN_SCAN_DEPTH).max(MAX_SCAN_DEPTH).step(1).default(DEFAULT_SCAN_DEPTH).volatile()
    .description('How many directory levels a scan descends from a Workspace root.'),
  maxScanDirectories: z.number().min(1).step(1).default(MAX_SCAN_DIRECTORIES).volatile()
    .description('Directories one scan may inspect before it stops looking.'),
  /**
   * Directory names a scan walks past, on top of the ones it always skips.
   *
   * This is an addition rather than a replacement: the built-in names stay in
   * force whatever this holds, because the setting is about what a scan should
   * not spend its budget on, and switching `node_modules` back on by accident is
   * a mistake with no upside. A name among the built-in ones that has to stop
   * being skipped is the other direction, and has its own setting - see
   * `removedScanDirectories`.
   *
   * Names are matched without regard to case, because the directory names this
   * is compared against are spelled by whichever filesystem is under the
   * Workspace.
   *
   * The ceiling here is a long way above the one the dialog enforces, and on
   * purpose. That number is about a list of tags a person is looking at; this one
   * is about refusing a file so malformed that the plugin should refuse to start.
   * A configuration written by hand with a few hundred names in it is honoured,
   * because a name someone wrote down is a name they meant.
   */
  ignoredScanDirectories: z.array(z.string()).max(10000).default([]).volatile()
    .description('Extra directory names the scan never descends into, beyond the ones it always skips.'),
  /**
   * The built-in names the scan descends into again.
   *
   * A subtraction rather than a replacement list, for a reason that only shows up
   * later: if this said "these are the names to skip", then every name a future
   * release adds to the built-in list would be silently dropped for anyone who had
   * ever edited this setting. Recording what was taken off keeps the two halves
   * saying what they mean, and survives the plugin changing underneath.
   *
   * A name here that the Host does not ship is ignored rather than refused: it
   * matches nothing, and a stale entry left by a rename should not stop the
   * configuration loading.
   */
  removedScanDirectories: z.array(z.string()).max(10000).default([]).volatile()
    .description('Built-in directory names the scan descends into again.'),
  /**
   * The branch prefix every new task space starts from.
   *
   * It is the one setting both halves of this plugin write: the configuration card
   * edits it directly, and the create dialog offers to save the prefix it is about to
   * use. Volatile like the rest of this schema, which is what makes the Plugins page
   * render it and every edit land on the running entry instead of waiting for a reload.
   */
  defaultBranchPrefix: z.string().default(DEFAULT_BRANCH_PREFIX).volatile()
    .description('The prefix every new task space starts from: the branch is this plus the task name. The create dialog offers to update it.'),
  /**
   * Whether the container root is the plugin's recommendation or the user's.
   *
   * `default` keeps the derived rule - the first directory below the volume root,
   * which is what gives every project of one root workspace the same container and
   * the worktree the common ancestor a session needs to commit. `custom` answers
   * with `tasksRootDirectory` instead, for a user who wants every task space
   * somewhere of their own; a directory that shares no such ancestor with the
   * repositories then has to be authorised by hand in the agent sessions the finish
   * opens, which is what the setting's own note warns about.
   *
   * The create dialog offers to save the location it was about to use, the way it
   * already does for the branch prefix. Volatile like the rest of this schema.
   */
  tasksRootStrategy: z.union(['default', 'custom']).default('default').loose().volatile()
    .description('Where a new task space goes. default derives it from the source root, and custom uses the directory below.'),
  /**
   * The container root a task space goes in under the `custom` strategy.
   *
   * Empty means "not set", which leaves the recommendation in place rather than
   * naming nowhere. Unlike the archive directory this one is not merely a
   * destination: it is checked by the same isolation rule an explicitly requested
   * container root is, so a directory inside (or containing) the repositories is
   * refused when a task is created or suggested rather than silently used.
   */
  tasksRootDirectory: z.string().default('').volatile()
    .description('Where new task spaces go under the custom strategy. Empty keeps the derived recommendation instead.'),
  /**
   * Which root a task's documents are filed under when it is archived.
   *
   * `container` keeps them in the container root, under
   * `<container root>\archived-docs`: everything this plugin writes then lives
   * under the one directory it names, and no second anchor appears elsewhere on
   * the volume. `custom` uses `archiveDocumentsDirectory`.
   *
   * Volatile like the rest of this schema: the Plugins page serves it and a write
   * lands on the running entry without a reload.
   */
  archiveDocumentsStrategy: z.union(['container', 'custom']).default('container').loose().volatile()
    .description('The root archived documents are filed under. container keeps them in the container root, and custom uses the directory below.'),
  /**
   * Where a task's documents are filed when it is archived, under the `custom`
   * strategy.
   *
   * Empty means "not set" and falls back to the container root, which is what the
   * setting files under by default. The `<project>\<task>-<stamp>` folders are
   * added under whatever root is chosen, so two tasks filed into one directory
   * never mix their documents. Volatile for the same reason as the strategy above.
   *
   * The value is not checked here. A directory that cannot hold the copy, or one
   * inside the task container, is refused by the archive itself, where the path it
   * has to stay out of is known.
   */
  archiveDocumentsDirectory: z.string().default('').volatile()
    .description('Where archived documents go under the custom strategy. Empty files them under the container root instead.'),
})

/**
 * Read a setting that `apply` only needs the value of.
 *
 * The Loader hands over a live reference, so a value read once is a snapshot -
 * which is why the settings a dialog can change are held as the reference and
 * asked at use time. The switch is the one exception: it is pushed into a module
 * and `apply` runs again on a change, so it is read here and not later.
 *
 * A plain value is accepted as well, because that is what a caller passing a
 * literal means and there is nothing to be gained by refusing it. Both shapes
 * matter, and reading only one of them fails quietly - `'off'.get` is undefined,
 * so a reference-only read treats a plain `'off'` as unset and the switch stays
 * on, which is the opposite of what was asked for.
 * @param setting - the reference, or the value itself.
 * @returns the value, or undefined when there is none.
 */
function settingValue(setting) {
  if (setting !== null && typeof setting === 'object' && typeof setting.get === 'function') return setting.get()
  return setting
}

export function apply(ctx, config = {}) {
  // Held, not read. The walk limits are resolved by `scanBounds()` at the moment a
  // walk starts, because this is set from the Plugins page while the entry is
  // running and the fields are live references rather than values - a snapshot
  // taken here reads the old depth after a new one is written, and reading the
  // reference directly answers with the default.
  appliedConfig = config ?? {}
  // Kept as the live reference, not its value: a prefix saved from the Web UI
  // reaches the running entry through this same accessor.
  branchPrefixReference = config.defaultBranchPrefix
  // Likewise for the archive destination: the settings card writes it and the
  // archive dialog reads it, both through this entry rather than its snapshot.
  archiveDirectoryReference = config.archiveDocumentsDirectory
  // And the strategy beside it, which the dialog needs before the directory is
  // any use: it names the root the directory may narrow.
  archiveStrategyReference = config.archiveDocumentsStrategy
  // And for the agent handoff entries: the settings card writes this one, the finish
  // dialog reads it, and shown is what anything but an explicit `hide` means.
  handoffEntryReference = config.handoffEntry
  // And for where a task space goes: the settings card writes the pair, and every
  // caller that was not told a container root resolves it through these.
  tasksRootStrategyReference = config.tasksRootStrategy
  tasksRootDirectoryReference = config.tasksRootDirectory
  // The audit log, unlike the others, is not read at use time: it is pushed into
  // the module that writes, because the writers are the many call sites and a
  // read there would mean asking every one of them for the setting.
  //
  // What is pushed is a way to ASK, not the answer. `config` here is the snapshot
  // `resolveConfig` produced when the Loader validated it, not a live view, so a
  // value read from it stays right only as long as this closure is replaced - and
  // it is, because the Loader restarts a plugin when its configuration changes
  // (`Fiber.update` -> `restart` -> `apply` again). Reading per record therefore
  // changes nothing in the normal path; it keeps the switch honest in the window
  // where the value has been written to the profile but `apply` has not run again,
  // and costs nothing beside the append it gates.
  //
  // The read goes through `settingValue`, as every other setting here does. Reading
  // only the reference shape fails quietly: `'off'.get` is undefined, so a plain
  // 'off' reads as unset and the switch stays on - the opposite of the ask.
  setAuditEnabledReader(() => settingValue(config.auditLog) !== 'off')
  // The tool is how the multi-repository workflow is driven while the Web UI is
  // still the upstream single-repository surface. A deployment that serves no
  // tool runtime keeps working: the /api endpoints remain the seam. The injected
  // callback returns the registration's disposer so cordis tears the tool down
  // with the plugin instead of leaking it.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (toolsCtx) => registerTaskTool(toolsCtx, { configuredRoot: configuredTasksRoot }))
  } else {
    registerTaskTool(ctx, { configuredRoot: configuredTasksRoot })
  }

  // The bundled skill carries the fuller workflow guidance, which is loaded on
  // demand; the tool description keeps the rules that must hold even when no
  // skill has been loaded. Both are handed back so cordis disposes them.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (skillsCtx) => registerTaskSkill(skillsCtx))
  } else {
    registerTaskSkill(ctx)
  }

  const handle = async (endpoint, payload = {}, signal) => {
    if (signal?.aborted) return fail('cancelled', 'The request was cancelled.')
    // Which request the records it produces belong to. The task, the project and
    // the container root are entered further down, where they are known.
    auditEnter({ op: endpoint })

    const listRepository = async (path) => {
      if (!path) throw coded('E6002', 'Select a DSH Workspace.')
      // One git process, and it is `worktree list --porcelain`.
      //
      // This used to be five: `--show-toplevel`, `--git-common-dir`,
      // `symbolic-ref origin/HEAD` and `for-each-ref`, plus this one. Three of
      // them were answering questions nothing asked.
      //
      //   - The porcelain's FIRST entry is the main working tree, by git's own
      //     ordering, so `--show-toplevel` was the same answer with a process
      //     attached to it.
      //   - `--git-common-dir` produced a `commonDir` that was written into the
      //     reply and read by nothing, in this repository or in the client.
      //   - `detectDefaultBranch` produced `defaultBranch` and `defaultRef`, also
      //     read by nothing. The branch the panel shows is derived on the client
      //     from the main worktree's row (scan.ts), which is why nobody noticed.
      //
      // Measured on a ninety-four repository Workspace: process creation is ~95%
      // of a git call on Windows (bare `git --version` costs almost as much as a
      // real query), the calls do not parallelise past about twelve in flight, and
      // the walk that finds the repositories is 0.08% of the scan. So the only
      // lever that matters is how many processes there are: five to one took a
      // measured 3.9s to roughly 0.9s.
      //
      // `log: false` because a scan is a read of every repository under the
      // Workspace, and `worktree` is not in the read-only filter. Five hundred
      // processes and a hundred records per refresh is not a log anybody can read.
      //
      // What a failing call leaves behind is not the log either: `runGit` records a
      // failure, and `auditRecord` then drops every record made before an operation
      // has named a container root - which a scan belongs to none of. So a scan that
      // could not answer says so in its own reply, and is not written down anywhere:
      // the log is a record of task spaces, and a scan is not one. That drop is
      // deliberate; see audit-log.js.
      const porcelain = await runGit(ctx.subprocess, path, ['worktree', 'list', '--porcelain'], { log: false })
      const worktrees = parseWorktrees(porcelain)
      // No fallback to a `rev-parse`: an empty porcelain is git saying this
      // directory has no worktrees, which is a repository that will not answer,
      // and inventing a path for it would put a row in the panel that git never
      // described.
      const repoPath = worktrees.find((worktree) => worktree.isMain)?.path
      if (repoPath === undefined) throw coded('E3004', `${path} is not a Git repository.`)
      return { repoPath, worktrees }
    }

    if (endpoint === 'worktree.scan') return recover(async () => {
      const paths = requestedPaths(payload)
      // Read once per request, not per lookup: the bounds are configuration, and a
      // request that read them twice could answer with a depth the user never saw
      // if the Plugins page wrote one halfway through.
      const bounds = scanBounds()
      const maxDepth = resolveScanDepth(payload.depth ?? bounds.depth)
      // What went wrong on the way, if anything. Collected rather than thrown: a
      // scan that found ninety of a hundred repositories has ninety repositories
      // worth showing, and answering it with an error threw those ninety away and
      // left the panel showing whatever it had remembered instead. See the return
      // shape below.
      let reason = ''
      const spared = (why) => { if (reason === '') reason = why }
      // Deduplicated by the cleaned path rather than by the string the caller
      // happened to send, so `C:\src` and `C:\src\` are one walk instead of two.
      const walked = topLevelRequestedPaths(paths)
      if (walked.length === 0) throw coded('E4006', 'No usable Workspace path was given to scan.')
      // Every path is walked on its own account and every walk reports its own
      // problems through `spared`. One unreadable root therefore costs only its own
      // repositories: the paths that did answer still show, and the answer says
      // which part did not.
      const found = await Promise.all(walked.map((path) => discoverGitRoots(path, { signal, maxDepth, maxDirectories: bounds.directories, ignored: bounds.ignored, onIssue: spared })))
      const roots = [...new Set(found.flat())]
      if (signal?.aborted) throw signal.reason
      const seen = new Set()
      // Asked a few at a time rather than one at a time, which is what this loop
      // used to do and what made a refresh on a machine with repositories the
      // wait: every other stage of the same refresh already runs in parallel, so
      // this one was the whole of it. The ceiling is deliberate - each repository
      // costs one `git` process, and asking for all of them at once trades the
      // queue for a fight over process slots.
      const listed = await mapWithLimit(roots, SCAN_CONCURRENCY, async (root) => {
        signal?.throwIfAborted()
        try {
          return await listRepository(root)
        } catch {
          // A repository can disappear while a scan is in progress, or refuse to
          // answer. Either way the others are still repositories.
          spared('Some repositories did not answer the scan and are not shown.')
          return undefined
        }
      })
      const repositories = listed.filter((repository) => {
        if (repository === undefined) return false
        const key = cleanPath(repository.repoPath)
        if (key === '' || seen.has(key)) return false
        seen.add(key)
        return true
      })
      const complete = reason === ''
      // An empty answer that knows why it is empty used to throw, on the reasoning
      // that there is nothing to show so the reason is the whole answer. It cost
      // more than it was worth: throwing meant `rememberScan` never ran, so a
      // Workspace whose repository had been deleted kept painting the stale list
      // that the very next scan was supposed to replace. The panel already renders
      // `reason` beside an empty list - that is what `complete` is for - so the
      // answer goes back with the reason attached and the memory is refreshed.
      // The scan is what refreshes the panel's memory of these Workspaces, and an
      // empty answer is remembered too: a task space whose worktrees are all gone
      // is exactly what the next panel should paint, rather than an older list.
      rememberScan(paths, repositories)
      // The list, plus whether it is the whole of it.
      //
      // An object rather than the bare array because "these ninety of a hundred"
      // and "these hundred" are different answers and the caller cannot tell them
      // apart from an array - which is what made this worth changing rather than
      // just swallowing the error: the panel used to answer a scan that found
      // ninety repositories with an error, and the ninety went on screen nowhere.
      // The Host and the client ship in one package, so the shape can change
      // without a compatibility window.
      // The bounds actually in force, as opposed to the bounds the caller believes
      // are in force. The panel names the depth in its scanning message, and a name
      // it made up could disagree with the walk - a stale config, a value clamped
      // by `resolveScanDepth`, a payload that carried its own. The Host is the only
      // side that knows, so the Host says.
      return { lists: repositories, complete, reason, bounds: { depth: maxDepth, directories: bounds.directories } }
    })

    if (endpoint === 'worktree.cached') return recover(async () => {
      // The whole point of this endpoint is the repaint it saves, so a miss is an
      // empty answer rather than an error the panel has to handle. It is answered
      // either way: holding nothing about these paths says nothing about what depth
      // a scan would run at now, and returning `null` for the miss would take that
      // answer away along with the rows - which is how a panel that has never
      // scanned anything ends up unable to name the depth of its first scan.
      const remembered = recallScan(requestedPaths(payload))
      // Read off the live configuration on every call, never off the remembered
      // scan: those are the bounds of a run that already happened, and a panel
      // that adopted them would be naming the previous scan rather than the one on
      // screen. The panel sends this depth in its scan payload, so the number it
      // shows and the number the Host walks cannot drift apart.
      const live = scanBounds()
      return {
        repositories: remembered?.repositories ?? [],
        statuses: remembered?.statuses ?? {},
        current: { depth: live.depth, directories: live.directories },
      }
    })

    if (endpoint === 'worktree.status') return recover(async () => {
      const path = typeof payload.path === 'string' ? payload.path.trim() : ''
      if (!path) throw coded('E4005', 'Worktree path is required.')
      const target = typeof payload.target === 'string' ? payload.target.trim() : ''
      // Two independent questions, asked together. The commit count is a range
      // over refs and never reads the status output, so running it after the
      // status was pure queueing.
      const [output, ahead] = await Promise.all([
        runGit(ctx.subprocess, path, ['status', '--short', '--branch']),
        target === '' ? '' : tryRunGit(ctx.subprocess, path, ['rev-list', '--count', `${target}..HEAD`]),
      ])
      const lines = output ? output.split(/\r?\n/) : []
      // What this worktree would carry back: everything on its HEAD the named branch
      // does not have. The caller names that branch, because the page already knows
      // which one the source checkout sits on - the branch finishing would merge
      // into. No name, or one git cannot resolve, leaves the count out rather than
      // claiming zero commits.
      const commits = Number.parseInt(ahead, 10)
      const status = {
        branchLine: lines.find((line) => line.startsWith('## ')) ?? '',
        changedFiles: lines.filter((line) => line && !line.startsWith('## ')).length,
        ...(Number.isFinite(commits) ? { commits } : {}),
        output,
      }
      rememberStatus(path, status)
      return status
    })

    if (endpoint === 'task.classify-root') return recover(async () => {
      const sourceRoot = typeof payload.sourceRoot === 'string' ? payload.sourceRoot.trim() : ''
      if (!sourceRoot) throw coded('E4004', 'A source root is required.')
      return classifySourceRoot(sourceRoot, { signal })
    })

    // The plural one exists so a panel can ask about a page of Workspaces in a
    // single round trip instead of one per row. The single form above stays for
    // the two callers that are about to act on what they are told - adding a
    // repository, adding a Workspace - because those must never be answered from
    // anything but a walk taken now. Both forms walk now; this one only stops
    // asking the same question N times over the wire.
    if (endpoint === 'task.classify-roots') return recover(async () => {
      const paths = requestedPaths(payload)
      if (paths.length === 0) throw coded('E4004', 'A source root is required.')
      // Not pruned the way `worktree.scan` prunes, and deliberately so. Pruning
      // deletes the nested path from the request; this endpoint's answer is not a
      // repository list but `isSourceRoot` per path, and that is what decides
      // whether a task space can be started from the Workspace. A Workspace
      // registered inside another one is a Workspace like any other, and dropping
      // it here took that ability away from it. `classifySourceRoots` stops the
      // duplicate walk from the other end instead: each path is classified on its
      // own account, while every other one skips its nested subtrees.
      return classifySourceRoots(paths, { signal, concurrency: SCAN_CONCURRENCY, ...taskScanBounds() })
    })

    if (endpoint === 'task.suggest-root') return recover(async () => {
      const sourceRoot = typeof payload.sourceRoot === 'string' ? payload.sourceRoot.trim() : ''
      if (!sourceRoot) throw coded('E4004', 'A source root is required.')
      return suggestTaskRoot(ctx.subprocess, sourceRoot, {
        tasksRoot: payload.tasksRoot,
        // An unnamed prefix is the configured one, not the built-in: the suggestion
        // is what the create dialog shows, and it must show the same default the
        // request will fall back to.
        branchPrefix: typeof payload.branchPrefix === 'string' && payload.branchPrefix !== ''
          ? payload.branchPrefix
          : configuredBranchPrefix(),
        // Likewise for the location, so the dialog opens on the container root the
        // configuration names instead of on the one it would otherwise derive.
        configuredRoot: configuredTasksRoot(),
          // Same walk, same depth, same ignored names as the classification and
          // the create: the dialog previews what those two will act on.
          ...taskScanBounds(),
        })
    })

    if (endpoint === 'task.preference') return recover(async () => {
      // Read-only, and shaped as a record rather than a bare string: the next
      // preference this dialog needs joins it without a second endpoint.
      return {
        defaultBranchPrefix: configuredBranchPrefix(),
        archiveDocumentsStrategy: configuredArchiveStrategy(),
        archiveDocumentsDirectory: configuredArchiveDirectory(),
        handoffEntry: configuredHandoffEntry(),
        // So a dialog can tell someone that what just happened was not recorded
        // rather than leave them to find an empty log and assume the plugin is
        // broken. The answer is the running state, not the configured value, so
        // it cannot disagree with what is actually being written.
        auditLog: auditEnabled() ? 'on' : 'off',
      }
    })

    if (endpoint === 'task.create') return recover(async () => {
      const sourceRoot = typeof payload.sourceRoot === 'string' ? payload.sourceRoot.trim() : ''
      const task = typeof payload.task === 'string' ? payload.task.trim() : ''
      if (!sourceRoot) throw coded('E4004', 'A source root is required.')
      if (!task) throw coded('E4003', 'A task name is required.')
      const repos = Array.isArray(payload.repos)
        ? payload.repos.filter((name) => typeof name === 'string' && name.trim() !== '').map((name) => name.trim())
        : undefined
      return createTask(ctx.subprocess, {
        sourceRoot,
        task,
        tasksRoot: payload.tasksRoot,
        repos,
        baseRef: typeof payload.baseRef === 'string' ? payload.baseRef.trim() : undefined,
        // A caller that names no prefix gets the configured one; an empty string
        // means the same thing, which is what an emptied dialog field sends.
        branchPrefix: typeof payload.branchPrefix === 'string' && payload.branchPrefix !== ''
          ? payload.branchPrefix
          : configuredBranchPrefix(),
        // A request that names no container root takes the configured one, which is
        // the same answer `task.suggest-root` just gave the dialog.
        configuredRoot: configuredTasksRoot(),
        // And the same walk that dialog previewed and the Workspace card counted,
        // with the same bounds: `scanDepth` decides what "the repositories under
        // this root" means, and one meaning has to hold across all three.
        scanBounds: taskScanBounds(),
      })
    })

    // A task that turned out to need one more repository after it started. The
    // repositories are absolute paths rather than names under a source root,
    // because a repository added here need not sit beside the ones the task
    // began with - it may be under another source root, or on another volume.
    if (endpoint === 'task.add-repositories') return recover(async () => {
      const task = typeof payload.task === 'string' ? payload.task.trim() : ''
      if (!task) throw coded('E4003', 'A task name is required.')
      const repositories = Array.isArray(payload.repositories)
        ? payload.repositories.filter((path) => typeof path === 'string' && path.trim() !== '').map((path) => path.trim())
        : []
      return addTaskRepositories(ctx.subprocess, {
        task,
        project: typeof payload.project === 'string' ? payload.project : '',
        tasksRoot: typeof payload.tasksRoot === 'string' ? payload.tasksRoot.trim() : '',
        repositories,
        baseRef: typeof payload.baseRef === 'string' && payload.baseRef.trim() !== ''
          ? payload.baseRef.trim()
          : undefined,
      })
    })

    // The task spaces sitting in a container root, with their identity. A create
    // that failed after its worktrees were made leaves the container on disk with
    // its branch intact, and nothing in the plugin remembers it once the dialog
    // closes. The dialog lists these and compares them against the Workspaces it
    // can see, so it can offer to register or clean up instead of reporting a name
    // clash the user can only answer by hand.
    if (endpoint === 'task.list') return recover(async () => {
      const tasksRoot = typeof payload.tasksRoot === 'string' ? payload.tasksRoot.trim() : ''
      return listTasks(ctx.subprocess, { tasksRoot })
    })

    if (endpoint === 'task.inspect') return recover(async () => {
      const path = typeof payload.path === 'string' ? payload.path.trim() : ''
      if (!path) throw coded('E4005', 'A task path is required.')
      return inspectTask(path)
    })

    if (endpoint === 'task.plan') return recover(async () => {
      const task = typeof payload.task === 'string' ? payload.task.trim() : ''
      if (!task) throw coded('E4003', 'A task name is required.')
      return planTask(ctx.subprocess, {
        task,
        project: typeof payload.project === 'string' ? payload.project : '',
        tasksRoot: typeof payload.tasksRoot === 'string' ? payload.tasksRoot.trim() : '',
        targets: branchTargets(payload.targets),
      })
    })

    if (endpoint === 'task.done') return recover(async () => {
      const task = typeof payload.task === 'string' ? payload.task.trim() : ''
      if (!task) throw coded('E4003', 'A task name is required.')
      return finishTask(ctx.subprocess, {
        task,
        project: typeof payload.project === 'string' ? payload.project : '',
        tasksRoot: typeof payload.tasksRoot === 'string' ? payload.tasksRoot.trim() : '',
        merge: payload.merge === true,
        target: typeof payload.target === 'string' ? payload.target : undefined,
        targets: branchTargets(payload.targets),
        deleteBranch: payload.deleteBranch === true,
        force: payload.force === true,
        cleanStray: payload.cleanStray === true,
        keep: Array.isArray(payload.keep) ? payload.keep.filter((name) => typeof name === 'string') : [],
        documentsDirectory: typeof payload.documentsDirectory === 'string' ? payload.documentsDirectory : undefined,
        discardDocuments: payload.discardDocuments === true,
        // Why the dialog is finishing a task it never told the user existed. The
        // rollback after a create whose Workspace would not register goes through
        // this endpoint like any other, so without this the log would show the
        // worktrees and the branch being deleted and never say that the reason
        // was a create that had already half succeeded.
        cause: typeof payload.cause === 'string' && payload.cause.trim() !== '' ? payload.cause.trim() : undefined,
      })
    })

    return fail(UNKNOWN, `Unknown endpoint: ${endpoint}`)
  }

  // Exact routes use Connection's authenticated /api carrier. In DSH rc.2,
  // rpc.handle() for a custom channel reads webServer from a service shadow
  // that has not injected it, causing the entire host to fail during boot.
  for (const endpoint of ENDPOINTS) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `${API_PREFIX}/${endpoint}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 })
        }
        let body
        try { body = await request.json() } catch {
          return new Response('body is not JSON', { status: 400 })
        }
        const message = readClientRequest(body)
        if (message === null) return new Response('invalid client-request message', { status: 400 })
        const result = message.method === `dsh-worktree-space/${endpoint}`
          ? await handle(endpoint, message.payload, request.signal)
          : fail(UNKNOWN, 'RPC method does not match endpoint.')
        return Response.json({ type: 'server-response', rpcId: message.rpcId, result })
      },
    }), `dsh-worktree-space ${endpoint} route`)
  }
}

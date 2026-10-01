import z from '@deepseek-ai/schemastery'
import { readdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { detectDefaultBranch, parseWorktrees, runGit, tryRunGit } from './task/git.js'
import { DEFAULT_BRANCH_PREFIX } from './task/naming.js'
import { classifySourceRoot, createTask, finishTask, inspectTask, listTasks, planTask, suggestTaskRoot } from './task/operations.js'
import { recallScan, rememberScan, rememberStatus } from './task/scanCache.js'
import { registerTaskSkill } from './task/skill.js'
import { registerTaskTool } from './task/tool.js'

// These helpers moved to the git module; they stay part of the entry module's
// public surface because callers and tests import them from here.
export { detectDefaultBranch, parseWorktrees, runGit } from './task/git.js'

const API_PREFIX = '/api/dsh-worktree-space'
const WORKTREE_ENDPOINTS = ['worktree.scan', 'worktree.cached', 'worktree.status']
const TASK_ENDPOINTS = ['task.classify-root', 'task.suggest-root', 'task.create', 'task.list', 'task.inspect', 'task.plan', 'task.done', 'task.preference']
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
const PUBLIC_ERROR_CODES = new Set([
  'bad-request',
  'cancelled',
])

export const fail = (code, message, details = {}) => ({
  ok: false,
  error: { code: PUBLIC_ERROR_CODES.has(code) ? code : 'bad-request', message, details: { issues: [], ...details } },
})

export const cleanPath = (value) => {
  const text = String(value ?? '')
  return text.length > 1 ? text.replace(/[\\/]+$/, '') : text
}

async function removeOrphanedWorktree(path) {
  if (!existsSync(path)) return false
  let marker
  try { marker = await readFile(`${path}/.git`, 'utf8') } catch { return false }
  const gitdir = marker.match(/^gitdir:\s*(.+)\s*$/m)?.[1]
  if (!gitdir || existsSync(gitdir)) return false
  await rm(path, { recursive: true, force: false })
  return true
}

const IGNORED_SCAN_DIRECTORIES = new Set(['node_modules', 'Library', 'dist', 'build', 'vendor'])

/** Scan bounds. The Web UI offers these depths, and the Host enforces them. */
export const MIN_SCAN_DEPTH = 1
export const MAX_SCAN_DEPTH = 5
export const DEFAULT_SCAN_DEPTH = 2
/** Directories one scan may inspect before it refuses to guess any further. */
export const MAX_SCAN_DIRECTORIES = 1000

/**
 * Scan bounds in force for this process, from the configuration.
 *
 * The walk is the Host's, so the depth and the directory cap are resolved here
 * once and used by every scan, rather than travelling with each request.
 */
const scanBounds = { depth: DEFAULT_SCAN_DEPTH, directories: MAX_SCAN_DIRECTORIES }

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
export async function discoverGitRoots(rootPath, { signal, maxDepth = DEFAULT_SCAN_DEPTH, maxDirectories = MAX_SCAN_DIRECTORIES } = {}) {
  const roots = []
  const queue = [{ path: cleanPath(rootPath), depth: 0 }]
  let inspected = 0
  for (let cursor = 0; cursor < queue.length;) {
    signal?.throwIfAborted()
    const batch = queue.slice(cursor, cursor + 8)
    cursor += batch.length
    inspected += batch.length
    if (inspected > maxDirectories) throw new Error('Worktree scan limit reached; choose a more specific Workspace.')
    await Promise.all(batch.map(async ({ path, depth }) => {
      signal?.throwIfAborted()
      let entries
      try { entries = await readdir(path, { withFileTypes: true }) } catch { return }
      if (entries.some((entry) => entry.name === '.git')) {
        roots.push(path)
        return
      }
      if (depth >= maxDepth) return
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || IGNORED_SCAN_DIRECTORIES.has(entry.name)) continue
        if (entry.name.startsWith('.') && entry.name !== '.worktrees') continue
        // Join with the platform separator: a hard-coded '/' yields mixed
        // separators on Windows, which breaks path identity against Git output.
        queue.push({ path: join(path, entry.name), depth: depth + 1 })
      }
    }))
  }
  return roots
}

export async function recover(operation, classify) {
  try {
    return ok(await operation())
  } catch (error) {
    const message = String(error?.message ?? error)
    return fail(classify?.(message) ?? 'bad-request', message)
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
  /** The Web UI's control is gone: this is the one place the depth is chosen. */
  scanDepth: z.number().min(MIN_SCAN_DEPTH).max(MAX_SCAN_DEPTH).step(1).default(DEFAULT_SCAN_DEPTH).volatile()
    .description('How many directory levels a scan descends from a Workspace root.'),
  maxScanDirectories: z.number().min(1).step(1).default(MAX_SCAN_DIRECTORIES).volatile()
    .description('Directories one scan may inspect before it stops looking.'),
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

export function apply(ctx, config = {}) {
  // The walk is the Host's, so these come from the configuration rather than from
  // the caller: a scan request carries paths, not limits.
  scanBounds.depth = resolveScanDepth(config.scanDepth)
  if (Number.isFinite(Number(config.maxScanDirectories))) {
    scanBounds.directories = Math.max(1, Math.trunc(Number(config.maxScanDirectories)))
  }
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

    const listRepository = async (path) => {
      if (!path) throw new Error('Select a DSH Workspace.')
      const [topLevel, commonDir, porcelain] = await Promise.all([
        runGit(ctx.subprocess, path, ['rev-parse', '--show-toplevel']),
        runGit(ctx.subprocess, path, ['rev-parse', '--git-common-dir']),
        runGit(ctx.subprocess, path, ['worktree', 'list', '--porcelain']),
      ])
      const worktrees = parseWorktrees(porcelain)
      const repoPath = worktrees.find((worktree) => worktree.isMain)?.path ?? topLevel
      const defaultBranch = await detectDefaultBranch(ctx.subprocess, repoPath, worktrees)
      return { repoPath, commonDir, defaultBranch: defaultBranch.name, defaultRef: defaultBranch.ref, worktrees }
    }

    if (endpoint === 'worktree.scan') return recover(async () => {
      const paths = requestedPaths(payload)
      const maxDepth = resolveScanDepth(payload.depth ?? scanBounds.depth)
      const roots = [...new Set((await Promise.all([...new Set(paths)].map((path) => discoverGitRoots(path, { signal, maxDepth, maxDirectories: scanBounds.directories })))).flat())]
      const seen = new Set()
      const repositories = []
      for (const root of roots) {
        signal?.throwIfAborted()
        try {
          const repository = await listRepository(root)
          const key = cleanPath(repository.repoPath)
          if (key && !seen.has(key)) {
            seen.add(key)
            repositories.push(repository)
          }
        } catch {
          // A repository can disappear while a scan is in progress.
        }
      }
      // The scan is what refreshes the panel's memory of these Workspaces. An
      // empty answer is remembered too: a task space whose worktrees are all gone
      // is exactly what the next panel should paint, rather than an older list.
      // A failed scan never gets here, so it leaves the last good answer standing.
      rememberScan(paths, repositories)
      return repositories
    })

    if (endpoint === 'worktree.cached') return recover(async () => {
      // The whole point of this endpoint is the repaint it saves, so a miss is an
      // answer - `null` - and not an error the panel has to handle.
      return recallScan(requestedPaths(payload)) ?? null
    })

    if (endpoint === 'worktree.status') return recover(async () => {
      const path = typeof payload.path === 'string' ? payload.path.trim() : ''
      if (!path) throw new Error('Worktree path is required.')
      const output = await runGit(ctx.subprocess, path, ['status', '--short', '--branch'])
      const lines = output ? output.split(/\r?\n/) : []
      // What this worktree would carry back: everything on its HEAD the named branch
      // does not have. The caller names that branch, because the page already knows
      // which one the source checkout sits on - the branch finishing would merge
      // into. No name, or one git cannot resolve, leaves the count out rather than
      // claiming zero commits.
      const target = typeof payload.target === 'string' ? payload.target.trim() : ''
      const ahead = target === '' ? '' : await tryRunGit(ctx.subprocess, path, ['rev-list', '--count', `${target}..HEAD`])
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
      if (!sourceRoot) throw new Error('A source root is required.')
      return classifySourceRoot(sourceRoot)
    })

    if (endpoint === 'task.suggest-root') return recover(async () => {
      const sourceRoot = typeof payload.sourceRoot === 'string' ? payload.sourceRoot.trim() : ''
      if (!sourceRoot) throw new Error('A source root is required.')
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
      }
    })

    if (endpoint === 'task.create') return recover(async () => {
      const sourceRoot = typeof payload.sourceRoot === 'string' ? payload.sourceRoot.trim() : ''
      const task = typeof payload.task === 'string' ? payload.task.trim() : ''
      if (!sourceRoot) throw new Error('A source root is required.')
      if (!task) throw new Error('A task name is required.')
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
        push: payload.push === true,
      })
    })

    if (endpoint === 'task.list') return recover(async () => {
      const tasksRoot = typeof payload.tasksRoot === 'string' ? payload.tasksRoot.trim() : ''
      return listTasks(ctx.subprocess, { tasksRoot })
    })

    if (endpoint === 'task.inspect') return recover(async () => {
      const path = typeof payload.path === 'string' ? payload.path.trim() : ''
      if (!path) throw new Error('A task path is required.')
      return inspectTask(path)
    })

    if (endpoint === 'task.plan') return recover(async () => {
      const task = typeof payload.task === 'string' ? payload.task.trim() : ''
      if (!task) throw new Error('A task name is required.')
      return planTask(ctx.subprocess, {
        task,
        project: typeof payload.project === 'string' ? payload.project : '',
        tasksRoot: typeof payload.tasksRoot === 'string' ? payload.tasksRoot.trim() : '',
        targets: branchTargets(payload.targets),
      })
    })

    if (endpoint === 'task.done') return recover(async () => {
      const task = typeof payload.task === 'string' ? payload.task.trim() : ''
      if (!task) throw new Error('A task name is required.')
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
      })
    })

    return fail('bad-request', `Unknown endpoint: ${endpoint}`)
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
          : fail('bad-request', 'RPC method does not match endpoint.')
        return Response.json({ type: 'server-response', rpcId: message.rpcId, result })
      },
    }), `dsh-worktree-space ${endpoint} route`)
  }
}

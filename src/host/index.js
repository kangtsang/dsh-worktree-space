import z from '@deepseek-ai/schemastery'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import { readdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { detectDefaultBranch, parseWorktrees, runGit, tryRunGit } from './task/git.js'
import { classifySourceRoot, createTask, finishTask, inspectTask, listTasks, planTask, suggestTaskRoot } from './task/operations.js'
import { recallScan, rememberScan, rememberStatus } from './task/scanCache.js'
import { registerTaskSkill } from './task/skill.js'
import { registerTaskTool } from './task/tool.js'

// These helpers moved to the git module; they stay part of the entry module's
// public surface because callers and tests import them from here.
export { detectDefaultBranch, parseWorktrees, runGit } from './task/git.js'

const API_PREFIX = '/api/dsh-worktree-space'
const WORKTREE_ENDPOINTS = ['worktree.scan', 'worktree.cached', 'worktree.status']
const TASK_ENDPOINTS = ['task.classify-root', 'task.suggest-root', 'task.create', 'task.list', 'task.inspect', 'task.plan', 'task.done']
const ENDPOINTS = [...WORKTREE_ENDPOINTS, ...TASK_ENDPOINTS]

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
  sidebarEntry: z.union(['show', 'hide']).default('show').loose().volatile()
    .description('Show the Worktree Space entry in the sidebar footer.'),
  settingsEntry: z.union(['show', 'hide']).default('hide').loose().volatile()
    .description('Also show a Worktree Space section inside Settings.'),
  /** The Web UI's control is gone: this is the one place the depth is chosen. */
  scanDepth: z.number().min(MIN_SCAN_DEPTH).max(MAX_SCAN_DEPTH).step(1).default(DEFAULT_SCAN_DEPTH).volatile()
    .description('How many directory levels a scan descends from a Workspace root.'),
  maxScanDirectories: z.number().min(1).step(1).default(MAX_SCAN_DIRECTORIES).volatile()
    .description('Directories one scan may inspect before it stops looking.'),
})

export function apply(ctx, config = {}) {
  // The walk is the Host's, so these come from the configuration rather than from
  // the caller: a scan request carries paths, not limits.
  scanBounds.depth = resolveScanDepth(config.scanDepth)
  if (Number.isFinite(Number(config.maxScanDirectories))) {
    scanBounds.directories = Math.max(1, Math.trunc(Number(config.maxScanDirectories)))
  }
  // The tool is how the multi-repository workflow is driven while the Web UI is
  // still the upstream single-repository surface. A deployment that serves no
  // tool runtime keeps working: the /api endpoints remain the seam. The injected
  // callback returns the registration's disposer so cordis tears the tool down
  // with the plugin instead of leaking it.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (toolsCtx) => registerTaskTool(toolsCtx))
  } else {
    registerTaskTool(ctx)
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
        branchPrefix: typeof payload.branchPrefix === 'string' && payload.branchPrefix !== '' ? payload.branchPrefix : undefined,
      })
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
        branchPrefix: typeof payload.branchPrefix === 'string' && payload.branchPrefix !== '' ? payload.branchPrefix : undefined,
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
        tasksRoot: typeof payload.tasksRoot === 'string' ? payload.tasksRoot.trim() : '',
        targets: branchTargets(payload.targets),
      })
    })

    if (endpoint === 'task.done') return recover(async () => {
      const task = typeof payload.task === 'string' ? payload.task.trim() : ''
      if (!task) throw new Error('A task name is required.')
      return finishTask(ctx.subprocess, {
        task,
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
        const parsed = clientRequestSchema.safeParse(body)
        if (!parsed.success) return new Response('invalid client-request message', { status: 400 })
        const message = parsed.data
        const result = message.method === `dsh-worktree-space/${endpoint}`
          ? await handle(endpoint, message.payload, request.signal)
          : fail('bad-request', 'RPC method does not match endpoint.')
        return Response.json({ type: 'server-response', rpcId: message.rpcId, result })
      },
    }), `dsh-worktree-space ${endpoint} route`)
  }
}

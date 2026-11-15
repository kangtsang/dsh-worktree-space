/**
 * Reading a working tree's changes against a base, for the changes sidebar.
 *
 * The comparison is the one the rows already draw, made readable: the base is
 * the branch a task would be merged into (or the one a source checkout tracks),
 * the working tree is everything the reader would carry back - committed work,
 * staged work and untracked files. The start of the range is the merge base
 * rather than the base's tip, so work that landed on the base meanwhile does
 * not read as a deletion here.
 *
 * One `numstat` listing answers the file list and every count; one patch per
 * file answers the lines, fetched only when a file is opened. That is the
 * adaptation this plugin needs: a task space's repositories are already on
 * disk, so a whole diff can be read on demand instead of through one call that
 * has to carry every hunk.
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { coded } from './codes.js'
import { discoverSourceRepos } from './discover.js'
import { runGit, tryRunGit } from './git.js'
import { absolutePath, isInside } from './paths.js'
import { DEFAULT_IGNORED_SCAN_DIRECTORY_SET, DEFAULT_SCAN_DEPTH } from './scan-bounds.js'
import { readTaskMetadata } from './shared.js'

/** Untracked files listed before the rest are counted as omitted. */
const MAX_UNTRACKED_FILES = 100

/** An untracked file over this size is reported as a binary change rather than read. */
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024

/** Bytes inspected for a NUL, which is how git decides a file is binary. */
const BINARY_PROBE_BYTES = 8000

/** A file whose change is longer than this is reported as too large, without lines. */
const MAX_FILE_LINES = 20_000

/** A patch longer than this is reported as too large rather than parsed. */
const MAX_PATCH_BYTES = 1_500_000

/** Context lines around each hunk when a file is first opened. */
const DEFAULT_CONTEXT = 3

/** The most context a gap can expand to; also the clamp on a caller's value. */
const MAX_CONTEXT = 200

/**
 * The repositories of one task space, or the repository a Workspace root is.
 *
 * A task space is read from its own record: each repository keeps the start
 * point it was cut from, so the base is a fact on disk rather than a branch the
 * reader has since moved. A plain repository is compared with its upstream,
 * which is the comparison its row already shows.
 * @param subprocess - the profile's subprocess service.
 * @param path - a task space directory, or a repository directory.
 * @param options - `signal` to stop the reads.
 * @returns the overview the sidebar lists.
 */
export async function changesOverview(subprocess, path, { signal } = {}) {
  const root = absolutePath(path)
  if (!root) throw coded('E4005', 'A workspace or repository path is required.')
  const metadata = await readTaskMetadata(root)
  if (metadata !== undefined && Array.isArray(metadata.repositories) && metadata.repositories.length > 0) {
    const repositories = []
    for (const entry of metadata.repositories) {
      repositories.push(await taskRepository(subprocess, root, entry, signal))
    }
    return {
      kind: 'task',
      title: typeof metadata.task === 'string' && metadata.task !== '' ? metadata.task : basename(root),
      path: root,
      ...(typeof metadata.branch === 'string' && metadata.branch !== '' ? { branch: metadata.branch } : {}),
      repositories,
    }
  }
  // A Workspace that is not a checkout itself holds repositories below it; the
  // same walk the scan uses finds them, so the overview lists what the row's
  // badge already counted. A directory holding none falls through to the plain
  // repository answer below, whose single row carries the reason it could not be
  // compared.
  const found = await discoverSourceRepos(root, {
    maxDepth: DEFAULT_SCAN_DEPTH,
    maxDirectories: 500,
    ignored: DEFAULT_IGNORED_SCAN_DIRECTORY_SET,
    signal,
  })
  if (found.length > 1 || (found.length === 1 && found[0] !== root)) {
    const repositories = []
    for (const repository of found) repositories.push(await plainRepository(subprocess, repository, signal))
    return { kind: 'workspace', title: basename(root), path: root, repositories }
  }
  const entry = await plainRepository(subprocess, root, signal)
  return { kind: 'repo', title: basename(root), path: root, repositories: [entry] }
}

/**
 * One repository's file list, its counts, and the range it was read against.
 * @param subprocess - the profile's subprocess service.
 * @param repoPath - the checked-out directory to read.
 * @param base - the branch, tag or commit to compare with.
 * @param options - `signal` to stop the reads.
 * @returns the files and the totals.
 */
export async function changesList(subprocess, repoPath, base, { signal } = {}) {
  const root = absolutePath(repoPath)
  if (!root) throw coded('E4005', 'A repository path is required.')
  const head = await readHead(subprocess, root, signal)
  const candidates = [typeof base === 'string' ? base : '', ...(await taskBaseCandidates(subprocess, root, signal))]
  const resolved = await resolveBase(subprocess, root, candidates, signal)
  const statuses = parseNameStatus(await runGit(subprocess, root, ['-c', 'core.quotePath=false', 'diff', '--ignore-cr-at-eol', '--name-status', '-z', resolved.commit], { signal, log: false }))
  const numbered = parseNumstat(await runGit(subprocess, root, ['-c', 'core.quotePath=false', 'diff', '--ignore-cr-at-eol', '--numstat', '-z', resolved.commit], { signal, log: false }))
  const untracked = await untrackedFiles(subprocess, root, signal)
  const statusOf = new Map(statuses.map((entry) => [entry.path, entry]))
  const files = []
  for (const entry of numbered) {
    const found = statusOf.get(entry.path)
    statusOf.delete(entry.path)
    files.push(fileOf(entry, found))
  }
  for (const found of statusOf.values()) files.push(fileOf({ path: found.path, insertions: 0, deletions: 0 }, found))
  for (const entry of untracked) files.push(fileOf(entry, { status: 'untracked' }))
  files.sort((left, right) => left.path.localeCompare(right.path))
  const totals = { files: files.length, insertions: 0, deletions: 0 }
  for (const file of files) {
    totals.insertions += file.insertions
    totals.deletions += file.deletions
  }
  return { path: root, branch: head.branch, head: head.short, base: resolved.label, baseCommit: resolved.commit, files, totals }
}

/**
 * One file's hunks, read only when the reader opens that file.
 * @param subprocess - the profile's subprocess service.
 * @param repoPath - the checked-out directory to read.
 * @param base - the branch, tag or commit to compare with.
 * @param filePath - the file, relative to `repoPath`.
 * @param options - `oldPath` for a rename, `untracked` for a new file, `context`
 *   for how much unchanged text to keep around each hunk, and `signal`.
 * @returns a text comparison, a binary change, or a change too large to draw.
 */
export async function changesFile(subprocess, repoPath, base, filePath, { oldPath, untracked = false, context = DEFAULT_CONTEXT, baseCommit = '', signal } = {}) {
  const root = absolutePath(repoPath)
  if (!root) throw coded('E4005', 'A repository path is required.')
  const path = relativeInside(root, filePath)
  if (path === '') throw coded('E4005', 'A file path inside the repository is required.')
  const wanted = clampContext(context)
  if (untracked) return await untrackedContent(root, path, wanted)
  // The listing already resolved the comparison range; a caller that carries it
  // back saves the merge-base reads that would otherwise re-answer the same
  // question for every file of one repository.
  const known = /^[0-9a-f]{40}$/i.test(String(baseCommit ?? '')) ? String(baseCommit) : ''
  const resolved = known !== ''
    ? { label: known.slice(0, 7), commit: known }
    : await resolveBase(subprocess, root, [typeof base === 'string' ? base : '', ...(await taskBaseCandidates(subprocess, root, signal))], signal)
  const old = typeof oldPath === 'string' ? relativeInside(root, oldPath) : ''
  const pathspec = old === '' || old === path ? [path] : [old, path]
  const patch = await runGit(subprocess, root, [
    '-c', 'core.quotePath=false',
    'diff', '--ignore-cr-at-eol', '--no-color', '--no-ext-diff', '--no-textconv', '--submodule=short', '--ignore-submodules=dirty',
    '-M', `--unified=${wanted}`, resolved.commit, '--', ...pathspec,
  ], { signal, log: false })
  if (patch === '') return { kind: 'text', hunks: [] }
  if (/^Binary files /m.test(patch) || /^GIT binary patch/m.test(patch)) return { kind: 'binary' }
  if (patch.length > MAX_PATCH_BYTES) return { kind: 'tooLarge', lines: countPatchLines(patch) }
  const hunks = parseHunks(patch)
  return { kind: 'text', hunks }
}

/** One repository's row in the overview. */
async function taskRepository(subprocess, taskPath, entry, signal) {
  const name = entry !== null && typeof entry === 'object' && typeof entry.name === 'string' ? entry.name : ''
  const worktree = name === '' ? '' : join(taskPath, name)
  if (worktree === '') return { name, path: '', error: 'The task record names this repository with no name, so its worktree cannot be located.' }
  try {
    const summary = await summarize(subprocess, worktree, await taskBaseCandidates(subprocess, worktree, signal), signal)
    return { name, path: worktree, ...summary }
  } catch (error) {
    return { name, path: worktree, error: sentenceOf(error) }
  }
}

/** A plain repository's row, measured against its upstream. */
async function plainRepository(subprocess, root, signal) {
  const upstream = (await tryRunGit(subprocess, root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { signal, log: false })).trim()
  try {
    const summary = await summarize(subprocess, root, [upstream], signal)
    return { name: basename(root), path: root, ...summary }
  } catch (error) {
    return { name: basename(root), path: root, base: upstream, error: sentenceOf(error) }
  }
}

/** The branch, the resolved base, and the counts of one working tree. */
async function summarize(subprocess, root, candidates, signal) {
  const head = await readHead(subprocess, root, signal)
  const resolved = await resolveBase(subprocess, root, candidates, signal)
  const numbered = parseNumstat(await runGit(subprocess, root, ['-c', 'core.quotePath=false', 'diff', '--ignore-cr-at-eol', '--numstat', '-z', resolved.commit], { signal, log: false }))
  const untracked = await untrackedFiles(subprocess, root, signal)
  let insertions = 0
  let deletions = 0
  for (const entry of numbered) {
    insertions += entry.insertions
    deletions += entry.deletions
  }
  for (const entry of untracked) {
    insertions += entry.insertions
    deletions += entry.deletions
  }
  return {
    branch: head.branch,
    head: head.short,
    base: resolved.label,
    baseCommit: resolved.commit,
    insertions,
    deletions,
    files: numbered.length + untracked.length,
    untracked: untracked.length,
  }
}

/** The branch name (or the short commit on a detached HEAD) and that commit. */
async function readHead(subprocess, root, signal) {
  const branch = (await runGit(subprocess, root, ['rev-parse', '--abbrev-ref', 'HEAD'], { signal, log: false })).trim()
  const short = (await runGit(subprocess, root, ['rev-parse', '--short', 'HEAD'], { signal, log: false })).trim()
  return { branch: branch === '' || branch === 'HEAD' ? short : branch, short }
}

/**
 * Resolve the start of the comparison.
 *
 * The first candidate that resolves and shares history with HEAD wins; the
 * fallback is the commit a task recorded at creation, which is what remains
 * usable after the base branch is renamed or deleted. A base that resolves but
 * shares no history is skipped for the same reason.
 */
async function resolveBase(subprocess, root, candidates, signal) {
  const wanted = []
  for (const value of candidates) {
    const ref = typeof value === 'string' ? value.trim() : ''
    if (ref !== '' && !wanted.includes(ref)) wanted.push(ref)
  }
  if (wanted.length === 0) throw coded('E3006', 'There is no comparison base: the task records none, and the branch tracks no remote.')
  for (const ref of wanted) {
    const commit = (await tryRunGit(subprocess, root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { signal, log: false })).trim()
    if (commit === '') continue
    const mergeBase = (await tryRunGit(subprocess, root, ['merge-base', commit, 'HEAD'], { signal, log: false })).trim()
    if (mergeBase === '') continue
    return { label: labelOf(ref), commit: mergeBase }
  }
  throw coded('E3006', `The comparison base ${wanted[0]} does not exist in this repository, or shares no history with HEAD.`)
}

/** The value a reader sees for a resolved base: a ref as written, a commit shortened. */
function labelOf(ref) {
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref
}

/**
 * The bases a task space's record implies for one worktree, best first.
 *
 * The source checkout's current branch comes first, because that is the branch
 * the management page measures its rows against - the same number has to answer
 * for both. The record's own start points follow: the branch each repository was
 * cut from, then its start commit, which is the only one left when the source
 * checkout is gone or renamed. A recorded start point alone is not the base the
 * page shows (a repository can be started from `demo/A-v1` and later merged into
 * `main`), which is why it is a fallback rather than the answer.
 * @param subprocess - the profile's subprocess service.
 * @param worktree - the worktree directory, whose parent is the task space.
 * @param signal - the request's cancellation.
 * @returns the candidate refs, in the order they should be tried.
 */
async function taskBaseCandidates(subprocess, worktree, signal) {
  const metadata = await readTaskMetadata(dirname(worktree)).catch(() => undefined)
  if (metadata === undefined) return []
  const name = basename(worktree)
  const entry = Array.isArray(metadata.repositories)
    ? metadata.repositories.find((candidate) => candidate !== null && typeof candidate === 'object' && candidate.name === name)
    : undefined
  const candidates = []
  const sourcePath = typeof entry?.sourcePath === 'string' ? entry.sourcePath : ''
  if (sourcePath !== '') {
    const branch = (await tryRunGit(subprocess, sourcePath, ['rev-parse', '--abbrev-ref', 'HEAD'], { signal, log: false })).trim()
    if (branch !== '' && branch !== 'HEAD') candidates.push(branch)
  }
  for (const value of [entry?.sourceBranch, entry?.baseRef, metadata.baseRef, entry?.startCommit]) {
    const ref = typeof value === 'string' ? value.trim() : ''
    if (ref !== '' && !candidates.includes(ref)) candidates.push(ref)
  }
  return candidates
}

/** The untracked files, with the line counts a new-file hunk would show. */
async function untrackedFiles(subprocess, root, signal) {
  const listed = await runGit(subprocess, root, ['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '-z'], { signal, log: false })
  const paths = listed.split('\0').filter((path) => path !== '')
  const files = []
  for (const path of paths.slice(0, MAX_UNTRACKED_FILES)) {
    const full = join(root, path)
    if (!isInside(root, full)) continue
    const info = await stat(full).catch(() => undefined)
    if (info === undefined || !info.isFile()) continue
    if (info.size > MAX_UNTRACKED_BYTES) {
      files.push({ path, insertions: 0, deletions: 0, binary: true, tooLarge: true })
      continue
    }
    const bytes = await readFile(full).catch(() => undefined)
    if (bytes === undefined) continue
    if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
      files.push({ path, insertions: 0, deletions: 0, binary: true })
      continue
    }
    files.push({ path, insertions: splitLines(bytes.toString('utf8')).length, deletions: 0, untracked: true })
  }
  return files
}

/** One untracked file's whole content as a new-file hunk. */
async function untrackedContent(root, path, context) {
  const full = join(root, path)
  const info = await stat(full).catch(() => undefined)
  if (info === undefined || !info.isFile()) throw coded('E3005', `The file is not there: ${path}`)
  if (info.size > MAX_UNTRACKED_BYTES) return { kind: 'tooLarge', lines: 0 }
  const bytes = await readFile(full).catch(() => undefined)
  if (bytes === undefined) throw coded('E3005', `The file could not be read: ${path}`)
  if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return { kind: 'binary' }
  const lines = splitLines(bytes.toString('utf8')).map((line) => line.endsWith('\r') ? line.slice(0, -1) : line)
  if (lines.length > MAX_FILE_LINES) return { kind: 'tooLarge', lines: lines.length }
  return {
    kind: 'text',
    untracked: true,
    hunks: [{
      header: `@@ -0,0 +1,${lines.length} @@`,
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: lines.length,
      lines: lines.map((line) => `+${line}`),
    }],
    // Named so a reader can tell which context the caller asked for; the whole
    // file is always shown, so the value only records the request.
    context,
  }
}

/** Build the file record both listings share. */
function fileOf(entry, status) {
  const file = {
    path: entry.path,
    status: typeof status?.status === 'string' ? status.status : 'modified',
    insertions: entry.insertions,
    deletions: entry.deletions,
  }
  if (typeof entry.oldPath === 'string' && entry.oldPath !== '') file.oldPath = entry.oldPath
  if (typeof status?.oldPath === 'string' && status.oldPath !== '') file.oldPath = status.oldPath
  if (entry.binary === true) file.binary = true
  if (entry.tooLarge === true) file.tooLarge = true
  if (entry.untracked === true || file.status === 'untracked') file.untracked = true
  return file
}

/** Parse `--name-status -z`: one record per file, three fields for a rename. */
function parseNameStatus(text) {
  const parts = String(text ?? '').split('\0')
  const files = []
  for (let index = 0; index < parts.length;) {
    const code = parts[index++]
    if (code === undefined || code === '') continue
    const letter = code.charAt(0)
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[index++] ?? ''
      const path = parts[index++] ?? ''
      if (path !== '') files.push({ path, oldPath, status: letter === 'R' ? 'renamed' : 'copied' })
      continue
    }
    const path = parts[index++] ?? ''
    if (path !== '') files.push({ path, status: statusOfLetter(letter) })
  }
  return files
}

const STATUS_BY_LETTER = { A: 'added', C: 'copied', D: 'deleted', M: 'modified', R: 'renamed', T: 'modified', U: 'modified' }

function statusOfLetter(letter) {
  return STATUS_BY_LETTER[letter] ?? 'modified'
}

/** Parse `--numstat -z`: the same record shape, with `-` for a binary change. */
function parseNumstat(text) {
  const parts = String(text ?? '').split('\0')
  const files = []
  for (let index = 0; index < parts.length;) {
    const header = parts[index++]
    if (header === undefined || header === '') continue
    const fields = header.split('\t')
    if (fields.length < 3) continue
    const [added, deleted, path] = fields
    if (path === '') {
      const oldPath = parts[index++] ?? ''
      const newPath = parts[index++] ?? ''
      if (newPath === '') continue
      files.push({ path: newPath, oldPath, insertions: toCount(added), deletions: toCount(deleted), binary: added === '-' })
      continue
    }
    files.push({ path, insertions: toCount(added), deletions: toCount(deleted), binary: added === '-' })
  }
  return files
}

/** Turn git's count column into a number; `-` is a binary change, counted as zero lines. */
function toCount(value) {
  const count = Number.parseInt(value, 10)
  return Number.isFinite(count) && count > 0 ? count : 0
}

/** The hunks of one file's patch, with the header kept for the UI. */
function parseHunks(patch) {
  const hunks = []
  let current
  for (const raw of String(patch ?? '').split(/\r?\n/)) {
    // A line's own trailing CR is a checkout convention, not content: the
    // comparison already ignores it, and the row would carry it invisibly.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line)
    if (header !== null) {
      current = {
        header: line,
        oldStart: Number.parseInt(header[1], 10),
        oldLines: header[2] === undefined ? 1 : Number.parseInt(header[2], 10),
        newStart: Number.parseInt(header[3], 10),
        newLines: header[4] === undefined ? 1 : Number.parseInt(header[4], 10),
        lines: [],
      }
      hunks.push(current)
      continue
    }
    if (current === undefined) continue
    if (line.startsWith('@@') || line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('old mode') || line.startsWith('new mode') || line.startsWith('similarity') || line.startsWith('rename ')) {
      current = undefined
      continue
    }
    if (line.startsWith('\\')) continue
    if (line === '' || line.startsWith(' ') || line.startsWith('+') || line.startsWith('-')) current.lines.push(line === '' ? ' ' : line)
  }
  return hunks
}

/** Split a file's text into line contents, the way a hunk header counts them. */
function splitLines(text) {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/** How many changed lines a patch carries, for the too-large notice. */
function countPatchLines(patch) {
  let count = 0
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('+') || line.startsWith('-')) {
      if (!line.startsWith('+++') && !line.startsWith('---')) count += 1
    }
  }
  return count
}

/** A path the caller named, confirmed to stay inside the repository. */
function relativeInside(root, value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  const full = join(root, text)
  if (!isInside(root, full)) return ''
  return relative(root, full).split(sep).join('/')
}

/** Clamp a requested context to the range a hunk can carry. */
function clampContext(value) {
  const wanted = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_CONTEXT
  return Math.min(MAX_CONTEXT, Math.max(DEFAULT_CONTEXT, wanted))
}

/** A failure's own sentence, for the per-repository row that carries it. */
function sentenceOf(error) {
  const text = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
  return text.replace(/^E\d{4}:\s*/u, '')
}

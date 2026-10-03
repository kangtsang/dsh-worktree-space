/**
 * Git process helpers shared by every host module.
 *
 * `runGit` is the single place that spawns git, so the profile's subprocess
 * service stays the only execution seam. `gitSucceeded` exists because some git
 * questions are answered by the exit status alone — `show-ref --verify
 * --quiet` prints nothing either way, so a helper that reads stdout cannot tell
 * a reused branch from a missing one.
 *
 * Because `runGit` is that one place, it is also where every git call is
 * recorded: the two helpers below answer an empty string and a false rather
 * than throwing, and the exit code and diagnostic behind those answers are what
 * a report of "the merge did nothing" has to be read against.
 */
import { recordGitCall } from './audit-log.js'

/**
 * Which failure a git command that said something ran into.
 *
 * The two the caller can act on differently get their own code, because they are
 * the two the UI already tells apart: a directory that is not a repository, and a
 * worktree whose checkout has gone. Everything else is E3003 - one code for "git
 * said no", with the subcommand in `argv` and git's own words in `stderr` to
 * tell two of those apart.
 * @param stderr - what git wrote to standard error.
 * @returns the code to put on the error.
 */
function gitFailureCode(stderr) {
  const text = String(stderr ?? '')
  if (/not a git repository/i.test(text)) return 'E3004'
  if (/is not a working tree|No such file or directory/i.test(text)) return 'E3005'
  return 'E3003'
}

/**
 * Run git in a directory and fail on a non-zero exit.
 *
 * `log` decides what a call that worked leaves behind, and nothing else:
 *
 * - `true` (the default) records every call, subject to the read-only filter in
 *   audit-log.js.
 * - `false` records only the calls that failed.
 *
 * The scan passes `false`. It asks git five questions about every repository
 * under a Workspace, so a ninety-four repository scan produces five hundred
 * processes and - because `worktree` is deliberately absent from the read-only
 * filter, since `worktree add` is a mutation - ninety-four records. That file is
 * meant to be read by a person mid-incident, and it cannot be read with that in
 * it. Failures are the other half of the bargain and stay: a repository that
 * would not answer is exactly what somebody opening this log after a wrong panel
 * needs, and it is a handful of records rather than hundreds.
 * @param subprocess - the profile's subprocess service.
 * @param cwd - directory the command runs in.
 * @param args - git arguments, after the implicit `-C <cwd>`.
 * @param options - `log: false` to record failures only.
 * @returns the trimmed standard output.
 * @throws Error carrying git's own diagnostic when the command fails.
 */
export async function runGit(subprocess, cwd, args, { log = true } = {}) {
  const handle = subprocess.spawn({
    argv: ['git', '-C', cwd, ...args],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 2 * 1024 * 1024 },
      stderr: { maxBytes: 512 * 1024 },
    },
    graceMs: 1000,
  })
  const startedAt = Date.now()
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  if (log || outcome.exitCode !== 0 || (outcome.signal ?? null) !== null) {
    await recordGitCall({
      cwd,
      args,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout,
      stderr,
      ms: Date.now() - startedAt,
    })
  }
  if (outcome.exitCode !== 0 || outcome.signal !== null) {
    // The code travels on the error so the record that describes this failure -
    // whichever one catches it, and the log's own git record - names the same
    // thing. A silent non-zero exit is a question that was answered, not a
    // failure, and auditLog.js is the one that can tell them apart.
    const error = new Error(`git ${args.join(' ')} failed${outcome.signal ? ` (${outcome.signal})` : ` (exit ${outcome.exitCode})`}: ${stderr.trim() || stdout.trim()}`)
    error.code = gitFailureCode(stderr)
    throw error
  }
  return stdout.trim()
}

/**
 * Run git, answering an empty string instead of throwing.
 * @param subprocess - the profile's subprocess service.
 * @param cwd - directory the command runs in.
 * @param args - git arguments, after the implicit `-C <cwd>`.
 * @param options - passed through to {@link runGit}.
 * @returns the trimmed standard output, or an empty string when git fails.
 */
export async function tryRunGit(subprocess, cwd, args, options) {
  try {
    return await runGit(subprocess, cwd, args, options)
  } catch {
    return ''
  }
}

/**
 * Whether git exits zero, for questions git answers without printing.
 * @param subprocess - the profile's subprocess service.
 * @param cwd - directory the command runs in.
 * @param args - git arguments, after the implicit `-C <cwd>`.
 * @param options - passed through to {@link runGit}.
 * @returns whether the command exited zero.
 */
export async function gitSucceeded(subprocess, cwd, args, options) {
  try {
    await runGit(subprocess, cwd, args, options)
    return true
  } catch {
    return false
  }
}

/**
 * Pick the branch new work should start from, preferring the remote's own
 * default and then the conventional names.
 * @param subprocess - the profile's subprocess service.
 * @param repoPath - the repository to inspect.
 * @param worktrees - its parsed worktrees, used as the last resort.
 * @returns the branch name and the ref to start from.
 */
export async function detectDefaultBranch(subprocess, repoPath, worktrees) {
  const [remoteHead, refsOutput] = await Promise.all([
    tryRunGit(subprocess, repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']),
    tryRunGit(subprocess, repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin']),
  ])
  const refs = new Set(refsOutput.split(/\r?\n/).filter(Boolean))

  if (remoteHead) {
    const separator = remoteHead.indexOf('/')
    const name = separator >= 0 ? remoteHead.slice(separator + 1) : ''
    if (name) return { name, ref: refs.has(name) ? name : remoteHead }
  }

  for (const name of ['main', 'master', 'trunk', 'develop']) {
    if (refs.has(name)) return { name, ref: name }
    if (refs.has(`origin/${name}`)) return { name, ref: `origin/${name}` }
  }
  const name = worktrees.find((worktree) => worktree.isMain)?.branch ?? worktrees.find((worktree) => worktree.branch)?.branch
  return name ? { name, ref: name } : { name: 'HEAD', ref: 'HEAD' }
}

/**
 * Parse `git worktree list --porcelain` into rows; the first row is the main
 * working tree by git's own ordering.
 * @param text - the porcelain output.
 * @returns one row per worktree, in git's order.
 */
export function parseWorktrees(text) {
  const rows = []
  let current
  const push = () => {
    if (current?.path) rows.push(current)
    current = undefined
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      push()
      current = { path: line.slice(9).trim() }
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice(5).trim()
    } else if (current && line.startsWith('branch ')) {
      const ref = line.slice(7).trim()
      current.branch = ref.startsWith('refs/heads/') ? ref.slice(11) : ref
    } else if (current && line === 'detached') {
      current.detached = true
    } else if (current && line.startsWith('locked')) {
      current.locked = true
    } else if (current && line.startsWith('prunable')) {
      current.prunable = true
    }
  }
  push()
  return rows.map((row, index) => ({
    path: row.path,
    branch: row.branch,
    head: row.head,
    isMain: index === 0,
    detached: row.detached === true,
    locked: row.locked === true,
    prunable: row.prunable === true,
  }))
}

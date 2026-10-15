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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordGitCall } from './audit-log.js'

/**
 * A directory this plugin never creates, used to switch hooks off for every call.
 *
 * `core.hooksPath` pointing at a path that does not exist is how git is told to look for
 * no hooks at all. `/dev/null` is the usual spelling on Unix and is wrong here: git
 * 2.39.1 warns `encountered old-style '/dev/null' that should be '%(prefix)//dev/null'`
 * on every call, and there is no `dev/null` on Windows at all. An absent directory under
 * the system temporary directory needs no such special case and reads the same on every
 * platform.
 */
const GIT_HOOKS_PATH = join(tmpdir(), 'dsh-worktree-space-no-hooks')

/**
 * The `-c` settings every git call is made with.
 *
 * These go BEFORE `-C`, because a `-c` on the command line is applied in the order it is
 * written and `-C` changes the repository the rest of the command line is read against.
 *
 * - `core.fsmonitor=false`: a background file monitor is a process this plugin did not
 *   start and does not wait for, and on a large repository it can outlive the call.
 * - `core.hooksPath=<absent>`: a hook is arbitrary code from the repository, run with
 *   this plugin's own privileges at a moment the user did not ask for. `worktree add`
 *   runs `post-checkout`, and a repository can carry one.
 * - `protocol.file.allow=never`, `protocol.ext.allow=never`: these are what stop a
 *   submodule or a remote helper from reaching outside the repository - the `file://`
 *   transport is how a repository pulls in another one on disk, and the `ext::` transport
 *   runs an arbitrary command named by the URL.
 *
 * This is defence in depth, NOT a boundary, and it is worth being plain about which
 * half is missing. A git configuration that is already in the environment is the one
 * thing these flags cannot reach: `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` are
 * read from the environment before any of this, and this plugin cannot unset them -
 * `env` is merged onto the base the seam already scrubs, so a variable cannot be
 * removed here, and setting one of those to an empty string is fatal rather than
 * neutral (`GIT_DIR=''` gives `fatal: not a git repository: ''`). `GIT_CONFIG_COUNT=0`
 * below does neutralise the `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` injection pair,
 * and `GIT_CONFIG_NOSYSTEM=1` drops the machine-wide file, but what remains is the
 * repository's own `.git/config` - which is the user's own repository, and the reason
 * this is a hardening rather than a sandbox.
 */
const GIT_CONFIG_HARDENING = [
  '-c', 'core.fsmonitor=false',
  '-c', `core.hooksPath=${GIT_HOOKS_PATH}`,
  '-c', 'protocol.file.allow=never',
  '-c', 'protocol.ext.allow=never',
]

/**
 * The environment every git call is made with, merged onto the seam's scrubbed base.
 *
 * - `GIT_CONFIG_NOSYSTEM=1` drops the machine-wide configuration file, so a setting
 *   somebody put in `/etc/gitconfig` cannot change what these calls do.
 * - `GIT_CONFIG_COUNT=0` neutralises the `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`
 *   injection pair, which is otherwise read straight out of the environment.
 * - `GIT_TERMINAL_PROMPT=0` makes a call that wants credentials fail instead of blocking
 *   on a prompt nobody is there to answer - these calls run inside an HTTP handler.
 * - `GIT_OPTIONAL_LOCKS=0` keeps a read-only question from taking the index lock, which
 *   is what turns two of them running at once into a stall.
 * - `GIT_PAGER=cat` and `GIT_EDITOR=true` because a pager or an editor is a process
 *   waiting on a terminal that does not exist here.
 * - `LC_ALL=C` because {@link gitFailureCode} reads git's own words to tell "not a git
 *   repository" from "not a working tree". Git's messages are localised, so without this
 *   a user running under another locale gets E3003 for both - the code is chosen by
 *   matching English text, and this is what makes that text English.
 */
const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  GIT_EDITOR: 'true',
  LC_ALL: 'C',
}

/**
 * Build the argv for a git call, hardening settings included.
 *
 * Exported so that a test can assert the exact command line a call is made with rather
 * than reproduce it, and so that {@link parseGitArgv} is the only other place that knows
 * the shape.
 * @param cwd - directory the command runs in.
 * @param args - git arguments, after the implicit `-C <cwd>`.
 * @returns the whole argv, program included.
 */
export function gitArgv(cwd, args) {
  return ['git', ...GIT_CONFIG_HARDENING, '-C', cwd, ...args]
}

/**
 * Read a git argv back into its directory and its arguments.
 *
 * The inverse of {@link gitArgv}, and it exists because a test double has to answer the
 * same question the real code asked. Before the hardening settings were added, every
 * double in the suite read `argv[2]` as the directory and `argv.slice(3)` as the
 * arguments - positions that were correct only while the command line happened to start
 * `git -C <dir>`. That is a fact about the current shape of the call, not about git, and
 * it silently became wrong the moment anything was inserted before `-C`.
 *
 * Parsing by name rather than by position is what makes it keep working: the `-c`
 * settings are skipped wherever they sit, and `-C` is read for the directory it names.
 * A caller passing its own `-C` in `args` would have the last one win, which is what git
 * does too.
 * @param argv - the command line, program included.
 * @returns the directory and the arguments after it.
 */
export function parseGitArgv(argv) {
  const rest = Array.isArray(argv) ? [...argv] : []
  if (rest[0] === 'git') rest.shift()
  let cwd = ''
  const args = []
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (value === '-c') {
      // A `-c` takes one value with it; skipping the pair is what keeps a setting's
      // value from being mistaken for a subcommand.
      index += 1
      continue
    }
    if (value === '-C') {
      cwd = rest[index + 1] ?? ''
      index += 1
      continue
    }
    args.push(value)
  }
  return { cwd, args }
}

/**
 * The line of what git wrote that says what went wrong.
 *
 * Not simply the first line, which is how this was written first and what real git
 * disproves twice over. `git worktree add` prints `Preparing worktree (new branch 'x')`
 * before it fails, and `git merge` prints `Auto-merging <path>` before it reports a
 * conflict - so the first line of stderr is progress rather than the failure.
 *
 * What is kept is everything **from** the diagnostic line on, not the diagnostic line alone,
 * because git puts the part a reader needs on the lines under it: a `fatal:` is followed by
 * the sentence explaining it, and `error: The following untracked working tree files would
 * be overwritten by merge:` is followed by the file names. Keeping one line would drop the
 * names, and a refusal that does not say which file it is about sends the reader looking.
 * The progress git printed *before* the diagnostic is what gets dropped, which is the part
 * that says nothing about the failure.
 *
 * The diagnostic is the line git marks as such: `fatal:`, `error:`, `warning:`, or a
 * `CONFLICT (...)` and the other upper-case report lines git uses for a merge it could not
 * finish. Falling back to everything, when git wrote no such marker, keeps a command that
 * failed with something unrecognised from producing a sentence with no reason in it.
 *
 * The whole text is in the audit record, so the split is about what a model reads in one
 * sentence, not about losing anything.
 * @param text - what git wrote to one of its streams.
 * @returns the diagnostic and what follows it, trimmed.
 */
function diagnosticOf(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  const marker = /^(fatal|error|warning):/i
  // `CONFLICT (content): Merge conflict in <path>` and the other report lines a failed
  // merge prints. Matched by shape - a word in capitals, then a colon - so a path that
  // happens to be capitalised is not mistaken for one.
  const report = /^[A-Z][A-Z0-9 _-]{3,}(\s*\(.*\))?:/
  const from = lines.findIndex((line) => marker.test(line) || report.test(line))
  return (from === -1 ? lines : lines.slice(from)).join('\n')
}

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
 * How long a git command may run before it is stopped.
 *
 * A git call that never comes back is not a slow call, it is a hung one: `rev-parse`
 * on a network drive, or any command waiting on `index.lock` another process holds,
 * can sit there indefinitely - and because every one of these is awaited inside an
 * HTTP handler, the handler sits with it and the panel spins with no way out. A
 * minute is far past anything a healthy repository needs for the calls this plugin
 * makes, and short enough that the caller gets an answer it can act on.
 */
export const GIT_TIMEOUT_MS = 30_000

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
 *
 * Every call carries a deadline, and the caller may bring its own signal as well.
 * The deadline is what keeps a hung git from hanging the request that asked for it;
 * the caller's signal is what lets closing the panel stop work already in flight.
 * Both are handed to the subprocess seam as one abort, because that is the only
 * stop it understands, and the deadline is then read back off the signal rather
 * than off `exitCode` - a killed process has no exit code, and "it ran out of
 * time" is not something an exit code can say.
 * @param subprocess - the profile's subprocess service.
 * @param cwd - directory the command runs in.
 * @param args - git arguments, after the implicit `-C <cwd>`.
 * @param options - `log: false` to record failures only, `timeoutMs` for the
 *   deadline (default {@link GIT_TIMEOUT_MS}; absent or non-positive: no deadline),
 *   and `signal` to stop the call when the caller is cancelled.
 * @returns the trimmed standard output.
 * @throws Error carrying git's own diagnostic when the command fails, or E3003
 *   naming the command when it ran past its deadline.
 */
export async function runGit(subprocess, cwd, args, { log = true, timeoutMs = GIT_TIMEOUT_MS, signal } = {}) {
  const deadlineMs = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : undefined
  // One controller for both stops, because the seam takes one signal and the
  // question afterwards - "was this the deadline?" - has to be answerable.
  const controller = deadlineMs === undefined && signal === undefined ? undefined : new AbortController()
  // Whether the clock is what stopped it, recorded as the timer fires rather than read
  // back off the controller: a caller's own abort reaches the same controller, and
  // asking the controller afterwards cannot tell the two apart - so a cancelled call
  // would be reported as a timed-out one, which is a different thing to say.
  let expired = false
  const forward = () => controller.abort()
  if (controller !== undefined && signal !== undefined) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', forward, { once: true })
  }
  const timer = controller === undefined || deadlineMs === undefined
    ? undefined
    : setTimeout(() => { expired = true; controller.abort() }, deadlineMs)
  const startedAt = Date.now()
  let outcome
  let stdout = ''
  let stderr = ''
  try {
    const handle = subprocess.spawn({
      // The hardening settings go before `-C`, because `-c` is applied in the order it is
      // written and `-C` changes the repository the rest of the command line is read
      // against. See {@link GIT_CONFIG_HARDENING} for what each one is for, and for why
      // this is defence in depth rather than a boundary.
      argv: gitArgv(cwd, args),
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 2 * 1024 * 1024 },
        stderr: { maxBytes: 512 * 1024 },
      },
      graceMs: 1000,
      // Merged onto the seam's own scrubbed base rather than replacing it: `env` adds
      // these and cannot remove what the harness already decided to keep. See
      // {@link GIT_ENV}.
      env: GIT_ENV,
      ...(controller === undefined ? {} : { signal: controller.signal }),
    })
    outcome = await handle.done
    stdout = handle.collected.stdout?.readFrom(0).text ?? ''
    stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (controller !== undefined && signal !== undefined) signal.removeEventListener('abort', forward)
  }
  const elapsed = Date.now() - startedAt
  if (log || outcome.exitCode !== 0 || (outcome.signal ?? null) !== null) {
    await recordGitCall({
      cwd,
      args,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout,
      stderr,
      ms: elapsed,
    })
  }
  if (expired) {
    // E3003 rather than a code of its own: it is a git command that failed, and the
    // sentence is what tells the reader it failed by running out of time rather than
    // by answering. A caller that has to branch does so on the message's own subject -
    // there is nothing to retry differently, because the deadline is this side's.
    //
    // The `cwd` is not named, for the reason the failure sentence below gives: it is an
    // absolute path, and the caller already knows which task and repository it asked about.
    // The code leads, because this message is all a model receives.
    const error = new Error(`E3003: git ${args.join(' ')} exceeded its deadline of ${deadlineMs}ms and was stopped`)
    error.code = 'E3003'
    throw error
  }
  if (outcome.exitCode !== 0 || outcome.signal !== null) {
    // The code travels on the error so the record that describes this failure -
    // whichever one catches it, and the log's own git record - names the same
    // thing. A silent non-zero exit is a question that was answered, not a
    // failure, and auditLog.js is the one that can tell them apart.
    //
    // What is carried into the sentence is bounded, and the code leads it. git's stderr is
    // its own text, and three things about it matter here:
    //
    //   - It can be arbitrarily long (a `fatal:` plus a usage block plus hints), and this
    //     sentence reaches a model, so the first line is what is kept - the line that says
    //     what went wrong. The full text is already in the audit record, which is where a
    //     reader who needs it can find it.
    //   - It can quote a global path - git's own words about a config file, a template
    //     directory or a `safe.directory` refusal name locations outside the task space.
    //     Those are git's paths, not the plugin's, and they are not part of the failure
    //     this sentence is describing; the audit record still has them verbatim.
    //   - The `cwd` was appended, which is an absolute path for a failure the caller can
    //     already locate by the task it asked about.
    //
    // The code is prefixed for the reason `coded` gives at length: this message is all the
    // model receives of a tool failure.
    const code = gitFailureCode(stderr)
    const detail = diagnosticOf(stderr.trim() === '' ? stdout : stderr)
    const error = new Error(`${code}: git ${args.join(' ')} failed${outcome.signal ? ` (${outcome.signal})` : ` (exit ${outcome.exitCode})`}${detail === '' ? '' : `: ${detail}`}`)
    error.code = code
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

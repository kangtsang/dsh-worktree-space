/**
 * The audit log: every git call the plugin makes, and every failure, in one file.
 *
 * One JSONL file at the container root, `<container root>/worktree-space-log.jsonl`,
 * appended to and never rewritten. The container root is where it goes for three
 * reasons, all of them properties of this plugin rather than choices: a task
 * space directory is deleted when the task is finished, the plugin documents
 * that it never writes the DSH data directory, and everything this plugin
 * writes already lives under the one directory it names. A plain *file* at that
 * root is also invisible to `listTasks`, which walks the root and skips
 * anything that is not a directory - so the log cannot be mistaken for a
 * project, the way a `logs/` directory would be.
 *
 * The file is created by the first record that has something to say, and the
 * append itself never creates the container root: `appendFile` into a directory
 * that does not exist simply fails, and that failure is swallowed. So a read
 * that happens before any task space exists writes nothing at all, rather than
 * bringing a container root into being for its own sake.
 *
 * Operations and errors share the stream on purpose. Reproducing a failure
 * needs the commands that led to it and the exit that ended it, interleaved in
 * the order they ran; two files would make that a join on timestamps, and the
 * process dying mid-`done` is exactly when one tail of one file is all there is.
 *
 * Nothing here can fail into the caller: every write is wrapped, so a full disk,
 * a read-only container root or a path that cannot be renamed costs the record
 * and nothing else.
 *
 * The appends are awaited rather than fired and forgotten. A write that outlived
 * the operation it describes would be a record that lands after the caller has
 * moved on - reordered against the records beside it, and, on Windows, able to
 * add a file to a directory being walked for deletion and fail that deletion
 * with `ENOTEMPTY`. The cost is one small append per recorded call, against a
 * git call that has already spent its time spawning a process.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFile, readFile, rename, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

/** The log's own name at the container root. */
export const AUDIT_FILE = 'worktree-space-log.jsonl'

/**
 * Past this the file is moved aside and a new one started.
 *
 * The per-task part of a container is deleted with the task, so a task's own
 * story never needs trimming; this bound exists for the calls that belong to no
 * task - a scan or a status read - which would otherwise grow the one file that
 * does.
 */
const MAX_BYTES = 10 * 1024 * 1024

/** How much of git's own diagnostic is kept. It is quoted verbatim into errors. */
const STDERR_LIMIT = 2048
/** One argv entry is a path or a ref; this is generous for both. */
const ARGV_LIMIT = 512
/** A stack is short or it is a sign of something else. */
const STACK_LIMIT = 4000
/** One error message, whether it came from git or from this plugin. */
const MESSAGE_LIMIT = 2000

/**
 * The git subcommands that only ask.
 *
 * A read that answered is noise in a file that has to be read by a person
 * mid-incident, and the plugin makes a great many of them; anything not named
 * here is recorded, because a write is the story and an unrecognised subcommand
 * is more likely to be a write than a read. `branch` is on the write side of
 * that line even when it only lists, and `worktree list` only lists because its
 * subcommand is not in this set - both are cheap, and being wrong in this
 * direction means a record that turns out to be uninteresting rather than a
 * mutation nobody logged.
 */
const READ_ONLY_SUBCOMMANDS = new Set([
  'cat-file', 'check-ignore', 'config', 'diff', 'for-each-ref', 'log', 'ls-files',
  'merge-base', 'rev-list', 'rev-parse', 'show-ref', 'status', 'symbolic-ref', 'var', 'version',
])

/**
 * What the current request is, carried alongside each record.
 *
 * `enterWith` rather than a wrapper function: the endpoint name is known in one
 * place, the task, project and container root in another, several frames below,
 * and every caller would otherwise have to thread a context through signatures
 * that exist to say what a git call is for. The store follows the async chain,
 * so two concurrent requests never see each other's task.
 */
const scope = new AsyncLocalStorage()

/**
 * Add to what the current request records.
 *
 * Fields merge into the store rather than replace it: the endpoint sets `op`
 * before it knows the task, and the operation itself knows the task.
 * @param fields - the facts every record from here on carries.
 */
export function auditEnter(fields) {
  const carried = {}
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (typeof value === 'string' && value.trim() !== '') carried[key] = value.trim()
  }
  scope.enterWith({ ...(scope.getStore() ?? {}), ...carried })
}

/**
 * Cut a text to its limit, saying what was cut.
 * @param value - the text to bound.
 * @param limit - the longest text kept.
 * @returns the text, or the first `limit` characters and a note.
 */
function truncate(value, limit) {
  const text = String(value ?? '')
  return text.length <= limit ? text : `${text.slice(0, limit)}... (${text.length - limit} more characters)`
}

/**
 * Hide a password or token that git would have been given inside a URL.
 *
 * A URL the plugin hands to git can carry credentials, and a failing call
 * repeats it in its own diagnostic, so both the argument and what git said
 * about it are replaced. Only the authority is touched: a path that merely
 * contains an `@` keeps it, because a repository path is not a secret.
 * @param value - an argument or a diagnostic.
 * @returns the text with any URL authority replaced.
 */
function redact(value) {
  return String(value ?? '').replace(/\/\/[^/\s@]+@/g, '//***@')
}

/**
 * Append one record to the log at a container root.
 *
 * The root is only known from {@link auditEnter}, so a record made before an
 * operation has named its container root has nowhere to go and is dropped - the
 * endpoints that never reach a container root (`worktree.scan`,
 * `worktree.status`) have no task space to write beside.
 * @param kind - what the record is about: `git`, `error` or `warning`.
 * @param fields - the record's own fields.
 */
async function auditRecord(kind, fields) {
  try {
    const carried = scope.getStore() ?? {}
    const tasksRoot = typeof carried.tasksRoot === 'string' ? carried.tasksRoot.trim() : ''
    if (tasksRoot === '') return
    const line = `${JSON.stringify({
      ts: new Date().toISOString(),
      kind,
      op: carried.op ?? '',
      task: carried.task ?? '',
      project: carried.project ?? '',
      ...fields,
    })}\n`
    const path = join(tasksRoot, AUDIT_FILE)
    // Absent is zero, not a failure: the first record of the first task has
    // nothing to rotate away from.
    const size = await stat(path).then((info) => info.size, () => 0)
    if (size >= MAX_BYTES) await rotate(path)
    // No directory is created here. `appendFile` into a container root that is
    // not there fails, and that failure is what keeps a scan - which belongs to
    // no task space - from bringing a container root into being to log itself.
    await appendFile(path, line, 'utf8')
  } catch {
    // Serialising a value that cannot be serialised is not worth a failed task.
  }
}

/**
 * Move the log aside so the next append starts a new one.
 *
 * The moved file keeps its records - the whole point of the log - and stays at
 * the container root, where it is as invisible to `listTasks` as the log it
 * replaced. A rotation that fails is not retried: the append that follows it
 * either grows the file past the bound or lands in a new one, and neither is
 * worth losing the records about.
 * @param path - the log to move.
 */
async function rotate(path) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  await rename(path, join(dirname(path), `${basename(path, extname(path))}.${stamp}${extname(path)}`))
}

/**
 * Record one git call.
 *
 * Every git call in this plugin leaves through {@link runGit}, so this is the
 * single place a call is seen - including the calls whose answer is discarded:
 * `tryRunGit` and `gitSucceeded` answer an empty string and a false, and the
 * exit and the diagnostic behind those answers are exactly what a report of
 * "the merge did nothing" needs.
 * @param call - the call: where it ran, what it ran, and how it ended.
 */
export async function recordGitCall({ cwd, args, exitCode, signal, stdout = '', stderr = '', ms }) {
  const argv = Array.isArray(args) ? args.map((one) => truncate(redact(one), ARGV_LIMIT)) : []
  const failed = exitCode !== 0 || (signal ?? null) !== null
  if (!failed && READ_ONLY_SUBCOMMANDS.has(String(argv[0] ?? ''))) return
  await auditRecord('git', {
    cwd: typeof cwd === 'string' ? cwd : '',
    argv,
    exit: typeof exitCode === 'number' ? exitCode : null,
    ...(signal ? { signal } : {}),
    ...(failed
      ? { stderr: truncate(redact(stderr), STDERR_LIMIT), stdout: truncate(redact(stdout), STDERR_LIMIT) }
      : {}),
    ...(typeof ms === 'number' ? { ms } : {}),
  })
}

/**
 * Record something that failed.
 *
 * The stack and the error's own `code` are kept, because `recover` reports a
 * failure to the caller as its message alone - one string, with every
 * non-`bad-request` code flattened into `bad-request` - and this file is where
 * what actually happened is still on record.
 * @param error - the thrown value, which may be an `Error` or a message.
 * @param fields - what the record is about: the phase, the repository, and so on.
 */
export async function recordError(error, fields = {}) {
  await auditRecord('error', {
    ...fields,
    ...(error instanceof Error ? { name: error.name } : {}),
    message: truncate(redact(String(error?.message ?? error)), MESSAGE_LIMIT),
    ...(error?.code === undefined ? {} : { code: error.code }),
    ...(typeof error?.stack === 'string' ? { stack: truncate(redact(error.stack), STACK_LIMIT) } : {}),
  })
}

/**
 * Record something that did not stop the operation but changes what it means.
 * @param message - what to report, in the plugin's own words.
 * @param fields - what the record is about.
 */
export async function recordWarning(message, fields = {}) {
  await auditRecord('warning', {
    ...fields,
    message: truncate(redact(String(message ?? '')), MESSAGE_LIMIT),
  })
}

/**
 * Read a container root's log back.
 *
 * A line that does not parse - a truncated tail from a process that died mid
 * write - costs that one record rather than the file: this is the file a person
 * opens first, and it has to stay readable when it is most needed.
 * @param tasksRoot - the container root.
 * @returns the records, oldest first.
 */
export async function readAudit(tasksRoot) {
  const text = await readFile(join(String(tasksRoot ?? '').trim(), AUDIT_FILE), 'utf8').catch(() => '')
  const records = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // A half-written last line, or one a person edited by hand.
    }
  }
  return records
}

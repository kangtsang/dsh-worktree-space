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
import { existsSync } from 'node:fs'
import { open, readFile, rename, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { withTaskLock } from './task-lock.js'

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
 * Wall-clock time, local, as `YYYY-MM-DD HH:MM:SS`.
 *
 * Local rather than UTC on purpose: this file is read by a person in the middle
 * of an incident, on the machine that produced it, asking what time something
 * happened. A UTC offset they then have to convert is a step between them and
 * the answer. Nothing is lost by the fixed width - the file is append-only, so
 * the order of records is the order they ran in, and `ts` is never the thing
 * that sorts them.
 * @param date - the moment to render; defaults to now.
 * @returns the local timestamp, 19 characters, no offset and no milliseconds.
 */
export function localStamp(date = new Date()) {
  const two = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
    + ` ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

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
 * git's own complaint, in one line.
 *
 * git writes a lot at once - a fatal plus a usage block plus a hint - and the
 * whole of it is kept in `stderr`. What goes into `msg` is only its first line,
 * because that is the part that says what went wrong; the rest is git explaining
 * how to avoid doing it again, and a one-line summary that carried all of that
 * would be as unreadable as the raw thing.
 * @param text - a stream git wrote.
 * @returns the first non-empty line, trimmed, or an empty string.
 */
function firstLine(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.trim() !== '') return truncate(redact(line.trim()), MESSAGE_LIMIT)
  }
  return ''
}

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
 * Whether records are written, as the configuration has it.
 *
 * A cell rather than a field on the store, because the answer is a property of this
 * plugin rather than of a request: one setting turns the log off for every task
 * space at once, and a turn made part-way through a running request should take
 * effect at the next record rather than at the next request. It starts `true`,
 * because the setting's own default is that the log is on and a profile that has
 * never been configured has to behave like one that says so.
 */
let overridden = true

/**
 * How the configuration is asked whether to keep writing.
 *
 * A function rather than a value, so this module does not have to be told when the
 * answer changes. The Loader hands `apply` a snapshot rather than a live view, but
 * it restarts a plugin when the configuration changes, so the snapshot is replaced
 * then too and reading once per `apply` would have been correct. Reading per record
 * removes the dependence on that pairing: the switch is right for the next line
 * however the value got there - including the window after it has been written to
 * the profile and before the plugin restarts - and it costs nothing beside the
 * append it gates.
 *
 * Null means "no configuration to ask", and then {@link overridden} decides.
 * @type {(() => boolean) | null}
 */
let reader = null

/**
 * Teach this module how to read the switch.
 *
 * Installed once, by the entry, from the same `settingValue` every other setting
 * is read with - which matters, because a reference-only read treats a plain
 * `'off'` as unset and the switch stays on.
 * @param read - returns whether the configuration currently says to keep writing.
 */
export function setAuditEnabledReader(read) {
  reader = typeof read === 'function' ? read : null
}

/**
 * Turn the log on or off for everything written from now on.
 *
 * Nothing is read, moved or deleted: switching it off stops new records, and the
 * log already on disk stays where it is. That is deliberate - a log is the only
 * account of what happened to work that is not in anybody's history, and taking it
 * away with a setting would make the setting the one destructive thing this plugin
 * does. Rotating the old file aside is the deliberate way to retire one.
 *
 * A reader, once installed, outranks this: the configuration is the thing the user
 * changed from the page, and this cell only covers a caller with no configuration.
 * @param value - whether to keep writing.
 */
export function setAuditEnabled(value) {
  overridden = value !== false
}

/**
 * Whether records are being written.
 *
 * Asked at the moment of the record, so a change lands on the next line written
 * rather than on the next restart.
 * @returns `false` only when the configuration has switched the log off.
 */
export function auditEnabled() {
  if (reader) return reader()
  return overridden
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
 * The credential inside a URL's authority, of any scheme.
 *
 * Only the authority is touched: a path that merely contains an `@` keeps it,
 * because a repository path is not a secret. The authority is everything up to
 * the next `/` or whitespace, so a user without a password
 * (`https://bot@git.example.com/x`) is covered by the same rule as one with.
 */
const URL_CREDENTIALS = /\/\/[^\/\s@]*@/g

/**
 * A secret handed over as an assignment rather than in a URL.
 *
 * The authority rule cannot see these, and a credential does not only reach a
 * command line inside a URL: a header, a query parameter and an
 * `Authorization: bearer ...` echoed back by a failing call all carry the
 * secret without one. Each key is matched only where it is being assigned a
 * value, so a branch or a path that happens to be called `secret` is untouched.
 *
 * It over-redacts rather than under-redacts on purpose - this is an audit log,
 * and a word that merely looked like a secret being hidden costs a reader
 * nothing, while a secret that got through costs the user everything. That is
 * also why a value runs to the end of its line rather than to the next space:
 * an auth header is two words, and stopping at the first would hide the word
 * `Bearer` and leave the token behind it in plain text.
 *
 * The separator is `:` or `=`, or whitespace. Whitespace is the one that was
 * missing: `--password hunter2` and `--token ghp_abc` are how a credential is
 * handed to a command-line tool, and requiring an assignment character meant
 * neither was redacted at all. A keyword in that position is a flag being given a
 * value, which is the same act as an assignment.
 *
 * The keyword list is the vocabulary of the tools this plugin drives rather than a
 * guess at what a secret is called: `auth` covers `--auth`, `Authorization` and
 * `http.extraHeader=Authorization`, `credential` covers git's own
 * `credential.helper`-adjacent spellings, and `access[-_]?key` covers
 * `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` alike. `passwd` and `pwd` are
 * here because `password` alone missed them.
 */
const ASSIGNED_SECRET = /((?:token|password|passwd|pwd|secret|authorization|auth|credential|api[-_]?key|access[-_]?key)\s*[:=\s]\s*)("[^"]*"|'[^']*'|[^\r\n,;]+)/gi

/**
 * A token that announces itself by its shape rather than by a keyword.
 *
 * `ghp_...` on its own - no `token=`, no `Authorization:` - is a credential a
 * failing command echoes back inside a sentence, and the assignment rule cannot see
 * it because nothing assigns it. These are the prefixes the providers actually
 * issue, so a match is a credential and not a word that happens to look like one:
 * `feature/token-refresh` is the counter-example this rule has to keep, and it
 * carries none of these prefixes.
 *
 * `AKIA[0-9A-Z]{16}` is AWS's own access-key id shape, which is a fixed-length
 * alphabet rather than a prefix - matched by the same pattern.
 *
 * The lookbehind is what keeps this from eating identifiers that merely end in a
 * prefix. `sk-` is the dangerous one: `no-task-branch` contains `sk-branch`, and
 * without the boundary the plugin's own warning code was written to the log as
 * `no-ta***` - a redaction that destroyed the one field a reader greps for. A token
 * prefix is a token prefix when nothing word-like precedes it.
 */
const TOKEN_SHAPES = /(?<![A-Za-z0-9_-])(?:(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|sk-|xox[baprs]-)[A-Za-z0-9_-]{6,}|AKIA[0-9A-Z]{16})/g

/**
 * An authentication scheme and the credential after it.
 *
 * `Authorization: Basic dXNlcjpwYXNz` is already covered by the assignment rule
 * (the value runs to end of line), but a bare `Bearer eyJ...` in a sentence has no
 * keyword before it. Two words, and the second is the secret: matched together so
 * the scheme is hidden with the token rather than left behind as a clue.
 */
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g

/**
 * A PEM private key block, from its header to its footer.
 *
 * This is the shape the assignment rules cannot reach at all: there is no `key=` and
 * no token prefix, just a block of base64 between two marker lines. `[\\s\\S]*?` spans
 * the lines lazily so one block is one match and the text after the footer survives.
 * The header alone is redacted even when the block is truncated, because a log
 * holding `-----BEGIN OPENSSH PRIVATE KEY-----` and no footer is still holding the
 * beginning of a key.
 */
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g

/**
 * Hide a password or token, wherever git was given it.
 * @param value - an argument or a diagnostic.
 * @returns the text with any credential replaced.
 */
function redact(value) {
  return String(value ?? '')
    .replace(URL_CREDENTIALS, '//***@')
    .replace(PEM_BLOCK, '-----BEGIN PRIVATE KEY-----***')
    .replace(AUTH_SCHEME, '$1 ***')
    .replace(TOKEN_SHAPES, '***')
    .replace(ASSIGNED_SECRET, '$1***')
}

/**
 * A record's own fields with every string value redacted.
 *
 * The file's comment above promises over-redaction, and the promise was about the
 * strings the call sites redact one by one - `argv`, `stderr`, `stdout`, `message`,
 * `stack`, `msg`. A field passed through `fields` was not among them, so a credential
 * put in one appeared verbatim. No current caller does that, which is exactly why it
 * is worth fixing here rather than at each call site: the next one to pass a token as
 * a field would have to know this file's promise and remember it.
 *
 * Redaction is recursive into plain objects and arrays because a field may be one -
 * `conflictedFiles` is an array of paths - and a nested string is the same string.
 * Non-strings are left exactly as they are: `exit: 1`, `conflict: true` and
 * `ms: 12` are facts a reader filters on, and turning them into text would break
 * every `select(...)` in the file's own documentation. A value that cannot be walked
 * (a Map, a class instance) is left alone rather than coerced, since coercing it is
 * the one thing that could change what a caller meant to record.
 * @param value - a field's value.
 * @returns the value with every string inside it redacted.
 */
function redactedFields(value) {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(redactedFields)
  // `null` is an object, and `Object.entries(null)` throws; the null check is the
  // whole reason this is not a bare typeof test.
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactedFields(entry)]))
  }
  return value
}

/**
 * Append one record to the log at a container root.
 *
 * The root is only known from {@link auditEnter}, so a record made before an
 * operation has named its container root has nowhere to go and is dropped - the
 * endpoints that never reach a container root (`worktree.scan`,
 * `worktree.status`) have no task space to write beside.
 * @param kind - what the record is about: `git`, `error` or `warning`.
 * @param level - how bad it is: `info`, `warn` or `error`. Present on every
 *   record, so `select(.level == "error")` is the one query that answers "what
 *   went wrong" across both kinds rather than only the plugin's own errors.
 * @param fields - the record's own fields.
 */
async function auditRecord(kind, level, fields) {
  try {
    // The switch is read here rather than at each call site: a record is either
    // written whole or not at all, and there is nothing half a record would be
    // good for. Skipping before the work also skips the rotation check, so a log
    // switched off does not rename anything either.
    if (!auditEnabled()) return
    const carried = scope.getStore() ?? {}
    const tasksRoot = typeof carried.tasksRoot === 'string' ? carried.tasksRoot.trim() : ''
    if (tasksRoot === '') return
    const line = `${JSON.stringify({
      ts: localStamp(),
      kind,
      level,
      op: carried.op ?? '',
      task: carried.task ?? '',
      project: carried.project ?? '',
      ...redactedFields(fields),
    })}\n`
    const path = join(tasksRoot, AUDIT_FILE)
    // One writer at a time, keyed by the resolved log path.
    //
    // The sequence below is `stat -> rotate -> append`, three awaits with nothing
    // atomic in them, and the plugin reaches it concurrently: `inspect.js` maps
    // `Promise.all` over tasks, and the scan paths run beside each other. Two
    // callers entering at once used to lose records three different ways. Both read
    // the size over the bound and both rotate, so the second `rename` gets ENOENT -
    // and that record was dropped outright, because the whole block is wrapped in a
    // `catch` that swallows everything. A caller appending between another's
    // `rename` and its own `appendFile` wrote into the already-moved file. And a
    // record longer than `PIPE_BUF` (4 KiB), written with more than one
    // `appendFile`, could be interleaved into a half-line. The audit log is the
    // only durable record of finishing and deleting, so a dropped line is the one
    // thing it must not do.
    //
    // The key is the log's own path rather than the container root: the two are one
    // to one, and the path is what the rotation and the append both act on, so
    // serialising on it is exactly serialising the file. `withTaskLock` is the
    // plugin's existing in-process keyed chain (`task/task-lock.js`), reused rather
    // than copied - a second implementation of "serialise by key" would be a defect
    // of its own. The keys are disjoint from its finish locks (a log path is not a
    // task space), so a finish holding a task lock can log freely, and nothing here
    // ever takes a task lock, so there is no cycle to deadlock on.
    await withTaskLock(path, async () => {
      // Absent is zero, not a failure: the first record of the first task has
      // nothing to rotate away from.
      const size = await stat(path).then((info) => info.size, () => 0)
      if (size >= MAX_BYTES) {
        // Its own `try`, and a rotation that fails does not take the record with it.
        // An over-limit log is strictly better than a lost record: the file grows
        // past its bound and is rotated on some later write, whereas a record that
        // never lands is the one thing this file exists to prevent. The comment in
        // {@link rotate} already argued this; this is the code matching it.
        try {
          await rotate(path)
        } catch {
          // Deliberately swallowed: see above. The append below still runs.
        }
      }
      // No directory is created here. `open(path, 'a')` into a container root that
      // is not there fails, and that failure is what keeps a scan - which belongs
      // to no task space - from bringing a container root into being to log itself.
      //
      // One `open` and one `write` rather than `appendFile`: a single write on an
      // append-mode descriptor is one syscall, so a record cannot be split across
      // two appends and interleaved with another writer's half-line, however long
      // the record is.
      const handle = await open(path, 'a')
      try {
        await handle.write(line)
      } finally {
        await handle.close()
      }
    })
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
 *
 * The name is collision-proof, because the archives are kept forever: the
 * documented shape (`worktree-space-log.<YYYYMMDD-HHMMSS>.jsonl`) is the leading
 * part, and two things are added after it. Milliseconds first, because two
 * rotations in one second is ordinary on a machine that rotates a 10 MB log twice
 * while a build runs. Then a counter, because milliseconds are not enough either:
 * two rotations inside the same millisecond still collide, and `fs.rename` over an
 * existing file *succeeds* - it destroys the earlier archive, which is a silent
 * loss of the only account of what happened. "Keep all" is a promise the name has
 * to keep.
 * @param path - the log to move.
 */
async function rotate(path) {
  // The same local clock the records carry, so an archived file is named for the
  // time of the records it holds rather than for a moment eight hours away.
  // Dashes, not colons: `YYYY-MM-DD HH:MM:SS` is the record's stamp and is not a
  // legal filename on Windows, and a rename that throws would take the rotation
  // with it - the file then grows past its bound forever, silently.
  const stem = `${join(dirname(path), basename(path, extname(path)))}.${archiveStamp()}`
  const extension = extname(path)
  // The first candidate is the documented name; the counter is only reached when
  // something already holds it. `existsSync` rather than a create-with-`wx`, because
  // the rename below is the write and this loop only has to pick a name it will not
  // overwrite.
  let target = `${stem}${extension}`
  for (let counter = 1; existsSync(target); counter++) {
    target = `${stem}-${counter}${extension}`
  }
  await rename(path, target)
}

/**
 * The stamp an archived log is named for: {@link localStamp} plus milliseconds.
 *
 * Composed from `localStamp` rather than formatted again, so the documented
 * `YYYYMMDD-HHMMSS` part and the record's own `ts` cannot drift apart - the comment
 * in {@link rotate} says why the two have to agree.
 * @param date - the moment to render; defaults to now.
 * @returns the stamp, e.g. `2026-10-02-11-35-26-042`.
 */
function archiveStamp(date = new Date()) {
  const millis = String(date.getMilliseconds()).padStart(3, '0')
  return `${localStamp(date).replace(/[: ]/g, '-')}-${millis}`
}

/**
 * How severe a finished git call is.
 *
 * A non-zero exit alone does not mean something went wrong. `show-ref --verify
 * --quiet` and `rev-parse --verify` exit 1 to say "no such ref" - which is the
 * answer `create.js` is asking for when it checks whether a branch is free - and
 * they print nothing either way, which is what `--quiet` is for. Recording those
 * as errors put an `exit:1` in the log for every successful create, and a reader
 * filtering for trouble could not tell them from a merge that broke.
 *
 * What separates the two is whether git said anything. A genuine failure is loud:
 * `fatal: not a git repository`, `CONFLICT (content): ...`, `error: ...`. So the
 * exit code decides that a call failed, and git's own diagnostic decides whether
 * the failure is a problem or just the answer to the question.
 *
 * The rule is not "the caller swallowed it, so it is fine". A `gitSucceeded`
 * running outside a repository exits 128 and says so, and stays an error: a
 * swallowed answer the caller cannot distinguish from a broken one is exactly
 * the thing this file exists to leave on record.
 *
 * A signal is judged the other way round. A killed git has no exit code to read
 * and prints nothing worth reading, so there is no evidence it was only
 * answering a question - it is an error because nothing proved otherwise.
 * @param exitCode - the process exit code.
 * @param signal - the signal that ended it, if any.
 * @param stdout - what git wrote to standard output.
 * @param stderr - what git wrote to standard error.
 * @returns `error` when the call failed loudly, `info` otherwise.
 */
/**
 * Which failure a git command ran into, for the record.
 *
 * The same decision {@link gitFailureCode} makes in `git.js` for the error it
 * throws, over the same stderr - so the record and the thrown error carry the
 * same code, and a grep for it lands on both. Duplicated rather than shared
 * because `git.js` imports this file and an import the other way would be a
 * cycle; the test asserts the two agree.
 * @param stderr - what git wrote to standard error.
 * @returns `E3004`, `E3005` or `E3003`.
 */
function gitRecordCode(stderr) {
  const text = String(stderr ?? '')
  if (/not a git repository/i.test(text)) return 'E3004'
  if (/is not a working tree|No such file or directory/i.test(text)) return 'E3005'
  return 'E3003'
}

function gitLevel(exitCode, signal, stdout, stderr) {
  // A signal is never an answer to a question. There is no exit code to read and
  // whatever git managed to print before it was killed is not a verdict, so this
  // one is an error by default rather than by evidence - the opposite direction
  // from a non-zero exit, which is allowed to be quiet.
  if ((signal ?? null) !== null) return 'error'
  if (exitCode === 0) return 'info'
  return String(stderr ?? '').trim() === '' && String(stdout ?? '').trim() === '' ? 'info' : 'error'
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
  const level = gitLevel(exitCode, signal, stdout, stderr)
  // A sentence on the records that need one, and none on the ones that do not.
  // Filtering for `level == "error"` and finding bare argv and exit codes means
  // working out what each one was doing; quoting git's own first line of
  // complaint puts the point of the line in the line. A call that worked has
  // nothing to add - argv already says what ran - so it carries no msg.
  const complaint = firstLine(stderr) || firstLine(stdout)
  await auditRecord('git', level, {
    cwd: typeof cwd === 'string' ? cwd : '',
    argv,
    ...(level === 'error'
      ? {
          // The same code `runGit` puts on the error it throws, from the same
          // stderr, so a git record and whatever caught the failure name the
          // same condition and `grep` for it lands on both.
          code: gitRecordCode(stderr),
          msg: complaint
            ? `This git command failed, so whatever it was for did not happen: ${complaint}`
            : 'This git command failed without saying why, so whatever it was for may not have happened.',
        }
      : {}),
    exit: typeof exitCode === 'number' ? exitCode : null,
    ...(signal ? { signal } : {}),
    ...(failed
      ? { stderr: truncate(redact(stderr), STDERR_LIMIT), stdout: truncate(redact(stdout), STDERR_LIMIT) }
      : {}),
    ...(typeof ms === 'number' ? { ms } : {}),
  })
}

/**
 * Record how an operation turned out, in a sentence.
 *
 * Every other kind of record here is a fact about one thing: a command's argv,
 * an error's code, a warning's text. Those are what a machine reads, and reading
 * one means knowing what `worktree add` does and that a bare `exit:1` from
 * `show-ref --verify --quiet` means the branch is free rather than broken. This
 * is the record that says it in words, so the line answers "what happened" to
 * someone who is not reading this file's source.
 *
 * It exists because nothing else records a success. A create that works leaves
 * nothing behind but the git calls that made it, and a log whose entries are all
 * failures cannot tell you which of those were trouble.
 *
 * `msg` carries the sentence and the fields carry the particulars, so the two do
 * not repeat each other: the branch and the worktree count are fields, the
 * sentence says whether they are what you should now expect to find on disk.
 *
 * `msg` is not confined to this kind. Any record with something to say carries
 * one - a failed git command has git's own first line of complaint in it, an
 * error has what the failure means for the operation - and a record that has
 * nothing to add does not get one. A git call that worked already says what it
 * did in `argv`, so it carries no `msg`.
 * @param level - `info`, `warn` or `error`; an outcome that went wrong is
 *   `error`, and one that is worth noticing but did not stop anything is `warn`.
 * @param message - the sentence, in the plugin's own words.
 * @param fields - what the record is about: the phase, the branch, and so on.
 */
export async function recordEvent(level, message, fields = {}) {
  const severity = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'
  await auditRecord('event', severity, {
    ...fields,
    msg: truncate(redact(String(message ?? '')), MESSAGE_LIMIT),
  })
}

/**
 * Record something that failed.
 *
 * The stack and the code are kept, and they are the same code the caller is told:
 * `recover` decides it once, writes it here and returns it. A failure is therefore
 * findable from either end - the code on the screen, or the code in this file.
 *
 * Pass a `msg` in `fields` to say what the failure means in a sentence: `message`
 * below is whatever git or JavaScript produced, and on its own it is a stack
 * message that says what broke rather than what was being attempted.
 * @param error - the thrown value, which may be an `Error` or a message.
 * @param fields - what the record is about: the phase, the repository, a `msg`
 *   in the plugin's own words, and so on.
 */
export async function recordError(error, fields = {}) {
  // The code the caller passed wins over the one the error carries, and the order
  // here is the whole point: `recover` has already decided which code a caller is
  // allowed to see, and that decision has to be what a reader finds in the log.
  // Letting the error's own code win wrote the pre-decision code to the log while
  // the caller received the post-decision one - the same failure under two names,
  // which is what these codes exist to prevent. The error's own is the fallback
  // for a call that has not decided.
  const decided = fields.code ?? error?.code
  await auditRecord('error', 'error', {
    ...fields,
    ...(error instanceof Error ? { name: error.name } : {}),
    message: truncate(redact(String(error?.message ?? error)), MESSAGE_LIMIT),
    ...(decided === undefined ? {} : { code: decided }),
    ...(typeof error?.stack === 'string' ? { stack: truncate(redact(error.stack), STACK_LIMIT) } : {}),
  })
}

/**
 * Record something that did not stop the operation but changes what it means.
 *
 * Accepts either a sentence or a `warned()` object, because both are what callers
 * have. The object is the richer one and is what the finish passes: it carries the
 * warning's `code` - the same code a screen translates - and the `values` that
 * sentence needs, and taking the object's `message` while spreading those two into
 * the record is what keeps the log line and the screen about the same warning.
 *
 * Before this, an object was stringified: `String({...})` is `[object Object]`, so
 * every `kind: "warning"` line this plugin wrote lost both the sentence and the code
 * and recorded that literal. `recordWarning` has one caller, so that was every
 * warning there was - including `deploy-containers-left`, `leftover-refused` and
 * `no-task-branch`. The test that should have caught it passed a string, which is
 * the one shape that worked.
 * @param message - a sentence, or a `warned()` object.
 * @param fields - what the record is about.
 */
export async function recordWarning(message, fields = {}) {
  // A warning object, as `warned()` builds one: a message and the values a screen
  // needs. Detected by shape rather than by `instanceof`, because the object crosses
  // module boundaries and `instanceof` is a statement about which copy of a class is
  // in memory. `values` is spread as a nested field rather than flattened: the keys
  // inside it are the warning's own and must not collide with the record's.
  const warning = message !== null && typeof message === 'object' && typeof message.message === 'string'
    ? message
    : undefined
  const text = warning === undefined ? message : warning.message
  await auditRecord('warning', 'warn', {
    ...fields,
    ...(warning === undefined ? {} : { code: warning.code, values: warning.values }),
    message: truncate(redact(String(text ?? '')), MESSAGE_LIMIT),
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

/**
 * The deployment side of the delivery policy: the state a deploy records, the gate
 * a merge has to pass, and the teardown a finished task owes.
 *
 * Everything here speaks the one handshake the deploy scripts and this plugin
 * share, and nothing else: the environment id (`deploymentEnvId` in the record,
 * `DEPLOY_ENV_ID` for the scripts, the `dsh.env-id` label on the containers), the
 * state file's path (`DEPLOY_STATE_FILE` for the scripts, the deploy root's own
 * `.state.json` for this side), and the `.state.json` a deploy writes there. The
 * scripts own that file while the task runs - it is rewritten on every deploy - so
 * this side reads it and deletes it on teardown, but never establishes it.
 *
 * The deploy root is a single script, called as `<entry> up|smoke <envId>`. A `destroy`
 * subcommand is optional and this side never calls one: teardown finds the containers by
 * their `dsh.env-id` label and takes them down itself, so an entry that implements only
 * `up` and `smoke` is complete. The entry is `.worktree-space/deploy/deploy.sh` unless the
 * task's record names another file under that deploy root - a create may, because two tasks
 * in one project can hold different repositories and so need different deploy and smoke
 * scripts. Both the entry and the state file live inside the plugin's own directory
 * (`{@link PLUGIN_ROOT}/deploy/`), on the workspace side and in the task space alike: the
 * workspace's deploy root is copied to the same relative place here, so the one relative
 * path a record keeps resolves on either side. There used to be a `deploy.yaml` manifest
 * that declared several
 * targets and the command for each; it is gone, along with the `host` target it
 * existed for. A manifest's only capability was running an arbitrary command,
 * and a target the plugin cannot see - no container, no label, no log - is a
 * deployment whose failures cannot be diagnosed from here. Docker is what is
 * left, and docker needs no manifest: the plugin finds the containers by the
 * environment label itself.
 *
 * Every docker call is best effort: a machine without docker in the host's PATH has
 * tasks that simply have no deployment to read or tear down, which is a fact to
 * report, never a failure to raise.
 */

import { existsSync, statSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { coded, warned } from './codes.js'
import { deliveryPolicyOf } from './delivery.js'
import { isInside } from './paths.js'
import { DEPLOY_DIR, DEPLOY_ROOT, PLUGIN_ROOT, readTaskMetadata, taskDeployRootPath } from './shared.js'

/** The state file a deploy root carries, per the handshake. */
const STATE_NAME = '.state.json'

/** How much docker output a single call may hand back. */
const DOCKER_MAX_BYTES = 512 * 1024

/**
 * The deadlines every subprocess here runs under.
 *
 * The `timeoutMs` parameter existed from the start and no caller ever passed it, so
 * every docker call and every deploy script ran unbounded - which is not a slow
 * request but a hung one. `docker ps` against an unresponsive daemon never comes
 * back, and because each of those is awaited inside an HTTP handler, the panel spins
 * with no way out: closing it aborts nothing on this side. These are the numbers the
 * shape of each call asks for.
 */

/**
 * A docker query - `ps`, `inspect`, `compose ps`, `rm`.
 *
 * Short, because these are questions about a local daemon and the panel asks them on
 * every refresh: a query that has not answered in fifteen seconds is a daemon that is
 * not answering, and the panel is better off showing what it knows than waiting.
 */
const DOCKER_TIMEOUT_MS = 15_000

/**
 * A deploy script's `up`: ten minutes.
 *
 * A rebuild pulls images, installs dependencies and starts services, so it is the one
 * call here that is legitimately slow. The deadline is not a performance target - it
 * is the point past which the call is not going to answer at all, and past which the
 * person who pressed the button deserves to be told rather than left watching.
 */
const DEPLOY_UP_TIMEOUT_MS = 10 * 60 * 1000

/** A deploy script's `smoke`: five minutes. It runs a test suite, not a build. */
const DEPLOY_SMOKE_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Run one command, as {@link `git.js`} runs git: one spawn seam, one shape of answer.
 *
 * Its own module rather than a sibling in `git.js`, for the same reason that file
 * gives: it is the one spawn point for git, and this is not git.
 *
 * A deadline, when one is given, is this side's own: the subprocess seam ships no
 * timer, only the abort it reacts to and the tree-scoped stop behind it (its own
 * words), so the clock is one `AbortController` fired here. "It ran out of time"
 * is then read off that same signal rather than off `exitCode`, which cannot tell
 * a stop this call asked for from one somebody else sent.
 *
 * A deadline is not optional in practice: every call site below passes one, because
 * a parameter nobody passes is the same as no deadline at all. `timeoutMs` stays
 * optional in the signature so that a future caller can say "no deadline" on purpose,
 * and it is then written down at that call site rather than inherited by accident.
 * @param subprocess - the profile's subprocess service.
 * @param argv - the whole command line, program included.
 * @param options - `cwd` to run in, `maxBytes` per stream, `timeoutMs` for a
 *   deadline (absent or non-positive: no deadline at all), `env` for entries
 *   the child has to see (merged onto the harness's scrubbed parent base), and
 *   `signal` to stop the call when the caller is cancelled.
 * @returns the exit code with the collected streams, plus whether the deadline
 *   stopped it.
 */
async function runProcess(subprocess, argv, { cwd, maxBytes = DOCKER_MAX_BYTES, timeoutMs, env, signal } = {}) {
  const deadlineMs = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : undefined
  // One controller for the deadline and the caller's signal both, for the same reason
  // `runGit` uses one: the seam takes a single signal, and "was this the deadline?" has
  // to stay answerable afterwards - which it would not be if the caller's abort and the
  // timer reached the seam by different routes.
  const controller = deadlineMs === undefined && signal === undefined ? undefined : new AbortController()
  // Whether the clock is what stopped it, recorded as the timer fires rather than read
  // back off the controller: a caller's own abort reaches the same controller, and
  // asking the controller afterwards cannot tell the two apart.
  let expired = false
  const forward = () => controller.abort()
  if (controller !== undefined && signal !== undefined) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', forward, { once: true })
  }
  const timer = controller === undefined || deadlineMs === undefined
    ? undefined
    : setTimeout(() => { expired = true; controller.abort() }, deadlineMs)
  try {
    const handle = subprocess.spawn({
      argv,
      cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes }, stderr: { maxBytes } },
      graceMs: 1000,
      ...(env === undefined ? {} : { env }),
      ...(controller === undefined ? {} : { signal: controller.signal }),
    })
    const outcome = await handle.done
    const timedOut = expired
    return {
      ok: !timedOut && outcome.exitCode === 0,
      exitCode: outcome.exitCode,
      timedOut,
      stdout: handle.collected.stdout?.readFrom(0).text ?? '',
      stderr: handle.collected.stderr?.readFrom(0).text ?? '',
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (controller !== undefined && signal !== undefined) signal.removeEventListener('abort', forward)
  }
}

/** Run docker through {@link runProcess}, under the query deadline. */
async function runDocker(subprocess, args, { signal } = {}) {
  return runProcess(subprocess, ['docker', ...args], {
    cwd: process.cwd(),
    timeoutMs: DOCKER_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  })
}

/**
 * {@link runDocker} with every failure - a missing docker first of all - answered
 * as "nothing came back". Callers below report absence in their own terms.
 *
 * A timed-out query lands here too, and that is deliberate: a daemon that will not
 * answer is the same fact as one that is not installed, from the caller's side -
 * there are no containers to report. The deadline is what stops the wait from being
 * unbounded; what the wait would have found is not something this side can know.
 *
 * What this shape cannot say is *why* nothing came back, and that is what
 * {@link askDocker} exists beside it for: "docker ran and matched nothing" and
 * "docker could not be asked" are both `{ ok: false, stdout: '' }` here. That is
 * the right answer for a caller that only wants to know whether anything came back
 * - the panel's container list, say - and the wrong one for a caller deciding
 * whether to skip a teardown, which is why the teardown uses {@link askDocker}.
 */
async function tryDocker(subprocess, args, { signal } = {}) {
  try {
    return await runDocker(subprocess, args, { signal })
  } catch {
    return { ok: false, exitCode: null, timedOut: false, stdout: '', stderr: '' }
  }
}

/**
 * {@link runDocker}, answering "was docker asked at all" as well as what it said.
 *
 * The distinction the teardown needs and {@link tryDocker} cannot carry:
 * `answered: false` means docker could not be run or did not answer - not on PATH,
 * daemon unreachable, the deadline expired - while `answered: true` with empty
 * output means docker ran and matched nothing. Those are opposite facts about a
 * machine. The first says this side does not know what is standing; the second says
 * it knows nothing is.
 *
 * A sibling rather than a flag on {@link tryDocker}, because the lenient answer is
 * the right one for the callers that only ask "did anything come back", and
 * changing it in place would make every one of them handle a case it has no use
 * for. Both go through {@link runDocker}, so there is one spawn path and one
 * deadline.
 * @param subprocess - the profile's subprocess service.
 * @param args - the docker arguments, without the program.
 * @param options - `signal` to stop the call when the caller is cancelled.
 * @returns whether docker answered, why not when it did not, and what it said.
 */
async function askDocker(subprocess, args, { signal } = {}) {
  try {
    const out = await runDocker(subprocess, args, { signal })
    // A deadline that expired is docker not answering rather than docker answering
    // "nothing": the process was stopped before it could say either way.
    if (out.timedOut) return { answered: false, reason: 'timed-out', out }
    return { answered: true, reason: '', out }
  } catch (error) {
    return { answered: false, reason: String(error?.message ?? error) || 'not-runnable', out: undefined }
  }
}

/**
 * The task's own record, demanded up front.
 *
 * The record is what makes a directory one of this plugin's task spaces and what
 * carries the environment id, so a deployment question about a directory with no
 * record is a question about a stranger, and it fails the way every stranger does.
 * @param taskPath - the task space directory.
 * @returns the record read from the task space.
 */
async function requireRecorded(taskPath) {
  const recorded = await readTaskMetadata(taskPath)
  if (recorded === undefined) throw coded('E2003', `no such task space: ${taskPath}`, { path: taskPath })
  return recorded
}

/**
 * Every `.state.json` a deploy could have left in or under this task space.
 *
 * The task space's own deploy root is the one this plugin names for every script it runs
 * (`DEPLOY_STATE_FILE`), so it is searched first and it is where a script should write.
 * The repository shape is still read: a single-repository space may carry its own deploy
 * root instead, inside the repository's own worktree, which is that repository's file and
 * not this plugin's.
 *
 * The plugin's own directory is skipped in the walk below: the state file it holds is
 * already the first candidate, and reading it twice would let {@link preserveStates}
 * rewrite it twice.
 * @param taskPath - the task space directory.
 * @returns the state files that exist, preferred first.
 */
async function deliveryStateFiles(taskPath) {
  const files = []
  const entries = await readdir(taskPath, { withFileTypes: true }).catch(() => [])
  const candidates = [join(taskDeployRootPath(taskPath), STATE_NAME)]
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== PLUGIN_ROOT) candidates.push(join(taskPath, entry.name, DEPLOY_ROOT, STATE_NAME))
  }
  for (const path of candidates) {
    if (existsSync(path)) files.push(path)
  }
  return files
}

/**
 * The one path this task's deploy scripts are told to write their state to.
 *
 * Fixed, and independent of where the entry script sits: the deploy root is the task's
 * orchestration root, so its state lives at its top. That is the whole point - a script in a
 * subdirectory writes the same file as one at the top, without computing a relative path
 * and without knowing the layout. The path is handed over as `DEPLOY_STATE_FILE`, and it is
 * also the first place {@link deliveryStateFiles} looks.
 * @param taskPath - the task space directory.
 * @returns the absolute path of the state file.
 */
function stateFilePath(taskPath) {
  return join(taskDeployRootPath(taskPath), STATE_NAME)
}

/**
 * The environment a deploy script is run with.
 *
 * Two facts, both of which the script would otherwise have to derive: which environment it
 * is (so its containers, images and URL stay apart from every other task's) and where to
 * write the state the plugin reads back. `DEPLOY_STATE_FILE` is what makes the state file's
 * location a plugin decision rather than a script convention.
 *
 * The name is this plugin's own rather than `DSH_`-prefixed on purpose: `DSH_` is the
 * harness's reserved namespace for facts IT manages, and a plugin putting its own variable
 * there claims a name that is not its to claim.
 * @param taskPath - the task space directory.
 * @param envId - the environment id for this task.
 * @returns the entries to merge onto the child's environment.
 */
function deployEnvironmentFor(taskPath, envId) {
  return {
    ...(envId === '' ? {} : { DEPLOY_ENV_ID: envId }),
    DEPLOY_STATE_FILE: stateFilePath(taskPath),
  }
}

/**
 * Read the deployment state a deploy recorded, preferred file first.
 * @param taskPath - the task space directory.
 * @returns the state with its file path, or undefined when none was recorded.
 */
async function readDeliveryState(taskPath) {
  for (const path of await deliveryStateFiles(taskPath)) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'))
      if (parsed !== null && typeof parsed === 'object') return { path, state: parsed }
    } catch {
      // A half-written or hand-edited state file is not the state; the next file,
      // if any, speaks, and otherwise there is no deployment to report.
    }
  }
  return undefined
}

/**
 * The containers a task's environment is running right now, by its label.
 * @param subprocess - the profile's subprocess service.
 * @param envId - the environment id the label carries.
 * @returns one row per container, empty when docker says nothing.
 */
async function containersFor(subprocess, envId, { signal } = {}) {
  const out = await tryDocker(subprocess, [
    'ps', '-a', '--filter', `label=dsh.env-id=${envId}`, '--format', '{{.Names}}\t{{.State}}',
  ], { signal })
  if (!out.ok || out.stdout.trim() === '') return []
  return out.stdout.trim().split(/\r?\n/).map((line) => {
    const [name, state] = line.split('\t')
    return { name: name ?? '', state: state ?? 'unknown' }
  }).filter((row) => row.name !== '')
}

async function containerIds(subprocess, envId, { signal } = {}) {
  const out = await tryDocker(subprocess, ['ps', '-a', '-q', '--filter', `label=dsh.env-id=${envId}`], { signal })
  return out.ok ? out.stdout.trim().split(/\r?\n/).filter((one) => one !== '') : []
}

/**
 * The containers a task's environment is running, or why that cannot be answered.
 *
 * {@link containerIds} answers `[]` for both "none" and "docker could not be
 * asked", which is fine where the caller only renders a list. This is the same
 * question through {@link askDocker}, for the one caller that has to tell the two
 * apart: the teardown, which otherwise reports "nothing to remove" about an
 * environment it never looked at and lets the task space be deleted with the
 * containers still standing.
 * @param subprocess - the profile's subprocess service.
 * @param envId - the environment id the label carries.
 * @returns the ids, and whether docker answered the question at all.
 */
async function askedContainerIds(subprocess, envId, { signal } = {}) {
  const answer = await askDocker(subprocess, ['ps', '-a', '-q', '--filter', `label=dsh.env-id=${envId}`], { signal })
  if (!answer.answered) return { answered: false, ids: [], reason: answer.reason }
  if (!answer.out.ok) {
    // Docker ran and refused - a daemon that is up but rejects the query. That is
    // still an answer of sorts, but not one that says "there are none", so it is
    // reported the same way as not being able to ask.
    return { answered: false, ids: [], reason: answer.out.stderr.trim() !== '' ? answer.out.stderr.trim() : `docker ps exited ${answer.out.exitCode}` }
  }
  return { answered: true, ids: answer.out.stdout.trim().split(/\r?\n/).filter((one) => one !== ''), reason: '' }
}

/**
 * The acceptance URL a state file recorded, or nothing.
 *
 * One accessor for the two readers below, because the same value used to have two
 * rules: `deliveryStateSummary` asked whether it was a non-empty string, and
 * `deploymentStatus` took it as it came. A script-written state file is not a
 * trusted document - it is JSON on disk - so `url` can be an object, a number, or a
 * string that is not a URL at all.
 *
 * The panel renders this value, and that is why a non-string mattered rather than
 * being merely untidy: React refuses an object as a child, the client has no error
 * boundary, and a thrown render unmounts the whole settings page. A bad value must
 * therefore read as "no acceptance URL recorded" - the same answer as a state file
 * that never wrote one - rather than as a value that travels to a renderer.
 *
 * `http:` and `https:` only. `javascript:` and `data:` are not acceptance URLs, and
 * while a `target="_blank"` link does not execute the former in current browsers,
 * an audit of this plugin should not depend on that: a protocol this side would
 * never produce is not one it forwards.
 * @param value - the `url` field as the state file held it.
 * @returns the URL string when it is a usable http(s) one, else null.
 */
function acceptanceUrl(value) {
  if (typeof value !== 'string' || value === '') return null
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    // Not a URL at all - a path, a sentence, a fragment. Nothing to open.
    return null
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : null
}

/**
 * What the task's deployment looks like right now.
 *
 * Read live on every call: a dynamic port changes with every deploy, so the panel
 * asks rather than remembers, and the state file only answers for what a deploy
 * wrote down (the url it handed out, the smoke it ran).
 *
 * `derive` is accepted and ignored: it used to ask a manifest's own `status`
 * command when no state file existed, and the manifest is gone. It stays in the
 * signature because the panel's endpoint still passes it, and a parameter that
 * silently does nothing is better than one that fails - but the state file is now
 * the only place a URL can come from, and `urlSource` says so.
 * @param subprocess - the profile's subprocess service.
 * @param taskPath - the task space directory.
 * @returns the status the panel renders.
 */
export async function deploymentStatus(subprocess, taskPath, { signal } = {}) {
  const recorded = await requireRecorded(taskPath)
  const envId = typeof recorded.deploymentEnvId === 'string' ? recorded.deploymentEnvId : ''
  const policy = deliveryPolicyOf(recorded)
  const found = await readDeliveryState(taskPath)
  const stateUrl = acceptanceUrl(found?.state?.url)
  return {
    envId,
    target: policy.deploy.target,
    url: stateUrl,
    urlSource: stateUrl !== null ? 'state' : 'none',
    lastSmoke: found?.state?.lastSmoke ?? null,
    destroyedAt: found?.state?.destroyedAt ?? null,
    stateFound: found !== undefined,
    statePath: found?.path ?? null,
    containers: envId === '' ? [] : await containersFor(subprocess, envId, { signal }),
  }
}

/**
 * The two facts a caller wants from a task's delivery state without a second round
 * trip: the acceptance URL and the last smoke.
 *
 * Read through the same reader the panel uses ({@link readDeliveryState}), so the
 * tool and the card can never disagree about what a deploy recorded. Nothing is
 * derived here: the fallback that asks a deploy root's own `status` command is the
 * panel's explicit press, and running it from a `list` would make a read of many
 * tasks run many scripts.
 *
 * Every absence is answered as absence rather than as an error: a task that was
 * never deployed has no state file, and that is a fact about the task, not a
 * failure of the caller's request.
 * @param taskPath - the task space directory.
 * @returns the URL and smoke as recorded, both null when nothing was.
 */
export async function deliveryStateSummary(taskPath) {
  const found = await readDeliveryState(taskPath)
  const smoke = found?.state?.lastSmoke
  return {
    url: acceptanceUrl(found?.state?.url),
    lastSmoke: smoke === null || smoke === undefined || typeof smoke !== 'object'
      ? null
      : {
        result: typeof smoke.result === 'string' ? smoke.result : 'unknown',
        ...(typeof smoke.at === 'string' && smoke.at !== '' ? { at: smoke.at } : {}),
      },
    statePath: found?.path ?? null,
  }
}

/**
 * The gate a merge has to pass when the policy ties it to a deployment.
 *
 * One refusal: the deployment records no passing smoke. That covers both shapes of "no
 * green smoke" - the state file was never written, or it was and its smoke is missing or
 * red - because the action they ask for is the same one either way: deploy, run the smoke,
 * and let that script write the result down.
 *
 * They used to be two codes (E5005 for no state at all, E5006 for a smoke that did not
 * pass). The split read as two different problems and was not: a task whose script never
 * wrote the file and a task whose smoke failed are both "the environment has not been shown
 * to work", and the person reading it does the same next thing. The missing-file message
 * also carried the whole delivery-policy explanation, which no longer described anything -
 * there is no policy field left for it to name. So the two became one.
 *
 * `bypass` is the user's own overrule, and it exists because the user's
 * instruction outranks the policy: the panel asks ("the smoke has not passed -
 * finish anyway?") and, on their yes, finishes with this flag set. What arrives
 * through the model-facing tool never carries it - the gate the model meets is the
 * hard one, and its way past is deploying and smoking, never retrying.
 * @param recorded - the task's own record.
 * @param taskPath - the task space directory, where the state is looked up.
 * @param options - `merge` is the request under judgement; `bypass` overrules on
 *   the user's explicit say-so.
 * @returns a warning sentence when the gate was bypassed, or undefined when it
 *   either passed cleanly or does not apply.
 * @throws Error carrying E5006 when the merge may not proceed.
 */
export async function assertDeliveryGate(recorded, taskPath, { merge = false, bypass = false } = {}) {
  if (merge !== true) return undefined
  const policy = deliveryPolicyOf(recorded)
  if (policy.deploy.target === 'none') return undefined
  const envId = typeof recorded?.deploymentEnvId === 'string' ? recorded.deploymentEnvId : ''
  const found = await readDeliveryState(taskPath)
  // No state file is the same answer as a state file with no green smoke: the deployment
  // has not been shown to work. `missing` still says which of the two it is, so a screen
  // can name the step rather than the code.
  const smoke = found?.state?.lastSmoke
  const passing = smoke !== null && typeof smoke === 'object' && smoke.result === 'pass'
  // A green smoke is only evidence about the environment it was run against, so the smoke
  // has to be no older than the last `up` this side ran. `deployedAt` is written by the
  // host rather than by the script, so a script cannot date a deployment that never
  // happened. Without this, deploy A -> smoke passes -> edit -> deploy B -> A's green
  // light still opens B's merge, which is the stale-green shape of this gate.
  //
  // A check on evidence, never a wall: `bypass` - the user's own say-so from the panel -
  // steps over it exactly as it steps over a red smoke. `deployedAt` is absent for a
  // deploy run by a session rather than by this side, and an absent one is not a refusal:
  // the alternative would be to refuse work the plugin never saw and cannot date.
  const deployedAt = typeof found?.state?.deployedAt === 'string' ? found.state.deployedAt : ''
  const smokeAt = smokeTime(smoke)
  const stale = deployedAt !== '' && smokeAt !== undefined && smokeAt < Date.parse(deployedAt)
  if (passing && !stale) return undefined
  const missing = found === undefined ? ['deployment', 'smoke'] : ['smoke']
  if (bypass) {
    return warned('delivery-gate-bypassed', 'the user acknowledged finishing without a passing smoke', { missing })
  }
  const because = found === undefined
    ? '`<deploy root>/.state.json` is absent'
    : stale
      ? `the recorded smoke (${smoke.at}) is older than the last deployment this side ran (${deployedAt}), so it says nothing about the environment standing now`
      : 'it carries no `lastSmoke` with `result: "pass"`'
  throw coded(
    'E5006',
    `the deployment records no passing smoke, so the merge is refused: ${because}${envId === '' ? '' : ` (environment ${envId})`}. `
      + 'Deploy the task space and run its smoke, having that script merge `lastSmoke: { result, at }` into the state file, '
      + 'then merge.',
    { target: policy.deploy.target, envId, missing },
  )
}

/**
 * When a recorded smoke was run, as a number, or undefined when it says nothing usable.
 *
 * The stamp is the deploy script's to write, so it is read defensively: a missing or
 * unparseable one answers "no date", which the gate reads as "cannot be shown to be
 * stale" rather than as a refusal. Dating evidence is a reason to ask again, never a
 * reason to refuse work on the strength of a field somebody's script did not write.
 * @param smoke - the `lastSmoke` object from the state file.
 * @returns the epoch milliseconds, or undefined.
 */
function smokeTime(smoke) {
  const at = smoke !== null && typeof smoke === 'object' ? smoke.at : undefined
  if (typeof at !== 'string' || at.trim() === '') return undefined
  const parsed = Date.parse(at)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * What a finish would still be waiting for, asked without refusing anything.
 *
 * The gate above answers the same question, but only when a merge is actually
 * attempted - which is the last minute of a task's life, and the worst moment to
 * learn that a state file was never written. This is that same judgement made
 * available earlier: a deploy and a smoke report it as they finish, so the reader
 * sees "still waiting for a passing smoke" while the smoke can still be run,
 * rather than as a refusal they have to reverse-engineer.
 *
 * Deliberately NOT the gate itself: nothing here throws, and `merge` is not
 * required, because this is a report about the policy rather than a decision about
 * a request. The keys are the same ones the gate names, so a screen can say both
 * in the same words.
 * @param recorded - the task's own record.
 * @param taskPath - the task space directory, where the state is looked up.
 * @returns the missing keys, and whether the policy gates a merge at all.
 */
export async function deliveryGatePreview(recorded, taskPath) {
  const policy = deliveryPolicyOf(recorded)
  // A policy that deploys nothing has no gate to preview, and saying otherwise would
  // invent a requirement the finish will not enforce.
  if (policy.deploy.target === 'none') return { applies: false, missing: [], target: 'none' }
  const found = await readDeliveryState(taskPath)
  // The same keys the gate reports, by the same judgement - one function, so a screen
  // cannot say "nothing is missing" about a merge the gate then refuses. The smoke is
  // read through the gate's own rule: green, run against an environment that is up, and
  // no older than the last deployment this side ran.
  if (found === undefined) return { applies: true, missing: ['deployment', 'smoke'], target: policy.deploy.target }
  const missing = []
  const smoke = found.state?.lastSmoke
  const deployedAt = typeof found.state.deployedAt === 'string' ? found.state.deployedAt : ''
  const smokeAt = smokeTime(smoke)
  const stale = deployedAt !== '' && smokeAt !== undefined && smokeAt < Date.parse(deployedAt)
  if (smoke === null || typeof smoke !== 'object' || smoke.result !== 'pass' || stale) missing.push('smoke')
  return { applies: true, missing, target: policy.deploy.target }
}

/**
 * Tear a task's environment down, by the label it was deployed with.
 *
 * The compose project is asked to go first - it owns the network and the volumes
 * beside the containers - using the compose file and working directory the
 * containers themselves record in their compose labels, so this needs no deploy
 * script and no path agreement. Whatever is still standing after that (a container
 * started with `docker run` and the label, a compose that would not run) is removed
 * by force, and what even that could not remove is reported as a warning rather
 * than raised: the task space is going away either way.
 *
 * The state files survive. The acceptance facts they hold - the smoke that passed,
 * the human ack - belong to the task, not to the containers: destroying the
 * environment to free the machine must not un-accept work the user already looked
 * at. Only the URL dies with the containers (its dynamic port is dead), and a
 * `destroyedAt` stamp records that the environment is down.
 * @param subprocess - the profile's subprocess service.
 * @param taskPath - the task space directory, to find the state file to clear and
 *   - when no id is named - the environment id itself, which is how the panel's
 *   destroy endpoint asks.
 * @param envId - the environment id; when empty it is read from the task's record,
 *   and when the record names none there is nothing named to remove.
 * @returns what was removed, with a warning when part of it could not be.
 */
export async function destroyDeployment(subprocess, taskPath, envId, { signal } = {}) {
  let id = typeof envId === 'string' ? envId.trim() : ''
  let recordedForTarget
  if (id === '') {
    // The panel asks by path alone: the environment id lives in the task's own
    // record. The finish-time hook names it explicitly, because by then the
    // space the record lived in may already be gone.
    recordedForTarget = await readTaskMetadata(taskPath).catch(() => undefined)
    if (recordedForTarget !== undefined && typeof recordedForTarget.deploymentEnvId === 'string') id = recordedForTarget.deploymentEnvId
  }
  if (id === '') {
    return { removed: false, containers: 0, warning: warned('no-deployment-recorded', 'no deployment environment is recorded for this task space, so there is nothing named to remove') }
  }
  // Everything left is docker: containers are found by the environment label, and
  // the compose project they belong to is asked of the containers themselves. There
  // used to be a branch here for a manifest target's own `destroy` command; with
  // `host` gone there is no such target, and `none` never had containers of its own
  // to tear down. A `none` task can still carry containers from a deploy made
  // outside this flow, and teardown must never be the thing that gets refused:
  // containers nobody can take down from here are a worse end state than the
  // policy's own surprise. It falls through to the label path below, which finds them.
  const found = await askedContainerIds(subprocess, id, { signal })
  if (!found.answered) {
    // Docker could not be asked, so this side does not know whether anything is
    // standing. Reported rather than answered "nothing to remove": that answer let a
    // finish delete the task space while the containers, networks and volumes stayed
    // on the machine forever, and "docker is not on PATH" was indistinguishable from
    // "there really are no containers".
    //
    // A warning and not a refusal, because teardown must never be the thing that
    // blocks: the task space is going away either way, and what the user needs is to
    // be told that the environment may still be standing and that docker has to be
    // reachable to take it down.
    return {
      removed: false,
      containers: 0,
      unknown: true,
      warning: warned(
        'deploy-containers-unchecked',
        `the environment's containers could not be looked up, so it is unknown whether any are still standing: `
          + `docker could not be asked (${found.reason})`,
        { envId: id, reason: found.reason },
      ),
    }
  }
  const ids = found.ids
  if (ids.length === 0) {
    // Nothing standing: nothing was destroyed, so no acceptance fact loses its
    // environment and the state files stay exactly as they are.
    return { removed: false, containers: 0 }
  }

  const inspect = await tryDocker(subprocess, [
    'inspect', ...ids,
    '--format', '{{index .Config.Labels "com.docker.compose.project.config_files"}}\t{{index .Config.Labels "com.docker.compose.project.working_dir"}}',
  ], { signal })
  let composed = false
  if (inspect.ok) {
    for (const line of inspect.stdout.split(/\r?\n/)) {
      const [files, dir] = line.split('\t')
      if (!files || files === '<no value>' || !dir || dir === '<no value>') continue
      const down = await tryDocker(subprocess, [
        'compose', '--project-name', id, '--project-directory', dir,
        ...files.split(',').filter((file) => file.trim() !== '').flatMap((file) => ['-f', file.trim()]),
        'down', '-v', '--remove-orphans',
      ], { signal })
      if (down.ok) {
        composed = true
        break
      }
    }
  }

  const warnings = []
  let removed = composed
  const left = await askedContainerIds(subprocess, id, { signal })
  if (!left.answered) {
    // The same distinction after the teardown: a check that could not run is not a
    // clean result. Reported so a partial teardown is not read as a complete one.
    warnings.push(warned(
      'deploy-containers-unchecked',
      `whether the environment's containers are gone could not be checked: docker could not be asked (${left.reason})`,
      { envId: id, reason: left.reason, after: 'teardown' },
    ))
  } else if (left.ids.length > 0) {
    const removedForce = await tryDocker(subprocess, ['rm', '-f', ...left.ids], { signal })
    if (removedForce.ok) {
      removed = true
    } else {
      warnings.push(warned('deploy-containers-left', `could not remove ${left.ids.length} container${left.ids.length === 1 ? '' : 's'} of environment ${id}: ${removedForce.stderr.trim() !== '' ? removedForce.stderr.trim() : 'docker failed'}`, { count: left.ids.length, envId: id, reason: removedForce.stderr.trim() }))
    }
  }
  await preserveStates(taskPath)
  return { removed, containers: ids.length, ...(warnings.length > 0 ? { warning: warnings[0] } : {}) }
}

/**
 * The acceptance facts survive the environment: each state file keeps its smoke
 * and its ack, loses only the URL (the dynamic port is dead), and gains the stamp
 * saying the environment is down. Written as one line of JSON — the deploy script
 * reads these fields back per line, so the on-disk shape is part of the handshake.
 */
async function preserveStates(taskPath) {
  const destroyedAt = new Date().toISOString()
  for (const path of await deliveryStateFiles(taskPath)) {
    try {
      const state = JSON.parse(await readFile(path, 'utf8'))
      if (state !== null && typeof state === 'object') {
        await writeFile(path, `${JSON.stringify({ ...state, url: null, destroyedAt })}\n`, 'utf8')
      }
    } catch {
      // An unreadable state file is left exactly as it lies: rewriting it from
      // nothing would trade a maybe-recoverable history for a certainly-empty one.
    }
  }
}

/** How much of a command's output to hand back to a panel that asked for the run. */
const OUTPUT_TAIL = 4000

/** The last {@link OUTPUT_TAIL} characters of a command's combined output. */
function outputTail(...streams) {
  const text = streams.join('\n').trim()
  return text.length > OUTPUT_TAIL ? `…${text.slice(text.length - OUTPUT_TAIL)}` : text
}

/**
 * Why a candidate entry may not be run, or '' when it may.
 *
 * Two questions, both asked against the path this side is about to hand to `bash`, and
 * neither answerable from `existsSync` alone. The first is containment: the record lives
 * inside the task space (`{@link taskMetadataPath}`), which is the working directory of the
 * session that works there, so its `deployScript` is a string an agent can write - and
 * `join` happily resolves `../../../Users/me/evil.sh` out of the tree. The path was checked
 * at create time (E4014, in `create.js`); that check is the promise, and this is the one
 * that keeps it, because nothing re-runs the create-time check on the way to executing it.
 *
 * The second is that it is a real file. `existsSync` is true for a directory, and a
 * directory handed to `bash` fails at spawn with a message about the file rather than about
 * the record that named it.
 *
 * Both paths are resolved before the comparison, so the answer is about where the candidate
 * really lands rather than about how it was spelled. The comparison itself is the plugin's
 * one {@link isInside}, so a spelling that differs only in separators - or only in case, on
 * Windows - is not a way past it.
 * @param script - the candidate entry, as this side would run it.
 * @param root - the directory it must sit strictly inside.
 * @returns an empty string when the candidate may be run, else why it may not.
 */
function deployEntryRefusal(script, root) {
  if (!isInside(resolve(root), resolve(script))) return 'outside'
  let stats
  try {
    stats = statSync(script)
  } catch {
    return 'missing'
  }
  return stats.isFile() ? '' : 'not-a-file'
}

/**
 * The deploy root that can rebuild the environment: the entry the task's own record names
 * under `.worktree-space/deploy/`, else a `deploy.sh` at the top of the task space's own
 * orchestration root, then one inside a repository, in directory order - the same two
 * shapes the state files are found by.
 *
 * A named entry is asked for first and alone: the record is the task's own answer to "which
 * script runs here", so a missing one is reported as missing rather than quietly replaced by
 * whatever `deploy.sh` happens to sit beside it. The entry may sit anywhere under the deploy
 * root, including a subdirectory - nothing about the state file depends on that, because the
 * plugin names its path.
 *
 * Every branch re-checks where its candidate lands before returning it
 * ({@link deployEntryRefusal}). For the named branch that check is the whole defence: the
 * value comes out of a file the task session can write, and the create-time validation that
 * confined it to the deploy root is not repeated anywhere between the record and the spawn.
 * For the two joined fallbacks it is defence in depth - their directory names come from
 * `readdir` or from this plugin's own layout - but it is applied there too, so the rule is a
 * property of the function rather than of the one branch that was attacked.
 * @param taskPath - the task space directory.
 * @param recorded - the task's own record, whose `deployScript` names the entry when a
 *   create chose one.
 * @returns the script and its directory, or undefined when the space deploys nothing.
 * @throws Error carrying E5008 when the record names an entry that is not a file inside the
 *   task space's own deploy root.
 */
async function findDeployScript(taskPath, recorded) {
  const named = typeof recorded?.deployScript === 'string' ? recorded.deployScript.trim() : ''
  const deployRoot = taskDeployRootPath(taskPath)
  if (named !== '') {
    // The record's value is relative to the task space's own root - the same relative path
    // the workspace uses, because the deploy root is copied to the same place on both sides
    // (`.worktree-space/deploy/`). So it is joined here and nowhere else, and the workspace's
    // spelling and this one cannot drift. The script's own directory is where it runs from,
    // so its siblings are reachable.
    const script = resolve(taskPath, ...named.split('/').filter((part) => part !== ''))
    // Refused rather than skipped, and refused here rather than at the spawn: the record
    // named this entry, so falling back to whatever `deploy.sh` sits beside it would run a
    // script nobody chose - the same reasoning the missing-entry case already follows.
    const refusal = deployEntryRefusal(script, deployRoot)
    if (refusal !== '') {
      const because = refusal === 'outside'
        ? `it is not inside the task space's own deploy root (${deployRoot})`
        : refusal === 'not-a-file'
          ? 'it is a directory, not a file'
          : 'it is not there'
      throw coded(
        'E5008',
        `the deploy script this task's record names cannot be run: ${because}. The record is ${named}.\n`
          + '  The record lives inside the task space, so the session working there can write it, and the path is '
          + `re-checked here rather than trusted; put the entry under \`${DEPLOY_DIR}/\` inside the task space, or clear `
          + 'the record\'s `deployScript` to fall back to that directory\'s own `deploy.sh`.',
        { path: taskPath, deployScript: named, reason: refusal },
      )
    }
    return { script, dir: dirname(script) }
  }
  const entries = await readdir(taskPath, { withFileTypes: true }).catch(() => [])
  const candidates = [{ dir: deployRoot, root: deployRoot }]
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== PLUGIN_ROOT) {
      // The repository shape: a single-repository space may carry its own deploy root inside
      // the repository's worktree. It is that repository's file rather than this plugin's, so
      // it is held to the task space rather than to the plugin's deploy root.
      candidates.push({ dir: join(taskPath, entry.name, DEPLOY_ROOT), root: taskPath })
    }
  }
  for (const candidate of candidates) {
    const script = join(candidate.dir, 'deploy.sh')
    if (deployEntryRefusal(script, candidate.root) !== '') continue
    return { script, dir: candidate.dir }
  }
  return undefined
}

/**
 * Re-run the task's smoke through its own deploy script, after a re-deploy or
 * whenever the user wants a fresh verdict.
 *
 * Unlike a rebuild, a failed smoke is a result rather than an error: the script
 * has already recorded `fail` in the state file (that is its contract), so what
 * comes back is the output tail and the live status either way, and the card
 * repaints from it — a red badge is as much an answer as a green one. Only the
 * structural failures (no script, unstartable) raise.
 * @param subprocess - the profile's subprocess service.
 * @param taskPath - the task space directory.
 * @param options - `signal`, when the caller has one, to stop the run in flight.
 * @returns the smoke output and the deployment status as it stands after it.
 * @throws Error carrying E5008 when there is no deploy script, or it failed to start.
 */
export async function smokeEnvironment(subprocess, taskPath, { signal } = {}) {
  const recorded = await requireRecorded(taskPath)
  const envId = typeof recorded.deploymentEnvId === 'string' ? recorded.deploymentEnvId.trim() : ''
  const found = await findDeployScript(taskPath, recorded)
  if (found === undefined) {
    throw coded('E5008', `no deploy script exists in this task space, so there is nothing to smoke: ${taskPath}`)
  }
  let out
  try {
    out = await runProcess(subprocess, ['bash', found.script, 'smoke', ...(envId === '' ? [] : [envId])], {
      cwd: found.dir,
      maxBytes: 2 * 1024 * 1024,
      // A smoke runs a test suite, so it is allowed minutes - but not forever. Without
      // this the handler that asked for it waits on a script that may never exit.
      timeoutMs: DEPLOY_SMOKE_TIMEOUT_MS,
      // Where the script must merge `lastSmoke`. Handed over rather than left to a
      // convention, so a script in a subdirectory writes the same file as one at the top.
      env: deployEnvironmentFor(taskPath, envId),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    throw coded('E5008', `the deploy script could not be started (${error.message}); bash must be on the PATH the server runs with`)
  }
  return {
    output: outputTail(out.stderr, out.stdout),
    exitCode: out.exitCode,
    // Reported rather than folded into the exit code, because a script this side stopped
    // has no exit code to read: the smoke did not fail, it did not finish, and the card
    // has to be able to say which. A red badge over a timeout would read as a real
    // verdict on the environment.
    timedOut: out.timedOut,
    status: await deploymentStatus(subprocess, taskPath),
    // The smoke is what the gate waits for, so this is the moment its answer is
    // most useful: a red one says so here, while the user is still on the card,
    // rather than as an E5006 refusal at the finish.
    gate: await deliveryGatePreview(recorded, taskPath),
  }
}

/**
 * Rebuild the task's environment through its own deploy script: the one-click
 * 部署验收 behind a destroyed (or never-deployed) card.
 *
 * The script is the task space's own - the same one a session runs - with the
 * environment id passed as the second argument so the rebuilt environment lands
 * under the same name and label the record already carries. A failed build is an
 * error (nothing new was deployed), and it names itself in the output tail.
 * @param subprocess - the profile's subprocess service.
 * @param taskPath - the task space directory.
 * @param options - `signal`, when the caller has one, to stop the run in flight.
 * @returns the deploy output and the deployment status as it stands after it.
 * @throws Error carrying E5008 when there is no deploy script, or the build failed.
 */
export async function deployEnvironment(subprocess, taskPath, { signal } = {}) {
  const recorded = await requireRecorded(taskPath)
  const envId = typeof recorded.deploymentEnvId === 'string' ? recorded.deploymentEnvId.trim() : ''
  const found = await findDeployScript(taskPath, recorded)
  if (found === undefined) {
    throw coded('E5008', `no deploy script exists in this task space, so there is nothing to deploy: ${taskPath}`)
  }
  let out
  try {
    out = await runProcess(subprocess, ['bash', found.script, 'up', ...(envId === '' ? [] : [envId])], {
      cwd: found.dir,
      maxBytes: 2 * 1024 * 1024,
      // A rebuild pulls images and starts services, so this is the longest deadline here
      // - and still a deadline. A build that has not answered in ten minutes is one that
      // is not going to, and the person who pressed the button is owed the answer.
      timeoutMs: DEPLOY_UP_TIMEOUT_MS,
      // Where the script must write `url`. Handed over rather than left to a convention, so
      // a script in a subdirectory writes the same file as one at the top.
      env: deployEnvironmentFor(taskPath, envId),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    throw coded('E5008', `the deploy script could not be started (${error.message}); bash must be on the PATH the server runs with`)
  }
  if (out.timedOut) {
    // Named separately from a non-zero exit, because it asks for a different thing: the
    // script did not fail, it did not finish, and what it left behind is unknown. The
    // output tail is still shown, because whatever it printed before being stopped is
    // the only account of where it got to.
    throw coded(
      'E5008',
      `the deploy script did not finish within ${Math.round(DEPLOY_UP_TIMEOUT_MS / 60000)} minutes and was stopped:\n${outputTail(out.stderr, out.stdout)}`,
    )
  }
  if (!out.ok) {
    throw coded('E5008', `the deploy script failed with exit code ${out.exitCode}:\n${outputTail(out.stderr, out.stdout)}`)
  }
  // Dated by this side, after the script that ran `up` has exited zero, and by no other
  // writer: `deployedAt` is what tells a green smoke run against *this* environment from
  // one recorded before it was rebuilt (see `assertDeliveryGate`). A script that wrote its
  // own stamp could date a deployment that never happened, and the scripts own the other
  // fields anyway - this one is deliberately not theirs, the way `destroyedAt` is not.
  //
  // Best effort: a state file that will not take the stamp leaves the gate where it was
  // before this existed, which is the right trade against failing a deployment that has
  // already come up.
  await stampDeployedAt(taskPath)
  return {
    output: outputTail(out.stdout),
    status: await deploymentStatus(subprocess, taskPath),
    // What a finish would still be waiting for, read now rather than discovered as
    // an E5006 refusal at the very end. The deploy has just run, so this is
    // the first moment the question can be answered at all.
    gate: await deliveryGatePreview(recorded, taskPath),
    // Asked after `up` exited zero, which is the only moment it can be asked: the
    // script has run, so whatever it started either carries the label or does not.
    ...(await labelledContainerWarning(subprocess, envId, { signal })),
  }
}

/**
 * Whether this environment came up with containers the plugin can find, as a warning.
 *
 * The label is the whole handshake between the plugin and a deploy script, and nothing
 * checked that it was ever applied. `up` exiting zero only says the script thought it
 * succeeded; a script that started containers under a different project name, or under no
 * label at all, left an environment this side cannot see - and a finish then finds no
 * containers, reports "nothing to remove", and deletes the task space with the containers,
 * networks and volumes still on the machine. The task space is what is gone, so nothing
 * afterwards can find them either.
 *
 * A warning and never a refusal, which is the maintainer's standing rule: the script may
 * legitimately start things the label cannot see - a stack it manages itself, a service on
 * the host - and failing the deploy over that would block a workflow that works. What the
 * user needs is to be told, while the card is still in front of them, that the finish will
 * not be able to tear this environment down.
 *
 * Silent when docker cannot be asked: that is not evidence about the label, and a warning
 * that fires on every machine without docker would be noise rather than a signal. The
 * teardown reports the not-asked case in its own words, where it is the thing that matters.
 * @param subprocess - the profile's subprocess service.
 * @param envId - the environment id the label should carry; empty means no label was named.
 * @param options - `signal` to stop the lookup when the caller is cancelled.
 * @returns `{ warning }` when the environment has no findable container, else `{}`.
 */
async function labelledContainerWarning(subprocess, envId, { signal } = {}) {
  if (envId === '') return {}
  const found = await askedContainerIds(subprocess, envId, { signal })
  if (!found.answered || found.ids.length > 0) return {}
  return {
    warning: warned(
      'deploy-no-labelled-containers',
      `the deploy script exited successfully but no container carries this environment's label `
        + `(\`dsh.env-id=${envId}\`), so the finish will not be able to tear the environment down; `
        + 'check that the script labels its containers with `$DEPLOY_ENV_ID`, or take them down yourself',
      { envId, label: `dsh.env-id=${envId}` },
    ),
  }
}

/**
 * Record that this side has just run the task's deployment, on every state file.
 *
 * Written only after `up` exited zero, and only by this side. The file is the deploy
 * scripts' own while the task runs, so the merge is a read-modify-write of the one field
 * this plugin owns - the same shape {@link preserveStates} uses for the other one.
 *
 * Truncated to whole seconds on purpose, because that is the precision the other stamp in
 * this file has: `write-state.sh` writes `lastSmoke.at` with `date -u +...%SZ`, so a
 * millisecond stamp here would read a smoke taken in the same second as *older* than the
 * deployment it followed - and refuse a merge that had just been smoked. Both stamps are
 * seconds, so they compare like for like; the cost is that a smoke from the previous
 * deploy within the same second counts as current, which is a second of ambiguity against
 * a false refusal every time the two land together.
 * @param taskPath - the task space directory.
 */
async function stampDeployedAt(taskPath) {
  const deployedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  for (const path of await deliveryStateFiles(taskPath)) {
    try {
      const state = JSON.parse(await readFile(path, 'utf8'))
      if (state !== null && typeof state === 'object') {
        await writeFile(path, `${JSON.stringify({ ...state, deployedAt })}\n`, 'utf8')
      }
    } catch {
      // An unreadable state file is left exactly as it lies: the deployment has already
      // succeeded, and rewriting this from nothing would trade a recoverable history for a
      // certainly-empty one.
    }
  }
}

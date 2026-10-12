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

import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { coded, warned } from './codes.js'
import { deliveryPolicyOf } from './delivery.js'
import { DEPLOY_ROOT, PLUGIN_ROOT, readTaskMetadata, taskDeployRootPath } from './shared.js'

/** The state file a deploy root carries, per the handshake. */
const STATE_NAME = '.state.json'

/** How much docker output a single call may hand back. */
const DOCKER_MAX_BYTES = 512 * 1024

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
 * @param subprocess - the profile's subprocess service.
 * @param argv - the whole command line, program included.
 * @param options - `cwd` to run in, `maxBytes` per stream, `timeoutMs` for a
 *   deadline (absent or non-positive: no deadline at all), and `env` for entries
 *   the child has to see (merged onto the harness's scrubbed parent base).
 * @returns the exit code with the collected streams, plus whether the deadline
 *   stopped it.
 */
async function runProcess(subprocess, argv, { cwd, maxBytes = DOCKER_MAX_BYTES, timeoutMs, env } = {}) {
  const deadlineMs = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : undefined
  const controller = deadlineMs === undefined ? undefined : new AbortController()
  const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), deadlineMs)
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
    const timedOut = controller !== undefined && controller.signal.aborted
    return {
      ok: !timedOut && outcome.exitCode === 0,
      exitCode: outcome.exitCode,
      timedOut,
      stdout: handle.collected.stdout?.readFrom(0).text ?? '',
      stderr: handle.collected.stderr?.readFrom(0).text ?? '',
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Run docker through {@link runProcess}. */
async function runDocker(subprocess, args) {
  return runProcess(subprocess, ['docker', ...args], { cwd: process.cwd() })
}

/**
 * {@link runDocker} with every failure - a missing docker first of all - answered
 * as "nothing came back". Callers below report absence in their own terms.
 */
async function tryDocker(subprocess, args) {
  try {
    return await runDocker(subprocess, args)
  } catch {
    return { ok: false, exitCode: null, stdout: '', stderr: '' }
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
async function containersFor(subprocess, envId) {
  const out = await tryDocker(subprocess, [
    'ps', '-a', '--filter', `label=dsh.env-id=${envId}`, '--format', '{{.Names}}\t{{.State}}',
  ])
  if (!out.ok || out.stdout.trim() === '') return []
  return out.stdout.trim().split(/\r?\n/).map((line) => {
    const [name, state] = line.split('\t')
    return { name: name ?? '', state: state ?? 'unknown' }
  }).filter((row) => row.name !== '')
}

async function containerIds(subprocess, envId) {
  const out = await tryDocker(subprocess, ['ps', '-a', '-q', '--filter', `label=dsh.env-id=${envId}`])
  return out.ok ? out.stdout.trim().split(/\r?\n/).filter((one) => one !== '') : []
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
export async function deploymentStatus(subprocess, taskPath) {
  const recorded = await requireRecorded(taskPath)
  const envId = typeof recorded.deploymentEnvId === 'string' ? recorded.deploymentEnvId : ''
  const policy = deliveryPolicyOf(recorded)
  const found = await readDeliveryState(taskPath)
  const stateUrl = found?.state?.url ?? null
  return {
    envId,
    target: policy.deploy.target,
    url: stateUrl,
    urlSource: stateUrl !== null ? 'state' : 'none',
    lastSmoke: found?.state?.lastSmoke ?? null,
    destroyedAt: found?.state?.destroyedAt ?? null,
    stateFound: found !== undefined,
    statePath: found?.path ?? null,
    containers: envId === '' ? [] : await containersFor(subprocess, envId),
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
    url: typeof found?.state?.url === 'string' && found.state.url !== '' ? found.state.url : null,
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
  if (passing) return undefined
  const missing = found === undefined ? ['deployment', 'smoke'] : ['smoke']
  if (bypass) {
    return warned('delivery-gate-bypassed', 'the user acknowledged finishing without a passing smoke', { missing })
  }
  throw coded(
    'E5006',
    'the deployment records no passing smoke, so the merge is refused: `<deploy root>/.state.json` is either absent or '
      + `carries no \`lastSmoke\` with \`result: "pass"\`${envId === '' ? '' : ` (environment ${envId})`}. `
      + 'Deploy the task space and run its smoke, having that script merge `lastSmoke: { result, at }` into the state file, '
      + 'then merge.',
    { target: policy.deploy.target, envId, missing },
  )
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
  // The same two keys the gate reports for the same two shapes: no state file means the
  // deployment is missing and so is its smoke; a state file means only the smoke is.
  if (found === undefined) return { applies: true, missing: ['deployment', 'smoke'], target: policy.deploy.target }
  const missing = []
  const smoke = found.state?.lastSmoke
  if (smoke === null || typeof smoke !== 'object' || smoke.result !== 'pass') missing.push('smoke')
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
export async function destroyDeployment(subprocess, taskPath, envId) {
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
  const ids = await containerIds(subprocess, id)
  if (ids.length === 0) {
    // Nothing standing: nothing was destroyed, so no acceptance fact loses its
    // environment and the state files stay exactly as they are.
    return { removed: false, containers: 0 }
  }

  const inspect = await tryDocker(subprocess, [
    'inspect', ...ids,
    '--format', '{{index .Config.Labels "com.docker.compose.project.config_files"}}\t{{index .Config.Labels "com.docker.compose.project.working_dir"}}',
  ])
  let composed = false
  if (inspect.ok) {
    for (const line of inspect.stdout.split(/\r?\n/)) {
      const [files, dir] = line.split('\t')
      if (!files || files === '<no value>' || !dir || dir === '<no value>') continue
      const down = await tryDocker(subprocess, [
        'compose', '--project-name', id, '--project-directory', dir,
        ...files.split(',').filter((file) => file.trim() !== '').flatMap((file) => ['-f', file.trim()]),
        'down', '-v', '--remove-orphans',
      ])
      if (down.ok) {
        composed = true
        break
      }
    }
  }

  const warnings = []
  let removed = composed
  const left = await containerIds(subprocess, id)
  if (left.length > 0) {
    const removedForce = await tryDocker(subprocess, ['rm', '-f', ...left])
    if (removedForce.ok) {
      removed = true
    } else {
      warnings.push(warned('deploy-containers-left', `could not remove ${left.length} container${left.length === 1 ? '' : 's'} of environment ${id}: ${removedForce.stderr.trim() !== '' ? removedForce.stderr.trim() : 'docker failed'}`, { count: left.length, envId: id, reason: removedForce.stderr.trim() }))
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
 * @param taskPath - the task space directory.
 * @param recorded - the task's own record, whose `deployScript` names the entry when a
 *   create chose one.
 * @returns the script and its directory, or undefined when the space deploys nothing.
 */
async function findDeployScript(taskPath, recorded) {
  const named = typeof recorded?.deployScript === 'string' ? recorded.deployScript.trim() : ''
  if (named !== '') {
    // The record's value is relative to the task space's own root - the same relative path
    // the workspace uses, because the deploy root is copied to the same place on both sides
    // (`.worktree-space/deploy/`). So it is joined here and nowhere else, and the workspace's
    // spelling and this one cannot drift. The script's own directory is where it runs from,
    // so its siblings are reachable.
    const script = join(taskPath, ...named.split('/').filter((part) => part !== ''))
    return existsSync(script) ? { script, dir: dirname(script) } : undefined
  }
  const entries = await readdir(taskPath, { withFileTypes: true }).catch(() => [])
  const candidates = [taskDeployRootPath(taskPath)]
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== PLUGIN_ROOT) candidates.push(join(taskPath, entry.name, DEPLOY_ROOT))
  }
  for (const dir of candidates) {
    const script = join(dir, 'deploy.sh')
    if (existsSync(script)) return { script, dir }
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
 * @returns the smoke output and the deployment status as it stands after it.
 * @throws Error carrying E5008 when there is no deploy script, or it failed to start.
 */
export async function smokeEnvironment(subprocess, taskPath) {
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
      // Where the script must merge `lastSmoke`. Handed over rather than left to a
      // convention, so a script in a subdirectory writes the same file as one at the top.
      env: deployEnvironmentFor(taskPath, envId),
    })
  } catch (error) {
    throw coded('E5008', `the deploy script could not be started (${error.message}); bash must be on the PATH the server runs with`)
  }
  return {
    output: outputTail(out.stderr, out.stdout),
    exitCode: out.exitCode,
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
 * @returns the deploy output and the deployment status as it stands after it.
 * @throws Error carrying E5008 when there is no deploy script, or the build failed.
 */
export async function deployEnvironment(subprocess, taskPath) {
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
      // Where the script must write `url`. Handed over rather than left to a convention, so
      // a script in a subdirectory writes the same file as one at the top.
      env: deployEnvironmentFor(taskPath, envId),
    })
  } catch (error) {
    throw coded('E5008', `the deploy script could not be started (${error.message}); bash must be on the PATH the server runs with`)
  }
  if (!out.ok) {
    throw coded('E5008', `the deploy script failed with exit code ${out.exitCode}:\n${outputTail(out.stderr, out.stdout)}`)
  }
  return {
    output: outputTail(out.stdout),
    status: await deploymentStatus(subprocess, taskPath),
    // What a finish would still be waiting for, read now rather than discovered as
    // an E5006 refusal at the very end. The deploy has just run, so this is
    // the first moment the question can be answered at all.
    gate: await deliveryGatePreview(recorded, taskPath),
  }
}

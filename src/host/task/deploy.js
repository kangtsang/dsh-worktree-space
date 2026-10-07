/**
 * The deployment side of the delivery policy: the state a deploy records, the gate
 * a merge has to pass, and the teardown a finished task owes.
 *
 * Everything here speaks the one handshake the deploy scripts and this plugin
 * share, and nothing else: the environment id (`deploymentEnvId` in the record,
 * `DSH_ENV_ID` for the scripts, the `dsh.env-id` label on the containers), and the
 * `.state.json` a deploy writes where its `deploy/` root sits. The scripts own that
 * file while the task runs - it is rewritten on every deploy - so this side reads
 * it, appends a human acceptance ack to it, and deletes it on teardown, but never
 * establishes it.
 *
 * Every docker call is best effort: a machine without docker in the host's PATH has
 * tasks that simply have no deployment to read or tear down, which is a fact to
 * report, never a failure to raise.
 */

import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { coded } from './codes.js'
import { deliveryPolicyOf } from './delivery.js'
import { readTaskMetadata } from './shared.js'

/** The state file a deploy root carries, per the handshake. */
const STATE_NAME = '.state.json'

/** How much docker output a single call may hand back. */
const DOCKER_MAX_BYTES = 512 * 1024

/**
 * Run one command, as {@link `git.js`} runs git: one spawn seam, one shape of answer.
 *
 * Its own module rather than a sibling in `git.js`, for the same reason that file
 * gives: it is the one spawn point for git, and this is not git.
 * @param subprocess - the profile's subprocess service.
 * @param argv - the whole command line, program included.
 * @param options - `cwd` to run in, and `maxBytes` per stream.
 * @returns the exit code with the collected streams.
 */
async function runProcess(subprocess, argv, { cwd, maxBytes = DOCKER_MAX_BYTES } = {}) {
  const handle = subprocess.spawn({
    argv,
    cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes }, stderr: { maxBytes } },
    graceMs: 1000,
  })
  const outcome = await handle.done
  return {
    ok: outcome.exitCode === 0,
    exitCode: outcome.exitCode,
    stdout: handle.collected.stdout?.readFrom(0).text ?? '',
    stderr: handle.collected.stderr?.readFrom(0).text ?? '',
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
  if (recorded === undefined) throw coded('E2003', `no such task space: ${taskPath}`)
  return recorded
}

/**
 * Every `.state.json` a deploy could have left in or under this task space.
 *
 * Two shapes exist: a `deploy/` root beside the worktrees (the multi-repository
 * orchestration the bundled skill describes), and a repository that carries its own
 * deploy root (the single-repository shape). The task space's own root is searched
 * first - it speaks for the whole task - then each repository's, in directory order.
 * @param taskPath - the task space directory.
 * @returns the state files that exist, preferred first.
 */
async function deliveryStateFiles(taskPath) {
  const files = []
  const entries = await readdir(taskPath, { withFileTypes: true }).catch(() => [])
  const candidates = [join(taskPath, 'deploy', STATE_NAME)]
  for (const entry of entries) {
    if (entry.isDirectory()) candidates.push(join(taskPath, entry.name, 'deploy', STATE_NAME))
  }
  for (const path of candidates) {
    if (existsSync(path)) files.push(path)
  }
  return files
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
 * wrote down (the url it handed out, the smoke it ran, the ack a user gave).
 * @param subprocess - the profile's subprocess service.
 * @param taskPath - the task space directory.
 * @returns the status the panel renders.
 */
export async function deploymentStatus(subprocess, taskPath) {
  const recorded = await requireRecorded(taskPath)
  const envId = typeof recorded.deploymentEnvId === 'string' ? recorded.deploymentEnvId : ''
  const policy = deliveryPolicyOf(recorded)
  const found = await readDeliveryState(taskPath)
  return {
    envId,
    target: policy.deploy.target,
    verification: policy.verification,
    url: found?.state?.url ?? null,
    lastSmoke: found?.state?.lastSmoke ?? null,
    humanAck: found?.state?.humanAck ?? null,
    destroyedAt: found?.state?.destroyedAt ?? null,
    stateFound: found !== undefined,
    statePath: found?.path ?? null,
    containers: envId === '' ? [] : await containersFor(subprocess, envId),
  }
}

/**
 * Record the user's acceptance on the deployment state.
 *
 * The ack lives in the state file, beside the smoke it confirms, because both
 * belong to one deployment: a new deploy rewrites the file and the ack is gone,
 * which is the rule - a change shipped again is a change to accept again. The
 * scripts preserve the ack across a re-run smoke for the same reason.
 * @param taskPath - the task space directory.
 * @returns where the ack was written and what it says.
 */
export async function ackAcceptance(taskPath) {
  const found = await readDeliveryState(taskPath)
  if (found === undefined) {
    throw coded('E5005', 'there is no deployment state to accept: deploy the task space and let the smoke pass first')
  }
  const next = { ...found.state, humanAck: { at: new Date().toISOString(), by: 'user' } }
  // Single line, like every other writer of this file: the deploy script reads
  // these fields back per line, so a pretty-printed ack would break that read.
  await writeFile(found.path, `${JSON.stringify(next)}\n`, 'utf8')
  return { statePath: found.path, humanAck: next.humanAck }
}

/**
 * The gate a merge has to pass when the policy ties it to a deployment.
 *
 * Three refusals, in the order they bite: the policy expects a deployment and none
 * was ever recorded; one was, but its smoke is not green; the smoke is green but
 * the policy waits for a human ack that has not been given. A policy with no
 * deployment target has no gate at all - it is how a task nobody configured stays
 * exactly as finishable as it was before delivery policies existed.
 *
 * `bypass` is the user's own overrule, and it exists because the user's
 * instruction outranks the policy: the panel asks ("the smoke has not passed / the
 * human ack is missing - finish anyway?") and, on their yes, finishes with this
 * flag set. What arrives through the model-facing tool never carries it - the gate
 * the model meets is the hard one, and its way past is deploying, smoking, and
 * being accepted, never retrying.
 * @param recorded - the task's own record.
 * @param taskPath - the task space directory, where the state is looked up.
 * @param options - `merge` is the request under judgement; `bypass` overrules on
 *   the user's explicit say-so.
 * @returns a warning sentence when the gate was bypassed, or undefined when it
 *   either passed cleanly or does not apply.
 * @throws Error carrying E5005, E5006 or E5007 when the merge may not proceed.
 */
export async function assertDeliveryGate(recorded, taskPath, { merge = false, bypass = false } = {}) {
  if (merge !== true) return undefined
  const policy = deliveryPolicyOf(recorded)
  if (policy.deploy.target === 'none') return undefined
  const envId = typeof recorded?.deploymentEnvId === 'string' ? recorded.deploymentEnvId : ''
  const found = await readDeliveryState(taskPath)
  const missing = []
  if (found === undefined) {
    if (bypass) return `the user acknowledged finishing without any recorded ${policy.deploy.target} deployment`
    throw coded(
      'E5005',
      `the delivery policy requires a ${policy.deploy.target} deployment before merging, and no deployment state was recorded`
        + `${envId === '' ? '' : ` (environment ${envId})`}. Deploy the task space and run its smoke first.`,
    )
  }
  const smoke = found.state?.lastSmoke
  if (smoke === null || typeof smoke !== 'object' || smoke.result !== 'pass') missing.push('a passing smoke')
  if ((policy.verification === 'agent-then-human' || policy.verification === 'human') && found.state?.humanAck?.at === undefined) {
    missing.push('the human acceptance ack')
  }
  if (missing.length === 0) return undefined
  if (bypass) return `the user acknowledged finishing without ${missing.join(' and ')}`
  if (missing.length === 1 && missing[0] === 'a passing smoke') {
    throw coded('E5006', 'the last deployment smoke did not pass, or never ran; run it again and only then merge')
  }
  throw coded('E5007', `the delivery policy waits for ${missing.join(' and ')} before merging; confirm the acceptance in the Worktree Space panel, or finish anyway from there`)
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
  if (id === '') {
    // The panel asks by path alone: the environment id lives in the task's own
    // record. The finish-time hook names it explicitly, because by then the
    // space the record lived in may already be gone.
    const recorded = await readTaskMetadata(taskPath).catch(() => undefined)
    if (recorded !== undefined && typeof recorded.deploymentEnvId === 'string') id = recorded.deploymentEnvId
  }
  if (id === '') {
    return { removed: false, containers: 0, warning: 'no deployment environment is recorded for this task space, so there is nothing named to remove' }
  }
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
      warnings.push(`could not remove ${left.length} container${left.length === 1 ? '' : 's'} of environment ${id}: ${removedForce.stderr.trim() !== '' ? removedForce.stderr.trim() : 'docker failed'}`)
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
 * The deploy root that can rebuild the environment: a `deploy/deploy.sh` in the
 * task space's own orchestration root first, then one inside a repository, in
 * directory order - the same two shapes the state files are found by.
 * @param taskPath - the task space directory.
 * @returns the script and its directory, or undefined when the space deploys nothing.
 */
async function findDeployScript(taskPath) {
  const entries = await readdir(taskPath, { withFileTypes: true }).catch(() => [])
  const candidates = [join(taskPath, 'deploy')]
  for (const entry of entries) {
    if (entry.isDirectory()) candidates.push(join(taskPath, entry.name, 'deploy'))
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
  const found = await findDeployScript(taskPath)
  if (found === undefined) {
    throw coded('E5008', `no deploy/deploy.sh exists in this task space, so there is nothing to smoke: ${taskPath}`)
  }
  let out
  try {
    out = await runProcess(subprocess, ['bash', found.script, 'smoke', ...(envId === '' ? [] : [envId])], {
      cwd: found.dir,
      maxBytes: 2 * 1024 * 1024,
    })
  } catch (error) {
    throw coded('E5008', `the deploy script could not be started (${error.message}); bash must be on the PATH the server runs with`)
  }
  return {
    output: outputTail(out.stderr, out.stdout),
    exitCode: out.exitCode,
    status: await deploymentStatus(subprocess, taskPath),
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
  const found = await findDeployScript(taskPath)
  if (found === undefined) {
    throw coded('E5008', `no deploy/deploy.sh exists in this task space, so there is nothing to deploy: ${taskPath}`)
  }
  let out
  try {
    out = await runProcess(subprocess, ['bash', found.script, 'up', ...(envId === '' ? [] : [envId])], {
      cwd: found.dir,
      maxBytes: 2 * 1024 * 1024,
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
  }
}

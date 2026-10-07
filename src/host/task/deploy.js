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
  const manifest = await readDeployManifest(taskPath)
  const targets = manifest === undefined ? ['docker'] : manifest.broken ? [] : Object.keys(manifest.targets)
  return {
    envId,
    target: policy.deploy.target,
    verification: policy.verification,
    // The targets the manifest offers, and whether the policy's own target
    // allows unattended deploys - the D8 exemption a host target states in its
    // manifest entry. A space without a manifest offers docker the L0 way.
    targets,
    autoAllowed: manifest !== undefined && !manifest.broken && manifest.targets[policy.deploy.target]?.autoAllowed === true,
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
  let recordedForTarget
  if (id === '') {
    // The panel asks by path alone: the environment id lives in the task's own
    // record. The finish-time hook names it explicitly, because by then the
    // space the record lived in may already be gone.
    recordedForTarget = await readTaskMetadata(taskPath).catch(() => undefined)
    if (recordedForTarget !== undefined && typeof recordedForTarget.deploymentEnvId === 'string') id = recordedForTarget.deploymentEnvId
  }
  if (id === '') {
    return { removed: false, containers: 0, warning: 'no deployment environment is recorded for this task space, so there is nothing named to remove' }
  }
  // A non-docker target has no containers to find by label: its teardown is
  // whatever the manifest's destroy command says, run with the same env id.
  const target = (recordedForTarget !== undefined ? recordedForTarget : await readTaskMetadata(taskPath).catch(() => undefined))
  const policyTarget = typeof target?.delivery === 'object' && target.delivery !== null
    ? String(target.delivery?.deploy?.target ?? 'docker')
    : 'docker'
  if (policyTarget !== 'docker') {
    const manifest = await readDeployManifest(taskPath)
    const entry = manifestEntryFor(manifest, policyTarget, 'destroy')
    const out = await runManifestCommand(subprocess, entry.destroy, manifest.dir, id)
    return { removed: out.ok, containers: 0, ...(out.ok ? {} : { warning: outputTail(out.stderr, out.stdout) }) }
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

/** The manifest file a deploy root may carry, per the D12 decision. */
const MANIFEST_NAME = 'deploy.yaml'

/**
 * Parse the manifest's documented structure and nothing beyond it.
 *
 * The contract is two levels: `targets:` at the top, one target name per line
 * under it, and per target the scalar fields the handshake knows - `up`, `smoke`,
 * `status`, `destroy`, `autoAllowed`. Anchors, block scalars, nested maps beyond
 * that shape are outside the contract and are answered as a broken manifest
 * rather than half-interpreted: a command quietly dropped is a deploy that never
 * runs, which is worse than one that refuses to start.
 * @param text - the manifest file's contents.
 * @returns the targets map, or undefined when the text is outside the contract.
 */
export function parseManifestTargets(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  const targets = Object.create(null)
  let current = null
  let sawTargets = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trimEnd()
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    const body = line.trim()
    const field = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(body)
    if (field === null) return undefined
    const [, key, inline] = field
    if (indent === 0) {
      if (key === 'targets' && inline === undefined) { sawTargets = true; current = null; continue }
      return undefined
    }
    if (!sawTargets) return undefined
    if (inline === undefined || inline === '') {
      // A target name opens a fresh entry, whichever one was being filled before.
      current = targets[key] = {}
      continue
    }
    if (current === null) return undefined
    const scalar = inline.replace(/^['"]|['"]$/g, '')
    current[key] = scalar === 'true' ? true : scalar === 'false' ? false : scalar
  }
  return sawTargets && Object.keys(targets).length > 0 ? targets : undefined
}

/**
 * The deploy manifest a task space declares, preferred root first - the same
 * two shapes the state files are found by.
 * @param taskPath - the task space directory.
 * @returns the manifest with its directory and targets, undefined when none exists,
 *   or a broken-marker when one exists but cannot be trusted.
 */
export async function readDeployManifest(taskPath) {
  const entries = await readdir(taskPath, { withFileTypes: true }).catch(() => [])
  const candidates = [join(taskPath, 'deploy')]
  for (const entry of entries) {
    if (entry.isDirectory()) candidates.push(join(taskPath, entry.name, 'deploy'))
  }
  for (const dir of candidates) {
    const file = join(dir, MANIFEST_NAME)
    if (!existsSync(file)) continue
    const text = await readFile(file, 'utf8').catch(() => undefined)
    if (text === undefined) return { broken: true, dir, targets: undefined }
    const targets = parseManifestTargets(text)
    if (targets === undefined) return { broken: true, dir, targets: undefined }
    return { broken: false, dir, targets }
  }
  return undefined
}

/**
 * Resolve the manifest entry a policy target deploys through.
 *
 * No manifest at all means the space predates manifests and deploys docker the
 * L0 way - answered as `null`, which callers translate into the deploy-script
 * path. A manifest that exists but lacks the policy's target is the refusal the
 * policy promised: a target it does not offer is never silently swapped for
 * another one.
 * @param manifest - what {@link readDeployManifest} found.
 * @param target - the delivery policy's deploy target.
 * @param field - which command is being asked for (`up`, `smoke`, `destroy`).
 * @returns the target's entry, `null` for the no-manifest docker default.
 * @throws Error carrying E5009 or E5010 when the target is not offered or the
 *   manifest cannot be trusted.
 */
function manifestEntryFor(manifest, target, field) {
  if (target === 'none') {
    throw coded('E5009', 'the delivery policy deploys nothing (target none), so there is no manifest entry to serve; this action should not have been reachable')
  }
  if (manifest === undefined) return target === 'docker' ? null : undefined
  if (manifest.broken) throw coded('E5010', `the deploy manifest exists but cannot be parsed, so no target can be trusted; fix or remove ${MANIFEST_NAME}`)
  const entry = manifest.targets[target]
  if (entry === undefined || entry === null || typeof entry !== 'object') {
    throw coded('E5009', `the manifest offers no '${target}' target (its targets: ${Object.keys(manifest.targets).join(', ') || 'none'}); the delivery policy cannot be served by swapping in another`)
  }
  if (field !== undefined && typeof entry[field] !== 'string' || field !== undefined && entry[field] === '') {
    throw coded('E5009', `the manifest's '${target}' target names no '${field}' command`)
  }
  return entry
}

/** Run one manifest command, with the environment id the handshake passes by variable. */
async function runManifestCommand(subprocess, command, dir, envId) {
  return runProcess(subprocess, ['bash', '-c', `DSH_ENV_ID='${envId}' ${command}`], {
    cwd: dir,
    maxBytes: 2 * 1024 * 1024,
  })
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
  const policy = deliveryPolicyOf(recorded)
  const manifest = await readDeployManifest(taskPath)
  const entry = manifestEntryFor(manifest, policy.deploy.target, 'smoke')
  let out
  if (entry === null) {
    // No manifest: docker deploys the L0 way, through the script's own subcommand.
    const found = await findDeployScript(taskPath)
    if (found === undefined) {
      throw coded('E5008', `no deploy/deploy.sh exists in this task space, so there is nothing to smoke: ${taskPath}`)
    }
    try {
      out = await runProcess(subprocess, ['bash', found.script, 'smoke', ...(envId === '' ? [] : [envId])], {
        cwd: found.dir,
        maxBytes: 2 * 1024 * 1024,
      })
    } catch (error) {
      throw coded('E5008', `the deploy script could not be started (${error.message}); bash must be on the PATH the server runs with`)
    }
  } else {
    out = await runManifestCommand(subprocess, entry.smoke, manifest.dir, envId)
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
  const policy = deliveryPolicyOf(recorded)
  const manifest = await readDeployManifest(taskPath)
  const entry = manifestEntryFor(manifest, policy.deploy.target, 'up')
  let out
  if (entry === null) {
    // No manifest: docker deploys the L0 way, through the script's own subcommand.
    const found = await findDeployScript(taskPath)
    if (found === undefined) {
      throw coded('E5008', `no deploy/deploy.sh exists in this task space, so there is nothing to deploy: ${taskPath}`)
    }
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
  } else {
    out = await runManifestCommand(subprocess, entry.up, manifest.dir, envId)
    if (!out.ok) {
      throw coded('E5008', `the manifest's up command failed with exit code ${out.exitCode}:\n${outputTail(out.stderr, out.stdout)}`)
    }
  }
  return {
    output: outputTail(out.stdout),
    status: await deploymentStatus(subprocess, taskPath),
  }
}

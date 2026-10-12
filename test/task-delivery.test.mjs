/**
 * The delivery policy and the deployment side of it.
 *
 * The policy is one answer - does this task expect a deployment whose smoke has to
 * pass before the work may land - recorded once and read everywhere, so the tests
 * here are mostly about the two moods: a policy stated at create time refuses to be
 * ambiguous, and the same policy read back from an old record substitutes the
 * default instead. The gate is tested against a real state file on a real temporary
 * task space, because its whole job is reading exactly that file.
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyStraysPolicy,
  DEFAULT_DELIVERY_POLICY,
  coerceDeliveryPolicy,
  deliveryPolicyOf,
  normalizeDeliveryPolicy,
  resolveDeliveryPolicy,
} from '../src/host/task/delivery.js'
import { deployEnvironment, deploymentStatus, destroyDeployment, assertDeliveryGate } from '../src/host/task/deploy.js'
import { PLUGIN_ROOT, taskMetadata } from '../src/host/task/shared.js'

const STATE = {
  envId: 'dsh-public-login',
  url: 'http://localhost:51555',
  lastSmoke: { at: '2026-10-05T00:00:00Z', result: 'pass' },
  services: [],
}

/** A task space directory carrying a metadata record and, when asked, a deploy root's state file. */
async function taskFixture({ state, metadataDelivery } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-delivery-'))
  const metadata = {
    version: 1,
    task: 'login',
    project: 'public',
    branch: 'task/login',
    deploymentEnvId: 'dsh-public-login',
    ...(metadataDelivery === undefined ? {} : { delivery: metadataDelivery }),
    repositories: [],
  }
  // The record and the deploy root both live in the plugin's own directory, which is the
  // layout every reader and writer here agrees on.
  await mkdir(join(root, PLUGIN_ROOT), { recursive: true })
  await writeFile(join(root, PLUGIN_ROOT, 'worktree-space.json'), JSON.stringify(metadata), 'utf8')
  if (state !== undefined) {
    await mkdir(join(root, PLUGIN_ROOT, 'deploy'), { recursive: true })
    await writeFile(join(root, PLUGIN_ROOT, 'deploy', '.state.json'), JSON.stringify(state, null, 2), 'utf8')
  }
  return { root, metadata, statePath: join(root, PLUGIN_ROOT, 'deploy', '.state.json') }
}

describe('delivery policy', () => {
  it('defaults to a delivery that turns nothing on', () => {
    expect(DEFAULT_DELIVERY_POLICY.deploy.target).toBe('none')
    expect(normalizeDeliveryPolicy(undefined)).toEqual(DEFAULT_DELIVERY_POLICY)
    // One field, and a partial policy is completed rather than rejected: the caller
    // says only what it cares about, and there is nothing else left to say.
    expect(normalizeDeliveryPolicy({ deploy: { target: 'docker' } })).toEqual({
      version: 1,
      deploy: { target: 'docker' },
    })
  })

  it('refuses a target that is not one of the allowed ones, at create time', () => {
    expect(() => normalizeDeliveryPolicy({ deploy: { target: 'kubernetes' } })).toThrow(/deploy\.target/)
    expect(() => normalizeDeliveryPolicy({ deploy: { target: 'kubernetes' } })).toThrow(expect.objectContaining({ code: 'E4010' }))
    // `host` was a target once. It is refused here rather than quietly read back,
    // because a create that names a target this plugin cannot observe is a create
    // whose deployment could never be diagnosed; the lenient read below is where a
    // record that already says `host` gets its fallback.
    expect(() => normalizeDeliveryPolicy({ deploy: { target: 'host' } })).toThrow(/deploy\.target/)
    expect(normalizeDeliveryPolicy({ deploy: { target: 'none' } }).deploy.target).toBe('none')
    // A field the schema no longer has is not a value to validate: the request is
    // read as the one answer it does carry, and everything else is dropped.
    expect(normalizeDeliveryPolicy({ verification: 'vibes', deploy: { target: 'docker' } })).toEqual({
      version: 1,
      deploy: { target: 'docker' },
    })
  })

  it('substitutes the default when the record is read back', () => {
    // A record from before the schema shrank still reads: every field that no longer
    // exists is dropped, and a value this side can no longer serve falls back to the
    // default. For the removed `host` target that means the gate is dropped rather
    // than invented, which is the safe direction for a target nothing can serve.
    const old = coerceDeliveryPolicy({ deploy: { target: 'host', mode: 'auto' }, verification: 'agent', merge: { mode: 'auto' } })
    expect(old).toEqual(DEFAULT_DELIVERY_POLICY)
    expect(coerceDeliveryPolicy({ deploy: { target: 'docker' } })).toEqual({ version: 1, deploy: { target: 'docker' } })
    // And a policy read off the record is what the gate reads, whatever the record's age.
    expect(deliveryPolicyOf({ delivery: { deploy: { target: 'docker' } } }).deploy.target).toBe('docker')
    expect(deliveryPolicyOf(undefined)).toEqual(DEFAULT_DELIVERY_POLICY)
  })

  it('resolves from the request alone, then the built-in default', () => {
    // The request's own policy is taken whole. There is no stored per-project layer
    // between it and the default any more, so nothing else can complete it or
    // contradict it - what a create states is what the finish later reads.
    expect(resolveDeliveryPolicy({ deploy: { target: 'docker' } }).deploy.target).toBe('docker')
    expect(resolveDeliveryPolicy(undefined)).toEqual(DEFAULT_DELIVERY_POLICY)
    expect(resolveDeliveryPolicy(null)).toEqual(DEFAULT_DELIVERY_POLICY)
    // A request that cannot be stated unambiguously still refuses the create.
    expect(() => resolveDeliveryPolicy({ deploy: { target: 'kubernetes' } })).toThrow(/deploy\.target/)
  })
})

describe('the delivery gate', () => {
  it('stands open when the policy deploys nothing, whatever the state says', async () => {
    const { root } = await taskFixture({ metadataDelivery: { deploy: { target: 'none' } } })
    await expect(assertDeliveryGate({ delivery: { deploy: { target: 'none' } } }, root, { merge: true })).resolves.toBeUndefined()
  })

  it('refuses a merge with no deployment recorded, under the same code as a failed smoke', async () => {
    // One code for both shapes of "no passing smoke": the state file was never written, or
    // it was and the smoke is missing or red. They used to be E5005 and E5006, which read as
    // two different problems - they are not, because the next step is the same either way.
    const { root } = await taskFixture({ metadataDelivery: { deploy: { target: 'docker' } } })
    await expect(assertDeliveryGate({ delivery: { deploy: { target: 'docker' } } }, root, { merge: true }))
      .rejects.toMatchObject({ code: 'E5006' })
  })

  it('refuses a merge whose smoke is not green', async () => {
    // The smoke is the whole of the gate now, so E5006 names it and nothing else:
    // there is no second debt a policy can record, and no third refusal left for a
    // request to fail on.
    const { root } = await taskFixture({
      metadataDelivery: { deploy: { target: 'docker' } },
      state: { ...STATE, lastSmoke: { at: '2026-10-05T00:00:00Z', result: 'fail' } },
    })
    await expect(assertDeliveryGate({ delivery: { deploy: { target: 'docker' } } }, root, { merge: true }))
      .rejects.toMatchObject({ code: 'E5006' })
  })

  it('lets a deploying task merge on a green smoke alone, and skips the gate without a merge', async () => {
    const { root } = await taskFixture({ metadataDelivery: { deploy: { target: 'docker' } }, state: STATE })
    await expect(assertDeliveryGate({ delivery: { deploy: { target: 'docker' } } }, root, { merge: true })).resolves.toBeUndefined()
    await expect(assertDeliveryGate({ delivery: { deploy: { target: 'docker' } } }, root, { merge: false })).resolves.toBeUndefined()
  })

  it('yields to the user\'s own overrule, as a warning rather than a refusal', async () => {
    // The panel asks "finish anyway?" and the user says yes: the gate steps aside,
    // and what it hands back is the warning the finish records, never silence. It
    // carries the sentence the Host writes for its log and the keys a screen needs to
    // say the same thing in the reader's own language.
    const { root } = await taskFixture({
      metadataDelivery: { deploy: { target: 'docker' } },
      state: { ...STATE, lastSmoke: { at: '2026-10-05T00:00:00Z', result: 'fail' } },
    })
    const warning = await assertDeliveryGate({ delivery: { deploy: { target: 'docker' } } }, root, { merge: true, bypass: true })
    expect(warning.code).toBe('delivery-gate-bypassed')
    expect(warning.message).toContain('passing smoke')
    expect(warning.values).toEqual({ missing: ['smoke'] })
    // Without the overrule the same request is still refused - the bypass is the
    // user's say-so, not a hole the gate forgot it had.
    await expect(assertDeliveryGate({ delivery: { deploy: { target: 'docker' } } }, root, { merge: true }))
      .rejects.toMatchObject({ code: 'E5006' })

    // The other shape of the same refusal - no state file at all - is overruled the same
    // way, and its warning names both facts a missing file leaves unrecorded: there was no
    // deployment and therefore no smoke.
    const bare = await taskFixture({ metadataDelivery: { deploy: { target: 'docker' } } })
    const none = await assertDeliveryGate({ delivery: { deploy: { target: 'docker' } } }, bare.root, { merge: true, bypass: true })
    expect(none.code).toBe('delivery-gate-bypassed')
    expect(none.values).toEqual({ missing: ['deployment', 'smoke'] })
  })
})

describe('deployment state reads and writes', () => {
  it('answers the status live: state file for the facts, docker for the containers', async () => {
    const { root } = await taskFixture({ metadataDelivery: { deploy: { target: 'docker' } }, state: STATE })
    const calls = []
    const subprocess = { spawn({ argv }) {
      calls.push(argv)
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: { stdout: { readFrom: () => ({ text: 'gw-1\trunning\nweb-1\trunning' }) }, stderr: { readFrom: () => ({ text: '' }) } },
      }
    } }
    const status = await deploymentStatus(subprocess, root)
    expect(status.envId).toBe('dsh-public-login')
    expect(status.url).toBe(STATE.url)
    expect(status.lastSmoke).toEqual(STATE.lastSmoke)
    expect(status.containers).toEqual([{ name: 'gw-1', state: 'running' }, { name: 'web-1', state: 'running' }])
    expect(calls[0].join(' ')).toContain('dsh.env-id=dsh-public-login')
    // What the record's policy says is the one manifest-like fact left; the
    // manifest's own answers - a target list, an autoAllowed flag, a verification
    // mode and a human ack - are gone from this shape entirely.
    expect(status.target).toBe('docker')
    expect(status.targets).toBeUndefined()
    expect(status.autoAllowed).toBeUndefined()
    expect(status.verification).toBeUndefined()
    expect(status.humanAck).toBeUndefined()
  })

  it('tears the environment down through compose, keeping the acceptance facts', async () => {
    const { root, statePath } = await taskFixture({ state: STATE })
    const calls = []
    const subprocess = { spawn({ argv }) {
      calls.push(argv.join(' '))
      // inspect answers the compose file and directory the containers carry; the
      // second `ps -a -q` runs after the down and answers empty.
      const text = argv.includes('inspect')
        ? 'E:\\space\\deploy\\docker-compose.yml\tE:\\space\\deploy'
        : (argv.includes('down') || (argv[1] === 'ps' && calls.length > 2)) ? '' : 'abc123'
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
      }
    } }
    const outcome = await destroyDeployment(subprocess, root, 'dsh-public-login')
    expect(outcome.removed).toBe(true)
    expect(calls.some((line) => line.includes('compose') && line.includes('down'))).toBe(true)
    // The facts outlive the containers: the smoke stays, only the URL dies with the
    // dynamic port, and the down-stamp says the environment is gone.
    const kept = JSON.parse(await readFile(statePath, 'utf8'))
    expect(kept.lastSmoke).toEqual(STATE.lastSmoke)
    expect(kept.url).toBeNull()
    expect(typeof kept.destroyedAt).toBe('string')
  })

  it('rebuilds the environment through the task space\'s own deploy script', async () => {
    const { root } = await taskFixture({ metadataDelivery: { deploy: { target: 'docker' } }, state: { ...STATE, url: null, destroyedAt: '2026-10-06T00:00:00Z' } })
    await mkdir(join(root, PLUGIN_ROOT, 'deploy'), { recursive: true })
    await writeFile(join(root, PLUGIN_ROOT, 'deploy', 'deploy.sh'), 'echo up "$@"\n', 'utf8')
    const calls = []
    const subprocess = { spawn({ argv }) {
      calls.push(argv.join(' '))
      const text = argv[1] === 'ps'
        ? 'gw-1\trunning'
        : argv[0] === 'bash' ? 'up dsh-public-login\nacceptance http://localhost:51666' : ''
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
      }
    } }
    const outcome = await deployEnvironment(subprocess, root)
    // The task's own script, with the record's environment id, so the rebuilt
    // environment lands under the same name and label.
    expect(calls.some((line) => line.includes('deploy.sh up dsh-public-login'))).toBe(true)
    expect(outcome.output).toContain('up dsh-public-login')
    expect(outcome.status.containers).toEqual([{ name: 'gw-1', state: 'running' }])
  })

  it('refuses to rebuild when the space carries no deploy script', async () => {
    const { root } = await taskFixture({ metadataDelivery: { deploy: { target: 'docker' } } })
    const subprocess = { spawn: vi.fn() }
    await expect(deployEnvironment(subprocess, root)).rejects.toMatchObject({ code: 'E5008' })
    expect(subprocess.spawn).not.toHaveBeenCalled()
  })

  it('falls back to removing the containers when compose will not run', async () => {
    const { root } = await taskFixture({ state: STATE })
    const calls = []
    let cleared = false
    const subprocess = { spawn({ argv }) {
      calls.push(argv.join(' '))
      // compose fails outright; the rm that follows is what clears the containers.
      if (argv.includes('rm')) cleared = true
      let text = ''
      if (argv.includes('inspect')) text = 'E:\\space\\deploy\\docker-compose.yml\tE:\\space\\deploy'
      else if (argv.includes('-q')) text = cleared ? '' : 'abc123'
      return {
        done: Promise.resolve({ exitCode: argv.includes('compose') ? 1 : 0, signal: null }),
        collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
      }
    } }
    const outcome = await destroyDeployment(subprocess, root, 'dsh-public-login')
    expect(calls.some((line) => line.includes(' rm -f abc123'))).toBe(true)
    expect(outcome.removed).toBe(true)
  })

  it('tears down containers a nothing-policy space still carries, through the label path', async () => {
    // `target: none` says no deployment was wanted, but a space can hold containers from a deploy
    // made outside this flow, and refusing to take those down is the one answer that leaves the
    // user stuck with them. Teardown is docker-only now - there is no per-target branch left that
    // could be reached instead - so it goes through the label path, which finds them.
    const { root } = await taskFixture({ metadataDelivery: { deploy: { target: 'none' } } })
    const calls = []
    const subprocess = { spawn({ argv }) {
      calls.push(argv.join(' '))
      let text = ''
      if (argv.includes('-q')) text = 'abc123'
      else if (argv.includes('inspect')) text = 'E:\\space\\deploy\\docker-compose.yml\tE:\\space\\deploy'
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
      }
    } }
    const outcome = await destroyDeployment(subprocess, root, 'dsh-public-login')
    expect(calls.some((line) => line.includes('compose'))).toBe(true)
    expect(calls.every((line) => !line.includes('deploy.sh'))).toBe(true)
    expect(outcome.removed).toBe(true)
  })

  it('answers quietly when there is nothing to tear down', async () => {
    const { root } = await taskFixture({})
    const subprocess = { spawn: vi.fn(() => { throw new Error('docker not found') }) }
    const outcome = await destroyDeployment(subprocess, root, 'dsh-public-login')
    expect(outcome).toEqual({ removed: false, containers: 0 })
  })
})

describe('task metadata carries the policy', () => {
  it('records the policy completed to the defaults, and the env id beside it', () => {
    const metadata = taskMetadata({
      task: 'login',
      project: 'public',
      tasksRoot: 'E:\\worktree-space',
      sourceRoot: 'E:\\workspace\\public',
      branch: 'task/login',
      repositories: [{ name: 'alpha', sourcePath: 'E:\\workspace\\public\\alpha' }],
      delivery: { deploy: { target: 'docker', mode: 'auto' } },
    })
    expect(metadata.deploymentEnvId).toBe('dsh-public-login')
    // One field, and the record says exactly that: `mode` is not carried over from
    // the request, because there is no longer a field for it to land in.
    expect(metadata.delivery).toEqual({ version: 1, deploy: { target: 'docker' } })
  })
})

describe('applyStraysPolicy', () => {
  const ARCHIVE = { strategy: 'container', directory: '' }
  // Forward slashes: the splitter accepts either, and the escape-free form keeps
  // the value readable - the production paths arrive with backslashes, same shape.
  const TASK = 'D:/space/worktree-space/proj/login'

  it('archives content away and clears output when the caller said nothing', () => {
    const r = applyStraysPolicy({}, ARCHIVE, TASK)
    expect(r.cleanStray).toBe(true)
    expect(r.discardDocuments).toBe(false)
    expect(r.documentsDirectory).toContain('archived-docs')
    expect(r.documentsDirectory).toContain('proj')
    expect(r.documentsDirectory).toContain('login-')
    // The stamp is the audit-log clock with a dash between date and time.
    expect(r.documentsDirectory).toMatch(/login-\d{8}-\d{6}$/)
    // The keep-list is always an array, so a caller never has to test for one.
    expect(r.keep).toEqual([])
  })

  it('keeps the entries the caller named, whatever the choice says', () => {
    const r = applyStraysPolicy({ strays: 'archive', keepEntries: ['notes.md', 'scratch/'] }, ARCHIVE, TASK)
    expect(r.keep).toEqual(['notes.md', 'scratch/'])
    // Naming entries to keep does not turn the archive off: the choice is still the
    // caller's `archive`, and the entries are an exception carved out of it.
    expect(r.cleanStray).toBe(true)
    expect(r.documentsDirectory).toContain('archived-docs')
  })

  it('keeps the shipped behaviour under keep: the choice declines to speak', () => {
    const r = applyStraysPolicy({ strays: 'keep' }, ARCHIVE, TASK)
    expect(r.cleanStray).toBe(false)
    expect(r.discardDocuments).toBe(false)
    expect(r.documentsDirectory).toBe('')
  })

  it('deletes only when the caller itself asked for discard', () => {
    // Deleting is reachable from here now, which it deliberately was not while this
    // was a policy recorded at create time: a standing answer that deletes the user's
    // files is one nobody can take back, whereas this call is made with the content
    // in front of the caller. An omitted or unknown choice never reaches it.
    const r = applyStraysPolicy({ strays: 'discard' }, ARCHIVE, TASK)
    expect(r.cleanStray).toBe(true)
    expect(r.discardDocuments).toBe(true)
    expect(r.documentsDirectory).toBe('')
    // A value the flow does not have falls back to archive - the answer that loses
    // nothing - rather than being obeyed or refused.
    const unknown = applyStraysPolicy({ strays: 'obliterate' }, ARCHIVE, TASK)
    expect(unknown.discardDocuments).toBe(false)
    expect(unknown.cleanStray).toBe(true)
    expect(unknown.documentsDirectory).toContain('archived-docs')
  })

  it('takes the caller\'s own directory over the archive root, and the custom root otherwise', () => {
    const named = applyStraysPolicy({ strays: 'archive', documentsDirectory: 'E:\\docs' }, ARCHIVE, TASK)
    expect(named.documentsDirectory.startsWith('E:\\docs')).toBe(true)
    const custom = applyStraysPolicy({ strays: 'archive' }, { strategy: 'custom', directory: 'D:\\docs' }, TASK)
    expect(custom.documentsDirectory.startsWith('D:\\docs')).toBe(true)
  })
})

/**
 * The delivery policy and the deployment side of it.
 *
 * The policy is three answers - does this task deploy, who verifies, how it merges -
 * recorded once and read everywhere, so the tests here are mostly about the two
 * moods: a policy stated at create time refuses to be ambiguous, and the same policy
 * read back from an old record substitutes defaults instead. The gate is tested
 * against a real state file on a real temporary task space, because its whole job is
 * reading exactly that file.
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
import { ackAcceptance, deployEnvironment, deploymentStatus, destroyDeployment, parseManifestTargets, readDeployManifest, assertDeliveryGate } from '../src/host/task/deploy.js'
import { taskMetadata } from '../src/host/task/shared.js'

const STATE = {
  envId: 'dsh-public-login',
  url: 'http://localhost:51555',
  lastSmoke: { at: '2026-10-05T00:00:00Z', result: 'pass' },
  humanAck: null,
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
  await writeFile(join(root, 'worktree-space.json'), JSON.stringify(metadata), 'utf8')
  if (state !== undefined) {
    await mkdir(join(root, 'deploy'), { recursive: true })
    await writeFile(join(root, 'deploy', '.state.json'), JSON.stringify(state, null, 2), 'utf8')
  }
  return { root, metadata, statePath: join(root, 'deploy', '.state.json') }
}

describe('delivery policy', () => {
  it('defaults to a delivery that turns nothing on', () => {
    expect(DEFAULT_DELIVERY_POLICY.deploy.target).toBe('none')
    expect(normalizeDeliveryPolicy(undefined)).toEqual(DEFAULT_DELIVERY_POLICY)
    // A partial policy is completed per field, not rejected: the caller says only
    // what it cares about, the rest is the standing default.
    expect(normalizeDeliveryPolicy({ deploy: { target: 'docker' } })).toEqual({
      ...DEFAULT_DELIVERY_POLICY,
      deploy: { target: 'docker', mode: 'on-request' },
    })
  })

  it('refuses a value that is not one of the allowed ones, at create time', () => {
    expect(() => normalizeDeliveryPolicy({ deploy: { target: 'kubernetes' } })).toThrow(/deploy\.target/)
    expect(() => normalizeDeliveryPolicy({ verification: 'vibes' })).toThrow(/verification/)
  })

  it('substitutes defaults per field when the record is read back', () => {
    const policy = coerceDeliveryPolicy({ deploy: { target: 'docker', mode: 'sometimes' }, merge: { mode: 'auto' } })
    expect(policy.deploy).toEqual({ target: 'docker', mode: 'on-request' })
    expect(policy.merge).toEqual({ mode: 'auto', target: null, deleteBranch: true })
    expect(policy.verification).toBe(DEFAULT_DELIVERY_POLICY.verification)
    // And a policy read off the record is what the gate reads, whatever the record's age.
    expect(deliveryPolicyOf({ delivery: policy })).toEqual(policy)
    expect(deliveryPolicyOf(undefined)).toEqual(DEFAULT_DELIVERY_POLICY)
  })

  it('resolves from the request first, then the project default, then none', () => {
    const defaults = { public: { deploy: { target: 'docker', mode: 'auto' }, merge: { mode: 'auto' } } }
    const explicit = { verification: 'agent' }
    // The request's own policy wins whole; it is not merged with the stored one.
    expect(resolveDeliveryPolicy('public', explicit, defaults).verification).toBe('agent')
    expect(resolveDeliveryPolicy('public', explicit, defaults).deploy.target).toBe('none')
    // The project default is the standing answer, completed to the defaults.
    expect(resolveDeliveryPolicy('public', undefined, defaults).deploy.target).toBe('docker')
    expect(resolveDeliveryPolicy('public', undefined, defaults).merge.mode).toBe('auto')
    // Another project, and an unknown one, stay on the built-in default.
    expect(resolveDeliveryPolicy('other', undefined, defaults).deploy.target).toBe('none')
    // A stored default that is wrong refuses the create exactly as an explicit one would.
    expect(() => resolveDeliveryPolicy('broken', undefined, { broken: { deploy: { target: 'kubernetes' } } })).toThrow(/deploy\.target/)
  })
})

describe('the delivery gate', () => {
  it('stands open when the policy deploys nothing, whatever the state says', async () => {
    const { root } = await taskFixture({ metadataDelivery: { deploy: { target: 'none' } } })
    await expect(assertDeliveryGate({ delivery: { deploy: { target: 'none' } } }, root, { merge: true })).resolves.toBeUndefined()
  })

  it('refuses a merge with no deployment recorded when the policy expects one', async () => {
    const { root } = await taskFixture({ metadataDelivery: { deploy: { target: 'docker' } } })
    await expect(assertDeliveryGate({ delivery: { deploy: { target: 'docker' } } }, root, { merge: true }))
      .rejects.toMatchObject({ code: 'E5005' })
  })

  it('refuses a merge whose smoke is not green', async () => {
    // An agent-only policy owes nothing to a human, so a failed smoke is the one
    // refusal: E5006 names the smoke alone. (Under agent-then-human both debts
    // are named together, as E5007 - the test below covers that.)
    const { root } = await taskFixture({
      metadataDelivery: { deploy: { target: 'docker' }, verification: 'agent' },
      state: { ...STATE, lastSmoke: { at: '2026-10-05T00:00:00Z', result: 'fail' } },
    })
    await expect(assertDeliveryGate({ delivery: { deploy: { target: 'docker' }, verification: 'agent' } }, root, { merge: true }))
      .rejects.toMatchObject({ code: 'E5006' })
  })

  it('names every unmet obligation together under agent-then-human', async () => {
    const { root } = await taskFixture({
      metadataDelivery: { deploy: { target: 'docker' } },
      state: { ...STATE, lastSmoke: { at: '2026-10-05T00:00:00Z', result: 'fail' } },
    })
    await expect(assertDeliveryGate({ delivery: { deploy: { target: 'docker' } } }, root, { merge: true }))
      .rejects.toMatchObject({ code: 'E5007' })
  })

  it('waits for the human ack under agent-then-human, and passes once it is given', async () => {
    const { root } = await taskFixture({ metadataDelivery: { deploy: { target: 'docker' } }, state: STATE })
    await expect(assertDeliveryGate({ delivery: { deploy: { target: 'docker' } } }, root, { merge: true }))
      .rejects.toMatchObject({ code: 'E5007' })

    const acked = await taskFixture({
      metadataDelivery: { deploy: { target: 'docker' } },
      state: { ...STATE, humanAck: { at: '2026-10-05T01:00:00Z', by: 'user' } },
    })
    await expect(assertDeliveryGate({ delivery: { deploy: { target: 'docker' } } }, acked.root, { merge: true })).resolves.toBeUndefined()
  })

  it('lets an agent-only policy merge on a green smoke alone, and skips the gate without a merge', async () => {
    const { root } = await taskFixture({ metadataDelivery: { deploy: { target: 'docker' }, verification: 'agent' }, state: STATE })
    await expect(assertDeliveryGate({ delivery: { deploy: { target: 'docker' }, verification: 'agent' } }, root, { merge: true })).resolves.toBeUndefined()
    await expect(assertDeliveryGate({ delivery: { deploy: { target: 'docker' } } }, root, { merge: false })).resolves.toBeUndefined()
  })

  it('yields to the user\'s own overrule, as a warning rather than a refusal', async () => {
    // The panel asks "finish anyway?" and the user says yes: the gate steps aside,
    // and what it hands back is the sentence the finish records, never silence.
    const { root } = await taskFixture({ metadataDelivery: { deploy: { target: 'docker' } }, state: STATE })
    const warning = await assertDeliveryGate({ delivery: { deploy: { target: 'docker' } } }, root, { merge: true, bypass: true })
    expect(warning).toContain('human acceptance ack')
    // Without the overrule the same request is still refused - the bypass is the
    // user's say-so, not a hole the gate forgot it had.
    await expect(assertDeliveryGate({ delivery: { deploy: { target: 'docker' } } }, root, { merge: true }))
      .rejects.toMatchObject({ code: 'E5007' })
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
  })

  it('writes the human ack onto the state file the deploy owns', async () => {
    const { root, statePath } = await taskFixture({ state: STATE })
    const result = await ackAcceptance(root)
    expect(result.humanAck.by).toBe('user')
    const written = JSON.parse(await readFile(statePath, 'utf8'))
    expect(written.humanAck.at).toBe(result.humanAck.at)
    // Everything the deploy wrote stays: the ack is appended to the same record.
    expect(written.lastSmoke).toEqual(STATE.lastSmoke)
    await expect(ackAcceptance(await mkdtemp(join(tmpdir(), 'dsh-empty-')))).rejects.toMatchObject({ code: 'E5005' })
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
    // The facts outlive the containers: the smoke and the ack stay, only the URL
    // dies with the dynamic port, and the down-stamp says the environment is gone.
    const kept = JSON.parse(await readFile(statePath, 'utf8'))
    expect(kept.lastSmoke).toEqual(STATE.lastSmoke)
    expect(kept.url).toBeNull()
    expect(typeof kept.destroyedAt).toBe('string')
  })

  it('rebuilds the environment through the task space\'s own deploy script', async () => {
    const { root } = await taskFixture({ metadataDelivery: { deploy: { target: 'docker' } }, state: { ...STATE, url: null, destroyedAt: '2026-10-06T00:00:00Z' } })
    await mkdir(join(root, 'deploy'), { recursive: true })
    await writeFile(join(root, 'deploy', 'deploy.sh'), 'echo up "$@"\n', 'utf8')
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
    expect(metadata.delivery.deploy).toEqual({ target: 'docker', mode: 'auto' })
    expect(metadata.delivery.verification).toBe(DEFAULT_DELIVERY_POLICY.verification)
  })
})

describe('applyStraysPolicy', () => {
  const ARCHIVE = { strategy: 'container', directory: '' }
  // Forward slashes: the splitter accepts either, and the escape-free form keeps
  // the value readable - the production paths arrive with backslashes, same shape.
  const TASK = 'D:/space/worktree-space/proj/login'

  it('archive files content away and clears output when the caller said nothing', () => {
    const r = applyStraysPolicy({ strays: 'archive' }, {}, ARCHIVE, TASK)
    expect(r.cleanStray).toBe(true)
    expect(r.discardDocuments).toBe(false)
    expect(r.documentsDirectory).toContain('archived-docs')
    expect(r.documentsDirectory).toContain('proj')
    expect(r.documentsDirectory).toContain('login-')
    // The stamp is the audit-log clock with a dash between date and time.
    expect(r.documentsDirectory).toMatch(/login-\d{8}-\d{6}$/)
  })

  it('honours a caller that decided anything itself, verbatim', () => {
    const r = applyStraysPolicy({ strays: 'archive' }, { cleanStray: true }, ARCHIVE, TASK)
    expect(r.cleanStray).toBe(true)
    expect(r.documentsDirectory).toBe('')
    // keep-list counts as a decision too
    const kept = applyStraysPolicy({ strays: 'archive' }, { keep: ['notes.md'] }, ARCHIVE, TASK)
    expect(kept.cleanStray).toBe(false)
  })

  it('keeps the shipped behaviour under keep, and never discards without force', () => {
    const r = applyStraysPolicy({ strays: 'keep' }, {}, ARCHIVE, TASK)
    expect(r.cleanStray).toBe(false)
    const d = applyStraysPolicy({ strays: 'discard' }, { force: false }, ARCHIVE, TASK)
    expect(d.cleanStray).toBe(false)
    expect(d.discardDocuments).toBe(false)
  })

  it('discard only honours the abandon path, where force already said so', () => {
    const r = applyStraysPolicy({ strays: 'discard' }, { force: true }, ARCHIVE, TASK)
    expect(r.cleanStray).toBe(true)
    expect(r.discardDocuments).toBe(true)
    expect(r.documentsDirectory).toBe('')
  })

  it('roots the archive under a custom directory when the configuration names one', () => {
    const r = applyStraysPolicy({ strays: 'archive' }, {}, { strategy: 'custom', directory: 'D:\docs' }, TASK)
    expect(r.documentsDirectory.startsWith('D:\docs')).toBe(true)
  })
})

describe('the deploy manifest', () => {
  const DOC = [
    'targets:',
    '  docker:',
    '    up: ./deploy.sh up',
    '    smoke: ./deploy.sh smoke',
    '    destroy: ./deploy.sh destroy',
    '  host:',
    '    up: make run',
    '    smoke: make check',
    '    destroy: make stop',
    '    autoAllowed: true',
  ].join('\n')

  it('parses the documented two-level structure with scalars and booleans', () => {
    const t = parseManifestTargets(DOC)
    expect(t.docker.up).toBe('./deploy.sh up')
    expect(t.docker.destroy).toBe('./deploy.sh destroy')
    expect(t.host.autoAllowed).toBe(true)
    expect(t.host.up).toBe('make run')
  })

  it('answers a document outside the contract as untrusted, never half-interpreted', () => {
    expect(parseManifestTargets('version: 2\ntargets:')).toBeUndefined()
    expect(parseManifestTargets('targets: {}')).toBeUndefined()
    expect(parseManifestTargets('')).toBeUndefined()
  })

  it('finds the manifest by the same two shapes the state files use', async () => {
    const { root } = await taskFixture({})
    expect(await readDeployManifest(root)).toBeUndefined()
    await mkdir(join(root, 'deploy'), { recursive: true })
    await writeFile(join(root, 'deploy', 'deploy.yaml'), DOC, 'utf8')
    const m = await readDeployManifest(root)
    expect(m.broken).toBe(false)
    expect(Object.keys(m.targets).sort()).toEqual(['docker', 'host'])
  })

  it('refuses to deploy through a target the manifest does not offer', async () => {
    // The manifest offers docker only; a policy pointing at host must be refused,
    // never silently swapped to the target the manifest does have.
    const { root } = await taskFixture({ metadataDelivery: { deploy: { target: 'host' } } })
    await mkdir(join(root, 'deploy'), { recursive: true })
    await writeFile(join(root, 'deploy', 'deploy.yaml'), 'targets:\n  docker:\n    up: x\n', 'utf8')
    await expect(deployEnvironment({ spawn: vi.fn() }, root)).rejects.toMatchObject({ code: 'E5009' })
  })

  it('marks a broken manifest as untrusted rather than half-interpreted', async () => {
    const { root } = await taskFixture({ metadataDelivery: { deploy: { target: 'docker' } } })
    await mkdir(join(root, 'deploy'), { recursive: true })
    await writeFile(join(root, 'deploy', 'deploy.yaml'), 'targets:\n  [broken', 'utf8')
    await expect(deployEnvironment({ spawn: vi.fn() }, root)).rejects.toMatchObject({ code: 'E5010' })
  })

  it('runs the manifest up command with the environment id passed by variable', async () => {
    const { root } = await taskFixture({ metadataDelivery: { deploy: { target: 'host', mode: 'auto' }, verification: 'agent' } })
    await mkdir(join(root, 'deploy'), { recursive: true })
    await writeFile(join(root, 'deploy', 'deploy.yaml'), 'targets:\n  host:\n    up: make run\n    smoke: make check\n    destroy: make stop\n    autoAllowed: true\n', 'utf8')
    const calls = []
    const subprocess = { spawn({ argv }) {
      calls.push(argv.join(' '))
      const text = argv[1] === 'ps' ? 'host-proc\trunning' : (argv[0] === 'bash' && argv[1] === '-c') ? 'ran make run' : ''
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
      }
    } }
    const out = await deployEnvironment(subprocess, root)
    expect(calls.some((c) => c.includes("DSH_ENV_ID='dsh-public-login'") && c.includes('make run'))).toBe(true)
    expect(out.status.targets).toEqual(['host'])
    expect(out.status.autoAllowed).toBe(true)
  })

  it('reports the targets and the autoAllowed flag in the status', async () => {
    const { root } = await taskFixture({ metadataDelivery: { deploy: { target: 'host', mode: 'auto' } } })
    await mkdir(join(root, 'deploy'), { recursive: true })
    await writeFile(join(root, 'deploy', 'deploy.yaml'), 'targets:\n  host:\n    up: make run\n    smoke: make check\n    destroy: make stop\n', 'utf8')
    const subprocess = { spawn() { return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } } } } }
    const status = await deploymentStatus(subprocess, root)
    expect(status.targets).toEqual(['host'])
    // No autoAllowed in the entry: host stays man-driven by default (D8).
    expect(status.autoAllowed).toBe(false)
  })
})

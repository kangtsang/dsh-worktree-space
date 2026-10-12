// Does the plugin actually hand the script its state-file path, and does a subdirectory
// entry still get the same fixed path? That is the whole point of the change: the user's
// script must not have to work out where the deploy root is.
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deployEnvironment, smokeEnvironment } from '../src/host/task/deploy.js'
import { PLUGIN_ROOT, writeTaskMetadata, taskMetadata } from '../src/host/task/shared.js'

const STATE = { url: 'http://localhost:1', services: ['web'], lastSmoke: { at: '2026-10-05T00:00:00Z', result: 'pass' } }

/** The task space's own deploy root: the plugin's directory, then `deploy`. */
const deployRoot = (dir) => join(dir, PLUGIN_ROOT, 'deploy')

/** A task space with one entry script, at `entry`, plus a passing state file. */
async function taskSpaceWith(entry) {
  const dir = await mkdtemp(join(tmpdir(), 'deploy-env-'))
  await mkdir(deployRoot(dir), { recursive: true })
  // The record's value is relative to the task space's own root - the same relative path the
  // workspace uses, because the deploy root sits at the same place on both sides - so the
  // script is written at exactly the path the entry spells.
  const script = join(dir, ...entry.split('/'))
  await mkdir(join(script, '..'), { recursive: true })
  await writeFile(script, 'echo entry\n', 'utf8')
  await writeFile(join(deployRoot(dir), '.state.json'), `${JSON.stringify(STATE)}\n`, 'utf8')
  await writeTaskMetadata(dir, taskMetadata({
    task: 'login', project: 'public', tasksRoot: join(dir, '..'), sourceRoot: '/repo',
    branch: 'task/login', delivery: { deploy: { target: 'docker' } },
    ...(entry === `${PLUGIN_ROOT}/deploy/deploy.sh` ? {} : { deployScript: entry }),
  }))
  return dir
}

/** A subprocess mock that records the env it was handed. */
function spawnRecorder() {
  const envs = []
  return {
    envs,
    subprocess: {
      spawn({ argv, env }) {
        envs.push({ argv, env })
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } },
        }
      },
    },
  }
}

describe('the deploy scripts are told where their state lives', () => {
  it('passes the fixed state path to `up`, whatever the entry is called', async () => {
    const dir = await taskSpaceWith(`${PLUGIN_ROOT}/deploy/deploy.sh`)
    try {
      const { subprocess, envs } = spawnRecorder()
      await deployEnvironment(subprocess, dir)
      expect(envs[0].env.DEPLOY_STATE_FILE).toBe(join(deployRoot(dir), '.state.json'))
      // The environment id still travels, or containers from two tasks would collide.
      expect(envs[0].env.DEPLOY_ENV_ID).toBe('dsh-public-login')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('gives a subdirectory entry the same path as one at the top', async () => {
    // The point of the whole change: the script's depth does not change where the state
    // goes, so nothing in the script has to compute a relative path.
    const top = await taskSpaceWith(`${PLUGIN_ROOT}/deploy/deploy.sh`)
    const deep = await taskSpaceWith(`${PLUGIN_ROOT}/deploy/variants/smoke-a.sh`)
    try {
      const a = spawnRecorder()
      const b = spawnRecorder()
      await deployEnvironment(a.subprocess, top)
      await deployEnvironment(b.subprocess, deep)

      // Same directory name, different task spaces - so compare what the plugin said about
      // each space rather than the absolute paths, which differ by the temp directory.
      expect(a.envs[0].env.DEPLOY_STATE_FILE).toBe(join(deployRoot(top), '.state.json'))
      expect(b.envs[0].env.DEPLOY_STATE_FILE).toBe(join(deployRoot(deep), '.state.json'))
      // Both name the top of `deploy/`, and neither names the script's own directory.
      expect(a.envs[0].env.DEPLOY_STATE_FILE).not.toContain('variants')
      expect(b.envs[0].env.DEPLOY_STATE_FILE).not.toContain('variants')
      // And the deep entry really was the one that ran.
      expect(b.envs[0].argv[1]).toBe(join(deployRoot(deep), 'variants', 'smoke-a.sh'))
    } finally {
      await rm(top, { recursive: true, force: true })
      await rm(deep, { recursive: true, force: true })
    }
  })

  it('passes the same path to `smoke`, and still finds the state it recorded', async () => {
    const dir = await taskSpaceWith(`${PLUGIN_ROOT}/deploy/variants/smoke-a.sh`)
    try {
      const { subprocess, envs } = spawnRecorder()
      const outcome = await smokeEnvironment(subprocess, dir)
      expect(envs[0].env.DEPLOY_STATE_FILE).toBe(join(deployRoot(dir), '.state.json'))
      // The gate read the same file the plugin pointed the script at: the smoke in it is
      // visible, so this space is not refused at the finish.
      expect(outcome.gate.missing).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports a named entry that is missing rather than falling back to deploy.sh', async () => {
    // The record is the task's own answer to "which script runs here". Quietly running a
    // different script because the named one vanished would deploy something nobody chose.
    const dir = await mkdtemp(join(tmpdir(), 'deploy-env-'))
    try {
      await mkdir(deployRoot(dir), { recursive: true })
      await writeFile(join(deployRoot(dir), 'deploy.sh'), 'echo default\n', 'utf8')
      await writeTaskMetadata(dir, taskMetadata({
        task: 'login', project: 'public', tasksRoot: join(dir, '..'), sourceRoot: '/repo',
        branch: 'task/login', delivery: { deploy: { target: 'docker' } },
        deployScript: `${PLUGIN_ROOT}/deploy/gone.sh`,
      }))
      const { subprocess } = spawnRecorder()
      await expect(deployEnvironment(subprocess, dir)).rejects.toMatchObject({ code: 'E5008' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

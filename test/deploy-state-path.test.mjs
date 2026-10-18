// Does the plugin actually hand the script its state-file path, and does a subdirectory
// entry still get the same fixed path? That is the whole point of the change: the user's
// script must not have to work out where the deploy root is.
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deployEnvironment, smokeEnvironment } from '../src/host/task/deploy.js'
import { isWindowsBashStub, bashInterpreter } from '../src/host/task/bash-interpreter.js'
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

/**
 * The entry path is re-checked where it is used, not only where it was chosen.
 *
 * `deployScript` lives in the record, the record lives inside the task space, and the task
 * space is the working directory of the session that works there - so the value is a string
 * an agent can write. The create-time check (E4014) confined it to the deploy root, but
 * nothing re-ran that check between the record and `bash`, and `join` resolves `../..` out of
 * the tree without complaint. These are the three shapes the attack takes, plus the legitimate
 * one it must not break.
 */
describe('a recorded deploy script is confined to the deploy root at run time', () => {
  /**
   * A task space whose record names `entry`.
   *
   * The record is written through `writeTaskMetadata`, the same writer the plugin uses, so the
   * value under test reaches `findDeployScript` by the ordinary route rather than by a
   * hand-edited fixture that skips the schema.
   * @param entry - the record's `deployScript`.
   * @returns the task space directory.
   */
  async function spaceNaming(entry) {
    const dir = await mkdtemp(join(tmpdir(), 'deploy-confine-'))
    await mkdir(deployRoot(dir), { recursive: true })
    await writeTaskMetadata(dir, taskMetadata({
      task: 'login', project: 'public', tasksRoot: join(dir, '..'), sourceRoot: '/repo',
      branch: 'task/login', delivery: { deploy: { target: 'docker' } },
      deployScript: entry,
    }))
    return dir
  }

  it('refuses an entry that walks out of the task space, and does not run it', async () => {
    // The attack the review describes: `../../../evil.sh` in the record makes the next deploy
    // run an out-of-bounds script as the host process, with the audit log recording a user
    // pressing a button. The script is planted for real, at the path the record's own `../..`
    // walk reaches, so a fix that merely rejected a nonexistent path would not be what this
    // passes. The task space is nested one level deeper than the container so the escape lands
    // inside this fixture rather than in the system temp directory.
    const container = await mkdtemp(join(tmpdir(), 'deploy-confine-'))
    const space = join(container, 'x', 'proj', 'login')
    const evil = join(container, 'evil.sh')
    try {
      await writeFile(evil, 'echo pwned\n', 'utf8')
      await mkdir(deployRoot(space), { recursive: true })
      await writeTaskMetadata(space, taskMetadata({
        task: 'login', project: 'proj', tasksRoot: container, sourceRoot: '/repo',
        branch: 'task/login', delivery: { deploy: { target: 'docker' } },
        deployScript: '../../../evil.sh',
      }))
      const { subprocess, envs } = spawnRecorder()

      await expect(deployEnvironment(subprocess, space)).rejects.toMatchObject({ code: 'E5008' })
      await expect(smokeEnvironment(subprocess, space)).rejects.toMatchObject({ code: 'E5008' })
      // The assertion that matters most: the script was never executed. A refusal that still
      // spawned `bash evil.sh up` would be a refusal in name only.
      expect(envs).toEqual([])
      // And it is a refusal about containment, not about the file being missing - the file is
      // right there, which is what makes this an escape rather than a typo.
      expect(existsSync(evil)).toBe(true)
      await expect(deployEnvironment(subprocess, space)).rejects.toThrow(/not inside the task space/)
    } finally {
      await rm(container, { recursive: true, force: true })
    }
  })

  it('refuses an entry that resolves inside the task space but outside the deploy root', async () => {
    // The narrower shape, and the one a containment check written against the task space alone
    // would let through: the script is a real file the task session itself could have written,
    // and it sits inside the task space - but not in the deploy root the create confined the
    // entry to. `${PLUGIN_ROOT}/sibling.sh` is that path exactly: one level up from `deploy/`,
    // still inside the space.
    const dir = await spaceNaming(`${PLUGIN_ROOT}/sibling.sh`)
    try {
      await writeFile(join(dir, PLUGIN_ROOT, 'sibling.sh'), 'echo sibling\n', 'utf8')
      const { subprocess, envs } = spawnRecorder()
      await expect(deployEnvironment(subprocess, dir)).rejects.toMatchObject({ code: 'E5008' })
      expect(envs).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses an entry that names a directory', async () => {
    // `existsSync` is true for a directory, so the old check accepted one and the failure
    // surfaced as a `bash` error about a file rather than as a refusal naming the record.
    const dir = await spaceNaming(`${PLUGIN_ROOT}/deploy/not-a-script`)
    try {
      await mkdir(join(deployRoot(dir), 'not-a-script'), { recursive: true })
      const { subprocess, envs } = spawnRecorder()
      await expect(deployEnvironment(subprocess, dir)).rejects.toMatchObject({ code: 'E5008' })
      await expect(deployEnvironment(subprocess, dir)).rejects.toThrow(/directory, not a file/)
      expect(envs).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('still runs a legitimate entry inside the deploy root, subdirectory or not', async () => {
    // The control for the three above: a fix that refused everything would pass them all.
    const top = await spaceNaming(`${PLUGIN_ROOT}/deploy/deploy.sh`)
    const deep = await spaceNaming(`${PLUGIN_ROOT}/deploy/variants/smoke-a.sh`)
    try {
      for (const dir of [top, deep]) {
        await writeFile(join(deployRoot(dir), '.state.json'), `${JSON.stringify(STATE)}\n`, 'utf8')
      }
      await writeFile(join(deployRoot(top), 'deploy.sh'), 'echo top\n', 'utf8')
      await mkdir(join(deployRoot(deep), 'variants'), { recursive: true })
      await writeFile(join(deployRoot(deep), 'variants', 'smoke-a.sh'), 'echo deep\n', 'utf8')

      const a = spawnRecorder()
      const b = spawnRecorder()
      await deployEnvironment(a.subprocess, top)
      await deployEnvironment(b.subprocess, deep)

      expect(a.envs[0].argv[1]).toBe(join(deployRoot(top), 'deploy.sh'))
      expect(b.envs[0].argv[1]).toBe(join(deployRoot(deep), 'variants', 'smoke-a.sh'))
    } finally {
      await rm(top, { recursive: true, force: true })
      await rm(deep, { recursive: true, force: true })
    }
  })
})

describe('the interpreter the entry is run by', () => {
  it('is not the WSL forwarding stub, on either subcommand', async () => {
    // The defect this pins: `['bash', entry, 'up']` handed the entry to a Linux
    // distribution, which cannot read a native Windows path, and answered exit 127
    // with `No such file or directory` naming a script that was right there. The
    // assertion is about the interpreter, not about the entry - the entry's position
    // is already pinned by the tests above.
    const dir = await taskSpaceWith(`${PLUGIN_ROOT}/deploy/deploy.sh`)
    try {
      const { subprocess, envs } = spawnRecorder()
      await deployEnvironment(subprocess, dir)
      // Found by shape, not by position: a deploy is followed by docker queries, so
      // the last spawn is not the entry's.
      const entry = envs.map((e) => e.argv).find((argv) => argv[2] === 'up' || argv[2] === 'smoke')
      expect(entry).toBeDefined()
      expect(isWindowsBashStub(entry[0])).toBe(false)

      envs.length = 0
      await smokeEnvironment(subprocess, dir)
      const smoke = envs.map((e) => e.argv).find((argv) => argv[2] === 'smoke')
      expect(smoke).toBeDefined()
      expect(isWindowsBashStub(smoke[0])).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('hands the entry a PATH its own shell tools are on', async () => {
    // The second defect, which the first one was hiding: with the WSL stub the entry
    // never started, so nothing ever reached the line that runs `dirname`. Once it
    // does start, a shell named by absolute path cannot find `dirname`, `basename` or
    // `sed` - they are separate executables beside it, and neither the harness's own
    // shell nor Git for Windows is on the PATH the Host gives a child. The entry then
    // died on `dirname: command not found`, exit 1.
    const dir = await taskSpaceWith(`${PLUGIN_ROOT}/deploy/deploy.sh`)
    try {
      const { subprocess, envs } = spawnRecorder()
      await deployEnvironment(subprocess, dir)
      const entry = envs.map((e) => e).find((e) => e.argv[2] === 'up' || e.argv[2] === 'smoke')
      expect(entry).toBeDefined()
      // The two hand-declared variables must survive the PATH fix, or the state file
      // and the environment id go missing instead - which is the trade this must not
      // make.
      expect(entry.env.DEPLOY_STATE_FILE).toBe(join(deployRoot(dir), '.state.json'))
      expect(entry.env.DEPLOY_ENV_ID).toBe('dsh-public-login')
      // And the shell's own directory leads the PATH, so its tools win over a
      // same-named one further along it. Split on the separator alone: a drive
      // letter's colon is part of the first entry, not another break.
      const bash = bashInterpreter()
      if (bash.toolDir !== undefined) {
        const separator = entry.env.PATH.includes(';') ? ';' : ':'
        expect(entry.env.PATH.split(separator)[0]).toBe(bash.toolDir)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

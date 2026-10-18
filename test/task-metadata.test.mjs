/**
 * Task metadata: the JSON record a container carries, and the note rendered
 * from it.
 *
 * The record has to survive being read by a version that does not know it, and
 * a container from before the JSON existed has to keep answering with what its
 * note says. Both are tested here, against the module the host actually uses.
 */
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PLUGIN_ROOT,
  TASK_METADATA,
  TASK_OWNED_ENTRIES,
  TASK_README,
  readTaskMetadata,
  renderTaskMetadata,
  taskMetadata,
  writeTaskMetadata,
} from '../src/host/task/shared.js'

/** A container directory holding only a legacy note. */
async function legacyContainer() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-metadata-'))
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'README.en.md'), [
    '# Task: login',
    '',
    '- Branch: `task/login` (one branch per repository below)',
    '- Base: each repository\'s current HEAD',
    '- Created: 2026-01-01T00:00:00.000Z',
    '- Source root: `E:\\workspace\\public\\kratos-admin`',
    '',
    '## Repositories',
    '- `alpha`',
    '',
  ].join('\n'))
  return root
}

describe('task metadata', () => {
  it('records the identity and the creation-time facts, and nothing live', () => {
    const metadata = taskMetadata({
      task: 'filter-demo',
      project: 'public',
      tasksRoot: 'E:\\worktree-space',
      sourceRoot: 'E:\\workspace\\public',
      branch: 'task/filter-demo',
      repositories: [
        { name: 'mybatis-3', sourcePath: 'E:\\workspace\\public\\mybatis-3', sourceBranch: 'main', startCommit: '9f1c2ab' },
      ],
    })

    expect(metadata.version).toBe(1)
    expect(metadata.task).toBe('filter-demo')
    expect(metadata.baseRef).toBe(null)
    expect(typeof metadata.createdAt).toBe('string')
    expect(metadata.deploymentEnvId).toBe('dsh-public-filter-demo')
    expect(metadata.repositories).toEqual([
      {
        name: 'mybatis-3',
        sourcePath: 'E:\\workspace\\public\\mybatis-3',
        sourceBranch: 'main',
        startCommit: '9f1c2ab',
        branch: 'task/filter-demo',
      },
    ])
    // Live state is a git question; a copy here would go stale immediately.
    expect(metadata).not.toHaveProperty('changedFiles')
    expect(metadata.repositories[0]).not.toHaveProperty('currentBranch')
  })

  it('writes the record and the note rendered from it, and reads the record back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-metadata-'))
    try {
      const metadata = taskMetadata({
        task: 'login',
        project: 'public',
        tasksRoot: 'E:\\worktree-space',
        sourceRoot: 'E:\\workspace\\public',
        branch: 'task/login',
        baseRef: 'main',
        repositories: [{ name: 'alpha', sourcePath: 'E:\\workspace\\public\\alpha' }],
      })
      await writeTaskMetadata(root, metadata)

      const written = JSON.parse(await readFile(join(root, PLUGIN_ROOT, TASK_METADATA), 'utf8'))
      expect(written).toEqual(metadata)

      // The note carries what a session needs, and says where the facts live.
      const note = await readFile(join(root, PLUGIN_ROOT, TASK_README), 'utf8')
      expect(note).toBe(renderTaskMetadata(metadata))
      expect(note).toContain('# Task: login')
      expect(note).toContain("- Branch: `task/login`")
      expect(note).toContain('- Base: `main`')
      expect(note).toContain(metadata.createdAt)
      // Named with the directory it sits in: the record is no longer at the top of the
      // task space, so the note has to say where a reader finds it.
      expect(note).toContain(`${PLUGIN_ROOT}/${TASK_METADATA}`)
      expect(note).toContain('- `alpha`')
      // The deployment section states this task's own id, copied verbatim into
      // every deploy command; nothing else is what keeps environments apart. The
      // delivery policy renders beside it, so a session reads both from one note.
      expect(note).toContain('## Deployment')
      expect(note).toContain('DEPLOY_ENV_ID=dsh-public-login')
      // The commands printed in that section carry the id themselves. A note that
      // says "pass it to every deploy command" and then prints one without it is
      // the contradiction that cost a task its containers once: the session copied
      // the command, the entry fell back to its own default id, the panel found no
      // `dsh.env-id` label and offered deploy instead of smoke and destroy. The
      // instruction and the copyable string have to agree.
      expect(note).toContain('deploy.sh up dsh-public-login')
      expect(note).toContain('deploy.sh smoke dsh-public-login')
      // And the consequence is stated, because "pass it" alone does not tell a
      // session what goes wrong when it does not.
      expect(note).toContain('the smoke and destroy buttons disappear')
      // Every printed deploy command in the section names this task's own id - no
      // command may be left to default, whichever line it came from.
      for (const line of note.split('\n').filter((l) => l.includes('deploy.sh up') || l.includes('deploy.sh smoke'))) {
        expect(line).toContain('dsh-public-login')
      }
      // The delivery section is one line now, because the policy behind it is one
      // field: whether this task expects a deployment. Everything else a finish
      // decides is passed on the `done` call, so the note does not record it.
      expect(note).toContain('## Delivery')
      expect(note).toContain('- Deployment target: `none`.')

      expect(await readTaskMetadata(root)).toEqual(metadata)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('renders without the deployment sections when the record predates them', () => {
    // A container old enough to hold neither field renders no guidance that names
    // an id or a policy: a session asked to guess either would guess worse than
    // no section at all.
    const { deploymentEnvId, delivery, ...legacy } = taskMetadata({
      task: 'login',
      project: 'public',
      tasksRoot: 'E:\\worktree-space',
      sourceRoot: 'E:\\workspace\\public',
      branch: 'task/login',
      repositories: [{ name: 'alpha', sourcePath: 'E:\\workspace\\public\\alpha' }],
    })
    expect(deploymentEnvId).toBeDefined()
    expect(delivery).toBeDefined()
    expect(renderTaskMetadata(legacy)).not.toContain('## Deployment')
    expect(renderTaskMetadata(legacy)).not.toContain('## Delivery')
  })

  it('keeps reading a container that only has the legacy note', async () => {
    const root = await legacyContainer()
    try {
      const read = await readTaskMetadata(root)
      // Identity survives; the fields only the JSON carries are absent rather
      // than wrong, and version 0 marks where they came from.
      expect(read).toEqual({
        version: 0,
        task: 'login',
        branch: 'task/login',
        sourceRoot: 'E:\\workspace\\public\\kratos-admin',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('falls back to the legacy note when the record is unreadable', async () => {
    const root = await legacyContainer()
    try {
      await mkdir(join(root, PLUGIN_ROOT), { recursive: true })
      await writeFile(join(root, PLUGIN_ROOT, TASK_METADATA), '{ this is not json')
      expect(await readTaskMetadata(root)).toEqual({
        version: 0,
        task: 'login',
        branch: 'task/login',
        sourceRoot: 'E:\\workspace\\public\\kratos-admin',
      })

      // A record that parses but names no task is no identity either.
      await writeFile(join(root, PLUGIN_ROOT, TASK_METADATA), JSON.stringify({ version: 1, branch: 'task/login' }))
      expect((await readTaskMetadata(root)).task).toBe('login')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports no metadata for a directory that is not a container', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-metadata-'))
    try {
      expect(await readTaskMetadata(root)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // README.md is deliberately NOT owned: in a space old enough to hold one the
  // plugin wrote, the name is now as likely to be the user's own.
  it('owns one directory at the top level, the legacy note name beside it', () => {
    // One entry, because the record, the note and the deploy root are all inside it: a
    // finish clears the plugin's bookkeeping by clearing the directory, and a copied
    // `deploy/` tree is not something to file away as the user's documents either.
    expect(TASK_OWNED_ENTRIES).toEqual([PLUGIN_ROOT, 'README.en.md'])
    expect(TASK_OWNED_ENTRIES).not.toContain('README.md')
    // The record's own names live inside the directory rather than at the top level.
    expect(TASK_OWNED_ENTRIES).not.toContain(TASK_METADATA)
    expect(TASK_OWNED_ENTRIES).not.toContain(TASK_README)
  })
})

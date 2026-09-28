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
  TASK_METADATA,
  TASK_OWNED_FILES,
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
        tasksRoot: 'E:\\worktree-space',
        sourceRoot: 'E:\\workspace\\public',
        branch: 'task/login',
        baseRef: 'main',
        repositories: [{ name: 'alpha', sourcePath: 'E:\\workspace\\public\\alpha' }],
      })
      await writeTaskMetadata(root, metadata)

      const written = JSON.parse(await readFile(join(root, TASK_METADATA), 'utf8'))
      expect(written).toEqual(metadata)

      // The note carries what a session needs, and says where the facts live.
      const note = await readFile(join(root, TASK_README), 'utf8')
      expect(note).toBe(renderTaskMetadata(metadata))
      expect(note).toContain('# Task: login')
      expect(note).toContain("- Branch: `task/login`")
      expect(note).toContain('- Base: `main`')
      expect(note).toContain(metadata.createdAt)
      expect(note).toContain('worktree-space.json')
      expect(note).toContain('- `alpha`')

      expect(await readTaskMetadata(root)).toEqual(metadata)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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
      await writeFile(join(root, TASK_METADATA), '{ this is not json')
      expect(await readTaskMetadata(root)).toEqual({
        version: 0,
        task: 'login',
        branch: 'task/login',
        sourceRoot: 'E:\\workspace\\public\\kratos-admin',
      })

      // A record that parses but names no task is no identity either.
      await writeFile(join(root, TASK_METADATA), JSON.stringify({ version: 1, branch: 'task/login' }))
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

  it('owns exactly the three files it writes, the legacy name included', () => {
    expect(TASK_OWNED_FILES).toEqual(['worktree-space.json', 'README.md', 'README.en.md'])
  })
})

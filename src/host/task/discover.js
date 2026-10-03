/**
 * Source-repository discovery, ported from the source skill's `discover_repos`.
 *
 * A source root is either a single repository or a directory whose top-level
 * children are repositories. A linked worktree checkout carries `.git` as a
 * file rather than a directory, so only a real `.git` directory marks a source
 * repository — that is what keeps a task container from being mistaken for a
 * source root.
 */
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { coded } from './codes.js'

/**
 * Whether a directory is a source repository, that is, its `.git` is a real
 * directory.
 * @param directory - the candidate directory.
 * @returns whether the directory is a source repository.
 */
export async function isSourceRepository(directory) {
  try {
    return (await stat(join(directory, '.git'))).isDirectory()
  } catch {
    return false
  }
}

/**
 * Discover the source repositories under a source root: the root itself when it is
 * a repository, otherwise every repository down to `maxDepth` levels below it.
 * Hidden children and `*.worktrees` containers are skipped by name.
 *
 * `maxDepth` used to be hard-wired to one level, and that is what made a Workspace
 * whose repositories sit one directory down report none of them. `E:\workspace` is
 * the shape that breaks: its top level holds containers (`aqumon`, `public`), not
 * repositories, so a one-level walk found nothing while `worktree.scan` - a
 * different function with its own, configurable depth - found ninety-four. The
 * Workspace card counted the shallow answer, so the panel said "no repositories"
 * about a root full of them, and raising `scanDepth` changed nothing because this
 * function never read it. The depth now arrives from the same `scanBounds` the
 * scan reads, so the two cannot disagree.
 *
 * The walk is breadth-first and bounded in both directions, so a signal is honoured
 * between batches: a panel that has been closed should stop costing the disk.
 * @param sourceRoot - the directory holding the source repositories.
 * @param options - how far to look.
 * @param options.signal - an abort signal, when the caller has one.
 * @param options.maxDepth - how many levels below the root to look. One keeps the
 *   historical contract for a caller that passes no bounds.
 * @param options.maxDirectories - the ceiling on directories inspected; the walk
 *   stops and keeps what it found rather than throwing, because one oversized root
 *   must not cost the caller every other root's repositories.
 * @param options.ignored - lower-cased directory names the walk skips.
 * @returns the repository paths in stable order; empty when none are found.
 */
export async function discoverSourceRepos(sourceRoot, {
  signal,
  maxDepth = 1,
  maxDirectories = Number.POSITIVE_INFINITY,
  ignored = new Set(),
} = {}) {
  const repositories = []
  const queue = [{ path: sourceRoot, depth: 0 }]
  let inspected = 0
  for (let cursor = 0; cursor < queue.length;) {
    signal?.throwIfAborted()
    const batch = queue.slice(cursor, cursor + 8)
    cursor += batch.length
    inspected += batch.length
    if (inspected > maxDirectories) break
    await Promise.all(batch.map(async ({ path, depth }) => {
      // A repository is a leaf of this walk: nothing under it is a source root of
      // its own, and a linked worktree is not one at all - `.git` is a file there,
      // not the directory this checks for.
      if (await isSourceRepository(path)) {
        repositories.push(path)
        return
      }
      if (depth >= maxDepth) return
      let entries
      try {
        entries = await readdir(path, { withFileTypes: true })
      } catch {
        // Unreadable is not empty, but this walk answers only a count and a list,
        // and the caller has no side channel to be told in - which is the reason
        // the count could look like a fact about the disk when it was a fact about
        // a failed read. It contributes nothing rather than a wrong repository.
        return
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.')) continue
        if (entry.name.endsWith('.worktrees')) continue
        if (ignored.has(entry.name.toLowerCase())) continue
        queue.push({ path: join(path, entry.name), depth: depth + 1 })
      }
    }))
  }
  return repositories.sort()
}

/**
 * Resolve explicitly named repositories under a source root.
 *
 * A source root that is itself a repository lists that repository by its own
 * name, because that is the name discoverSourceRepos reports for it: the root,
 * not a child of the root.
 * @param sourceRoot - the directory holding the source repositories.
 * @param names - repository directory names.
 * @returns the resolved repository paths, in the given order.
 * @throws Error when a name does not name a source repository.
 */
export async function resolveSourceRepos(sourceRoot, names) {
  const selfName = (await isSourceRepository(sourceRoot)) ? basename(sourceRoot) : undefined
  const repositories = []
  for (const name of names) {
    const candidate = name === selfName ? sourceRoot : join(sourceRoot, name)
    if (!(await isSourceRepository(candidate))) throw coded('E6001', `not a source repository: ${name}`)
    repositories.push(candidate)
  }
  return repositories
}

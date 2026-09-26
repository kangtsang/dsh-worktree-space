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
import { join } from 'node:path'

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
 * Discover the source repositories under a source root: the root itself when it
 * is a repository, otherwise every top-level child that is one. Hidden children
 * and `*.worktrees` containers are skipped by name.
 * @param sourceRoot - the directory holding the source repositories.
 * @returns the repository paths in stable order; empty when none are found.
 */
export async function discoverSourceRepos(sourceRoot) {
  if (await isSourceRepository(sourceRoot)) return [sourceRoot]

  let entries
  try {
    entries = await readdir(sourceRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const repositories = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    if (entry.name.endsWith('.worktrees')) continue
    const candidate = join(sourceRoot, entry.name)
    if (await isSourceRepository(candidate)) repositories.push(candidate)
  }
  return repositories.sort()
}

/**
 * Resolve explicitly named repositories under a source root.
 * @param sourceRoot - the directory holding the source repositories.
 * @param names - repository directory names.
 * @returns the resolved repository paths, in the given order.
 * @throws Error when a name does not name a source repository.
 */
export async function resolveSourceRepos(sourceRoot, names) {
  const repositories = []
  for (const name of names) {
    const candidate = join(sourceRoot, name)
    if (!(await isSourceRepository(candidate))) throw new Error(`not a source repository: ${name}`)
    repositories.push(candidate)
  }
  return repositories
}

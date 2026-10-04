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
import { basename, join, resolve } from 'node:path'
import { isInside, samePathLocation } from './paths.js'
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
  exclude = [],
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
      // Another caller asked about a directory inside this one and will walk it
      // itself. Stopping here is what keeps one repository from being discovered -
      // and paid for - twice, and it is not the same thing as not walking this
      // path: the caller still gets its own answer for the nested directory, from
      // its own walk. `topLevelRequestedPaths` is not usable for this, because it
      // deletes the nested path from the request rather than the nested subtree
      // from this walk - which costs the nested Workspace its own classification,
      // and with it the ability to start a task space from it.
      if (exclude.some((nested) => isInside(nested, path))) return
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
 * Resolve the repositories a request named, under a source root.
 *
 * A repository is named by its path, not by its directory name. Discovery walks
 * to `maxDepth`, so the repositories it reports are not always direct children of
 * the source root - a Workspace registered one level above its repositories gets
 * `repos/alpha` from discovery - and a name carries none of that. The dialog then
 * sent back `alpha`, and the only way to rebuild it was to join it onto the source
 * root, which asks the wrong question: it finds `E:/wt-demo/alpha` for a workspace
 * rooted at `E:/wt-demo` and answers "not a source repository" about a repository
 * the same dialog had just listed. Listing it and taking it were two functions
 * reading two different trees.
 *
 * A bare name still works, because `resolve` treats it as relative to the source
 * root - the shape the agent tool sends, and the shape that was correct while every
 * repository really was a direct child. A path is taken as written.
 *
 * Whatever the caller sends is checked to sit inside the source root. Discovery is
 * bounded by that root, so anything outside it did not come from this dialog, and a
 * path is an input rather than something to look up.
 * @param sourceRoot - the directory holding the source repositories.
 * @param requested - repository paths, or names relative to the source root.
 * @returns the resolved repository paths, in the given order.
 * @throws Error when one does not name a repository inside the source root.
 */
export async function resolveSourceRepos(sourceRoot, requested) {
  const repositories = []
  // A source root that is itself a repository is listed by its own name, because
  // that is the name discovery reports for it. Reading a bare name as relative to
  // the root would ask for a child called after the root, so the root answers for
  // itself. Resolved once, and only if some bare name actually turns up.
  let rootIsRepo
  const rootAnswersForItself = async (entry) => {
    if (rootIsRepo === undefined) rootIsRepo = await isSourceRepository(sourceRoot)
    return rootIsRepo && !/[\\/]/.test(entry) && basename(sourceRoot) === basename(entry)
  }

  for (const raw of requested) {
    const entry = typeof raw === 'string' ? raw.trim() : ''
    if (entry === '') throw coded('E4005', 'a repository path is required')
    // Absolute wins, bare name lands under the source root - which also covers a
    // relative path such as "repos/alpha", the one discovery actually produces.
    const candidate = (await rootAnswersForItself(entry))
      ? resolve(sourceRoot)
      : resolve(sourceRoot, entry)
    if (!samePathLocation(candidate, sourceRoot) && !isInside(sourceRoot, candidate)) {
      throw coded('E4006', `not inside the source root ${sourceRoot}: ${entry}`)
    }
    if (!(await isSourceRepository(candidate))) throw coded('E6001', `not a source repository: ${basename(candidate)}`)
    repositories.push(candidate)
  }
  return repositories
}

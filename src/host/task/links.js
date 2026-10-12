/**
 * Symbolic links and junctions inside a task space.
 *
 * A link is a name for somewhere else rather than content of its own, and that
 * single fact is why this module exists as its own file rather than as a helper
 * inside the archiving code that first needed it. Two callers ask the same two
 * questions about links at opposite ends of a task's life:
 *
 *   - `create` asks at the start, so a task space that already holds links - or a
 *     machine that will refuse to recreate them - is known before the work rather
 *     than discovered when the finish cannot file a stray.
 *   - `archive` asks at the end, where the answer decides whether a stray can be
 *     copied into the documents directory at all.
 *
 * Both need the same answer to "may this process create a link", and both need the
 * same walk to find them, so keeping one copy here is what stops the two from
 * disagreeing about a fact that is a property of the machine and the directory.
 */
import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

/**
 * Whether this process is refused the right to create a symbolic link.
 *
 * Windows needs `SeCreateSymbolicLinkPrivilege` for that: Developer Mode grants it to
 * an ordinary user, an ordinary installation does not. The answer decides whether a
 * stray holding a link can be filed at all, because `fs.cp` recreates links rather
 * than copying what they point at - on a machine that refuses, the copy stops part-way
 * with an `EPERM` about the link and leaves half an archive behind. Probed rather than
 * assumed, and asked once: nothing about the process's token changes while it runs.
 *
 * A junction is creatable on Windows without that privilege, so a machine answering
 * `true` here is not refusing every kind of link - it is refusing the one `fs.cp`
 * needs when it recreates a symbolic link, which is the operation that fails.
 * @returns whether a symbolic link could not be created here.
 */
export function symlinksRefused() {
  linkProbe ??= (async () => {
    const probe = await mkdtemp(join(tmpdir(), 'dsh-worktree-link-'))
    try {
      await symlink(join(probe, 'target'), join(probe, 'link'))
      return false
    } catch {
      return true
    } finally {
      await rm(probe, { recursive: true, force: true }).catch(() => {})
    }
  })()
  return linkProbe
}

/** The one probe {@link symlinksRefused} keeps, so the question is asked once. */
let linkProbe

/**
 * Every link below a directory, as paths relative to it.
 *
 * The listing is what the reader is given when a stray cannot be filed whole, so it names
 * entries the way the task space shows them rather than as absolute paths. Links are not
 * descended into: a link is a name for somewhere else, and walking one would both leave
 * the directory being filed and, where links point back into their own tree -
 * `node_modules/.pnpm` is full of them - never come back. A junction is a link here as
 * much as a symbolic link is: `readdir` reports one as a directory, and
 * `Dirent.isSymbolicLink` is what tells the two apart.
 *
 * An unreadable directory is skipped rather than raised over: the caller is asking what
 * links it can see, and one it cannot look inside is not a link it can name. The walk is
 * bounded because both callers run it on a directory a person is waiting on.
 * @param directory - the directory to look through.
 * @param options - `maxEntries` bounds the walk.
 * @returns the relative paths, in the order they were found.
 */
export async function findLinks(directory, { maxEntries = 2000 } = {}) {
  const found = []
  const queue = [directory]
  let seen = 0
  while (queue.length > 0 && seen < maxEntries) {
    const current = queue.shift()
    let children
    try {
      children = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      seen += 1
      if (seen > maxEntries) break
      const path = join(current, child.name)
      if (child.isSymbolicLink()) {
        found.push(relative(directory, path))
        continue
      }
      if (child.isDirectory()) queue.push(path)
    }
  }
  return found
}

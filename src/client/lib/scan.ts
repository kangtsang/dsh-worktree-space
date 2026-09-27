import { cleanPath } from "./paths"
import type { RememberedScan, WorktreeList } from "./types"

/**
 * The repositories a scan found, as the panel lists them.
 *
 * A repository can arrive twice — a task space registered as its own Workspace,
 * scanned on top of the source root it came from — so the list is deduplicated by
 * repository path. The main worktree is not a linked one and has no row of its
 * own; it leaves its branch behind as the repository's current branch.
 * @param lists - repositories as the Host reported them.
 * @returns one entry per repository, in the order the scan found them.
 */
export function scannedRepositories(lists: WorktreeList[]): WorktreeList[] {
  const seen = new Set<string>()
  const repositories: WorktreeList[] = []
  for (const list of lists) {
    const key = cleanPath(list.repoPath)
    if (!key || seen.has(key)) continue
    seen.add(key)
    repositories.push({
      ...list,
      currentBranch: list.worktrees.find(row => row.isMain)?.branch,
      worktrees: list.worktrees.filter(row => !row.isMain),
    })
  }
  return repositories
}

/**
 * The rows a remembered scan paints, with whichever statuses the Host still holds.
 *
 * A worktree the Host was never asked about keeps the panel's "checking status…"
 * mark rather than a blank one: the caller is scanning again at that same moment,
 * so those rows are about to be filled in for real.
 * @param remembered - the Host's remembered answer.
 * @param pending - the label for a row whose status is not remembered yet.
 * @returns the repositories, ready to render.
 */
export function rememberedRepositories(remembered: RememberedScan, pending: string): WorktreeList[] {
  return scannedRepositories(remembered.repositories).map(repository => ({
    ...repository,
    worktrees: repository.worktrees.map(row => {
      const status = remembered.statuses[row.path]
      return status === undefined ? { ...row, statusError: pending } : { ...row, ...status }
    }),
  }))
}

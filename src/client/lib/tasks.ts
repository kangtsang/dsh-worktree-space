import { cleanPath, containerRootOf, nameOf, parentOf, projectOf } from "./paths"
import type { Worktree, WorktreeList } from "./types"

/** One repository inside a task container, with the status the page already read. */
export interface TaskRepository {
  name: string
  path: string
  branch?: string
  changedFiles: number
  /** Commits on this worktree's branch that its merge target does not have yet. */
  commits: number
  locked: boolean
  /** Git keeps the record but the directory is gone. */
  prunable: boolean
  /** The page has not read this repository's status yet. */
  checking: boolean
  /** The status read failed, so this repository's state is unknown. */
  unknown: boolean
}

/**
 * A task container: one directory under a project under the container root,
 * holding one worktree per repository, all on one branch.
 *
 * The page derives these from the worktrees it already scanned rather than
 * asking the Host for a second list, so a task is exactly as visible as the
 * worktrees that make it up — and finishing one is offered only while something
 * is left to finish.
 */
export interface TaskGroup {
  /** Task directory name, which is what `task.done` takes as `task`. */
  name: string
  /** Task directory, `<container root>/<project>/<task>`. */
  path: string
  /** The project this task is filed under, read from the path's depth. */
  project: string
  /** Container root, which is what `task.done` takes as `tasksRoot`. */
  tasksRoot: string
  /** The shared branch, when every repository agrees on one. */
  branch?: string
  repositories: TaskRepository[]
  /** Uncommitted files across the task; a removal without `force` keeps these. */
  changedFiles: number
  /** Commits waiting to be merged back, across the task's repositories. */
  commits: number
  lockedRepositories: number
  prunableRepositories: number
  /** Repositories whose status the page is still reading. */
  checkingRepositories: number
  unknownRepositories: number
}

/**
 * Whether a worktree sits in the layout a task uses: a container directory one
 * level above the worktree, on the branch named after it.
 *
 * This is the same convention `createTask` writes and `finishTask` reads back.
 * A linked worktree someone made by hand — say a `feature/foo` checkout inside
 * `<repo>.worktrees/` — fails the branch test and is left to the repository
 * list instead of being offered as a task to finish.
 * @param worktree - a linked worktree row.
 * @returns the container directory, or undefined when this is not a task.
 */
export function taskContainerOf(worktree: Worktree): string | undefined {
  if (worktree.isMain) return undefined
  const container = parentOf(cleanPath(worktree.path))
  const name = nameOf(container)
  if (name === "" || !worktree.branch?.endsWith(`/${name}`)) return undefined
  return container
}

/**
 * Group scanned repositories into the tasks their worktrees belong to.
 * @param repos - scanned repository lists, as the settings page holds them.
 * @returns one entry per task container, ordered by task name.
 */
export function groupTasks(repos: WorktreeList[]): TaskGroup[] {
  const groups = new Map<string, { group: TaskGroup; seen: Set<string> }>()
  for (const repo of repos) {
    for (const worktree of repo.worktrees) {
      const container = taskContainerOf(worktree)
      if (container === undefined) continue
      const key = cleanPath(container)
      let entry = groups.get(key)
      if (entry === undefined) {
        entry = {
          seen: new Set<string>(),
          group: {
            name: nameOf(container),
            path: container,
            project: projectOf(container),
            // Two levels up, not one: the task's parent is its project, and the
            // project's parent is the root `task.done` files the archive against.
            tasksRoot: containerRootOf(container),
            repositories: [],
            changedFiles: 0,
            commits: 0,
            lockedRepositories: 0,
            prunableRepositories: 0,
            checkingRepositories: 0,
            unknownRepositories: 0,
          },
        }
        groups.set(key, entry)
      }
      // A task container registered as its own Workspace can surface the same
      // repository through two scans; count each worktree once.
      const repoKey = cleanPath(worktree.path)
      if (entry.seen.has(repoKey)) continue
      entry.seen.add(repoKey)
      // "Not read yet" and "could not be read" both land in `statusError`; the flag
      // is what keeps them apart.
      const checking = worktree.checking === true
      const statusError = worktree.statusError
      const unknown = !checking && statusError !== undefined && statusError !== ""
      const changedFiles = worktree.changedFiles ?? 0
      const commits = worktree.commits ?? 0
      entry.group.repositories.push({
        name: nameOf(worktree.path),
        path: worktree.path,
        branch: worktree.branch,
        changedFiles,
        commits,
        locked: worktree.locked,
        prunable: worktree.prunable,
        checking,
        unknown,
      })
      entry.group.changedFiles += changedFiles
      entry.group.commits += commits
      if (worktree.locked) entry.group.lockedRepositories += 1
      if (worktree.prunable) entry.group.prunableRepositories += 1
      if (checking) entry.group.checkingRepositories += 1
      if (unknown) entry.group.unknownRepositories += 1
    }
  }

  const tasks = [...groups.values()].map((entry) => entry.group)
  for (const task of tasks) {
    const branches = new Set(task.repositories.map((repository) => repository.branch))
    task.branch = branches.size === 1 ? task.repositories[0]?.branch : undefined
    task.repositories.sort((left, right) => left.name.localeCompare(right.name))
  }
  // Project first, then task: two projects may each hold a task of the same name,
  // and a name-only order would leave their relative order to the map's insertion.
  return tasks.sort((left, right) => left.project.localeCompare(right.project) || left.name.localeCompare(right.name))
}

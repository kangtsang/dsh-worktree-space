import { sameLocation, slashPath } from "./paths"
import type { WorkspacesService } from "./types"

/** What adding a repository source by hand can end in. */
export type AddRepositoryOutcome =
  /** The path was already a Workspace, so nothing changed. */
  | { added: false; reason: "already" }
  /** The path is now a Workspace, and will be scanned with the rest. */
  | { added: true; path: string }

/** The one call this needs, named so the two entry points can share it. */
type Classifier = { classifyRoot: (path: string) => Promise<{ isRepository: boolean }> }

/**
 * Put a repository the user named by hand into the list the page shows.
 *
 * Registering it as a Workspace is what puts it there: the repository view is
 * nothing but a scan of the Workspaces, so a repository that is not one is not in
 * the list, and it is not a candidate for a task that needs one added either.
 * There is no list of ours to keep in step — DSH keeps this one, and the user
 * removes it with the Workspace deletion they already have.
 *
 * A path that is already registered is left alone rather than refused. The user
 * asked for the repository to be in the list, and it is; making that an error
 * would send them looking for something to fix that is not broken.
 *
 * A linked worktree is refused along with anything that is not a repository at
 * all: its `.git` is a file rather than a directory, so cutting a worktree from
 * it would nest one worktree inside another. That judgement is the Host's — it
 * is the same test `createTask` applies — so this asks rather than re-derives it.
 * @param api - the worktree API, for the one classification this needs.
 * @param workspaces - the Workspace service the repository is registered with.
 * @param path - the directory the user named.
 * @returns what happened, for the caller to report.
 * @throws Error carrying the Host's message when the path is not a source repository.
 */
export async function addRepositorySource(
  api: Classifier,
  workspaces: WorkspacesService,
  path: string,
): Promise<AddRepositoryOutcome> {
  const target = String(path ?? "").trim()
  if (target === "") throw new Error("A repository path is required.")
  const state = await api.classifyRoot(target)
  if (!state.isRepository) {
    throw new Error(`${slashPath(target)} is not a git repository, so a task cannot hold a worktree of it.`)
  }
  const registered = workspaces.list.getSnapshot().items ?? []
  if (registered.some((workspace) => sameLocation(workspace.path, target))) {
    return { added: false, reason: "already" }
  }
  await workspaces.create({ path: target })
  return { added: true, path: target }
}
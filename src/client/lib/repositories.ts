import { sameLocation, slashPath } from "./paths"
import type { WorkspacesService } from "./types"

/** What adding a repository source by hand can end in. */
export type AddRepositoryOutcome =
  /** The scan already lists it, so it is on the page already and nothing changed. */
  | { added: false; reason: "listed" }
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
 * What decides whether this repository is added is whether the scan already
 * lists it — not whether some ancestor directory happens to be a registered
 * Workspace. The two are different questions and the page only answers the first:
 * a repository under a registered Workspace is in the list through it, and adding
 * it again would register a second Workspace over the same directory, which then
 * has to be tidied up by hand. So the list decides, and a path it does not carry
 * is registered whether or not anything above it already is.
 *
 * Being listed is reported rather than refused, and as a notice rather than an
 * error: the repository is in the list the user was adding to, which is what they
 * wanted, and nothing is broken. The page says so and leaves the field open so
 * the path can be corrected without starting again.
 *
 * A linked worktree is refused along with anything that is not a repository at
 * all: its `.git` is a file rather than a directory, so cutting a worktree from
 * it would nest one worktree inside another. That judgement is the Host's — it
 * is the same test `createTask` applies — so this asks rather than re-derives it.
 * @param api - the worktree API, for the one classification this needs.
 * @param workspaces - the Workspace service the repository is registered with.
 * @param path - the directory the user named.
 * @param listed - the repository paths the last scan already returned.
 * @returns what happened, for the caller to report.
 * @throws Error carrying the Host's message when the path is not a source repository.
 */
export async function addRepositorySource(
  api: Classifier,
  workspaces: WorkspacesService,
  path: string,
  listed: readonly string[],
): Promise<AddRepositoryOutcome> {
  const target = String(path ?? "").trim()
  if (target === "") throw new Error("A repository path is required.")
  if (listed.some((known) => sameLocation(known, target))) {
    return { added: false, reason: "listed" }
  }
  const state = await api.classifyRoot(target)
  if (!state.isRepository) {
    throw new Error(`${slashPath(target)} is not a git repository, so a task cannot hold a worktree of it.`)
  }
  await workspaces.create({ path: target })
  return { added: true, path: target }
}
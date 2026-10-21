## Finishing a task

Run `action: "done"`. It **removes the worktrees** and, by default, **keeps every branch**.
Two arguments carry the decision, and one of them is required.

**A deploying task is not finished until its fence has passed.** With `deployTarget: docker`
the finish is defined by the smoke, not merely gated by it: the work is done when the task
space's own smoke has recorded `pass`, and the acceptance URL `up` wrote is what the user is
handed. Never report such a task complete because the code is written, and never treat the
gate as a formality — `done` refuses the merge while it is unsatisfied (E5006), this tool has
no override to send, and the user's own "finish anyway" lives on the panel.

**Who calls it is the user's decision, and both flows are supported.**

| Flow | How it goes | What it costs |
| --- | --- | --- |
| **The session finishes its own work** | the session in the task space calls `done`, resolving any conflict itself | nothing — and only it can resolve a conflict in the isolated checkout |
| **The leader finishes** | the member reports back; the leader or the user calls `done` | one more round trip, and the caller is not looking at the work |

Neither is preferred. **The authorisation runs down the chain**: a session finishing work it
was told to do is the user's authorisation carried out. What it must not do is invent one —
merge only where the work was asked to land, and ask when the brief does not say which flow.

Both flows are reachable: the E5012 guard counts sessions working in the task space **except
the caller**, so a member calling `done` mid-turn is not refused with itself as the blocker.
Every other session in there still is.

**`merge` is required — `done` refuses a call that omits it (E7006).** `true` lands the task
branches on their targets, `false` leaves the work where it is. There is no default, because
a merge is the one step a finish cannot take back. Decide it from what the user asked for;
nothing in the task records a standing answer to fall back on.

**`done` is refused while a session is still working in the task space (E5012).** A finish
removes the worktrees, so a session whose directory is inside would lose the ground under it
mid-turn. The refusal names the sessions and what each is doing. **Stop them first** with
`wts_session_tool cancel`, then call `done` again; `wts_session_tool status` says what each is
doing first. If the work is not meant to stop, leave the space standing — nothing was
removed. **The caller is not one of those sessions**: a member finishing its own work is
running inside the space it asks to remove, so it is left out of the count.

**`strays` says what happens to the files git never tracked**, and omitting it means `archive`:

| `strays` | The user's untracked files | Build output | The task space |
| --- | --- | --- | --- |
| `archive` (default) | copied into the archive directory, then removed | cleared | removed and unregistered |
| `keep` | left exactly where they are | left | kept (it is not empty) |
| `discard` | **deleted** | cleared | removed and unregistered |

**`discard` is refused here (E7007) and you must not reach for it.** It is the only choice
that loses anything, and deleting the user's own writing is theirs to decide — no reflog
behind those files, no branch to recover them from. Only the panel can do it. When the user
asks for the leftovers to be thrown away, send them to the panel; do not substitute `archive`
quietly, because that is a different outcome than the one they asked for. `keepEntries` names
entries to leave alone whatever `strays` says. Where `archive` files them is not this call's
to name.

Name the task's own layer as well as the container: pass `tasksRoot` (the container root),
`task`, and `project` — the source root's directory name. `sourceRoot` instead of `project`
is enough; passing neither is refused, because the container root alone cannot say which
project's task was meant.

Confirm each destructive step with the user before passing it:

1. **Merge?** Only when the user explicitly says to. Pass `merge: true`. An unsatisfied
   deployment gate still refuses it. The merge puts the **task branch into the target
   branch**, landing in the source repository; by default the target is each source
   repository's checked-out branch. Ask which branch when the user has another in mind and
   pass `target` (one branch per repository); a branch checked out nowhere is merged in a
   temporary worktree, so no source checkout is switched. Before the target is touched it is
   merged **the other way**, inside the task space's own worktree (`git merge --no-ff
   --no-edit <target>`): a clean pre-merge is undone again (`git reset --hard`), while a
   conflict is left standing there — `MERGE_HEAD` and unresolved files intact — and that
   repository's worktree and branch stay in place. Either way the target branch and source
   checkout are untouched, and the other repositories still complete. Skipped when the target
   is already contained in the task branch.
2. **Work nobody committed?** Nothing to pass: `done` reports every repository with
   uncommitted changes, keeps its worktree, and flags the row **`needsCommit: true`** with
   the checkout named in `error`. **Read the flag, not the sentence.** Nothing is committed
   until someone who has read the changes writes the message, and that is the job of the
   session in the task space: route it with `wts_session_tool send`, `mode: "steer"`, to the
   session id the finish answers with (or `wts_session_tool find` by the checkout's
   directory; `wts_session_tool create` when the record names none), asking it to commit in
   **each** of those repositories, on the task branch, with a message saying what the changes
   were for. Read them first, never commit over the user's work blind, never push. Committing
   touches the source `.git` and may need elevated permission, granted in the session itself
   — the plugin never asks for it; where repositories share nothing but the volume root, tell
   the session to ask the user rather than assume the commands go through. The wait is
   skipped for a branch deleted unmerged, a worktree mid-merge (step 3), and `force: true`,
   which discards uncommitted work with the worktree. A commit that fails leaves that
   repository as it is while the others carry on. **The commits do not finish the task**: call
   `done` again once the session reports them in, or let that session call it.

   **Where the setting is on, both sessions open differently.** **Full access for the
   sessions handed to the agent for conflicts and commits** (`handoffFullAccess`) opens each
   in the **task space** instead of the common ancestor, and gives each `danger-full-access`
   once it exists — nothing will be refused and nothing to approve. Read what the first
   message says about the working directory instead of assuming either arrangement. Off —
   the default — everything above holds. **A session of your own already in the task space is
   not handed this work**: widening yours to finish a merge is the user's decision.
3. **A conflict, or a checkout of the user's own in the way?** Neither is resolved by picking
   a side, and neither is routine: `references/conflicts.md` says what each needs.
4. **Delete the branch?** After a merge, and only when the user asks: the branch is **kept**
   unless the call says otherwise — pass `deleteBranch: true` with `merge: true`. That
   default is the reversible one: once the space is gone the branch is the only record of how
   the work was made. To remove the space without merging anything, that is the abandon path:
   `deleteBranch: true` with `force: true` and `merge: false`.

The Workspace registration follows the directory. When the finish removes the task space,
`done` drops the registration, so the space leaves the workspace list and its sessions move
to "Ungrouped" — **unless the call passed `unregisterWorkspace: false`**, which keeps the
group with nothing on disk behind it. Pass that only when the user asked: nothing warns,
because it is the answer they asked for rather than something that went wrong. A finish that
keeps the container — a conflict left standing, uncommitted work, strays kept — keeps the
registration either way. A registration that could not be dropped while the entry is still
listed is a **warning** over a finish that still happened; remove it by hand. An entry
already gone is not a failure to report.

**A conflict or a dirty checkout is the one part of a finish that is not routine** — read
`references/conflicts.md` when a row is flagged `mergeInProgress` or `dirtyCheckout`.

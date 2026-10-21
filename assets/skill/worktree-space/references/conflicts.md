## A conflict, and a checkout that is in the way

Read this when a `done` answers with a row flagged `mergeInProgress` or
`dirtyCheckout`. Everything else a finish decides is in `finishing.md`.

Each repository row answers `mergeInProgress`, `mergeSite` and `conflictedFiles`;
`mergeInProgress` is what marks a repository the finish left on a conflict.

3. **A conflict?** The answer for a repository left on a conflict is flagged
   **`mergeInProgress: true`**, and reports `mergeSite` — the checkout the conflict
   stands in, inside the task space — and `conflictedFiles`. The panel opens it with
   **Hand the conflict to the agent**; from a `done` the leader dispatched, route it the same
   way as step 2 (`wts_session_tool send`, `mode: "steer"`, to the session the finish
   named). That session is
   shared by every conflicting repository and works in the common ancestor of their
   sites (or of each site and its source repository, when the Host named it), and in the
   task space where those sites share nothing but the volume root; a
   repository that already has the session from step 2 reuses it. Resolve
   exactly those files in that checkout,
   write a version that keeps both sides' intentions, and **commit the merge there
   yourself**: `git add`, then `git commit` with a message saying how you reconciled
   the two sides. Never resolve a conflict by picking a side the user has not picked,
   never push, and leave merging back into the target branch to `done`. `done` checks
   that no conflict markers remain and that the merge is committed, and it does **not**
   commit for you: a resolved but uncommitted merge is reported as `the merge in
   <path> is resolved but not committed` and leaves the repository as it stands.
   Committing the merge puts the target into the task branch, so the next `done` merges
   for real without rehearsing again; if the target branch has moved on since, the
   rehearsal runs once more, and a fresh conflict is left standing the same way. That next
   `done` does not start by itself: once the session stops, the panel reads the plan again and,
   where the merge has been committed and nothing is left uncommitted, its headline turns into a
   green light and **The conflict is resolved: carry on and finish the task.** — the panel's
   **Continue finishing** button is one way to ask for that next `done`: what it does is merge
   the branch into the user's own checkout, so it waits for them. A session that was told to
   finish can also call that `done` itself, the same as any other finish. Either way, resolving a
   conflict does not end the task, and only that second `done` finishes it.
   **There is no policy field that pre-delegates this.** A conflict is resolved when
   the user hands it over — by the panel's button, or by telling you to resolve it.
   Nothing in the task's record can have decided that in advance, so do not wait for
   the panel button when the user has already asked you to resolve it: fix the
   conflicted files in the checkout, commit the merge there, and call `done` again
   with the same request, in this session. Committing a merge may need elevated
   permission in the session; ask for it openly rather than retrying around it, and if
   the user is not there to grant it, stop and report.
   **Not the same as `dirtyCheckout`.** A row flagged **`dirtyCheckout: true`** is the
   user's own working checkout, which a merge would overwrite. No merge was started and
   there are no markers to reconcile, so sending anyone after conflict files wastes the
   trip. That work is the user's and may have nothing to do with this task: do **not**
   commit or stash it on their behalf. Say what is in the way, name the checkout, and
   let them deal with it — then call `done` again.

---
name: task-worktree-space
description: Use when the user starts a task or feature spanning one or more repositories and wants the work isolated in its own git worktree workspace rather than the source checkouts - multi-repo, parallel sessions, an isolated branch - or asks to list, merge or clean up a finished task. Chinese phrasings that mean the same include 多仓库并行开发、独立工作目录、工作区隔离、任务空间、Worktree Space、收尾合并清理.
---

# Task Worktree Space

Isolate work per task using git worktrees, in a source root that holds one or
more git repositories. One task is one directory outside the source tree holding
a worktree of every selected repository, all on the same branch, so a single
session can edit across repositories while other sessions and the source
repositories stay untouched.

Drive the whole workflow through the `task_worktree_space` tool. Do not run
`git worktree` commands by hand for it.

> **Beta (experimental)**: handing a merge conflict to an agent is the part of this plugin
> that may still change, so tell the user that reports belong at
> https://github.com/kangtsang/dsh-worktree-space/issues when something goes wrong.

## The model

```
E:\workspace\public\projects\      ← source root: the repositories, stay on main
├── project_a\
└── project_b\

E:\worktree-space\                 ← task space: outside the source tree
└── fix-login\                     ← the task directory — the session's cwd
    ├── project_a\                 ← worktree, branch task/fix-login
    └── project_b\
```

For a single repository the shape is the same: the source root is that one
repository and the task directory holds a single worktree of it.

Why this shape:

- **File isolation** — each task directory is a physically separate checkout, so
  sessions cannot overwrite each other's uncommitted work.
- **Commit isolation** — every worktree is on `task/<task>`, so commits from
  different tasks never interleave on one branch.
- **Cross-repo coherence** — every repository in a task shares the branch name;
  that is what links the task's commits across repositories.
- **Source/work separation** — the task space is a directory of its own, never
  inside the source root; the tool refuses a nested layout.

## Starting a task (ask first, then create)

Follow this order. Never create a workspace with a guessed location.

1. **Task name** — take it from the user's message; ask when it is missing.
2. **Source root** — the directory holding the repositories, usually the
   session's working directory. If that directory is itself a git repository it
   is used directly; a git worktree checkout is not a source root.
3. **Run `action: "suggest-root"`** with that directory as `sourceRoot`. It
   reports the repositories the task would span and the recommended task space
   location — `worktree-space` inside the first directory below the volume root
   that the source root sits in, so the task space and the source tree share a
   prefix and a session opened on their common ancestor can still reach each
   worktree's index (which lives under the source repository's
   `.git/worktrees/<name>/`) to commit and to resolve a conflict. A source root
   sitting directly under the volume root shares nothing but that root with its
   worktrees, so a session there has to be approved in by the user.
4. **Ask the user where the task space should live**, offering the recommendation
   first and one or two alternatives. Skip the question only when the user
   already stated the location. Never offer a location inside the source root.
5. **Ask which repositories** to include when the source root holds several and
   the user did not say; pass the chosen directory names as `repos`.
6. **Ask which commit to start from** — recommend each repository's current HEAD
   (omit `baseRef`); alternatives are another active branch or the main branch.
7. **Branch prefix** — `task/` unless the user asks for another one; pass the
   choice as `branchPrefix` and expect the branch to be that prefix plus the task
   name (`hotfix/<task>`, `release-<task>`, …).
8. **Run `action: "create"`** and report the task directory path and the branch
   name.
9. **Work in the task directory**: it is where the task's session belongs.

Pass `push: true` only when the user explicitly asked for a remote branch.
Branches are local-only by default.

## Working inside a task space

When the working directory is a task directory — a folder whose subfolders are
worktrees of different repositories:

- The task directory itself is **not** a git repository; run git commands inside
  each repository subdirectory.
- Commit in **each repository separately**; there is no cross-repo commit. The
  branch name is the same everywhere.
- **Never edit, commit or merge in the source repositories** — for the session
  they are read-only references.
- **Never merge by hand** from a session: not the task branch, and not into any
  branch of the source repositories. Finishing a task is the user's action, and it
  merges into whichever branch each source repository has checked out.
- Read the task's `worktree-space.md` for its branch, base and repositories rather
  than guessing (the same facts as data live in `worktree-space.json`); if another
  session created the workspace, follow that file.

## Finishing a task

Run `action: "done"`. By default it **removes the worktrees, keeps every branch,
and keeps any stray files** the session left in the task space — it does not
merge, delete a branch, or delete stray files unless asked.

Confirm each destructive step with the user before passing it:

1. **Merge?** Only when the user explicitly says to merge. Pass `merge: true`. The
   merge puts the **task branch into the target branch** and it lands in the source
   repository; by default the target is the branch each source repository has checked
   out — the task's own starting point. Ask which branch to merge into when the user
   has another one in mind, and pass it as `target` (one branch for every repository);
   a branch that is checked out nowhere is merged in a temporary worktree, so no
   source checkout is ever switched. Before the target is touched, the target is
   merged into the task branch **in the opposite direction**, inside the task space's
   own worktree (`git merge --no-ff --no-edit <target>`): a clean pre-merge is undone
   again (`git reset --hard` to the HEAD from before it), while a conflict is left
   standing there — the worktree keeps its `MERGE_HEAD` and its unresolved files —
   and that repository's worktree and branch stay in place. Either way the target
   branch and the source checkout are untouched, and the other repositories still
   complete. The pre-merge is skipped only when the target is already contained in the
   task branch (`git merge-base --is-ancestor <target> <branch>`).
2. **Work nobody committed?** Nothing to decide and nothing to pass: `done` reports
   every repository the plan showed uncommitted changes for, keeps its worktree, and
   names the checkout in the row's `error` — `uncommitted work is waiting in
   <path>`. Nothing is committed until the user presses **Authorize the agent to
   commit** in the panel, and that button opens **one** session shared by every
   affected repository, working in the common ancestor of their worktrees (or of
   each worktree and its source repository, when the Host named it), so commit in
   **each** of those repositories, on the task branch, with a
   message that says what the changes were for and why; read them first and never
   commit over the user's work blind, and never push. Committing changes the source
   repository's `.git` directory and may need elevated permission, which is granted in
   the session itself — the plugin never asks for it. Where those repositories share
   nothing but the volume root it is still that **one** session: it works in the task
   space, which reaches every one of their worktrees but need not reach the index
   inside the source repositories' `.git`, so ask the user to approve the elevation in
   that session instead of assuming the git commands will go through. The wait is skipped for a
   branch being deleted unmerged (a commit would be deleted with it), for a worktree
   in the middle of an unfinished merge (step 3 takes it), and for `force: true`,
   which discards uncommitted work along with the worktree. A commit that fails keeps
   that repository as it is — not merged, not removed — while the others carry on.
   The commits do not carry the finish on by themselves either: once that session
   stops the plugin reads the plan again, and where the worktrees have all come back
   clean the panel says the commits are done under a green light and waits for the
   user's own **Finish task** press — the step after it is the merge.
3. **A conflict?** The answer for a repository left on a conflict reports
   `mergeInProgress`, `mergeSite` — the checkout the conflict stands in, inside the
   task space — and `conflictedFiles`. Nothing is opened by itself here either: the
   user presses **Authorize the agent to resolve it** in the panel, and that session is
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
   green light and **The conflict is resolved: carry on and finish the task.** — asking for the next
   `done` is the user's move, with the panel's **Continue finishing** button: what it does is merge
   the branch into their own checkout, so it waits for them. Resolving a conflict yourself does not
   end the task, and only that second `done` finishes it.
4. **Delete the branch?** After a merge, and only when the user asks: pass
   `deleteBranch: true` together with `merge: true`. When the user wants the task
   space gone without merging anything, that is the abandon path: pass
   `deleteBranch: true` with `force: true` and `merge: false`, which removes the
   worktrees and force-deletes the branches with the commits on them.
5. **Stray files?** When the outcome lists strays (agent notes, editor caches, a
   plan), show them and ask which to *keep*; then pass `cleanStray: true` with
   `keep: [...]` naming those. Keeping everything means passing neither.

Each repository row answers `mergeInProgress`, `mergeSite` and `conflictedFiles`;
`mergeInProgress` is what marks a repository the finish left on a conflict.

## Failure modes worth knowing

- A task space inside the source root, or a source root inside the task space, is
  refused: work and source must stay isolated.
- `create` refuses a task name whose branch already exists in any repository —
  pick another name.
- `create` refuses a base that any repository does not have.
- Removing a worktree refuses when it still has uncommitted changes; `done` waits for
  an agent to commit those first, so this is the exception rather than the rule. It
  reports the refusal and keeps the worktree so nothing is lost. Pass `force: true`
  only when the user has deliberately decided to discard that work.
- `create` rolls back the worktrees and the task space when any repository fails,
  so a failed create leaves no half task behind.
- A task name may not contain `/`, `\` or whitespace: it becomes the task space
  directory name and the branch suffix.

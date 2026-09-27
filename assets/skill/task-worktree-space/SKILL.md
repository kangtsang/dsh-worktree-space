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
   location.
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
- Read the task's `README.md` for its branch, base and repositories rather than
  guessing; if another session created the workspace, follow that file.

## Finishing a task

Run `action: "done"`. By default it **removes the worktrees, keeps every branch,
and keeps any stray files** the session left in the task space — it does not
merge, delete a branch, or delete stray files unless asked.

Confirm each destructive step with the user before passing it:

1. **Merge?** Only when the user explicitly says to merge. Pass `merge: true`. By
   default the merge lands on the branch each source repository has checked out —
   the task's own starting point. Ask which branch to merge into when the user has
   another one in mind, and pass it as `target` (one branch for every repository);
   a branch that is checked out nowhere is merged in a temporary worktree, so no
   source checkout is ever switched. A conflict leaves that repository's worktree
   and branch in place and reports it; the other repositories still complete.
2. **Delete the branch?** Only after it is merged, and only when the user asks.
   Pass `deleteBranch: true` together with `merge: true`.
3. **Stray files?** When the outcome lists strays (agent notes, editor caches, a
   plan), show them and ask which to *keep*; then pass `cleanStray: true` with
   `keep: [...]` naming those. Keeping everything means passing neither.

## Failure modes worth knowing

- A task space inside the source root, or a source root inside the task space, is
  refused: work and source must stay isolated.
- `create` refuses a task name whose branch already exists in any repository —
  pick another name.
- `create` refuses a base that any repository does not have.
- Removing a worktree refuses when it has uncommitted changes; `done` reports
  that and keeps the worktree so nothing is lost. Pass `force: true` only when
  the user has deliberately decided to discard that work.
- `create` rolls back the worktrees and the task space when any repository fails,
  so a failed create leaves no half task behind.
- A task name may not contain `/`, `\` or whitespace: it becomes the task space
  directory name and the branch suffix.

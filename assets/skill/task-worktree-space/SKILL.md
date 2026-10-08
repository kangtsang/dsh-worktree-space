---
name: task-worktree-space
description: Use when the user starts a task or feature spanning one or more repositories and wants the work isolated in its own git worktree workspace rather than the source checkouts - multi-repo, parallel sessions, an isolated branch - or asks to list, merge or clean up a finished task, or to deploy a task's services to a Docker environment for acceptance - 部署验收, 隔离环境, 验收地址. Chinese phrasings that mean the same include 多仓库并行开发、独立工作目录、工作区隔离、任务空间、Worktree Space、收尾合并清理、部署验收.
---

# Task Worktree Space

Isolate work per task using git worktrees, in a source root that holds one or
more git repositories. One task is one directory beside the repositories' directory holding
a worktree of every selected repository, all on the same branch, so a single
session can edit across repositories while other sessions and the source
repositories stay untouched.

Drive the whole workflow through the `task_worktree_space` tool. Do not run
`git worktree` commands by hand for it.

> **Beta (experimental)**: handing a merge conflict to an agent is the part of this plugin
> that may still change, and the plugin's own configuration can hide the two entries that
> offer it - so never promise the user a button that may not be on screen. Tell them that
> reports belong at
> https://github.com/kangtsang/dsh-worktree-space/issues when something goes wrong.

## The model

```
~/workspace/                        ← the root workspace: the first directory below the volume root
├── projects/                        ← source root: the repositories, stay on main
│   ├── project_a/
│   └── project_b/
├── deep/other-project/              ← another source root, filed deeper — same container
└── worktree-space/                  ← container root: one level below the root workspace
    └── projects/                    ← project layer: the source root's own directory name
        └── fix-login/               ← the task directory — the session's cwd
            ├── project_a/           ← worktree, branch task/fix-login
            └── project_b/
```

The container root holds one directory per **project** — the source root's own
directory name, derived rather than asked for — and each project holds its tasks.
That is what keeps two projects' tasks of the same name apart, and it is the same
depth in every case, so the task directory is always `<container root>/<project>/<task>`.

For a single repository the shape is the same: the source root is that one
repository and the task directory holds a single worktree of it. Where the source
root **is** the repository, the project layer and the repository take the same
name — `~/workspace/repo-x` gives `<container root>/repo-x/fix-login/repo-x` —
and that repeat is deliberate, not a mistake to correct.

The container root is the plugin's own zone: the first task space created under it
writes a `README.md` there saying so, and a container root that is itself a git
repository (it has a `.git`) is refused outright.

Why this shape:

- **File isolation** — each task directory is a physically separate checkout, so
  sessions cannot overwrite each other's uncommitted work.
- **Commit isolation** — every worktree is on `task/<task>`, so commits from
  different tasks never interleave on one branch.
- **Cross-repo coherence** — every repository in a task shares the branch name;
  that is what links the task's commits across repositories.
- **Source/work separation** — the task space is a directory of its own: never
  inside the repositories' directory, and never a parent of it; the tool refuses
  both.

## Starting a task (ask first, then create)

Follow this order. Never create a workspace with a guessed location.

1. **Task name** — take it from the user's message; ask when it is missing.
2. **Source root** — the directory holding the repositories, usually the
   session's working directory. If that directory is itself a git repository it
   is used directly; a git worktree checkout is not a source root.
3. **Run `action: "suggest-root"`** with that directory as `sourceRoot`. It
   reports the repositories the task would span and the recommended container
   root — `worktree-space` one level below the **root workspace**, that is, in
   the first directory the source root sits in below its volume root. Two source
   roots under the same root workspace are offered the same container however
   deep their own project is filed (`~/workspace/projects` and
   `~/workspace/deep/other-project` both recommend
   `~/workspace/worktree-space`). The task space and the source tree therefore
   share a prefix, and a session opened on their common ancestor can still reach
   each worktree's index (which lives under the source repository's
   `.git/worktrees/<name>/`) to commit and to resolve a conflict. A source root
   sitting directly under the volume root shares nothing but that root with its
   worktrees, so a session there has to be approved in by the user.
   The plugin's own configuration can name the container root instead — that
   setting is the user's standing answer to where task spaces go — and
   `suggest-root` reports that one when it is set, so report what it returns
   rather than a location of your own.
4. **Ask the user where the task space should live**, offering the recommendation
   first and one or two alternatives. Skip the question only when the user
   already stated the location, and expect the recommendation to be the
   configured container root when the plugin has one. Never offer a location
   inside the repositories' directory, and never one that would hold it.
5. **Ask which repositories** to include when the source root holds several and
   the user did not say; pass the chosen directory names as `repos`.
6. **Ask which commit to start from** — recommend each repository's current HEAD
   (omit `baseRef`); alternatives are another active branch or the main branch.
7. **Branch prefix** — `task/` unless the user asks for another one; pass the
   choice as `branchPrefix` and expect the branch to be that prefix plus the task
   name (`hotfix/<task>`, `release-<task>`, …).
8. **Run `action: "create"`.** It does both halves: it makes the task directory,
   the branch and one worktree per repository **and registers the result as a DSH
   Workspace**, which is what puts the task space in the workspace list under
   `<source workspace title>/<task>`.
9. **Report where it is, and say which entry opens the session.** A session is
   opened *with* the Workspace, and opening one is not something this tool can do:
   that is the panel's **Create and open** in the Worktree Space dialog, or
   picking the registered Workspace in the workspace list. Report the task
   directory path and the branch name, then name that entry rather than leaving
   the user to find it.
   A create that answers with a warning that the Workspace was **not** registered
   means the deployment serves no workspace registry, or the registration itself
   failed; the warning names which. Register the directory before anything is
   opened in it — **Create and open**, or **Register again** when a create is
   refused — and do not report the task as under way until that is done, because
   until then nothing in the interface shows the task space.
10. **Work in the task directory**: it is where the task's session belongs.

Task branches are local only. Pushing one to a remote is the user's own action:
this plugin never writes to a remote, so never push from here.

## Adding a repository to a task already under way

Run `action: "add"` when a task that already exists turns out to need a repository
it did not start with. Do **not** create a second task for it, and do not run
`git worktree` by hand.

- Pass `tasksRoot` (the container root), `task`, and `project` — or `sourceRoot`
  instead of `project`, as for `done`.
- Pass each repository in `repos` as an **absolute path**, not a name. A repository
  added this way does not have to sit under the source root the task began from:
  it may be under another source root, or on another volume entirely.
- `baseRef` is optional. Omitted, each repository starts from its own HEAD; pass the
  task's own `baseRef` to have them start from what the task started from.
- The new repository joins the branch the task is already on, and the task's
  metadata records where its source repository lives.
- Nothing is removed from a task this way. There is no "remove a repository"
  action: if the user asks for one, say so rather than approximating it with
  `git worktree remove` or a delete.

Where a repository lives changes nothing about finishing. A finish reads each
worktree's own source repository, so the merge, the worktree removal and the
branch deletion all work the same from any volume. What it does change is the
write boundary of a session that commits here: a linked worktree keeps its git
metadata inside its source repository, so a repository that shares no common
directory with the task space — another volume, certainly — is outside a session
opened on the task space. The finish dialog already says so when it hands commits
or a conflict to an agent, and asks for the elevation in that session. Say it
when you add such a repository rather than letting the user meet it at the end.

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

## Deploying for acceptance

When the user wants to try the work, or a change only shows itself at runtime,
deploy the task space's services to an isolated Docker environment instead of
starting them on the host: ports cannot collide with anything the user already
runs, the services reach each other over their own network, and tearing the
whole environment down afterwards is one command.

A task space is deployable when one of its repositories carries a
`deploy/deploy.sh` of its own, or when the space holds a `deploy/` orchestration
root beside the worktrees — a `docker-compose.yml` whose build contexts name the
sibling worktrees. When neither exists and the user asks to deploy, scaffolding
that root from the repositories' own run commands is ordinary session work; what
must not happen is starting the services on the host instead.

- Take the environment id from `worktree-space.md` (`DSH_ENV_ID=...`) and pass it
  to **every** deploy command. It is what keeps this task's containers, images and
  acceptance URL apart from every other task's — never guess one, and never reuse
  another task's.
- `./deploy.sh up` builds and starts the environment and prints the acceptance
  URL. Run `./deploy.sh smoke` and let it pass **before** reporting the URL: an
  address that answers 500 is not a deliverable. When it fails, the reason is
  usually in `./deploy.sh logs <service>`.
- Report the URL together with what to click to see the change, and say that the
  environment keeps running until it is destroyed.
- Leave the environment to the user. `./deploy.sh destroy` tears it down when they
  are done with it; every deployed container carries a `dsh.env-id` label, so an
  environment can also be found and cleaned up after the fact.

## Finishing a task

Run `action: "done"`. By default it **removes the worktrees, keeps every branch,
and keeps any stray files** the session left in the task space — it does not
merge, delete a branch, or delete stray files unless asked.

Name the task's own layer as well as the container: pass `tasksRoot` (the container
root), `task`, and `project` — the source root's directory name. Passing `sourceRoot`
instead of `project` is enough, since the name is derived from it; passing neither is
refused, because the container root alone cannot say which project's task of that name
was meant.

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
   <path>`. Nothing is committed until the user presses **Hand the commits to the
   agent** in the panel, and that button opens **one** session shared by every
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
   user presses **Hand the conflict to the agent** in the panel, and that session is
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
   **One exception, by the task's own policy:** when the task's `worktree-space.md`
   records `Conflicts: agent-auto`, the user has already delegated the whole loop -
   do not wait for the panel button or report and stop. Resolve the conflicted files
   in the checkout, commit the merge there, and call `done` again with the same
   request, in this session. Committing a merge may need elevated permission in the
   session; ask for it openly rather than retrying around it, and if the user is not
   there to grant it, stop and report - the delegation covers the decision, never a
   silent permission.
4. **Delete the branch?** After a merge, and only when the user asks: pass
   `deleteBranch: true` together with `merge: true`. When the user wants the task
   space gone without merging anything, that is the abandon path: pass
   `deleteBranch: true` with `force: true` and `merge: false`, which removes the
   worktrees and force-deletes the branches with the commits on them.
5. **Stray files?** When the outcome lists strays (agent notes, editor caches, a
   plan), show them and ask which to *keep*; then pass `cleanStray: true` with
   `keep: [...]` naming those. Keeping everything means passing neither.

The Workspace registration follows the directory. When the finish removes the task
space itself, `done` drops the registration too, so the task space leaves the
workspace list and its sessions move to "Ungrouped". A finish that keeps the
container — a conflict left standing, uncommitted work, strays that were kept —
keeps the registration as well, because the directory is still there and the list
has to go on showing it. A registration that could not be dropped is reported as a
**warning** over a finish that still happened; remove it from the workspace list by
hand.

Each repository row answers `mergeInProgress`, `mergeSite` and `conflictedFiles`;
`mergeInProgress` is what marks a repository the finish left on a conflict.

## Failure modes worth knowing

- A task space inside the repositories' directory, or a directory that holds them,
  is refused: work and source must stay isolated.
- A container root that is itself a git repository (it holds a `.git`) is refused
  before anything is created — that zone is for worktrees, not for a checkout of
  its own. Point `tasksRoot` somewhere that is not a repository.
- `create` refuses a task name whose branch already exists in any repository —
  pick another name.
- `create` refuses with **E2002** when a task space for exactly this task, project
  and branch is already on disk — which means an earlier create made the container
  and stopped before its Workspace was registered, usually one made by this tool
  before it registered anything. The worktrees and the branch are still there, so
  nothing is lost: register it (**Create and open**, or **Register again** in the
  dialog once the refusal is shown), or finish and remove it. Creating again under
  that name keeps failing until one of the three is done. An **E2001** on the same
  name is the other situation — the name belongs to a different task space — and it
  is not recoverable this way.
- `create` reports a **warning** rather than a failure when the task space was made
  but its Workspace could not be registered. The task space is real and usable; what
  is missing is only the entry in the workspace list, and the warning says so.
- `done` asks first whether its worktrees can actually be removed, and refuses with
  **E5011** while any of them is held by something outside the process — a dev server,
  a browser, an editor started in the task space. Nothing has been merged, removed or
  filed at that point: close it, then finish again. The answer names each directory and
  what blocked it, and the check only renames a directory and puts the name back, so a
  refusal leaves the task space exactly as it was.
- A stray that holds a **link** cannot be filed on a machine that will not create
  symbolic links — an ordinary Windows installation, without Developer Mode: `done`
  keeps it and names the entries in the way. A link is a name for somewhere else, so
  the plugin will not copy whatever it points at instead. Removing or moving those
  entries out is one delete each and needs no privilege, and finishing again then
  files the rest.
- A repository whose worktree `git` has **unregistered but could not delete** is
  reported as a repository still on disk, never as a stray: `done` will not file a
  checkout away as the user's documents, and will not delete it either. Read that
  row's `error`, remove the directory by hand, then finish again. This is rare —
  `done` finishes git's own delete itself when it can — and happens only while
  something outside the plugin is holding those files.
- `create` refuses a base that any repository does not have.
- `add` refuses a repository the task already holds a worktree of: every worktree
  is named after its source repository's directory, so two of them cannot share a
  name inside one task.
- `add` refuses a repository that sits inside the task space or holds it — a
  worktree cut from such a repository would be written inside itself.
- `add` takes back only the worktrees it made when it fails partway. The task's
  own repositories are left exactly as they were; a repository that could not be
  removed is named in the message and still on disk.
- Removing a worktree refuses when it still has uncommitted changes; `done` waits for
  an agent to commit those first, so this is the exception rather than the rule. It
  reports the refusal and keeps the worktree so nothing is lost. Pass `force: true`
  only when the user has deliberately decided to discard that work.
- `create` rolls back the worktrees and the task space when any repository fails,
  so a failed create leaves no half task behind.
- A task name may not contain `/`, `\` or whitespace: it becomes the task space
  directory name and the branch suffix.

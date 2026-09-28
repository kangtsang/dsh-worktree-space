# Worktree Space

Worktree Space for DeepSeek Harness: one task can span several repositories. Each one gets
its own Git worktree on the same branch, kept in a task space outside the source tree and
registered as a DSH Workspace with its own sessions.

![DeepSeek Harness Plugin](https://img.shields.io/badge/DeepSeek%20Harness-Plugin-7c5cff)
![License](https://img.shields.io/badge/license-MIT-22c55e)

<img src="docs/img/manage-worktree-space.png" alt="The management page: Tasks, Workspaces and Repositories views" width="960">

[中文](README.md) · **English**

> **Beta (experimental)**: behaviour may still change — please report problems in
> [GitHub Issues](https://github.com/kangtsang/dsh-worktree-space/issues).

## Features

- **Create a task from a session.** Pick a source root, name the task, choose the branch prefix,
  tick the repositories it should span, and say where the task space goes. Every repository gets a
  worktree on `<branch prefix><task>` — `task/<task>` by default — starting from each repository's
  current HEAD, or from a branch or commit you name.
- **Registered as a Workspace** named `<parent>/<task>`, opened with a session whose working
  directory is the task space, so an agent can edit across repositories without touching the
  source checkouts.
- **A management page**, with three views (both ways in, and their defaults, are described under Manage tasks):
  - **Task spaces** puts each task's repositories together (branch, how many files changed,
    whether it is locked or prunable);
  - **Workspaces** shows which Workspaces can host a task space, and how many repositories
    each one has;
  - **Git repositories** lists every Git repository found and the worktrees linked to it.

  All three can be searched, and **Needs attention** narrows them to rows worth a look
  (changes, a lock, something prunable, or a status that failed to read). The arrow on a row
  folds that row on its own; the button beside the filters folds or opens them all at once.
- **Finish a task** from its row. By default each repository's branch is merged back into the
  branch that repository has checked out — the task space's own starting point, since nothing
  here switches a source checkout — and the dialog can point any repository at another local
  branch instead, which is then merged in a temporary worktree without touching your checkout.
  The worktrees are removed, the task space's own documents are filed under
  `archived-docs/<workspace>-<YYYYMMDD-HHMMSS>` (leave the archive option unticked and they
  are deleted along with everything else), and the Workspace registration is removed. It will not finish while a
  session in that Workspace is still running — stop it or let it end, then try again.
- **Finish task space** also sits in that workspace list's own `⋯` menu, for directories that
  really are task spaces.
- **New task space** is in that same `⋯` menu, for Workspaces that hold repositories, and
  opens the one create dialog.
- **No extra service needed.** The two entries, the scan depth and the directory limit all
  live in the plugin's own configuration (see Configuration). It follows DSH themes, takes
  its language from DSH, and gives the plugin list its own name, description and icon.

## Layout of a task

```text
<task space root>/
├── <task>/                        the task space — also the session's working directory
│   ├── worktree-space.json        the task's record: branch, base, repositories, created
│   ├── worktree-space.md          rendered from that record — branch, base and conventions
│   ├── <repository A>/            a worktree on <branch prefix><task>
│   └── <repository B>/            a worktree on the same branch name
└── archived-docs/
    └── <parent>-<task>-20260926-020933/    documents filed here when a task is finished
```

Removing a worktree never deletes its Git branch; finishing a task merges the branch back
before the worktree goes.

## Compatibility

Built against the DSH **0.1.7-rc.1** client contract (web profile). Verified on
`0.1.7-rc.1`: the host RPC routes register, the client bundle loads without changes, and the
plugin list shows the name, description, icon and configuration section correctly.

## Usage

### Install

**From npm:**

```sh
dsh plugin --profile web add dsh-worktree-space
```

The plugin's row lives in the profile's `cordis.patch.yml` — this repository carries DSH's bundle
patch, which normally writes it for you; if the plugin never shows up, add it by hand:

```yaml
- id: worktree-space
  name: dsh-worktree-space
  config:
    panelEntry: hide         # the management page's row under New session (hidden by default)
    sidebarEntry: show       # the shortcut in the sidebar footer (shown by default)
    scanDepth: 2
    maxScanDirectories: 1000
```

To uninstall: `dsh plugin --profile web remove dsh-worktree-space`. To update, remove and reinstall.

### Configuration

**In the UI** (recommended): sidebar → **Plugins** → **Worktree Space** → its configuration
section, beside every other plugin's; changes take effect immediately, no restart. You can also
edit the file: the plugin's `config:` block in `profiles/<profile>/cordis.patch.yml` under the DSH
data directory (as in the sample above), which needs a DSH restart.

| Setting | Values | Default | Meaning |
| --- | --- | --- | --- |
| Panel entry (under New session) | show / hide | **hide** | The row in the sidebar's panel list that opens the management page full-width (the page brings its own left-hand navigation and its Back to conversation); hidden by default |
| Shortcut in the sidebar footer | show / hide | show | The shortcut at the sidebar foot, opening that same page as a **dialog** |
| Scan depth | 1–5 levels | 2 levels | How many levels below a Workspace directory (level 0) the scan looks for Git repositories |
| Scan directory limit | 500 / 1000 / 2000 / 3000 / 5000 / 10000 | 1000 | How many directories one scan may read; past it you are asked for a smaller Workspace |
| Default branch prefix | any text | `task/` | The prefix a new task space starts from; changing it in the create dialog and ticking Set as the default branch prefix writes it back here when you create |
| Archive documents directory | any path | empty | Where a finished task's documents are filed; empty files them under each Workspace's own title directory |

A scan covers **every** Workspace. It goes breadth-first, reading up to eight directories at
a time per level. Any directory holding `.git` counts as a repository; `node_modules`,
`dist`, `build`, `vendor` and hidden directories are skipped (except `.worktrees`).

### Create a task

<img src="docs/img/new-worktree-space.png" alt="New Worktree Space" width="720">

1. In a session, click **New Worktree Space** above the composer.
2. Name the task — it is lower-cased, and spaces, Chinese and other characters become dashes
   (`hotfix-placeorder`); an invalid name tells you which rule it breaks.
3. Set the **branch prefix** if you want another one. The branch is this prefix plus the task
   name, and an empty field falls back to the configured default (`task/` unless you changed it).
   The line under the field always names the default it would use. Tick **Set as the default
   branch prefix** — offered only when what you typed differs from the configured default — to
   write it back to the plugin's settings when you create.
4. Say where the task space goes. It has to sit outside the source tree, and a recommended
   path is filled in for you.
5. Tick the repositories the task should span — each card names the branch its HEAD is on — and
   choose the branch base.
6. Click **Create and open**. The new Workspace opens a session whose working directory is the
   task space.

If the task space is built but registering the Workspace fails, the dialog says why and lets
you retry the registration.

### Manage tasks

Open the **management page** — two ways in:

- **The Worktree Space shortcut at the sidebar foot** (shown by default) — opens it as a **dialog**;
- **The Worktree Space row under New session** (hidden by default, turn it on in the
  **configuration**) — opens it **full width** in the main column, where the page brings its own
  left-hand navigation: **Back to conversation** first, since the panel takes the column the
  conversation was in, then the three views. The dialog form keeps the switcher in its toolbar.

The three
views differ as described under Features: Task spaces shows each task and its repositories,
Workspaces shows where a task space can start, Code repositories shows every Git project found
and its worktrees. The summary on the right follows the view (`N tasks` / `N Workspaces` /
`N repositories · M Worktrees`), and reads `shown / total` while a search or filter is
narrowing the list.

The panel rescans every time it is opened, but it first paints what the Host still remembers
of the previous scan, so it shows data straight away and swaps in the fresh result when the
scan lands (`Scanning every Workspace…` marks the wait). That memory lives in the DSH instance's own
process only: nothing is written to disk, and it is gone when the instance exits.

### Finish a task

<img src="docs/img/finish-task.png" alt="The Finish task dialog" width="960">

Use **Finish task** on the task row, or **Finish task space** in the workspace list's `⋯` menu.
The dialog spells out what is about to happen — uncommitted files, commits to merge, the
branch to merge into, and the task space's own documents (the archive option only appears
when there is something to archive). Merging back is selected by default; deleting the
branch and forcing are not.

Finishing a task space is one standard path, in three steps:

**1. Commit.** Every repository worktree in the task space is walked: one that holds
uncommitted changes gets `git add -A` and then
`git commit -m "chore(task): commit work in progress before finishing the task space"`, on
its own task branch. This step always runs, takes no parameter and needs no opt-in. The one
exception is a deliberate delete-without-merge — abandoning the task space with
`deleteBranch` and `force` — where that commit would be deleted along with the branch, so it
is skipped. A worktree in the middle of an unfinished merge (it holds `MERGE_HEAD`) is
skipped too and left to the merge. A commit that fails (a hook refusing, a missing
`user.name`/`user.email`, gpg signing, `index.lock`, a file in use) affects that repository
only: it is neither merged nor removed and keeps its state, the others carry on, and the
result names each one.

**2. Merge.** The task branch is merged into the target branch. Before that, the target is
pre-merged into the task branch **inside the task space's own worktree**
(`git merge --no-ff --no-edit <target>`): when that comes out clean, the pre-merge is undone
again (`git reset --hard <the HEAD from before the pre-merge>`), and the task branch is then
merged into the target branch as usual; when it conflicts, that merge is **not aborted and
not reverted** — the conflict stays exactly where it stands, in that worktree, which keeps
its `MERGE_HEAD` and its unresolved files.

**3. Stop on a conflict and ask for the agent.** As soon as one repository stands on a
conflict the whole finish is partial (`failed: true`, the container stays, and the other
repositories may already be merged and removed). Every repository row reports
`autoCommitted`, `mergeInProgress`, `mergeSite` (the directory the conflict stands in) and
`conflictedFiles`. The dialog then shows the conflicting repositories, the site paths and
the conflicted files, and offers **Hand the conflict to an agent**: clicking it opens a
separate session for every conflicting repository, working in the **common ancestor of the
conflict site and the main repository** — a linked worktree keeps its git metadata under the
main repository's `.git`, and a session's write boundary is its working directory, so the
common ancestor is what lets the agent both edit the files and commit the merge without
another approval (where the two share only a volume root, the site itself is used) — with
resolving the conflict and committing the merge as its first message. Once the
agent is done, **the user clicks Continue**, and the plugin finishes the task again with the
same request: the merge is already written, so what is left is merging into the target
branch, removing the worktrees, deleting the branches, archiving and cleaning up. The plugin
only opens the session; the agent does the resolving.

Deleting a branch normally needs the merge: deselect the merge and the branch option goes
with it. To abandon a task space instead of finishing it — nothing merged, the branches and
the commits on them discarded — select **Force** as well, which is what allows deleting a
branch that was never merged; abandoning is also the one combination that skips the commit
in step 1.

#### What each combination does

| Merge back | Delete branch | Force | What happens |
| --- | --- | --- | --- |
| ✓ | | | Each repository's uncommitted changes are committed on its own task branch first, and its branch is then merged into the target chosen on its own row (by default the branch that repository has checked out) with `--no-ff`; the worktrees are removed; **the branches stay**. A repository standing on a conflict keeps its place, the others still finish |
| ✓ | ✓ | | The same, and the branch is deleted once merged (`git branch -d`, so an unmerged branch cannot be deleted this way) |
| ✓ | | ✓ | The same as merging alone: the uncommitted changes were committed at step 1, so Force changes nothing further here; the branches stay |
| ✓ | ✓ | ✓ | Merge and force-delete the branch (`git branch -D`); the branch was merged, so nothing extra is lost |
| | | | Nothing is merged: the uncommitted changes are committed (they stay on the branch that stays), the worktrees and the task space go, **the branches stay** for you to merge by hand |
| | | ✓ | The same: the commit leaves the worktree clean, so Force changes nothing further; the branches stay |
| | ✓ | ✓ | **Abandon**: nothing merged and nothing committed, the branch force-deleted, and **the commits it held are discarded along with the uncommitted changes in the worktree** |

Whichever combination is chosen: the task space's own metadata — `worktree-space.json` and the `worktree-space.md` generated from it — is always cleared, and an older space may still hold `README.en.md` (cleared too) or a `README.md` this plugin wrote back then, which since 1.0.5 is left alone rather than assumed to be ours; anything else in the task space follows the archive choice (unselected, it is discarded
outright). **A repository whose commit failed, or whose merge stands on a conflict, is kept as it is and reported as unfinished** while the others finish, which is also why the task space directory and its workspace registration stay. The directory and the registration are removed only once every repository really went and the container is empty, and its sessions then fall back to Ungrouped with their transcripts
intact.

The **Finish task** button follows the same reasoning: **amber** is an ordinary finish (the
merge can be reverted and nothing is discarded), and it is **red** only where the dialog can
name what will be lost — abandoning the task space (no merge, force-deleting the branches)
while a worktree still holds uncommitted files, or while a branch still holds commits that
were never merged.

# Worktree Space

Worktree Space for DeepSeek Harness: one task can span several repositories. Each one gets
its own Git worktree on the same branch, kept in a task space outside the source tree and
registered as a DSH Workspace with its own sessions.

![DeepSeek Harness Plugin](https://img.shields.io/badge/DeepSeek%20Harness-Plugin-7c5cff)
![License](https://img.shields.io/badge/license-MIT-22c55e)

<img src="docs/img/manage-worktree-space.png" alt="The management page: Tasks, Workspaces and Repositories views" width="890">

[中文](README.md) · **English**

## Features

- **Create a task from a session.** Pick a source root, name the task, choose the branch prefix,
  tick the repositories it should span, and say where the task space goes. Every repository gets a
  worktree on `<branch prefix><task>` — `task/<task>` by default — starting from each repository's
  current HEAD, or from a branch or commit you name.
- **Registered as a Workspace** named `<parent>/<task>`, opened with a session whose working
  directory is the task space, so an agent can edit across repositories without touching the
  source checkouts.
- **A management page** (the Worktree Space entry in the sidebar footer), with three views:
  - **Task spaces** puts each task's repositories together (branch, how many files changed,
    whether it is locked or prunable);
  - **Workspaces** shows which Workspaces can host a task space, and how many repositories
    each one has;
  - **Code repositories** lists every Git repository found and the worktrees linked to it.

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
│   ├── README.md                  the task's branch, base and conventions
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

**From npm (recommended):**

```sh
dsh plugin --profile web add dsh-worktree-space
```

**Straight from the GitHub repository:**

```sh
dsh plugin --profile web add github:kangtsang/dsh-worktree-space
```

The plugin's row lives in the profile's `cordis.patch.yml` — this repository carries DSH's bundle
patch, which normally writes it for you; if the plugin never shows up, add it by hand:

```yaml
- id: worktree-space
  name: dsh-worktree-space
  config:
    sidebarEntry: show       # the entry in the sidebar footer
    settingsEntry: hide      # whether to offer one in Settings as well
    scanDepth: 2
    maxScanDirectories: 1000
```

To uninstall: `dsh plugin --profile web remove dsh-worktree-space`. To update, remove and install
again.

### Configuration

Change these in **Plugins → Worktree Space** in the sidebar, next to every other plugin's
configuration; they take effect immediately.

| Setting | Values | Default | Meaning |
| --- | --- | --- | --- |
| Sidebar entry | show / hide | show | The Worktree Space entry in the sidebar footer |
| Settings entry | show / hide | hide | Whether to put an entry in Settings as well; the two are independent |
| Scan depth | 1–5 levels | 2 levels | How far down from each Workspace root the scan goes (the root itself does not count) |
| Scan directory limit | 500 / 1000 / 2000 / 3000 / 5000 / 10000 | 1000 | How many directories one scan may read; past it you are asked for a smaller Workspace |

A scan covers **every** Workspace. It goes breadth-first, reading up to eight directories at
a time per level. Any directory holding `.git` counts as a repository; `node_modules`,
`dist`, `build`, `vendor` and hidden directories are skipped (except `.worktrees`).

### Create a task

<img src="docs/img/new-worktree-space.png" alt="New Worktree Space" width="598">

1. In a session, click **New Worktree Space** above the composer.
2. Name the task — it is lower-cased, and spaces, Chinese and other characters become dashes
   (`hotfix-placeorder`); an invalid name tells you which rule it breaks.
3. Set the **branch prefix** if you want another one. The branch is this prefix plus the task
   name, and it defaults to `task/`; clearing the field puts that default back.
4. Say where the task space goes. It has to sit outside the source tree, and a recommended
   path is filled in for you.
5. Tick the repositories the task should span — each card names the branch its HEAD is on — and
   choose the branch base.
6. Click **Create and open**. The new Workspace opens a session whose working directory is the
   task space.

If the task space is built but registering the Workspace fails, the dialog says why and lets
you retry the registration.

### Manage tasks

Open the **management page** from the Worktree Space entry in the sidebar footer. The three
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

<img src="docs/img/finish-task.png" alt="The Finish task dialog" width="612">

Use **Finish task** on the task row, or **Finish task space** in the workspace list's `⋯` menu.
The dialog spells out what is about to happen — uncommitted files, commits to merge, the
branch to merge into, and the task space's own documents (the archive option only appears
when there is something to archive). Merging back is on by default; deleting the branch and
forcing past uncommitted work are not.

Deleting a branch normally needs the merge: untick the merge and the branch option goes
with it. To abandon a task space instead of finishing it — nothing merged, the branches and
the commits on them discarded — tick **Force** as well, which is what allows deleting a
branch that was never merged.

#### What each combination does

| Merge back | Delete branch | Force | What happens |
| --- | --- | --- | --- |
| ✓ | | | Every repository's branch is merged into the target chosen on its own row (by default the branch that repository has checked out) with `--no-ff`; the worktrees are removed; **the branches stay**. A repository whose merge conflicts is left as it is, the others still finish |
| ✓ | ✓ | | The same, and the branch is deleted once merged (`git branch -d`, so an unmerged branch cannot be deleted this way) |
| ✓ | | ✓ | The same, and **uncommitted** changes in the worktrees are discarded (without it, a worktree with uncommitted changes fails `worktree remove` and is kept whole); the branches stay |
| ✓ | ✓ | ✓ | Merge, discard uncommitted changes, force-delete the branch (`git branch -D`); the branch was merged, so nothing extra is lost |
| | | | Nothing is merged: the worktrees and the task space go, **the branches stay** for you to merge by hand |
| | | ✓ | Only the worktrees go, uncommitted changes and all; the branches stay |
| | ✓ | ✓ | **Abandon**: nothing merged, the branch force-deleted, and **the commits it held are discarded with it** |

Whichever combination is chosen: the plugin's own `README.en.md` is always cleared, anything
else in the task space follows the archive choice (unticked, it is discarded outright), and
as long as any repository was kept — a conflicted merge, say — both the task space directory
and its workspace registration stay; otherwise both are removed and its sessions fall back
to Ungrouped with their transcripts intact.

The **Finish task** button follows the same reasoning: **amber** is an ordinary finish (the
merge can be reverted and nothing is discarded), and it is **red** only where the dialog can
name what will be lost — uncommitted files in the plan with Force ticked, or a branch with
commits on it being deleted without a merge.

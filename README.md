# Worktree Space

Worktree Space for DeepSeek Harness: one task spans one or more repositories, each
checked out as a Git worktree on a single shared branch, inside a task space directory
outside the source tree, and registered as a DSH Workspace with its own sessions.

![DeepSeek Harness Plugin](https://img.shields.io/badge/DeepSeek%20Harness-Plugin-7c5cff)
![License](https://img.shields.io/badge/license-MIT-22c55e)

[Simplified Chinese](README.zh.md) · **English**

## Features

- **Create a task from a session.** Choose a source root, name the task, tick which of its
  repositories to span, and choose where the task space goes. Every repository gets a
  worktree on `<branch prefix>/<task>` — `feat/<task>` by default — based either on each
  repository's current HEAD or on a branch or commit you name.
- **Registered as a Workspace** named `<parent>/<task>`, opened with a fresh session whose
  working directory is the task space, so an agent edits across repositories without
  touching the source checkouts.
- **A management page** (the Worktree Space entry in the sidebar footer) with three views:
  - **Tasks** groups the repositories of each task, with branch, change count and
    locked / prunable state;
  - **Workspaces** says which Workspaces a task space can start in, and how many
    repositories each holds;
  - **Repositories** lists every Git repository found and its linked worktrees.

  All three support search and a **Needs attention** filter (rows with changes, a lock, a
  stale record or a failed status). Each row folds with its own arrow, and the button beside
  the filters folds or opens every row at once.
- **Finish a task** from its row: merge each repository's branch back (on by default),
  remove the worktrees, file the task space's own documents under
  `archived-docs/<workspace>-<YYYYMMDD-HHMMSS>` (untick and everything in the task space is
  deleted instead), and remove the Workspace registration. Finishing is refused while a
  session in that workspace is still running.
- **Finish task space** also appears in the workspace list's own `⋯` menu — only for
  directories that are task spaces.
- **No additional service.** Both entries, the scan depth and the directory limit are set in
  the plugin's own configuration (see Configuration). It follows DSH themes, switches
  language with DSH, and supplies its own name, description and icon to the plugin list.

## Layout of a task

```text
<task space root>/
├── <task>/                        the task space — also the session's working directory
│   ├── README.md                  the task's branch, base and conventions
│   ├── <repository A>/            a worktree on <branch prefix>/<task>
│   └── <repository B>/            a worktree on the same branch name
└── archived-docs/
    └── <parent>-<task>-20260926-020933/    documents filed here when a task is finished
```

Removing a worktree never deletes its Git branch; finishing a task merges the branch back
before the worktree goes.

## Compatibility

Built against the DSH **0.1.7-rc.1** client contract (web profile). Verified on
`0.1.7-rc.1`: the host RPC routes register, the client bundle loads unmodified, and the
plugin list shows this plugin's name, description and icon with its configuration section
intact.

## Usage

### Install

```sh
# from a local checkout (development)
dsh plugin --profile web add link:/absolute/path/to/dsh-worktree-space

# from npm (once published)
dsh plugin --profile web add dsh-worktree-space
```

A profile with `patchReload: live` recomposes without a restart; otherwise restart `dsh web`.

### Configuration

Set these in **Plugins → Worktree Space** in the sidebar, beside every other plugin's
configuration; a change applies at once.

| Setting | Values | Default | Meaning |
| --- | --- | --- | --- |
| Sidebar entry | show / hide | show | The Worktree Space entry in the sidebar footer |
| Settings entry | show / hide | hide | Also offer an entry inside Settings; the two are independent |
| Scan depth | 1–5 levels | 2 levels | How far the scan descends from each Workspace root, which itself is not counted |
| Scan directory limit | 500 / 1000 / 2000 / 3000 / 5000 / 10000 | 1000 | Directories one scan may read before it asks for a more specific Workspace |

A scan always covers **every** Workspace — there is no scope control. It is
**breadth-first**, eight directories at a time per level; a directory holding `.git` is a
repository, and `node_modules`, `dist`, `build`, `vendor` and hidden directories are skipped
(except `.worktrees`).

### Create a task

<img src="docs/new-worktree-space.png" alt="New Worktree Space" width="598">

1. In a session, choose **New Worktree Space** above the composer.
2. Name the task — it is lower-cased, and spaces, Chinese and other characters become dashes
   (`hotfix-placeorder`); an invalid name says which rule it breaks.
3. Set the task space location. It has to sit outside the source tree; a recommended path is
   filled in.
4. Tick the repositories the task should span, and choose the branch base.
5. Click **Create and open**. The new Workspace opens with a session in the task space.

If the task space is built but registering the Workspace fails, the dialog says so and
offers to retry the registration.

### Manage tasks

<img src="docs/manage-worktree-space.png" alt="The management page: Tasks, Workspaces and Repositories views" width="890">

Open the **management page** from the Worktree Space entry in the sidebar footer. The three
views differ as described under Features: Tasks for each task and its repositories,
Workspaces for where a task space can start, Repositories for every Git project found and
its worktrees. The summary on the right follows the view (`N tasks` / `N Workspaces` /
`N repositories · M Worktrees`), and shows `shown / total` while a search or filter is
narrowing the list.

### Finish a task

<img src="docs/finish-task.png" alt="The Finish task dialog" width="612">

Use **Finish task** on the task row, or **Finish task space** in the workspace list's `⋯` menu.
The dialog states what will happen — uncommitted files, commits to merge, the merge target,
and the task space's own documents (the archive option appears only when there is something
to archive) — before anything happens. Merging back is on by default; deleting the branch
and forcing past uncommitted work are not.

# Changelog

What changed in each release. Earlier versions live in the git history only; the per-release
evidence for host compatibility is in [`store-evidence.md`](store-evidence.md).
The Chinese version is [`CHANGELOG.md`](CHANGELOG.md).

## 1.3.4 — 2026-10-22

The ability to wait on a session is gone.

### Changed

- **`wts_session_tool` has no `wait` action, and `send` and `create` no longer take
  `waitForReply`.** A leader that blocks on a session can neither take the user's next
  instruction nor act on the report that arrives while it waits — and a dispatched session
  reports its own progress, while a turn that ends badly is pushed to the dispatcher by the
  watcher. There was nothing for the wait to do.

  `timeoutMs` and `requireTurnEnd` go with them: they existed only to bound a block.

  The non-blocking half covers the same ground. `status` tells "stuck" from "busy" off the
  session's own clock, `read` shows what it has actually said, and `send` steers it.
  `read` keeps `sinceSeq`, which is a paging cursor there and was never only a wait
  argument.

  **This is a breaking change for a caller**: one still passing `waitForReply`, or calling
  `wait`, gets an argument-validation error. Send, then look once with `status` / `read`
  when you have a reason to — do not block.

## 1.3.3 — 2026-10-21

Nine tools become two, the skill splits into stages that load on demand, and a routine deploy no
longer needs the skill at all.

### Changed

- **The eight session-control tools are now one.** `wts_session_tool_find` / `_status` / `_read` /
  `_send` / `_create` / `_resume` / `_wait` / `_cancel` are eight actions of
  `wts_session_tool`, chosen by an `action` argument. What each of the eight descriptions repeated
  — where a session id comes from, which actions need a live session, what a `sinceSeq` is for —
  is now stated once, and none of the eight capabilities is gone.

  Three argument names changed so that no word means two things: `find`'s `title` / `cwd` /
  `limit` became `titleMatch` / `cwdMatch` / `resultLimit`. They carry a different meaning from
  `create`'s `title` and `cwd` and `read`'s `limit`, and one tool holding both spellings would
  leave the caller guessing.

### Added

- **The skill loads by stage.** `SKILL.md` is a routing table now, and the body is split across six
  files under `references/` — creating, working, finishing, conflicts, deploying, failures — read
  when you reach that stage rather than all at once. A session that only needs a task space and a
  dispatched job no longer reads a whole skill first.

- **A routine deploy needs no skill.** The task's own `.worktree-space/worktree-space.md` already
  names its deploy entry, its `DEPLOY_ENV_ID` and the state file the gate reads, and the tool
  description now points at it. A task whose deploy script is written and has run before is
  deployed by copying those commands — **`references/deploying.md` is for writing or fixing an
  entry, not for running one that already works.**

- **A dispatched session reports before it starts work.** Before writing any code, it says what it
  takes the job to be and which repositories and files it expects to touch. An aim that was
  misread costs one message there, and a finished change nobody asked for at the end.

### Fixed

- The packaging allowlist was missing the six new `references/` files. They were already shipping
  (`files` declares the whole `assets/` directory), but that list is the guard against unrelated
  files riding along, and an unlisted path is a hole rather than a redundant entry.

## 1.3.2 — 2026-10-20

An adjustable wait for the two deploy-for-acceptance steps, and the host compatibility window
narrowed to 0.2.0.

### Added

- **A deploy entry can set its own wait.** The plugin waited ten minutes for `up` and five for
  `smoke` and stopped the script past that, with nowhere to change either. A task whose smoke
  genuinely needed longer had to shorten the smoke or edit the plugin. An entry may now answer a
  third subcommand, `timeouts`, printing one line of JSON with two second counts:
  `{"upSeconds":1200,"smokeSeconds":900}`. The plugin asks once before each step and runs that
  step under the number it printed; either key may be omitted and keeps its default.

  The subcommand may be left out forever. An entry that does not implement it, exits non-zero,
  prints something that is not JSON, or names a value outside 1–3600 seconds is read as having no
  opinion, and the built-in deadlines stand — **it changes how long the plugin waits, never
  whether the step runs**.

### Compatibility

- **The 0.1.7 line is no longer supported.** The lower bound moves from `0.1.7-rc.1` to
  `0.2.0-rc.1` across all four declarations (`engines.dsh`, both peer dependencies —
  `dsh-client-connection` and `dsh-tools` — and `dsh.compatibility.dsh`), and the verified window
  becomes four releases. A host still on 0.1.7 should stay on 1.3.1.

### Documentation

- The Chinese README now links the plugin's Bilibili introduction.

## 1.3.1 — 2026-10-18

Fixes on the Docker deploy-for-acceptance and conflict hand-off paths, plus two documentation
gaps closed.

### Fixed

- **The deploy and smoke buttons no longer report a missing script on Windows.** The `bash` on
  Windows is not a shell and cannot read a native path such as `D:\...`, so an entry that was
  plainly on disk was reported as `No such file or directory`. The plugin now picks a real shell
  itself, and says so plainly when it finds none.
- **The deploy entry cannot find its own tools.** The fix above let the script run for the first
  time, which exposed `dirname: command not found` on the very next line — a shell started by
  absolute path does not get the utilities beside it. The plugin hands those over now.
- **The smoke and destroy buttons disappear.** Containers came up under the deploy entry's own
  default environment id, so the plugin looked for this task's id, found nothing and treated the
  environment as having no containers at all. The `up` and `smoke` commands in a task space's note
  now carry that id.
- **Handing a conflict to an agent adds a Workspace nobody asked for.** The hand-off session was
  opened on the container root, leaving a row in the workspace list named after a directory that
  holds every project's task spaces. It is opened in the task space itself now, and the finish
  that removes the task space drops that row with it.
- **The conflict session does not appear under its task space.** A session opened on a directory
  that is already a Workspace does not join it by itself, so it worked in the right directory and
  still sat in Ungrouped. The plugin now files it there explicitly.

### Documentation

- Deploying for acceptance now states its prerequisite: a container engine this machine can reach
  (`docker` on PATH with its daemon running). Docker Desktop, Podman, colima and a native Linux
  engine all count.

### Compatibility

- The window covers six DSH releases, adding `0.2.1-rc.1` and `0.2.1-rc.2`.

## 1.3.0 — 2026-10-16

Everything that changed since 1.2.1. This is what a user or an agent can observe; how it was
arrived at is not here.

### Breaking changes

- **The tool is renamed `wts_worktree_space`** (was `task_worktree_space`), and eight new
  `wts_session_tool_*` session tools arrive.
- **`done` requires `merge`.** A call without a boolean is refused (E7006) - a merge is the step
  whose two directions cost differently and cannot be undone.
- **The finish's untracked-content parameter becomes `strays`**: `archive` (the default), `keep`,
  `discard`; the entries to keep move to `keepEntries`. The tool refuses `discard` (E7007).
  **The default also changed**: `archive` removes the task space from disk, where 1.2.1's default
  left it standing.
- **The plugin's own files move into `.worktree-space/`**: the record, the note and the deploy root.
  The old locations are no longer read.
- **The bundled skill is renamed** `task-worktree-space` to `worktree-space`.

### Added

- **Deploying for acceptance, end to end.** A create may state `deployTarget: docker`, which copies
  the workspace's `.worktree-space/deploy/` into the task space; the entry implements `up`, `smoke`
  and `destroy`. `up` writes the acceptance URL, `smoke` writes `lastSmoke`. **The gate**: until a
  smoke records `pass`, `done` with `merge: true` is refused (E5006). A create that asks to deploy
  with nothing to deploy with is refused (E4015).
- **Eight session-control tools**: `find`, `status`, `read`, `send`, `create`, `resume`, `wait`,
  `cancel`.
- **A new `dispatch` action** hands a job to a session in a task space that already exists, with a
  permission and a watch flag it may name.
- **A task space can be registered as a DSH Workspace**: `registerWorkspace` (on by default) and
  `unregisterWorkspace` (undone with the finish by default).
- **The task record is also kept under the source root**:
  `<source root>/.worktree-space/tasks/<project>/<task>.json`, with archive in `tasks-archive/`.

## 1.2.1 — 2026-10-06

### Added

- A **plugin settings** entry at the foot of the management page's nav column, opening this
  plugin's own configuration page.
- A **feedback** link under the full-page panel's heading; only the dialog had one.
- A second line under the heading, **the flow**: pick a workspace, create the task space, let the
  agent work, finish the task.

### Fixed

- The management page section of the README described something that was no longer true: the view
  switch has been in the shared nav column, not the toolbar.

## 1.2.0 — 2026-10-04

### Added

- **"Add repository" decides off the scan.** Whether a repository may be added is whether the scan
  lists it, not whether one of its parents is a registered Workspace.
- **Names and paths on a row can be selected and copied**: the arrow is the control, the text is no
  longer inside a button.
- **The default scan depth goes from two levels to three**, so a workspace registered over a deeper
  layout no longer reads like an empty directory.
- Repositories one level below a workspace can create a task space, and a task space is **found by
  location** rather than compared as a string.

### Fixed

- **A task's commits on a detached HEAD were silently dropped**: `rev-parse --abbrev-ref HEAD`
  answers the literal `HEAD`, so the merge became the target branch merging itself - reported as
  success, with the commits left dangling. It is refused now.
- **A failed create's rollback left its branch behind**, so a retry of the same name met "branch
  already exists".
- **One create error reached the audit log and the caller with different codes** (E2005 against a
  collapsed E9001).
- `E7007` was missing from the code table and was published as `E9001`.
- A create that ticked **"save as default"** and then threw **deleted the task space it had just
  made**.
- Two workspaces with a repository of the same name **crossed their "add repository" checkboxes**.
- Opening a row's menu from the keyboard **attached the action to whichever row the pointer had
  last used**.

## 1.1.0 — 2026-10-01

### Features

- **Create a task space**: pick a source root, name the task, choose a branch prefix (`task/` by
  default), tick the repositories to span, choose where it goes. Each repository gets a worktree on
  `<prefix><task>`.
- **The task space is registered as a Workspace** named `<parent>/<task>`, with a session opened on
  it whose working directory is that task space.
- **A management page with three views** - workspaces, Git repositories, task spaces - each
  searchable, filterable by what needs attention, and collapsible row by row or all at once.
- **Finish a task**: merge each repository into its target branch, remove the worktrees, archive the
  documents, unregister the Workspace; refused while a session is still running in it.
- **A task-space menu** on each workspace row: create a task space, finish one.
- **The layout**: task spaces live under the container root, filed by project (the source
  workspace's own directory name) and then by task, with each repository's worktree under that.
  Archive goes to `<project>/<task>-<timestamp>/`.
- **No extra service dependencies**: scan depth and the directory limit are this plugin's own
  settings; DSH themes and language settings are honoured.

### Changed

- The management page opens on the **workspaces view** (it opened on task spaces, the one view from
  which a task cannot be started).
- The directory that holds task spaces is named the **Worktree Space container**, and "merge back
  into the current branch" becomes "merge back into the target branch".
- Each of the three views carries one sentence saying what it lists, below the control it describes.

### Compatibility

- DSH `>=0.1.7-rc.1 <0.3.0-0`; available as both the web and desktop profiles.

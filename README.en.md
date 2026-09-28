# Worktree Space

Worktree Space for DeepSeek Harness: one task can span several repositories. Each one gets
its own Git worktree on the same branch, kept in a task space outside the source tree and
registered as a DSH Workspace with its own sessions.

![DeepSeek Harness Plugin](https://img.shields.io/badge/DeepSeek%20Harness-Plugin-7c5cff)
![License](https://img.shields.io/badge/license-MIT-22c55e)

<img src="docs/img/manage-worktree-space.png" alt="The management page: Tasks, Workspaces and Repositories views" width="960">

[中文](README.md) · **English**

> **Beta (experimental)**: handing the commits and the merge conflicts to an agent is a feature
> in an experimental validation phase, and its behaviour may still change (see the experimental
> section at the end); the rest of this document describes the flow without an agent. Please
> report problems in
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
  Uncommitted changes in a worktree have to be committed by you first (the plugin writes no
  commit; see Finish a task), and then the worktrees are removed, the task space's own documents
  are filed under
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

Built against the DSH **0.1.7-rc.1** client contract. Verified on `0.1.7-rc.1` and `0.1.7-rc.2`: the
host RPC routes register, the client bundle loads without changes, and the plugin
list shows the name, description, icon and configuration section correctly.

The compatibility range declared explicitly in the manifest (`package.json`):

| Field | Declared value | Meaning |
| --- | --- | --- |
| `engines.node` | `>=22.19.0` | Required Node.js version |
| `engines.dsh` | `>=0.1.7-rc.1` | Compatible DSH versions |
| `dsh.manifestVersion` | `1` | DSH manifest format version |
| `dsh.compatibility.profiles` | `["web"]` | Verified profile |

**Fixed commit**: this version (`v1.0.6`) is the commit `ae7bb4386069090f9f188937a4d4eeafaadc9407` on GitHub —
the acceptance package was packed from that commit, byte for byte.

`engines.dsh` is **declarative**: today's DSH installers and loaders do not enforce it, so declaring
a range does not reject an incompatible host — the range means no more than "`0.1.7-rc.1` and later
are treated as compatible", and what has actually been verified is `0.1.7-rc.1` and `0.1.7-rc.2`. If
a later DSH release changes the client contract and breaks the plugin, this lower bound will be
raised, or the state recorded honestly in `dsh.compatibility`; if you hit a version-specific problem,
open an [issue](https://github.com/kangtsang/dsh-worktree-space/issues).

## Permissions, dependencies and failure boundaries

At runtime this plugin reads and writes files and runs `git`. Those two permissions *are* its
function; they cannot be reduced to zero. The full account — what it reads, what it writes, which
subcommands it runs and what happens when things fail — is in
[PERMISSIONS.en.md](PERMISSIONS.en.md); the disposable-Profile install / start / uninstall
acceptance evidence is in [docs/store-evidence.md](docs/store-evidence.md).

**Permissions at a glance:**

| Permission | Scope |
| --- | --- |
| File reads | The Workspace directories you pick (breadth-first scan, skipping `node_modules`, `dist`, `build`, `vendor` and hidden directories except `.worktrees`); a task space's `worktree-space.json` and `worktree-space.md`; each worktree's `.git` marker file; the plugin's own `assets/skill/task-worktree-space/SKILL.md`; and, at finish, the contents of the files git lists through `git diff --name-only HEAD` / `--diff-filter=U`, read only to decide whether a merge still carries conflict markers |
| File writes | Only inside the task-space container: `<task space>/<task>/` and the worktrees in it, `worktree-space.json`, `worktree-space.md`, and `archived-docs/` when filing documents. Finishing a task removes only worktrees, task directories and documents the plugin itself created; a merge also `git worktree add`s one temporary checkout under the **system temporary directory** (merge → `worktree remove --force` → delete that directory). It does **not** write the files of a source repository's checkout and does **not** write the DSH data directory or config files (DSH's own plugin configuration service stores your settings) |
| Command execution | `git` only, always as `git -C <dir> <subcommand>` with fixed argv through a single `runGit` seam — no shell. Queries: `rev-parse` (including `rev-parse --verify --quiet MERGE_HEAD`), `worktree list`, `status`, `rev-list`, `for-each-ref`, `show-ref`, `symbolic-ref`, `merge-base`, `diff --name-only` (including `--diff-filter=U`). Mutations: `worktree add / remove / prune`, `merge`, `merge --abort`, `reset --hard`, `branch -d / -D`. **`add` and `commit` are not among them**: the plugin writes no commit, uncommitted work stops that repository, and a commit handed to an agent is run by the **host's agent** in that session (see the failure boundaries) |
| Network | Only `git push -u origin <branch>`, and only when you explicitly ask for a push in the create dialog or the tool; the plugin itself makes no HTTP requests and downloads nothing |
| Credentials | Reads, stores and forwards none. A push uses whatever credentials your local Git is already configured with (credential helper / SSH); the plugin never touches keys and never reads environment variables |
| Global resources | No global installs, no daemon or resident service, no writes to system directories |

**Dependencies:**

| Dependency | Purpose | Provided by |
| --- | --- | --- |
| Node.js `>=22.19.0` | Runs the host code | Your DSH installation |
| DSH `>=0.1.7-rc.1` | Client contract, RPC and the Workspace API | Your DSH installation |
| `@deepseek-ai/cordis`, `@deepseek-ai/schemastery` | Plugin framework and config schema | peer dependencies supplied by the DSH profile |
| `@deepseek-ai/dsh-client-connection`, `@deepseek-ai/dsh-tools` | Host RPC registration and tool definitions | peer dependencies supplied by the DSH profile |
| React 18 | Management-page UI | Supplied by the DSH web runtime |
| `git` | Every worktree and branch operation | The Git already installed on your machine (not shipped with the plugin; a missing `git` on `PATH` is an error) |
| `@hugeicons/*`, `@radix-ui/react-dialog` | Icons and dialog primitives, **build-time only**; inlined into `client/client.js` when building | Not installed as runtime packages — installing this plugin brings in no new runtime third-party dependency |

**External services:** none. The plugin contacts no third-party service and reports no telemetry.

**Failure boundaries (never silent):**

| Situation | Behaviour |
| --- | --- |
| Directory scan hits its limit | Throws with `Worktree scan limit reached; choose a more specific Workspace.` — pick a narrower Workspace |
| Any `git` command fails | Throws `git <args> failed (exit N): <stderr>`, surfacing Git's own diagnosis verbatim |
| A repository still holds uncommitted work at finish | That repository stops (`force` is what discards it): `uncommitted work is waiting in <worktree>; commit it before the task can be finished`; the plugin **writes no commit**, the others carry on, and the result names each one |
| A merge is resolved but not committed | `the merge in <worktree> is resolved but not committed` — the state is kept as it stands |
| The resolved files still carry conflict markers | `the resolved merge still has conflict markers in <files>` — kept as they stand, no side is taken |
| Merge conflict | Does **not** auto `merge --abort`; the merge site is kept (with `mergeSite` and `conflictedFiles`) until you authorise the next step |
| Worktree removal fails | Reports `failed to remove the worktree (uncommitted changes? force it deliberately)`; the worktree is kept and reported, and `git worktree prune` is the remedy |
| A task directory is not empty | The directory and the Workspace registration are kept rather than force-deleted |
| A fact cannot be confirmed | It is written as "unknown" — absence of evidence is never inferred as absence of access |

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
   path is filled in for you: `worktree-space` inside the **first directory below the volume
   root** that the source root sits in (source root `E:\workspace\public\dsh-worktree-space`
   recommends `E:\workspace\worktree-space`). At that depth the task space and the source tree
   sit in one common ancestor below the volume root, and the recommendation itself is not
   widened to the volume root. Another location still works; it is only a source root sitting
   directly under the volume root (`E:\repo`) that shares nothing but that root with its
   worktree (an agent handed the commits or the conflict then has to authorise itself in that
   session — see the experimental section at the end).
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

**1. The commits are yours to make; this plugin never writes one.** While the plan shows
uncommitted changes in a repository and **Force** is not ticked, **Finish task** stays
unavailable — those changes are not this side's to write, and a worktree will not go while it
holds them. The plan names those repositories and how many changes each one holds. Commit them in
each worktree yourself with `git add` and `git commit` (the message is yours to write); when you
are done, close the dialog and open it again — it re-reads the plan every time it opens, and those
repositories stop holding **Finish task** back. You can also tick **Force**, which says those
changes are not wanted: they are discarded with the worktree. This plugin writes no commit and
never touches the index — the changes are yours, and so is the message. If your own commit fails
(a hook refusing, a missing `user.name`/`user.email`, gpg signing, `index.lock`, a file in use),
the repository is simply still dirty and still blocks the finish: fix it and commit again. If you
would rather not do it yourself, **Authorize the agent to commit** hands it to an agent session
(see the experimental section at the end). Two cases skip this step: a deliberate
delete-without-merge — abandoning the task space with `deleteBranch` and `force`, where a commit
would be deleted along with the branch — and a worktree in the middle of an unfinished merge (it
holds `MERGE_HEAD`), which step 3 takes over.

**2. Merge: rehearse the other way round, then merge for real.** The merge itself puts **the task
branch into the target branch** (by default the branch the source repository has checked out), and
it lands in the **source repository**. Before the target is touched, the target is merged into the
task branch **inside the task space's own worktree** — the opposite direction — with
`git merge --no-ff --no-edit <target>`, run in `<task space>\<repository>`. Two outcomes:

- **Clean**: that rehearsal is undone again (`git reset --hard <the HEAD from before the
  rehearsal>`, the worktree back where it started), and the task branch is then merged into the
  target branch with `--no-ff` as usual, so the target keeps an ordinary merge commit. A target
  that is not checked out anywhere is merged in a temporary worktree that is discarded
  afterwards, leaving the source checkout alone.
- **Conflicted**: that merge is **not aborted and not reverted** — the rehearsal simply stays
  where it stands, in the task branch's worktree, which keeps its `MERGE_HEAD` and the conflicted
  files with their markers sitting in its working tree (for instance
  `E:\wt-demo\spaces\demo\alpha\src\app.ts`). The **target branch is untouched**, and so is the
  source repository's checkout.

Why rehearse the other way round: a conflict in the real merge lands in your source repository and
its checkout, and it would have to be aborted, with a side picked by hand. Rehearsing first puts
the conflict in the plugin's own checkout — the task branch's worktree — which is exactly where the
work can be dealt with in place, without touching your checkout.

**3. A conflict stops the finish and waits for you to resolve it on the spot.** As soon as one
repository stands on a conflict the whole finish is partial (`failed: true`, the container stays,
and the other repositories may already be merged and removed). Every repository row reports
`mergeInProgress`, `mergeSite` (the directory the conflict stands in) and `conflictedFiles`. The
dialog then shows **A merge conflicted: deal with it, then finish the task again.** with the
direction and the site explained above; the way on is **Continue finishing** at the foot of the
panel.

The site is the task branch's own worktree (for instance `E:\wt-demo\spaces\demo\alpha`), standing
in an unfinished merge: `git -C <site> status` lists the `both modified:` files, and
`git -C <site> rev-parse MERGE_HEAD` has a value. Resolve the conflict there, `git add`, and one
`git commit` that says how you reconciled the two sides concludes the merge — the target branch and
the source repository's checkout were never touched; the worktree's index lives under the source
repository's `.git/worktrees/<name>/`, so the commit has to land on that one. To have an agent
resolve this conflict instead, use **Authorize the agent to resolve it** (see the experimental
section at the end).

Pressing **Continue finishing** runs the same checks, in the same order:

- first that no conflict markers are left on the site, then that the merge has been committed (the
  `MERGE_HEAD` is gone);
- then the usual question, whether the target branch is already contained in the task branch
  (`git merge-base --is-ancestor <target> <branch>`): you have just merged the target branch into
  the task branch and committed it, so the answer is usually yes, and **the rehearsal is skipped**,
  going straight to the real merge from step 2 (the task branch into the target branch with
  `--no-ff`), followed by the worktree removal and, when asked, the branch deletion;
- **but if someone has pushed to the target branch in the meantime**, the target is no longer
  contained in the task branch, so **the rehearsal runs once more** — this time merging those new
  commits into the task branch. Clean, and it is undone before the real merge; conflicted, and it
  is the same story as before: the conflict stays where it stands in the task branch's worktree,
  and you resolve it there once more and press **Continue finishing** again. Skipping the rehearsal
  has exactly one condition — that the target really is already contained in the task branch — so
  resolving a conflict once never bypasses it.
- The one exception is a **race**: the rehearsal came out clean and, a moment later, the real
  merge (in the source repository, into the target branch) conflicts because the target moved
  again. That one is `git merge --abort`ed: the source repository is left as it was found and
  git's own words are reported. A rehearsal has already been paid for, so a conflict left standing
  there could only be somebody else's commit, not a conflict to hand on. The worktree and the
  branch are kept — merge the new target into the task branch, then finish again.

If the site still holds a resolution nobody committed, the plugin does not commit it for you: the
site is left exactly as it stands and the question goes back to the user — the row's `error` says
`the merge in <path> is resolved but not committed`, or that conflict markers remain — and
**Continue finishing** at the foot of the panel is the way back in.

**Leaving loses no progress.** The report and any session rows opened are kept, so reopening the
dialog shows the page you left, with the plan read again (the per-repository target branches and the
checkboxes are not part of that, so pick those again). The backdrop, Esc and the ✕ in the corner
leave the same way, and all of them are held back only while a finish is actually running.

Deleting a branch normally needs the merge: deselect the merge and the branch option goes
with it. To abandon a task space instead of finishing it — nothing merged, the branches and
the commits on them discarded — select **Force** as well, which is what allows deleting a
branch that was never merged; abandoning is also the one combination that skips the commit
in step 1.

#### What each combination does

| Merge back | Delete branch | Force | What happens |
| --- | --- | --- | --- |
| ✓ | | | **Finish task** is unavailable at first: commit each worktree's uncommitted changes to its own task branch yourself (until you do, the finish stays on that step and names the worktree — `uncommitted work is waiting in <path>` in that row's `error`), and its branch is then merged into the target chosen on its own row (by default the branch that repository has checked out) with `--no-ff`; the worktrees are removed; **the branches stay**. A repository standing on a conflict keeps its place, the others still finish |
| ✓ | ✓ | | The same, and the branch is deleted once merged (`git branch -d`, so an unmerged branch cannot be deleted this way) |
| ✓ | | ✓ | Merging still happens, but Force skips the commit: uncommitted changes in the worktree are **discarded with it**, and the plugin does not commit them for you; the branches stay |
| ✓ | ✓ | ✓ | Merge and force-delete the branch (`git branch -D`); the branch was merged, so nothing extra is lost |
| | | | Nothing is merged: **Finish task** is unavailable until you commit the changes yourself (they stay on the branch that stays), the worktrees and the task space go, **the branches stay** for you to merge by hand |
| | | ✓ | The same, without the commit: uncommitted changes are **discarded with the worktree**; the branches stay |
| | ✓ | ✓ | **Abandon**: nothing merged and nothing committed, the branch force-deleted, and **the commits it held are discarded along with the uncommitted changes in the worktree** |

Whichever combination is chosen: the task space's own metadata — `worktree-space.json` and the `worktree-space.md` generated from it — is always cleared, and an older space may still hold `README.en.md` (cleared too) or a `README.md` this plugin wrote back then, which since 1.0.5 is left alone rather than assumed to be ours; anything else in the task space follows the archive choice (unselected, it is discarded
outright). **A repository whose work nobody committed, or whose merge stands on a conflict, is kept as it is and reported as unfinished** while the others finish, which is also why the task space directory and its workspace registration stay. The directory and the registration are removed only once every repository really went and the container is empty, and its sessions then fall back to Ungrouped with their transcripts
intact.

The **Finish task** button follows the same reasoning: **amber** is an ordinary finish (the
merge can be reverted and nothing is discarded), and it is **red** only where the dialog can
name what will be lost — abandoning the task space (no merge, force-deleting the branches)
while a worktree still holds uncommitted files, or while a branch still holds commits that
were never merged.

## Experimental: handing the commits and the conflicts to an agent

When finishing a task, the plugin can open a DSH agent session to do two jobs for you: commit the
uncommitted changes, and resolve a merge that stands on a conflict.

### The two buttons and what they do

- Repositories with uncommitted changes in the plan → **Authorize the agent to commit**: it opens a
  session that `git add`s those changes and commits them, with a message saying what changed and why
  (in the language and style that repository's own commits use).
- A repository standing on a merge conflict → **Authorize the agent to resolve it**: it opens a
  session that reads both sides, works out what each was after, writes a version that keeps both
  intentions, and concludes the merge itself (`git add`, then `git commit` with a message saying how
  the two sides were reconciled).

Both jobs ask the same: do not push, do not touch other repositories or the task space, and do not
merge a branch back into its target — that step is the plugin's.

Those repositories share one session (in the conflict step, a repository that already has the session
step 1 opened reuses it). The working directory is the common ancestor of their boundaries: a
repository's own boundary is its worktree, or, when the Host named the main checkout's path, the
common ancestor of that worktree and the main checkout. Where that common ancestor falls back to the
**volume root** (the repositories sit on different volumes, or both the task space and the
repositories sit directly under the root) there is still just the one session, working in the **task
space**, and the elevation is yours to approve in that session.

### The flow and its steps

1. With uncommitted changes in the plan, press **Authorize the agent to commit**: the plugin opens a
   session and hands the job over. Ticking **Force** skips this step and opens no session at all.
2. Wait for the session to stop. Once it does, the plugin re-reads the plan once (once per job, and a
   session seen running re-arms that read).
3. When the plan that comes back holds no uncommitted files in those repositories, the headline turns
   into a **green status light** with green text: in the commit step "The commits are done: carry on
   and finish the task.", in the conflict step "The conflict is resolved: carry on and finish the
   task."
4. Press **Finish task** or **Continue finishing** to carry on.
5. When a merge stands on a conflict, press **Authorize the agent to resolve it** and repeat steps
   2-4.
6. An agent that only edited the files without committing (or left conflict markers behind) gets no
   commit from this side: the site is left exactly as it stands, the result says it did not finish,
   and you wrap it up or take over yourself before pressing **Continue finishing**.
7. The rehearsal in step 3: once the agent has merged the target branch into the task branch and
   committed it, pressing **Continue finishing** usually answers "yes" to whether the target branch is
   already contained in the task branch, and the rehearsal is skipped; only when somebody has pushed
   to the target branch again does it run once more first.

**Finish task** or **Continue finishing** at the foot of the panel only ever runs once the user has
confirmed it.

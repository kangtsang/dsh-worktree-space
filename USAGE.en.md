# Worktree Space guide

Everything operating a task needs, from creating it to finishing it, lives here.

**What the plugin is, what it does and how each setting changes behaviour: see the [README](README.en.md).**

The guide is **two parts that neither needs the other**:

- **Part one (sections 1-9) is the guide route** — every step is something you do on screen, click by
  click. The README carries the short version of it; this is the long one.
- **Part two (sections 10-14) is an agent orchestrating end to end** — the agent in your session drives
  the whole thing with the tools, and you press nothing on the panel.

Both walk the **same flow**. They differ in who drives it, and in the handful of irreversible things at
the end that only a person may decide (section 14). Read only the half you mean to use; the error codes
in section 15 serve both.

> **The wording follows what the plugin does now.** Interface labels switch with DSH's own language
> setting, and this guide names the Chinese ones. Every behaviour here can be checked against the
> source: the client is under `src/client/` (`CreateWorktreeDialog.tsx`, `ArchiveTaskDialog.tsx`,
> `DeployCard.tsx`, `WorktreesSettings.tsx`), the host under `src/host/` (`task/create.js`,
> `task/deploy.js`, `task/delivery.js`, `task/archive.js`, `task/tool.js`, `session-tools.js`,
> `session-watch.js`).

---

## 📑 Contents

**Before you read**

- [0. Terms](#0-terms)

**Part one · the guide route**

- [1. The whole life of one task](#1-the-whole-life-of-one-task)
- [2. Opening the management page](#2-opening-the-management-page)　[3. Creating a task space](#3-creating-a-task-space)
- [4. Working inside a task space](#4-working-inside-a-task-space)　[5. Adding a repository to a task](#5-adding-a-repository-to-a-task)
- [6. Deploy and acceptance](#6-deploy-and-acceptance)　[7. Finishing a task](#7-finishing-a-task)
- [8. Conflicts and the "stopped on work" flag](#8-conflicts-and-the-stopped-on-work-flag)　[9. Troubleshooting](#9-troubleshooting)

**Part two · an agent orchestrating end to end**

- [10. What this route does](#10-what-this-route-does)　[11. More terms: the leader and the member](#11-more-terms-the-leader-and-the-member)
- [12. How the chain runs](#12-how-the-chain-runs)　[13. The three holds while it runs](#13-the-three-holds-while-it-runs)
- [14. The few things only a person can do](#14-the-few-things-only-a-person-can-do)

**Reference**

- [15. Error codes at a glance](#15-error-codes-at-a-glance)　[Appendix: the session-control tools](#appendix-the-session-control-tools)

---

## 0. Terms

| Term | What it means |
| --- | --- |
| **Source root** (`sourceRoot`) | The Workspace directory you work in day to day: either it is itself a git repository, or it holds several git repositories below it |
| **Container root** (`tasksRoot`) | Where task spaces go (the setting is called the **Worktree Space container root**). **The source root and the container root must not contain one another** |
| **Project layer** | The first level below the container root, named after the source root's own directory. The plugin layers by itself, so two projects can carry tasks with the same name without colliding |
| **Task space** | `<container root>/<project>/<task>` — one task's own directory, and **also the working directory of its session** |
| **Task branch** | `<branch prefix><task name>`, `task/<task name>` by default. Every repository in one task shares this one branch |
| **Task session** | A session whose working directory is the task space: it can edit, build and run services in that directory without touching the source checkouts |
| **Strays** | The files in the task space that **git has never tracked** — notes, scripts, logs, build output |
| **Environment id** | `dsh-<project>-<task>`, derived for any task Deploy was ticked for. Containers, images, ports and acceptance URLs stay out of each other's way because of it |
| **Acceptance URL** | The URL you can open once the environment is up; it lives in the task space's state file |

Two more words — the **leader** and the **member** — belong to part two alone; see
[section 11](#11-more-terms-the-leader-and-the-member).

---

# Part one · the guide route

Everything here is something you do on screen yourself. There are no tool calls, and no agent roles to
hold in your head.

## 1. The whole life of one task

| # | Stage | What you do on screen | What you have afterwards |
| --- | --- | --- | --- |
| 1 | **Create a task space** | Management page (or the session button) → fill in **New Worktree Space** → **Create and open session** | A task space directory, a task branch, a worktree for every repository you ticked; it registers as a Workspace and opens a session there |
| 2 | **Work inside it** | Do the work in that session, or edit and commit in the per-repository subdirectories yourself | Independent commits, one per repository |
| 3 | **Add a repository** (optional) | **Add repository** on the task's row | The new repository joins the task's existing branch |
| 4 | **Deploy and accept** (when Deploy is ticked) | The deploy card's **Deploy for acceptance** → **Run smoke** | An acceptance URL and a passing smoke |
| 5 | **Finish the task** | **Finish task** on the task's row → tick what you mean → **Confirm finish** | The merge back into the target branch, the worktrees removed, the space cleaned up, the strays filed away |
| 6 | **Settle a conflict** (when one happens) | Resolve it and commit the merge → **Carry on finishing** | The merge continues into step 5's cleanup |

**The plugin forces your hand in exactly two places**; every other step waits for a click:

- **The finish gate**: a task Deploy was ticked for cannot merge while its smoke has not passed
  ([6.6](#66-the-finish-gate));
- **The finish guards**: a session still working inside the space, or a worktree held by another process,
  refuses the finish ([7.7](#77-the-guards-before-finishing-the-cleanup-after)).

Step 4 only exists when **Deploy to Docker** was ticked. A task that was not ticked goes straight from
step 3 to step 5.

---

## 2. Opening the management page

<img src="docs/img/manage-worktree-space.png" alt="The management page: the three views - Workspaces, Git repositories, task spaces" width="960">

### 2.1 The four entrances

| Entrance | Where it sits | What it opens | Shown by default |
| --- | --- | --- | --- |
| **The shortcut at the foot of the sidebar** | **Worktree Space** at the bottom of the sidebar | The management page as a **dialog** | Yes |
| **The panel entrance** | The **Worktree Space** row below **New session** in the sidebar | The same page **full page** in the main area | No — switch it on in the plugin's settings |
| **The button in a session** | The plugin icon beside an empty session's input (its hint reads "New Worktree Space") | The **New** dialog directly | Only when the session is empty and its Workspace can host a task space |
| **The `⋯` menu of a Workspace row** | The menu on any Workspace row | **New Worktree Space**; directories that really are task spaces also carry **Finish Worktree Space** | Yes |

Both shapes (dialog and full page) share the same left-hand navigation: in the full page the first item
is **Back to session**, the three below it switch views, and **⚙ Plugin settings** at the foot jumps to
the host's plugin page to change this plugin's configuration.

### 2.2 The three views

| View | One row is | What you can do here |
| --- | --- | --- |
| **Workspaces** | Each DSH Workspace, with an "N repositories" badge; one without any says "No git repositories, no task space can be created" | **New Worktree Space** (on the rows that can host one), **Add Workspace** (name a directory to register it as a Workspace) |
| **Git repositories** | Every git repository the scan found, expanding into the worktrees linked to it (branch, N uncommitted changes, locked, prunable) | **New Worktree Space** (starting from one repository), **Add repository** (name a path to register that directory as a Workspace, which is why you are in this view) |
| **Task spaces** | Each task, expanding into the repositories below it; the task header carries its branch and how many commits await merging | **Add repository**, **Finish task**, and the deploy card under the task's row |

The search box matches tasks, Workspaces, repositories, branches and paths at once. All three views carry
a **Needs attention** filter for the rows worth looking at (changed, locked, prunable, or whose status
could not be read); in the Workspaces view that tier means "has repositories". The arrow on each row
folds it alone; the button beside it expands or collapses everything at once.

**Every opening rescans**, but the panel first paints itself from the previous scan, so there is data on
screen immediately. That memory lives in the DSH instance's process only and goes when the instance does.

---

## 3. Creating a task space

<img src="docs/img/new-worktree-space.png" alt="The New Worktree Space dialog" width="720">

### 3.1 Every field in the dialog

Top to bottom:

1. **Select repositories**: tick the repositories taking part in the task; each card names its current
   HEAD branch and its path. Below sit **Select all / Clear** and "N of M repositories selected".
   **Pick at least one**; all are ticked to begin with.
2. **Task information → Task name**: the name is lower-cased and every character that is not a letter,
   a digit, a dot, a hyphen or an underscore (spaces, Chinese characters, and so on) becomes a hyphen.
   It is both the task space's directory name and the branch suffix. Anything illegal is named as such
   on the spot.
3. **Branch prefix** (`task/` by default): the branch name is the prefix plus the task name. Once it
   differs from the current default, **Set as the default branch prefix** appears below it; ticking it
   writes this value back into the plugin's settings when you press **Create and open session**.
4. **Worktree Space container root**: already filled with the recommendation — **`worktree-space`, one
   level below the root workspace**, which is almost always what you want. The rule looks only at the
   first directory below the volume root, so `~/workspace/project1` and `~/workspace/deep-path/project2`
   recommend **the same** container. Changing it offers a **Set as default…** tick box too. The container
   root must neither contain nor be contained by the source root, and a container root that is itself a
   git repository is refused.
5. **Deploy to Docker** (unticked by default): ticking it reveals the **Deploy script** box; leave it
   empty and `workspace/.worktree-space/deploy/deploy.sh` is used. Why this has to be settled before the
   create is explained in 3.2.
6. **Branch start point**: **each repository's current HEAD** (the default) or **a named branch or
   commit**. In the second case that ref has to exist in **every** ticked repository; one miss refuses
   the create (`E3002`).
7. **Preview**: the **branch name** and **space directory name** this task will use, updating live as you
   type above.
8. **Create and open session**: builds everything, then opens a session in that task space.

### 3.2 "Does this deploy for acceptance?" has to be settled before the create

**The delivery policy is written exactly once, at creation, and nothing afterwards can add it or change
it** — the task's record keeps no trace of having wanted a gate once. Leaving the box unticked therefore
answers "this task does not get accepted", and nothing later reminds you that it was left open.

- **Unticked (`none`) is a fine answer**: a task with no runtime behaviour to accept should not tick it.
  But it has to be **your** answer.
- **Ticked (`docker`)**: a passing smoke *is* this task's finish line. `up` writes the acceptance URL,
  `smoke` records the result, and the finishing merge is checked against the gate
  ([6.6](#66-the-finish-gate)).
- Tick it with no usable entry script and **the create itself is refused** (`E4015`) rather than leaving
  you a task space that can never deploy.

### 3.3 What a create produces

```text
<container root>/
└── <project>/                           ← the project layer: the source root's directory name
    └── <task>/                          ← the task space, and that session's working directory
        ├── .worktree-space/             ← the plugin's own directory: everything of ours lives here
        │   ├── worktree-space.json      the task's record (branch, start point, repositories, delivery policy)
        │   ├── worktree-space.md        the same record rendered for a person to read
        │   └── deploy/                  the deploy root: a copy of the Workspace's .worktree-space/deploy/
        ├── <repository A>/              ← a worktree on <branch prefix><task name>
        └── <repository B>/
```

When **the source root is itself a repository** (`~/workspace/repo-x`), the project layer and the
repository layer carry the same name and you get `repo-x/task-x/repo-x` — the repetition is accepted on
purpose: the layout is always three levels deep.

The task space registers itself as a DSH Workspace named `<parent workspace>/<task>`, which is why it
groups on its own in the Workspace list.

**`.worktree-space/` is not your content**: it holds the record, the notes rendered from the record and
the deploy root. It is never archived, and it goes with the container when the space is cleared.

### 3.4 When a create is refused

| Case | Code | What to do |
| --- | --- | --- |
| The name is taken by a **different** task space | `E2001` | Pick another task name |
| A task space of that name is already on disk, just not registered | `E2002` | **Do not rebuild under a new name** — the dialog offers **Register again**, which puts it back to use |
| The branch is already taken | `E3001` | Pick another task name |
| The start ref does not exist in one of the repositories | `E3002` | Name a branch or commit every ticked repository has |
| The deploy script's path is outside the deploy root, or missing | `E4014` | Move the script into the Workspace's `.worktree-space/deploy/`, or change the path |
| Deploy ticked, no entry available | `E4015` | Add an entry script, or leave Deploy unticked for now |
| Something failed part way through | `E2005` / `E2006` | The first has been rolled back whole (retry the name as it is); the second left something behind — clear the paths the dialog names by hand |

**A failed registration is a warning, not a failure**: the task space is real and usable, and only its
row in the Workspace list is missing — **Register again** in the dialog puts it back.

---

## 4. Working inside a task space

The session that opens straight after the create **has the task space as its working directory**, so work
done there never reaches the source checkouts. You can also switch to that Workspace in DSH and open a
new session to take over at any time — several tasks each keep their own space, running side by side
without interfering.

Inside that directory a few rules hold:

- **The task space is not itself a git repository**: git commands belong in the **per-repository
  subdirectories**.
- **Commit per repository**; there is no cross-repository commit. The branch name is the same everywhere.
- **The source checkouts are read-only reference**: do not edit files there, do not commit there, and do
  not run `git merge` by hand. Merging is always what **Finish task** does for you
  ([7.3](#73-three-steps-commit-merge-conflict)).
- Branch, start point, participating repositories, environment id: read them from
  `.worktree-space/worktree-space.md` rather than guessing (the same facts sit as data in
  `.worktree-space/worktree-space.json`).
- **The task branch exists on this machine only.** Pushing anywhere is always your own move; the plugin
  never writes to a remote.

---

## 5. Adding a repository to a task

Discovered too late that a repository is missing: use **Add repository** on the task's row. Do not build
a second task space, and do not run `git worktree add` by hand.

- The candidates are exactly the list the **Git repositories** view holds; repositories already in the
  task are not offered again.
- For one that is not listed, you can **name a directory directly**: it registers as a Workspace and so
  joins the Git repositories view, where it can be picked.
- The new repository joins the task's **existing** branch, each starting from its own HEAD by default.
- It may sit in a different directory — even on a different volume — from the others. Neither merging nor
  finishing cares.
- **There is no "remove repository".** This release cannot take a repository back out of a task; when
  that matters, build a new task space.

---

## 6. Deploy and acceptance

Only for tasks **Deploy to Docker** was ticked for at creation.

### 6.1 The contract: one entry script

The whole deploy contract is one entry script answering two subcommands:

```sh
bash <task space>/.worktree-space/<entry> up    <envId>   # build and raise it, write the acceptance URL into the state file
bash <task space>/.worktree-space/<entry> smoke <envId>   # run the smoke, merge the result into the state file
```

`<entry>` is `.worktree-space/deploy/deploy.sh` by default; if **Deploy script** named something else at
creation, it is that name. The plugin runs the script with its own directory as the working directory, so
a script may reference files sitting beside it.

A `destroy` subcommand is **optional, and the plugin never calls it** — the card's destroy button takes
the containers down by their `dsh.env-id` label, with no help from a script. **An entry that implements
`up` and `smoke` alone is complete.**

### 6.2 The deploy root and the copy

A create copies the Workspace's own `.worktree-space/deploy/` **whole** to the same relative place inside
the task space. So put the script **together with whatever it references** into that directory once, and
every task space created afterwards can deploy out of the box; a script on its own gives you a deploy
that cannot run.

Because both sides sit at the same relative position, the "deploy script" path in the task's record holds
for the Workspace and for the task space alike. **Note that the deploy root is one level deeper than it
used to be**: a build context that read `../<repository>` in a compose file now reads `../../<repository>`.

### 6.3 Environment identity

Every task gets an environment id derived for it: `dsh-<project>-<task>` (lower case, everything that is
not alphanumeric folded to a hyphen). It reaches every deploy script as `DEPLOY_ENV_ID`, and it is the
value of the `dsh.env-id` label on the containers — containers, images, ports and acceptance URLs keep out
of each other's way because of that one id.

**Do not guess it and do not reuse another task's**: the card's destroy button finds containers by exactly
this label, and the wrong id takes someone else's environment down. The value is written into
`.worktree-space/worktree-space.md`; read it there.

### 6.4 The state-file contract

The deploy script **owns** the state file, and both the card and the finish gate read it. Its location is
fixed, whatever the entry script is called and wherever it sits:

```
<task space>/.worktree-space/deploy/.state.json
```

The plugin hands that absolute path to every script it runs as **`DEPLOY_STATE_FILE`**, so a script writes
`$DEPLOY_STATE_FILE` rather than working out which level the deploy root is on.

| Field | Who writes it | Meaning |
| --- | --- | --- |
| `url` | `up` | The acceptance URL |
| `lastSmoke: { result, at }` | `smoke` | The latest smoke; `result` is `pass` or `fail` |
| `services` | `up` (optional) | The service list, raw JSON |
| `destroyedAt` | **the plugin** (when you press destroy); a script may write it only inside its own `destroy` | When the environment was taken down |

- **Writing has to merge, not overwrite**: `smoke` changes `lastSmoke` alone and leaves the rest alone.
  One overwrite wipes `destroyedAt`, and the plugin then believes the environment is still up.
- **`up` and `smoke` never write `destroyedAt`**: clearing the trace of the last teardown is the plugin's.
- **The state file has to be written by the script that really ran that step** — neither editing it by
  hand nor copying a run recorded elsewhere counts. The gate takes it as evidence that the step happened.

A scaffolded task space ships `.worktree-space/deploy/write-state.sh`, which writes exactly
`$DEPLOY_STATE_FILE`:

```sh
./write-state.sh url <url>
./write-state.sh smoke pass|fail
./write-state.sh services <json>
```

**Not every task space has that script**: it is only written when the space had no deploy root of its own
at creation. When the Workspace carries a `.worktree-space/deploy/`, the whole directory is copied in and
nothing is scaffolded — in those task spaces the merging write is the deploy script's job.

### 6.5 The deploy card

The deploy card under the task's row **queries live every time** and caches nothing — the port a dynamic
 mapping hands out changes with every deploy, so the panel asks rather than remembers.

| Element | Meaning |
| --- | --- |
| Environment id | This task's environment id; hover for the whole name |
| Smoke badge | **Smoke passed / Smoke failed / Not smoked yet**, with the time |
| Running containers | The container count, counted live by the `dsh.env-id` label |
| Acceptance URL | Opens it in a new window |
| What the finish still needs | The gap the last deploy or smoke reported back, for example "The finishing merge still needs: a deployment, a passing smoke" |
| Refresh | Asks all of the above again (purely read-only) |

Buttons appear according to state:

- **Deploy for acceptance** — the task ticked Deploy and nothing is currently running;
- **Run smoke** — when something is running. **A failure is a result too**: the card's red badge refreshes
  all the same;
- **Destroy environment** — when something is running, behind **two confirmations** (it turns into
  "Confirm destroy" first, and only the second press executes).
- A task whose policy is `none` shows neither deploy nor smoke, but **still lists containers and keeps the
  destroy button** — a task that never ticked Deploy may nonetheless have containers raised elsewhere, and
  something you cannot take down is worse than an accident of policy.

The loop after changing code is: **deploy → smoke → finish the task once it passes**. **Acceptance facts
follow the task space**: destroying the environment does not clear the smoke result, and redeploying keeps
it too.

> **Red text on the card is not a display problem.** "Containers are running, but the script wrote no
> delivery state" means `up` never wrote `url` and `smoke` never merged `lastSmoke` — **fix the script, do
> not edit the file by hand**.

### 6.6 The finish gate

For a task Deploy was ticked for, **a merge needs a passing smoke**: no state file, or a `lastSmoke.result`
that is not `pass`, and the merge is refused (`E5006`). That is the host refusing, not a hint.

The panel checks once the moment you press **Finish task**. If the gate has not cleared it asks first —
**"The smoke has not passed yet. Finish the task anyway?"** — and only after you press **Carry on** does
the dialog open, with a `delivery-gate-bypassed` warning recorded in the log for that finish. Which is to
say: bypassing it leaves a trace.

Not pressing it is fine too: the card says outright "The finishing merge still needs: a deployment, a
passing smoke", and supplying those is the whole fix.

> **If you want to still be able to open the acceptance URL after finishing, look at it before you finish**
> — a successful finish takes the environment down ([7.7](#77-the-guards-before-finishing-the-cleanup-after)).

---

## 7. Finishing a task

<img src="docs/img/finish-task.png" alt="The finish-task dialog" width="960">

**Entrance**: **Finish task** on the task's row in the Task spaces view, or **Finish Worktree Space** in
that task's `⋯` menu in the Workspace list.

### 7.1 The plan, before anything else

Opening the dialog re-reads the real state by path first (it does not trust the row you came from), and
lays out what is about to happen:

| Area | Contents |
| --- | --- |
| Status line | Uncommitted changes · commits awaiting merge · the space's directory name |
| Repository list | Per row: repository name, task branch, `→` **target branch dropdown**, N commits, uncommitted / nothing uncommitted, the **source repository** path. The dropdown changes the target and recomputes the preview at once; a target that is not the source repository's current checkout is marked "will merge in a temporary worktree" |
| Other content in the task space | Names of the entries that will be archived or deleted, plus a document count; several build/editor artefacts are deleted alongside them; the note at the foot says `.worktree-space/` is not archiveable content |

### 7.2 The four options

| Option | Default | Meaning |
| --- | --- | --- |
| **Merge back into the target branch** | Ticked | Merges the task branch into the branch chosen per repository above with `git merge --no-ff` (by default each repository's currently checked-out branch). On conflict that repository is left untouched |
| **Delete branch** | Unticked | Deletes it once the merge succeeded. Without merging it also needs **Force**, and commits never merged go with it |
| **Force** | Unticked | Discards uncommitted changes, and permits deleting a branch that was never merged |
| **Archive the documents in the task space** | Ticked | Moves what git does not manage into a directory you choose. Unticking **deletes that content for good**, and the red warning names it item by item |

The archive directory shows below the options: `<archive root>/<project>/<task>-<YYYYMMDD-HHMMSS>/`, with
a local timestamp taken at the moment of archiving. The archive root is `archived-docs/` under the
container root by default and can be pointed elsewhere in the plugin's settings.

The dialog also states the consequence up front: **the task space directory is deleted; sessions in that
task space move to "Ungrouped" and keep their transcripts.**

### 7.3 Three steps: commit, merge, conflict

**1) Commit.** As long as the plan shows a repository with uncommitted changes and **Force** is unticked,
**Confirm finish stays unavailable** — the plugin does not write commits for you. Two ways out:

- commit yourself with `git add` / `git commit` in each worktree (a commit message is best written by
  whoever read those changes);
- or use **Hand the commits to an agent** (experimental, see 7.6).

When it is done, press **Carry on finishing**. If you committed outside the dialog — in a terminal or
another session — close it and open it again: every opening re-reads. **Force** works too: those changes
then go with the worktree.

**2) Merge: rehearsed backwards first, then done forwards.** The real merge **merges the task branch into
the target branch** and lands in the **source repository**. Before the target branch is touched, though,
the plugin tries it backwards inside the task space's **own worktree** (merging the target branch into the
task branch):

- **Clean**: that rehearsal is undone, then the ordinary `--no-ff` merge into the target branch runs; if
  no checkout holds the target branch, the merge happens in a temporary worktree and the source checkout
  is never touched.
- **Conflict**: **nothing is aborted and nothing is reset** — the rehearsal stays stopped inside the task
  branch's worktree, where the conflicting files sit with their markers in the working tree, **the target
  branch untouched** and the source repository's checkout unchanged either.

The backwards pass exists so that a conflict lands in the task space's own checkout, where it can be dealt
with where it happened; otherwise the scene of a real conflict would be your source checkout.

**3) A conflict: stopped, waiting for you.** See [section 8](#8-conflicts-and-the-stopped-on-work-flag).

### 7.4 What each combination of options does

| Merge back | Delete branch | Force | What happens |
| --- | --- | --- | --- |
| ✓ | | | Uncommitted changes are committed onto the task branch first, then merged into the target branch with `--no-ff`; the worktrees are removed; **the branch stays** |
| ✓ | ✓ | | The same, and the branch is deleted after a successful merge (`git branch -d`, so an unmerged one cannot go) |
| ✓ | | ✓ | The merge still runs, but committing is skipped: uncommitted changes **go with the worktree**; the branch stays |
| ✓ | ✓ | ✓ | Merge, then delete the branch by force (`git branch -D`) |
| | | | Nothing merges: changes are committed (they stay on the branch), the worktree and the task space are removed, **the branch stays** |
| | | ✓ | The same without committing: uncommitted changes **go with the worktree**; the branch stays |
| | ✓ | ✓ | **Abandoning the task**: no merge, no commit, the branch is deleted by force, and **nothing survives — not the commits, not the changes** |

Three things hold whatever the combination:

1. **The plugin's own `.worktree-space/` goes with the container**;
2. **Everything else follows that one tick box** — "Archive the documents in the task space" (ticked files
   it away, unticked deletes it);
3. **A repository that did not finish is left as it is**, marked unfinished, which is also why the task
   space directory and its Workspace registration stay.

The button's colour follows that: **orange** for an ordinary finish (the merge can be undone, nothing is
thrown away); it turns **red** only when something really will be thrown away (Force ticked, or a branch
deleted without merging).

### 7.5 The report

Once a finish has run, the dialog turns into a report:

| What it says | When |
| --- | --- |
| **Task finished.** / **Task finished, branch kept (not merged).** / **Task finished, branch deleted (not merged).** | Everything went through |
| **Partly finished — the repositories marked below were left as they are** | Some repository did not finish |
| **No repository finished** | Everything stopped |

One row per repository: `Merged into X` · `Worktree removed` · `Branch deleted`, or `Untouched` /
`Untouched (the merge conflict is where it was left)` / `Untouched (the merge was aborted)`; the row may
end with a folding block of git output. Below that: **Task space deleted** or **Task space kept: <path>**,
**Archived into <directory>: <name>**, **Strays kept: <name>**, and any number of warning lines (the one
recording that you bypassed the gate, for instance). The last line says where the Workspace registration
went: **Workspace registration removed**, or **kept** because the space is still there.

When it did not finish there is a **Carry on finishing** button: it finishes again with the same options.
If a session you handed work to is still busy, that button becomes **Waiting for the agent to finish** and
is disabled for the moment.

> The report keeps: after **Open session** or after closing the dialog, coming back reopens it with the
> progress and the report still there, so you carry on where you left off.

### 7.6 Optional: handing the commits and the conflicts to an agent (experimental)

> **Beta**: these two entrances are experimental and their behaviour may still move. They **show by
> default**; set "Handing conflicts and commits to an agent" to "hidden" in the plugin's settings to get
> the purely guide route back. When something goes wrong, please report it at
> [GitHub Issues](https://github.com/kangtsang/dsh-worktree-space/issues).

The finish dialog can open a DSH agent session and have it do two things for you:

- a repository with uncommitted changes → **hand the commits to an agent**;
- a repository stopped on a merge conflict → **hand the conflict to an agent**.

In both cases: **no push, no touching other repositories or task spaces, no merging the branch back**
— that last step stays with the plugin. The repositories share one session where they can (a repository
that already has a commit-phase session reuses it), and its working directory is their boundary's common
ancestor; when that ancestor is the volume root it falls back to the **task space**, and the commit that
has to write into the source repository's `.git` may then need permission granted in the session.

The switch sits in the middle of the dialog:

| State | Where the session opens | Permission |
| --- | --- | --- |
| **Grant as it goes** (default) | The narrowest directory covering both the worktree and the source repository's `.git` | Writing metadata outside that asks you once, in the session |
| **Full access** | The container root (and so filed under the Workspace group the plugin registered), set to full access the moment it opens | Nothing asks again — **and the price is that this session can afterwards write anywhere the DSH process can write on this machine** |

The matching setting is called "Sessions handed to an agent for conflicts and commits use full access"
(off by default), and it can be changed from the dialog. It **affects sessions opened afterwards only**;
one already opened has to be switched inside itself.

Whichever route you take, **Confirm finish / Carry on finishing** at the bottom is always for you to press.

### 7.7 The guards before finishing, the cleanup after

Three checks refuse a finish outright — **all of them before anything is touched**, so nothing has moved
at this point:

| Code | Meaning | What to do |
| --- | --- | --- |
| `E5011` | A worktree is held by something outside this process (a dev server, a browser, an editor) | Close whatever holds it, then finish |
| `E5012` | **A session inside the task space is still working** | Let those sessions go idle or stop them, then finish — or keep the task space for now |
| `E2005` | The directory holds no `.worktree-space/worktree-space.json`, so this does not read as one of this plugin's task spaces | Nothing has been deleted; check you picked the right directory, or restore that record file from a backup |

`E5012` needs three signals together (the registry says it is running, a turn has not ended in the log,
and work is still queued in the inbox); until the working session disappears the dialog greys its options
and says why.

**A successful finish takes the deployment down by itself**: when anything was deployed, the plugin removes
containers, networks and volumes by `dsh.env-id` — best effort, and a failure is a warning that never
blocks the finish. If you want one more look at the acceptance URL, take it before you finish.

---

## 8. Conflicts and the "stopped on work" flag

Some finishes are **not failures; they stop on work that is not done yet**. The report the dialog gives
you explains it **one repository per row**, and these three have to be told apart:

| How it reads in the report | Meaning | Whose move it is next |
| --- | --- | --- |
| Untouched (the merge conflict is where it was left), plus the scene's path and a list of conflicting files | A merge that did not get through; the markers are still in those files | **Settle the conflict and commit the merge** in that worktree |
| Uncommitted changes / "N files uncommitted, deal with them before finishing" | There is work in the worktree that was never committed | Commit on **that repository's own branch** |
| Merge skipped, the source repository's checkout named as carrying uncommitted changes | **Your own working copy of the source** has changes the merge would overwrite | **You** — this is not something this flow should commit or stash on your behalf |

The three genuinely differ: the last looks like a conflict in git's wording, but there **no merge was ever
started and there are no markers to settle**, so hunting through files for them is wasted effort — and
letting this flow commit or stash your own changes for you is worse than wasted.

**Where the scene is**: a stop on a conflict leaves it in **the task branch's own worktree**
(`~/workspace/worktree-space/project1/hotfix/repo-a`, say), sitting inside an unfinished merge. Settle the
conflict there, `git add`, and complete the merge commit with a message that says what was chosen —
**neither the target branch nor the source repository's checkout was touched at any point**.

Once the merge commit is made (the target branch is now inside the task branch), **Carry on finishing**
skips the rehearsal and does the real merge straight away. If the scene still holds an uncommitted
resolution, or the files still carry markers, the plugin **does not commit for you**: it keeps the scene
exactly as it is and names it.

---

## 9. Troubleshooting

**First move: read the operation log.** `worktree-space-log.jsonl` under the container root (on by
default) records every step this container has seen: the git commands that changed repository state, any
git command that failed, the outcome of every operation, and every error and warning with its code.
Credentials are masked first, and nothing is sent anywhere. It can be switched off in the plugin's
settings; switching off stops new records only and leaves whatever is already on disk alone.

**Then look your symptom up:**

| Symptom | Where to look first |
| --- | --- |
| A create is refused | [3.4 When a create is refused](#34-when-a-create-is-refused) |
| Nothing comes up / no acceptance URL | [6.5 The deploy card](#65-the-deploy-card), [6.4 The state file](#64-the-state-file-contract) |
| The merge is refused for want of a passing smoke | [6.6 The finish gate](#66-the-finish-gate) (code `E5006`) |
| **Confirm finish** will not press | [7.3, step one](#73-three-steps-commit-merge-conflict): uncommitted changes, or a session still working |
| A finish stopped on one repository | [section 8](#8-conflicts-and-the-stopped-on-work-flag) |
| It does not read as a task space | `E2005` ([7.7](#77-the-guards-before-finishing-the-cleanup-after)) |
| Some repository is never found | **Scan depth**, **Maximum directories** and **Ignored directory names** in the plugin's settings |

The full list of codes and their ways out is [section 15](#15-error-codes-at-a-glance).

---

# Part two · an agent orchestrating end to end

This part covers the other supported route: **the agent in your own session drives the whole flow**, using
the tools to create spaces, hand out work, follow progress, change its mind mid-flight, finish and merge —
and you press nothing on the panel.

If you mean to click through it yourself, this part is background reading and can be skipped —
[part one](#part-one--the-guide-route) is complete on its own.

> **This document is written for you, not as instructions to an agent.** What a session is to follow comes
> from the skill the plugin ships (`assets/skill/worktree-space/SKILL.md`), which the agent reads once it
> is loaded.

## 10. What this route does

| Stage | What the tools do for it |
| --- | --- |
| Create the space and hand out work | `create` does it in one call: directory, worktrees, branch, Workspace registration, and a session opened with its brief |
| Follow progress | Reads the session's own activity clock rather than guessing. No polling |
| Change your mind mid-flight | `steer` puts words into the turn that is running, delivered even inside long turns |
| Pick up after a failure, and a missing report | The plugin tells the leader either way: an abnormal turn reports itself, and so does a normal turn that never delivered its final report |
| Finish and merge | `done` does the merge, removes the worktrees and cleans up in one call; when it stops on a conflict or on uncommitted work, it points the session back at it and you call again |
| Deploy and acceptance | For a task Deploy was ticked for, its own entry's `up` / `smoke` clears the smoke gate |

| It fits when | It does not when |
| --- | --- |
| Nobody is watching: hand it out and forget it, the finish runs itself | You are sitting at the screen and want to watch every step |
| Several tasks run at once: one session steers several task spaces | You wanted a space and will do the work yourself |
| Long tasks need "if the work does not finish, something picks it back up" | You need to abandon a task or discard files (that takes a person — [section 14](#14-the-few-things-only-a-person-can-do)) |

## 11. More terms: the leader and the member

| Term | What it means |
| --- | --- |
| **The leader** (the leader agent) | **The agent that assigns the work**: it creates the space, hands out the task, follows progress, steers, finishes. The agent in your own session is the leader |
| **The member** (the member agent) | **The session sent into the task space.** It has its own context, its own approval gate and its own working directory, and cannot see the leader's session — which is why its brief has to be self-contained |
| **Task session** | Another name for the same session: "member session = task session" |

**The two are not parent and child**: the member is a session under the task space, not a child of the
leader, so the existing parent-child channel (`send_message`) cannot reach it — it answers
"belongs to another parent session". The leader's only channel is the eight `wts_session_tool_*` tools
([the appendix](#appendix-the-session-control-tools)).

## 12. How the chain runs

```
① Create the space and hand out the first piece of work
   wts_worktree_space({ action: "create", task, sourceRoot, tasksRoot,
                        deployTarget, prompt })     ← prompt does the create and the first hand-out together
   → returns { container, branch, sessionId }

② Follow progress (no polling; look when there is a reason)
   wts_session_tool_status({ sessionId })           ← lastActivity tells "stuck" from "in a long step"
   wts_session_tool_read({ sessionId })             ← tells "never delivered" from "ignored"

③ Change the requirement / correct course
   wts_session_tool_send({ sessionId, mode: "steer", message })

④ Abnormal turns announce themselves (on by default)
   A notice arrives = the work is not done → status says where it stopped → send puts it back on it

⑤ Deploy and acceptance (when Deploy is ticked)
   The task space's own entry: up → smoke → only a passing smoke lets ⑥ past the gate

⑥ Finish
   wts_worktree_space({ action: "done", task, project, tasksRoot,
                        merge: true, strays: "archive" })
   → if it stopped on a conflict or on uncommitted work, point the session back at it and call again
```

`wts_worktree_space` has six actions in all:

| action | What it does |
| --- | --- |
| `suggest-root` | Asks first: which repositories sit below this source root, and where the container root is recommended. This is where "the recommended place" comes from |
| `create` | Builds the space; `prompt` hands the first piece of work to a new session in the same call |
| `dispatch` | The space already exists and this is the second piece of work or later: it **opens another session** in the same task space |
| `add` | Adds repositories to a task that already exists |
| `list` | Lists the task spaces under a container root, with their branches and sessions |
| `done` | Finishes: merges, removes the worktrees, deals with the strays, cleans up |

**Do not `dispatch` into the same task space twice in a row** — a `dispatch` opens a session every time,
and two sessions that each believe they own the work edit the same files and interrupt each other's
commits. To add something for a session that is already running, use `wts_session_tool_send`.

**Everything handed out is prefaced by a standard preamble**, which states the task name, the container
root, the branch name, that "git commands run in the per-repository subdirectories", that nothing may be
edited or committed in the source checkouts and `git merge` is never written by hand, that who finishes is
your call (both routes support it), plus one line for a `docker` policy — "a passing smoke is this task's
finish line", that the acceptance stack has to be this task's own, which file the delivery facts go into,
that anything taking more than a minute belongs in the background, and **the channel to report on**: send
to the leader's own session id with `wts_session_tool_send` (the default `mode` is `steer`, so it arrives at
once; name `mode: "queue"` only for something that may wait for a boundary), and **before stopping you must
deliver one final report with `finalReport: true`**. Without it the leader is told the session ended without
reporting and has to go back into that session's log for the conclusion himself, which leaves the matter
with him. So even when a brief forgets the rules, they are still in there.

## 13. The three holds while it runs

**Following progress.** `wts_session_tool_status`'s **`lastActivity` is the one reliable signal** — file
times, mtimes and the tail of a log can all sit still for minutes during a build, while the session's own
clock does not. With `stalledMsThreshold` passed, **only a session that is running** is marked `stalled`;
for an idle session, "no events for a long while" is the normal state. `lastReply` answers "what it
believes it is doing right now"; `lastTurnEnd` is the only witness to the difference between "finished"
and "stopped silently after an error".

**Steering mid-flight.** The difference between `steer` and `queue` is a hard requirement in this setting:

| mode | When it is read | Which one to use |
| --- | --- | --- |
| `steer` (**default**) | **Interrupts the running turn and injects a step** | Nearly all traffic between sessions: time-sensitive corrections, and anything that has to arrive now, such as the leader answering a member |
| `queue` | At the session's **turn boundary** | The few messages that can wait — "here is reference material, read it when you are done". Only an explicit `mode: "queue"` takes this route |

A long task handed out is often **one long turn** from end to end, which is why the default has to be
`steer`: a message that does not arrive at once is held back by the next boundary — and from outside, the
session looks like it "ignored the request". To tell "never delivered" from "delivered and ignored", read
the session's own record with
`wts_session_tool_read`.

**Picking up after a failure, and a report that never came.** There are two cases here, and the plugin
treats them differently.

**One: the turn ended abnormally.** A session may never get the chance to report: a model call fails, it
hits the output ceiling, a pre-step refuses it, or the process dies and leaves an orphaned turn. The plugin
watches how turns end, and four kinds — `error`, `interrupted`, `blocked`, `max-tokens` — are announced to
the leader session on their own (naming the task, the member session id, the failure code and what to do
next, and saying plainly that **the work is not finished, do not treat it as done**). **Every abnormal turn
is reported**, not only the last one.

**Two: the turn ended normally, but no final report was delivered.** This watches the other way a report
goes missing: the work is done, the session stops, and nothing was sent. Before stopping its work a member
is required to call `wts_session_tool_send` with **`finalReport: true`**; when a turn ends `completed` the
plugin looks for that mark in the record, and if it is absent the leader is told the session **ended
normally without delivering a final report**. The notice also says that this is **not a failure** and that
it is **not** a reason to wake the session — read its last output first.

Both judgements rest on the task space's record: `finalReport: true` writes a `reportedAt` stamp (readable
local time) on that session's entry, **an interim progress message does not write it**, and **neither does
the finish (`done`)** — "finished but never reported" is exactly what is being reported, so the finish must
never mark it as reported. `reportedAt` is the one witness to "who delivered a final report", which is also
what you read when you look at the record on the panel.

`aborted` is never announced: a turn was stopped on purpose (by the user, or by the leader with `cancel`),
which is not "finished without reporting". A notice there would only send the leader to wake a session
somebody had just deliberately stopped.

The recovery chain is always: `status` to tell "running but stuck" from "gone" → `resume` to bring a
departed session back → `create` to reopen one in **the same task space** when it is gone for good → and
**in either case read that session's last state before deciding what to send**. Never send blind. `cancel`
is the brake: it aborts the running turn, and `keepInbox` decides whether queued work survives.

**Leave the judgement to your agent** — do not schedule polling or timed steer/cancel loops. The switch
`watchSession` is per call (`create` and `dispatch` both take it, **on by default**); pass `false` for the
call whose notices you do not want.

## 14. The few things only a person can do

The rows in bold below have no parameter on the tool side at all: however many times it is tried, the
answer is the same refusal (`E7007`).

| What you want | Who can do it |
| --- | --- |
| Merge, archive, keep | The tool can do it directly |
| Deploy and clear the smoke gate | The tool can run the entry script and then finish |
| Resolve a conflict, commit the merge | The tool can put a session on it and then call `done` |
| **Abandon a task** (no merge, delete the branch by force) | **Only you, on the panel** — there is no `force` on the tools |
| **Discard untracked files** (`discard`) | **Only you, on the panel** — unticking "Archive the documents in the task space" is what deletes them for good |
| **Merge with the gate unmet** | Go deploy and smoke; or press "finish anyway" on the panel |

That asymmetry is deliberate: irreversible things are decided there and then, by a person. Both routes call
**the same finishing function**, and the difference is only who may pass which arguments — it is not that
"the tools are refused and the panel obeys".

One more boundary: **even on the automatic route nobody writes `git merge` by hand in a source checkout**;
finishing always goes through `done` (which lands the merge in the source repository and leaves any
conflict in the task space's own worktree). And **pushing to a remote stays your own move** in every case.

---

## 15. Error codes at a glance

A code is more reliable than a sentence: a sentence changes with the interface language and a code does
not. The first digit is the class:

`E1` container and isolation · `E2` task space lifecycle · `E3` git and branches · `E4` parameters and
validation · `E5` finishing and merging · `E6` scanning and discovery · `E7` the package itself (meaning
the plugin is broken, and worth reporting) · `E9` an unknown failure.

### Creating and deploying

| Code | Meaning | Way out |
| --- | --- | --- |
| `E1001`-`E1003` | The container root is the source root, is inside it, or contains it | Move it: neither may contain the other |
| `E1005` | The container root will not do (it is a git repository, for instance) | Pick a directory that is not one |
| `E2001` | The name is taken by a **different** task space | Pick another task name |
| `E2002` | A task space of that name is on disk already, just not registered | **Register again** on the panel; do not rebuild under a new name |
| `E3001` | The branch is already taken | Pick another task name |
| `E3002` | The start ref does not exist in one of the repositories | Name a branch or commit every selected repository has |
| `E4001` | No repository was selected | Select at least one |
| `E4002` | Two repositories in one task share a name | Rename one, then select it |
| `E4014` | The deploy script is not an existing file under the Workspace's `.worktree-space/deploy/` | Put the script in that directory, or change the path |
| `E4015` | Deploy ticked, no usable deploy entry | Add an entry script, or use `none` for now |
| `E5008` | The deploy script is missing, or rebuilding the environment failed | Read the tail of the error output; or supply the deploy assets |
| `E6001` | The directory named is not a source repository | Name a directory that really is a git repository |

### Finishing and merging

| Code | Meaning | Way out |
| --- | --- | --- |
| `E2003` | There is no task space by that name | Check the path |
| `E2004` | The task space holds no git worktree | Check that this really is a task space |
| `E2005` | This does not read as one of this plugin's task spaces (no record file) | **Nothing has been deleted**; check the directory, or restore the record from a backup |
| `E4007` | Deleting a branch that was never merged, without force | Merge it, or abandon the task yourself on the panel |
| `E4008` | The merge target branch is unusable (missing, or the task branch itself) | Choose another local branch |
| `E5001` | A merge is still unfinished | Settle the conflict, commit the merge, finish again |
| `E5002` | The finish did not complete in every repository | See which ones were left and deal with each |
| `E5003` | One repository's finish failed | Try again |
| `E5004` | The source checkout has uncommitted changes the merge would overwrite | **You** commit or stash them |
| `E5006` | No passing smoke recorded, so the merge is refused | Deploy once and run the smoke; or press "finish anyway" on the panel |
| `E5011` | A worktree is held by something outside this process | Close it, then finish; **nothing has moved** |
| `E5012` | A session inside the task space is still working | Stop those sessions, or keep the task space for now |
| `E3003` / `E3004` / `E3005` | A git command failed / the directory is not a git repository / the checkout is gone | Follow git's own diagnosis |

### Codes only the tool route meets

| Code | Meaning |
| --- | --- |
| `E7005` | Unknown action |
| `E7006` | A required argument is missing (today only `done`'s `merge`) |
| `E7007` | An irreversible operation asked for through the tool (`force`, `strays: "discard"`) — only you, on the panel, may do those |

### Retired numbers

`E4013`, `E5005`, `E5007`, `E5009` and `E5010` are retired and **will never be reused for another
meaning**. Seen in an old log or an old transcript, read them as the new number that stands in their place
above.

---

## Appendix: the session-control tools

Work inside a task space goes to a **session of its own** (the member): it has its own context, its own
approval gate, its own working directory. The leader session is **not** its parent, so the existing
parent-child channel refuses outright (`belongs to another parent session`). These eight tools are the
only channel through.

### The eight tools

| Tool | What it does |
| --- | --- |
| `wts_session_tool_find` | Finds sessions by working directory / title / id, returning `sessionId`, whether it is online, its working directory and its title |
| `wts_session_tool_status` | Progress: `running`, `openTurn`, `lastActivity`, `pendingWork`, `lastReply`, and the tail of its reasoning; offline sessions answer from their persisted log |
| `wts_session_tool_read` | Reads messages (count, `role` filter, `sinceSeq` paging), online or offline alike |
| `wts_session_tool_send` | Sends a message; `mode` is `queue` or `steer`, and `finalReport: true` says this message is the task's final report |
| `wts_session_tool_create` | Opens a new session in a directory you name (the task space), optionally handing it a self-contained prompt |
| `wts_session_tool_resume` | Brings an offline session back online, after which `send` / `read` / `wait` work directly |
| `wts_session_tool_wait` | Waits for this output; on timeout it returns **the latest output that already exists** marked `stale`, never nothing |
| `wts_session_tool_cancel` | Aborts the running turn, optionally keeping whatever work is queued |

### Their parameters

| Tool | Parameters |
| --- | --- |
| `find` | `query`, `sessionId`, `title`, `cwd` (all substring matches), `liveOnly`, `limit` (10 by default, 50 at most) |
| `status` | `sessionId` (required), `stalledMsThreshold` (60000 by default), `recent` (8 by default, 20 at most), `reasoning` (`none` / `last` / `live` / `tail`, `tail` by default) |
| `read` | `sessionId` (required), `sinceSeq`, `limit` (20 by default, 100 at most), `role` (`user` / `assistant` / `both`), `includeReasoning` (true by default) |
| `send` | `sessionId`, `message` (both required), `mode` (`steer` by **default** / an explicit `queue`), `timeoutMs` (180000 by default, 3600000 at most), `finalReport` (false by default; only `true` writes `reportedAt`) |
| `create` | `cwd` (absolute path, the task space) or `workspaceId`, `prompt`, `timeoutMs` |
| `resume` | `sessionId` (required) |
| `wait` | `sessionId` (required), `sinceSeq` (`-1` counts every event), `timeoutMs`, `requireTurnEnd` |
| `cancel` | `sessionId` (required), `reason` (**required**, free text; missing or blank is refused), `keepInbox` (false by default, meaning queued work is cleared), `cause` (an optional short label) |

### Which to use when

- **"Stuck" or "in a long step": judge it on `lastActivity` alone** — see
  [section 13](#13-the-three-holds-while-it-runs).
- **Anything time-sensitive goes by `steer`**; `queue` is only for things that can wait for the turn
  boundary.
- **`find` is usually unnecessary**: `create` / `dispatch` already wrote the session id into the task's
  record and `list` reports it too, so `find` is the fallback when that id is not to hand.
- **A timeout is not an empty answer**: when `wait`'s budget runs out it returns the latest output that
  exists, marked `stale`, so you always learn what it said last.

---

> Anything wrong or missing here, please report it at
> [GitHub Issues](https://github.com/kangtsang/dsh-worktree-space/issues).

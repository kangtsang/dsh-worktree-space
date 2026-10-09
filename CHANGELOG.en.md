# Changelog

What changed in each release. Earlier versions live in the git history only; the per-release
evidence for host compatibility is in [`docs/store-evidence.md`](docs/store-evidence.md).
The Chinese version is [`CHANGELOG.md`](CHANGELOG.md).

## Unreleased

### Fixed
- **A task space created from an agent session is no longer left unregistered.**
  `task_worktree_space`'s `create` did the disk half only — the directory, the
  branch, one worktree per repository — while "register this directory as a DSH
  Workspace" is a client capability (the panel does it through the client's
  `ctx.workspaces.create`) with no counterpart on the tool's side. A task space made
  that way never appeared in the workspace list, had no session that could be opened
  in it, and **the next `create` under the same name was refused as E2002** —
  `createTask` reads exactly that leftover container as this task's own, so the only
  way out was the panel's "Register again", which nothing had told the agent about.
  `create` now registers the task space itself through the Host's
  `ctx.workspaceRegistry`, titled by the panel's own rule,
  `<source workspace title>/<task>`, so a task space made from a session reads in the
  workspace list exactly like one made from the dialog.
  The service is probed rather than required: where a deployment serves none, or the
  registration itself fails, `create` reports a **warning** instead of a failure —
  the task space on disk is real, and all that is missing is its entry in the list —
  naming the panel's "Create and open" / "Register again" as the remedy and saying
  that until then the same name is still refused as E2002. The bundled skill's
  "Starting a task" now carries that step too: the session is opened from the panel
  after `create`, and E2002 and E2001 are two different situations.
- **Finishing a task now takes the registration with the directory.** Registering on
  `create` made `done` responsible for unregistering, or a cleanly finished task
  would leave a workspace entry pointing at a directory that is gone. The rule is
  the panel's own (`ArchiveTaskDialog` drops the registration only once the
  container is really removed): it is dropped when the container went, and kept when
  it did not — a conflict left standing, uncommitted work, strays the user asked to
  keep — because a task space that is still on disk has to keep showing in the list,
  or it would vanish while its sessions scattered into "Ungrouped". The record is
  found among the registry's own rather than through `resolveByPath`, which
  canonicalizes through `fs.realpath` and so cannot answer for a directory that has
  just been deleted. A registration that could not be read or dropped is reported as
  a warning, never as a failure of a finish that has already taken the worktrees
  down.

### Added (interface language)

- **The Host's English sentence now travels with the values it was built from, and the
  interface says the same thing in its own language.** The Host still writes every
  failure and every warning once, in English — that is the copy the audit log keeps, and
  it is kept verbatim — and sends the paths, branch names, counts and missing items beside
  it as `details` / `values` (`coded(code, message, details)`, and the new
  `warned(code, message, values)`). The client says the same thing itself for the **codes
  it knows**, from those values; a code it does not know is shown exactly as the Host
  wrote it, so nothing is ever lost for want of a translation.
  **The warnings channel changed with it:** a warning used to be a string rendered
  verbatim, and is now `{ code, message, values }` like the rest, with the panel building
  the sentence from the code. The tool — which is what a model reads — still takes
  `message`, so its output shape is unchanged.
  This release covers the lifecycle family (E2001/E2002 through the mapping that already
  existed, E2003, E2004's three situations, E2005), the delivery gate
  (E5005/E5006/E5007 — what a gate is waiting for travels by key, `smoke` / `human-ack`,
  because a phrase translated word by word is not a phrase), the removal pre-flight
  (E5011), and **all eleven warnings** (a branch not deleted, a leftover refused, holding
  links, or failing to file, deployment cleanup, and the rest). The remaining codes still
  show the Host's English, and each one is purely additive to finish: the table is
  `src/client/lib/host-messages.ts`, and the Host side needs its `details`.
- **A finish now asks whether its worktrees can actually be removed before it does
  anything, and refuses with E5011 when one of them is held.** The question is answered
  by renaming a directory and renaming it straight back — the cheapest operation Windows
  refuses for the *same* reason it refuses a delete: a directory that is some process's
  working directory, or that holds a file another process opened without sharing delete,
  cannot be renamed either. Measured here: with a handle held on a file inside, the
  rename fails with `EPERM` and the delete fails with "being used by another process";
  release the handle and both succeed. On POSIX an open file blocks neither, so the
  rename there means what it says. The check writes nothing and deletes nothing, and puts
  the name back before answering; if it ever could not, it says where the directory now
  is rather than pretending it is where it was. It runs **before any merge, removal or
  filing**, so refusing costs nothing — nothing has happened yet, which is what makes
  "close it and finish again" true rather than hopeful.

### Fixed (finishing)

- **One link no longer stops an archive, and a half-copied archive is no longer left
  behind.** `fs.cp` *recreates* a link rather than copying what it points at, and an
  ordinary Windows installation (no Developer Mode) refuses to create symbolic links at
  all — measured here: `mklink` answers "You do not have sufficient privilege" and
  `fs.symlinkSync` throws `EPERM`. So a single link anywhere in a stray aborted the whole
  copy, and the task space could never be cleared. The process now probes once whether it
  may create a link, and where it may not, the stray is not copied at all: it stays where
  it is, the warning names the entries in the way, and removing or moving those out — one
  delete each, no privilege needed — is what lets the finish continue. A copy that failed
  used to leave half an archive in `archived-docs` too; that is taken back out now, and
  only when the destination really was this call's own (`errorOnExist` is what makes an
  `EEXIST` somebody else's directory, which is left alone).
- **A directory `git worktree remove` left behind is no longer filed as the user's
  documents.** Measured here (git `2.28.0.windows.1`), that command **unregisters the
  worktree before it deletes the directory**: when the delete fails it has already
  unregistered it and removed its `.git` file, leaving a checkout git no longer knows
  about. Worktree identity has exactly one test — is `.git` a file — so that leftover read
  as the user's own content, got filed into the documents directory (a whole checkout,
  `node_modules` and all, which is what the link above was hit inside), and **no later
  finish would ever remove it**: a second `done` would only try to archive it again, and
  would refuse outright with E2004 if it were the last one left. Now, when git's removal
  fails, git is asked whether it still knows the path. If it does — the up-front refusals:
  uncommitted work, a lock, a submodule — the failure is reported exactly as before and
  **not worked around**. If it does not, git had already committed itself to the delete,
  so the plugin finishes it inside its own fence and then `git worktree prune` clears
  git's bookkeeping. When both deletes fail, or for a directory an earlier run already
  orphaned, the directory is reported as a **repository** rather than as a stray: not
  filed, not cleaned, left exactly as it stands. The plugin's record stays with it, since
  the record is the only thing left that can say the directory is this task's repository
  rather than the user's own files — which is what lets a later finish recognise it.

### Added (the sessions handed to an agent can be made into one group)

- **A new setting, Full access for the sessions handed to the agent for conflicts and commits (`handoffFullAccess`, off by default).**
  Switched on, the two sessions this plugin opens for "commit the uncommitted work" and "resolve the merge
  conflict" change: their working directory becomes the **container root** (so they read in the sidebar under
  the Workspace the plugin registered, instead of in Ungrouped), and **two** events are appended to **that
  session's own log** right after it exists: `sandbox/mode` at `danger-full-access`, and `approval/policy` at
  `never`. Both are written together because DSH's own table treats them as **one preset**, named "full access",
  meaning "Full file access without approval prompts" — which is what the user's own switch in the panel
  produces, so the session reads as that preset rather than as a combination nothing names.
  - **Why it is needed**: a handoff session's default working directory is the one that reaches **both** the
    worktree and the source repository's `.git`, because a linked worktree keeps its git metadata in the
    source repository. That directory is decided by the layout rather than by the plugin, so those sessions
    can only land in a Workspace that happens to sit there — and in Ungrouped where none does. DSH's
    grouping is computed from the session's cwd on every read (`session.create` takes `workspaceId` or `cwd`,
    never both, and a Workspace's `sessionIds` are filtered by `sessionPath(id) === workspace.path`), so the
    only way to put them in a fixed group is to make that group's path the cwd — and the container root does
    not reach a source repository's `.git`, which is why the access has to be opened at the same time.
  - **The cost is what it says**: that session may then write anywhere the DSH process can, and the grant is
    **durable** state in the session log that survives a restart. So it is **off** by default, and it happens
    only when the user turns it on — in the plugin's settings, or on the card in the finish dialog.
  - **Re-checked before every write**: the new `task.handoff-access` endpoint re-reads the setting each time
    and refuses with `E4012` — writing no event — while it is off (a request naming no session is answered
    with `E4011`). With no session service, or a session that has already gone, it answers that it did not
    widen, and the handoff carries on: the panel says which access the session actually got rather than
    pretending the setting took effect.
  - **A session already open is unaffected**: the switch governs what is opened next. To change one that is
    already running, switch it in its own session with `/permission`.
- **The card that offers the handoff now shows that switch and can change it**, with a line saying it applies
  to the sessions opened after this. A host that serves no configuration form shows the state and no switch.
- **The container root's two names (`worktree-space`, `dsh-worktree-space`) joined the built-in ignored scan
  directories.** The container root is now registered as a Workspace, so a scan walks it — and all it holds is
  task spaces (linked worktrees are skipped) and archived documents, so it holds no repository of its own.
  The built-in list goes from 23 names to 25, with both READMEs and the `documented-defaults` test updated.
- **The copy about elevation branches on the setting.** `finishHandoffScopeWide` / `finishHandoffScopeTight` /
  `finishCommitEscalation` stop being true when it is on — the container root does not hold the source
  repository's `.git`, and that session no longer needs authorising — so they are replaced by
  `finishHandoffScopeFullAccess` / `finishCommitFullAccess`, and the agent's first message says
  `finishPromptScopeFullAccess`.
- `PERMISSIONS.md` / `PERMISSIONS.en.md` gained a "Session access (off unless the user turns it on)" section
  and two failure boundaries, stating this capability as it is.

### Added (a tool call can decide the workspace registration per call)

- **`task_worktree_space` gained `registerWorkspace` on `create` and `unregisterWorkspace` on `done`.** Both are
  booleans, and **omitting either changes nothing**: `create` still registers the task space it made as a DSH
  Workspace, and `done` still unregisters it when it really removes the directory. **The interface has no switch
  for either**: Create and open in the panel means build-and-register, and Finish task means remove-and-unregister
  — the user's own press, where registering is half of what it means. The tool is the other way in, so its caller
  says so per call:
  - `create` with `registerWorkspace: false` does the disk half only: the task space is made and reported as it
    always was, and it does **not** join the workspace list. The result still carries a warning saying so, with the
    way to put it right (the panel's Create and open, or Register again), because a caller that believed it was
    registered would open a session that cannot exist — and creating the same task again is still refused as E2002.
  - `done` with `unregisterWorkspace: false` **keeps** the registration when the finish really removes the
    directory: that task's sessions stay in its group instead of falling back to Ungrouped, and what the list has
    instead is a Workspace whose directory no longer exists. Keeping it is what the caller asked for, so nothing
    warns about it.
- **An unregistration no longer treats "was never there" or "is already gone" as a failure.** The tool's `done` and
  the finish dialog both ask the workspace list again after a delete fails, rather than guessing from an error
  message or code: an entry still in the list (so the delete really did not happen) is reported as a warning or an
  error, and an entry that has gone is the outcome this was after. A user deleting that Workspace in the interface
  first, or a task space that was never registered, no longer gets a false "could not be dropped".

### Added (handing work to a session in the task space)

- **`task_worktree_space` gained `action: "dispatch"`: open a session in the task space and hand it one prompt.**
  This is the one step of that automation chain which used to be a press in the interface and nothing else —
  opening a session was a GUI action. The session opens in the task space itself, so it reads under that task's
  group in the workspace list and can be followed from there. `create` with a `prompt` does it **in the same
  call** (make + register + open + hand over, in one step, which is what the panel's Create and open means —
  except that the session there starts empty and this one is already working). Both are optional: a `create`
  without a `prompt` behaves exactly as it did.
- **The permission follows DSH's own delegation rule.** The default is `inherit`: only the **calling session's own
  explicit sandbox override** is copied — not the deployment default (which the new session lands on anyway) and
  never a one-shot grant — so a session opened this way is **never wider than the one that opened it**. Pass
  `permission: "danger-full-access"` to ask for more, which the tool's description says is the user's call. What
  is written follows the granularity of DSH's own table: `danger-full-access` is a bundle of both knobs, so
  `approval/policy: never` is written with it — the session then reads as the preset the panel's own switch
  produces, instead of as a pair that matches nothing. `workspace-write` is left alone, because its preset
  already carries `ask`. Building, testing and deploying inside the task space need only `workspace-write`.
  **Committing still writes the source repository's `.git`, outside the task space**, and that remains the
  handoff's business, with its own switch.
- With no session service in the deployment, **nothing is opened and nothing fails**: the answer says no session
  was opened and points at the panel, because the task space itself is fine.

### Changed (a task branch is kept unless something said to delete it)

- **The policy's `merge.deleteBranch` default flips from `true` to `false`: a merge keeps the task branch, and only
  an explicit `true` deletes it.** The default now takes the reversible half: once the task space is gone, the task
  branch is the only record left of how that work was made, and deleting it is the step that cannot be walked back.
  What you see does not change: the panel's Delete the branch is unticked by default and the tool's `deleteBranch`
  is not passed unless asked for. What changed is the **policy's shipped default**, which is written into the task's
  record and read by the finish later - and had it stayed `true`, "by default" would have become "deleted by
  default" the moment the finish started honouring the policy. Neither the panel nor the tool is governed by that
  default: only an explicit choice deletes - the panel's tick, the tool's `deleteBranch: true`, or that task's own
  policy saying `true`.

### Added (the merge mode in a task's policy now does something)

- **`merge.mode` used to be written into the task's record and read by nobody. All three values now have a
  behaviour** (the policy is recorded at create time and every later step reads it):
  - `auto`: the record saying "this task merges back by itself" — the finish then needs no `merge` argument at
    all, and the merge is part of ending the task.
  - `ask` (the default, unchanged): a merge only when `merge: true` is passed.
  - `never`: this flow does not merge the task — a `merge: true` from the tool is refused (`E4013`), and the
    refusal names the way past it, which is the panel, where the user's own hand does it.
- **`auto` cannot be combined with a verification that waits for a person**: `merge.mode: auto` with
  `verification: agent-then-human` or `human` is refused **at create time** (`E4010`), because `auto` has no one
  to wait for and that acceptance could never arrive. A record from an older version, or one edited by hand, is
  **not** refused: read back, `auto` means what it says (no waiting for the ack), and the result carries a warning
  (`human-ack-waived`) rather than dropping it in silence.
- **The gate is untouched**: `auto` answers who presses the merge, not whether the work was checked — a policy
  that expects a deployment still needs that deployment and its passing smoke (`E5005`/`E5006`).
- **A finish's flags now say "stated" rather than "true or false"**: the panel always states them, so the user's
  tick or untick always outranks the record; the tool and the endpoint leave them out when they said nothing, and
  the task's own policy answers. One consequence was fixed with it: the **rollback** after a failed create now
  states `merge: false` explicitly, or under an `auto` policy it would have merged half-made work into the target
  branch.

## 1.2.1 — 2026-10-06

### Added

- **A "⚙ Plugin Settings" row at the foot of the management page's navigation column.**
  The dialog and the full-width panel share it; a click goes straight to this plugin's
  detail page on the Host's Plugins panel (through the `pluginNavigation.openBundle`
  the panel publishes, without touching the current Session), and the dialog closes
  before jumping. Where the Host serves no such navigation the row does nothing and
  the management page keeps working.
- **The full-width panel's heading carries the "Feedback" link.** Until now only the
  dialog had one, and the panel is the way most readers reach the page — the place
  most likely to want a bug report was the one place that offered no way to file it.
- **A second line under the heading: the usage flow** — pick a workspace -> create a
  task space -> the agent works -> finish the task (merge back to the target branch,
  archive the leftover documents, destroy the task space) — and the feedback link now
  rides at the end of that line.

### Fixed

- **The README's description of the management page disagreed with the page**: it said
  the dialog form kept the view switcher in its toolbar, while both forms had long
  since shared one navigation column.

## 1.2.0 — 2026-10-04

Everything in this release is about things that could be seen but not done: a path you
could read but not copy, a Workspace registered above a deeper layout that read as an
empty directory, and a repository that was already in the list being pushed back at you
as an error.

### Added

- **"Add repository" is decided by the scan.** What decides whether a repository is added
  is **whether the scan already lists it**, not whether some ancestor directory happens
  to be a registered Workspace. Those are different questions and the page only answers
  the first: a repository under a registered Workspace is in the list through that
  Workspace, so refusing to add it because an ancestor was registered refuses the very
  thing that was asked for.

### Fixed

- **The name and the path on a row can be selected.** The whole row was one button, so
  clicking anywhere on it folded the list, and text inside a button is not selectable in
  the browser's own stylesheet — **a path you could read, you could not copy**. The rows
  the fold revealed were outside that button, which is why those copied and their parents
  did not. The arrow is the control now, which leaves the text outside a button where
  selecting it is ordinary rather than worked around. Asking for `user-select: text` on
  the button would produce the same selection and drag a guard along with it: a drag
  that selects a path also lands on the click that folds the row, so the row would fold
  and unfold while its own path was being copied out of it. Nothing here has to be
  defended when there is no button to defend.
- **A nested Workspace is no longer scanned twice.** The containment test built its prefix
  from a backslash path and appended a forward slash, so on Windows it matched nothing —
  its own comment promised case-insensitivity and both separator spellings, and the code
  did neither. Registering both `E:/workspace` and `E:/workspace/public` walked the same
  tree twice and reported the inner one's repositories twice.
- **The default scan depth is three, not two.** It was two on a measurement — against a
  real Workspace the third level found two repositories out of ninety-six. But a
  repository is a leaf of that walk, so depth only buys the directories holding none
  between the source root and the repositories; on a source root whose repositories all
  sit within two levels the extra level walks nothing at all. What bounds a walk is the
  directory budget rather than the depth. Two levels meant a Workspace registered above a
  deeper layout reported none of its repositories and read as an empty directory rather
  than one it could not reach.
- **A repository one level below its Workspace can be created.** It was named by string;
  it is named by path now, through the same normalisation that decides where a directory
  is, so the two cannot disagree about the same directory.
- **A task space is found by location, not by string.** Two spellings of one directory —
  separators, a trailing slash, a different case on Windows — are the same place, and a
  comparison that treats them as different cannot find a task space that exists.
- **The 420px confirm width no longer reaches the finish dialog.** That width was wider
  than the dialog it sat in. Percentages follow the dialog rather than insisting on one
  size.


### Fixed (the review round)

A review pass re-ranked everything by severity and turned up one shape repeated
throughout: a guard written for a failure path that was never reached on it.

- **A task's commits were silently dropped when its worktree sat on a detached HEAD.**
  `rev-parse --abbrev-ref HEAD` returns the literal string `HEAD` there, and merging that
  merges the target branch into itself - "Already up to date.", exit 0, target unmoved.
  The commits never merged, the worktree was clean so it was removed, and the user was
  told the merge succeeded. They became unreachable objects, gone after one `git gc`.
  The branch-deletion path already refused this; the merge path did not. It now refuses
  explicitly rather than reporting success.
- **A failed create left its branch behind.** A branch made by `worktree add -b` does not
  go away with `worktree remove`, so the same retry hit "branch already exists". The
  rollback now takes the branch with it, and names it when it cannot.
- **One create error, two different codes.** Rebuilding the error dropped its `.code`, so
  every git failure inside a create reached the caller as `E9001` while the audit log
  recorded `E2005`. One code is decided once and used by both.
- **`E7007` was raised but absent from the code table**, so it was flattened to `E9001`
  on the way out - a refusal written down carefully, reported as "something failed".
- **Ticking "save as default" and having the form throw deleted the task space that had
  just been created.** The refusal path was handled; the throw path was not, and it
  landed in the outer catch. The comment twelve lines above promised the opposite.
  Same shape in the plugin's own settings: when the host never accepted a value the
  preview stayed pending forever with no notice.
- **Two workspaces with same-named repositories: the checkboxes crossed over.** The
  element ids were built from directory names, and a space in one made an invalid id.
- **Opening a task menu from the keyboard attached its actions to whatever row a mouse
  had used recently.** Row ownership was tracked on `pointerdown` only.
- **"Nothing was left behind" was written without checking in two cases.** A container
  that could not be read or removed still produced that sentence. Only ENOENT now proves
  the container is gone; everything else is named.

The acceptance scripts lost evidence in ways worth naming: paths containing spaces broke
across the board, because `Start-Process -ArgumentList` joins its array with spaces and
does not quote an element containing one. `$page` was assigned inside a try and read
outside it, under StrictMode, with no finally - so the server leaked holding its port and
the uninstall and rollback evidence were lost. Version ranking once put a final release
below its own release candidate. And the matrix report carried a BOM on 5.1 but not on 7,
while the json twin exists precisely for a gate that does not read prose.

Section 5 of `store-evidence.md` is rewritten from this run. **4/4 covers install, config
composition, visibility, uninstall and rollback only - not task-space creation or
finishing, container validation, or the interface fields.**
### Changed

- **"Already there" is a notice, not an error.** The user asked for a repository to be in
  the list, and it is; making that an error sends them looking for something to fix that
  is not broken. It is a notice — drawn in the warn colour, announced as a status, with
  the field left open — because a field that stays open under a red error tells the
  reader the last thing they did was wrong. It was not.
- **The scan prunes; the classification does not.** Pruning both looked tidier and was
  wrong: a nested Workspace pruned from the classification loses its `isSourceRoot`, and
  with it the answer to whether a task space can be created there. So the walk takes an
  exclusion list and each root excludes the subtrees nested under it, while the
  classification still sees every path it was asked about.

## 1.1.0 — 2026-10-01

This release changes wording and layout only; the plugin behaves as it did in 1.0.8.

### Added

- **One line per view.** Under the view switcher each of the three views says what it holds and
  what a row of it starts or finishes - creates a task space, or finishes one. They are not
  numbered: the views have no order between them and a task space can be created from two of
  them. The line sits under the controls because it describes the list those controls narrow,
  and it carries the summary's muted ink rather than reading as another control.

### Changed

- **The page opens on the workspaces view.** It used to open on the task spaces, which is the one
  view a task cannot be started from: a task space is created from a workspace or a repository,
  and finished from a task. The switcher runs **workspaces, Git repositories, task spaces**,
  the order the Features section lists them in.
- **The finish button is no longer filled.** A solid fill said more than the notice directly
  above it, so the button takes that notice's own treatment: a border in the tone and the tone
  at ten percent inside, in the warning and the danger state alike.
- **The container has a full name.** The directory the plugin keeps task spaces in is the
  Worktree Space container; the layer it occupies is its container root. It previously had a
  settings label but no definition, so the wording drifted between "task space root", "the
  container" and the bare directory name. The same rename carries into the i18n keys, and the
  two keys no string reads any more are dropped.
- **Three places said "merges back into its current branch".** That holds only when nothing
  else picked a target, and the finish dialog, the button label and the host all already call
  it the target branch. The store listing was the one place a reader would be told the narrower
  thing.
- **The READMEs, the panel and the store listing carry one sentence.** The plugin listing's
  summary and package.json's description still held the pre-panel sentence, so the page a
  reader lands on described the plugin differently from the README.
- **The three usage sections are named after what they act on.** They read Create / Manage /
  Finish a Worktree Space now; they had been named after tasks while every step in them acts on
  a task space. The cross-references that point at them follow along.
- **The archive stamp is spelled out.** Every place a reader copies it from - the directory
  tree, the layer note, the layout rule, the settings table - gives the full
  `<task>-<YYYYMMDD-HHMMSS>` form instead of a bare placeholder, and the settings table adds
  that it is the local time of the archiving moment, to the second.
- **The hero figure is the user-story flow.** Both READMEs now carry
  `docs/img/user-story-flow.png` under the badges - create, work in it, finish - and the
  previous hero, `new-session.png`, goes with it. package.json's `files`, the packaging
  allowlist and the storefront's `screenshots.json` all follow.
- **The READMEs are cut down.** README.md 419 -> 328 lines, README.en.md 529 -> 414. Removed:
  the manifest field table, the per-version operation matrix, the dependency table, the six
  causes of a failed commit, the merge troubleshooting steps. Kept: the Beta notice, the
  failure-boundary table, why the plugin rehearses the merge instead of merging straight away,
  and the options-combination table - each answers a decision the reader is in the middle of
  making. The user-facing docs now state what the plugin does rather than what it does for
  you, and that settles the same files as far as PERMISSIONS.md / PERMISSIONS.en.md and
  docs/store-evidence.md.

### Compatibility

- **The DSH range is `>=0.1.7-rc.1 <0.3.0-0`.** `engines.dsh`, both DSH peers and
  `dsh.compatibility.dsh` all read that one string, and `dshReleases` and `dshOperations` cover
  four releases: `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1` and `0.2.0-rc.2`.
- **The clients are the web client and the desktop client.** `dsh.compatibility.profiles` declares
  `["web", "desktop"]` and `dsh.client.platform` is `web` — the desktop client runs the same web
  client and the same `client/client.js`.

## 1.0.8 — 2026-09-29

### Added

- **A project layer above the task space.** A task space moves from
  `<container root>/<task>/<repository>/` to `<container root>/<project>/<task>/<repository>/`, where
  the project layer is the source workspace's own directory name, derived rather than asked for.
  Several projects under one container root no longer push their same-named tasks - both called
  `hotfix`, say - into one layer. The depth is the same three levels in every case, including the
  single-repository one where the project layer and the repository share a name and the path reads
  `repo-x/task-x/repo-x`.
- **The container root becomes the plugin's own zone.** The first task space created under it writes
  a `README.md` saying so and asking for no `git init` or `clone` in there (an existing file is never
  overwritten). The other way round, a container root that is itself a git repository - it has a
  `.git` - is refused, before any directory is created.
- **The task space's location is a setting.** "Task space location" derives the container root from
  the source workspace by default, or takes a specified directory. The create dialog can write both
  that directory and the strategy along with it back to the configuration.
- **The archived-documents root is a setting.** "Archived documents" keeps non-git files under
  `<container root>/archived-docs/` (the default), shared by every project of that container, or
  under a specified root. Either way the per-task `<project>/<task>-<stamp>/` layer is added below it,
  so the archive has the same shape as the task space.

### Changed

- **The create dialog's description is rewritten.** It placed the space by its relation to the
  repositories - "beside their directory" - which stopped being the rule once task spaces moved under
  the container root. It now says the task space directory is created under the container root, and
  that every selected repository gets a worktree on a branch of the same name.
- **The finish panel's small print reads at the beta notice's size.** The line saying that committing
  changes the source repository's `.git` and may need elevated permission - along with the conflict
  hint and the opening-a-session status in the same panel - drops from the dialog body's 14px/22px to
  12px/18px, matching the beta notice a few lines below it.
- **The create dialog is a tenth wider.** 690px to 759px, which puts each of its three field hints
  back on one line. The archive dialog stays at 690px.
- **DSH 0.2.0 is compatible.** The two DSH peers, `engines.dsh` and `dsh.compatibility.dsh` now all
  read `>=0.1.7-alpha.2 <0.3.0-0`. The peers had stopped at `^0.1.7-rc.1`, and DSH 0.2.0 enforces
  peers at install and at startup, so the published 1.0.7 was refused on 0.2.0-rc.1 and 0.2.0-rc.2
  before pnpm ever ran (`nothing was installed`). Both 0.2.0 releases join `dshReleases` and
  `dshOperations`; all five releases of the window were run through install, start, uninstall and
  rollback one by one.
- **Documentation and screenshots follow.** README.md / README.en.md and PERMISSIONS.md /
  PERMISSIONS.en.md are updated for all of the above, and three screenshots in `docs/img` are
  re-shot.

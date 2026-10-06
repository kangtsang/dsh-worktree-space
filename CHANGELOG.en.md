# Changelog

What changed in each release. Earlier versions live in the git history only; the per-release
evidence for host compatibility is in [`docs/store-evidence.md`](docs/store-evidence.md).
The Chinese version is [`CHANGELOG.md`](CHANGELOG.md).

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

# Changelog

What changed in each release. Earlier versions live in the git history only; the per-release
evidence for host compatibility is in [`docs/store-evidence.md`](docs/store-evidence.md).
The Chinese version is [`CHANGELOG.md`](CHANGELOG.md).

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

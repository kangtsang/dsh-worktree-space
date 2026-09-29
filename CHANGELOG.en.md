# Changelog

What changed in each release. Earlier versions live in the git history only; the per-release
evidence for host compatibility is in [`docs/store-evidence.md`](docs/store-evidence.md).
The Chinese version is [`CHANGELOG.md`](CHANGELOG.md).

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
  the source workspace by default, or takes a directory you name. The create dialog can write both
  the directory you typed there and the strategy along with it back to the configuration.
- **The archived-documents root is a setting.** "Archived documents" keeps non-git files under
  `<container root>/archived-docs/` (the default), shared by every project of that container, or
  under a root you name. Either way the per-task `<project>/<task>-<stamp>/` layer is added below it,
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

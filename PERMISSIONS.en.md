# PERMISSIONS — dsh-worktree-space permissions and failure boundaries

This file exists for DSH STORE's automated review and for human re-review: it states plainly what this
plugin does at runtime, what it does not do, and where it stops.

Declared baseline: `dsh-worktree-space@1.0.5`, at the fixed commit on this repository's default branch. The
plugin version, its `engines` and its `dsh` fields are in `package.json`.

## Runtime behaviour

- **Purpose**: make "one task spanning several repositories" a Workspace outside the source tree. Every
  selected repository gets its own `git worktree` at `<task space root>/<task>/<repository>`, all on the same
  task branch; that directory is registered as a DSH Workspace and opened with a session whose working
  directory is the task space.

- **Reads**:
  - The Workspace directory tree, read-only: a breadth-first `readdir` walk, at most `scanDepth` levels
    (1–5, default 2) and at most `maxScanDirectories` directories (default 1000), reading up to eight
    directories at a time per level. `node_modules`, `Library`, `dist`, `build`, `vendor` and hidden
    directories are skipped (except `.worktrees`). The scan only decides *which directory is a Git
    repository* — it **does not read file contents**.
  - The task space's two metadata files `worktree-space.json` and `worktree-space.md`, plus each repository
    worktree's `<worktree>/.git` marker file (used to tell whether that worktree has gone stale).
  - `assets/skill/task-worktree-space/SKILL.md` inside this package (registered as a bundled skill, read
    only, never copied anywhere).
  - The paths the user chooses (source root, task space root, archive directory).

- **Writes**: only inside the task space directory the user chose, its archive directory, and the one
  directory identified as a stale worktree; **never** into a source repository's working tree, and never into
  the DSH installation or a configuration file.
  - Create: `mkdir` the task space directory; `git worktree add` creates each checkout (git writes it); write
    `worktree-space.json` and the `worktree-space.md` rendered from it.
  - Archive: `cp` the task space's documents to `archived-docs/<workspace>-<YYYYMMDD-HHMMSS>/` (or the
    archive directory set in the configuration).
  - Clean up: `git worktree remove --force` removes a checkout; a **stale worktree** whose `.git` points at a
    gitdir that no longer exists has that one directory removed with `fs.rm(directory, { recursive: true })`;
    the task space directory itself is deleted and its Workspace registration removed only once it really is
    empty.
  - Configuration (the entry switches, scan depth, default branch prefix, archive directory) is stored by
    DSH's own plugin configuration service (the Plugins page's live form); **the plugin writes no
    configuration file**, and its `task.preference` endpoint is read-only.

- **Command execution**: `git` is invoked through the host's `subprocess` service with a **fixed argv**
  (`argv: ['git', '-C', <cwd>, ...args]`): **no shell**, no string interpolation, no user-supplied command,
  and no executable other than `git`. Every subcommand is listed in the table below.

- **Network**: the plugin itself issues **no HTTP request at all**. Its only network activity is
  `git push -u origin <branch>` when the user explicitly ticks Push in the create dialog (unticked and not run
  by default; `task.create` only carries it when `push === true`). Every other `git` subcommand is local.
  Git's own credential helpers and proxy settings are outside this plugin's control.

- **Credentials/keys**: the plugin **does not read, store or forward** credentials. It does not read
  `process.env`, `~/.git-credentials`, `~/.ssh`, `.netrc` or an OS keychain, and it writes no credential into a
  log or a response. Whether and which credentials `git push` uses is entirely up to the user's own Git setup.

- **External services**: none. No account, no server, no telemetry.

- **Global resources**: no global packages installed, no daemon, no system service, no permission changes, no
  symbolic links; the scan cache lives in the DSH instance's memory only and is gone when the instance exits.

### Every git subcommand invoked

| Kind | Subcommands |
| --- | --- |
| Queries (read-only) | `rev-parse --show-toplevel`, `rev-parse --git-common-dir`, `rev-parse --abbrev-ref HEAD`, `rev-parse HEAD`, `rev-parse --verify --quiet <ref>^{commit}`, `symbolic-ref --quiet --short refs/remotes/origin/HEAD`, `for-each-ref --format=%(refname:short)`, `show-ref --verify --quiet`, `status --short`, `status --porcelain`, `status --short --branch`, `worktree list --porcelain`, `rev-list --count`, `merge-base --is-ancestor`, `diff --name-only --diff-filter=U` |
| Worktrees | `worktree add`, `worktree remove --force`, `worktree prune` |
| Branches and commits | `branch -d`, `branch -D`, `add -A`, `commit -m "<fixed template message>"`, `merge --no-ff --no-edit <ref>`, `merge --abort`, `reset --hard <sha>` |
| Network (explicit opt-in) | `push -u origin <branch>` |

## Dependencies

| Dependency | Purpose | Provided by |
| --- | --- | --- |
| Node.js `>=22.19.0` | Runtime (`engines.node` in `package.json`) | The user's environment |
| DSH `>=0.1.7-rc.1` | Host: client contract and service injection (`engines.dsh`, lower bound only) | The user's environment |
| `@deepseek-ai/cordis` `^4.0.2` | Plugin framework | DSH profile (`peerDependencies`) |
| `@deepseek-ai/dsh-client-connection` `^0.1.7-rc.1` | Client connection and host RPC (`/api/dsh-worktree-space`) | DSH profile (`peerDependencies`) |
| `@deepseek-ai/dsh-tools` `^0.1.7-rc.1` | Host tool definition, `defineTool` | DSH profile (`peerDependencies`) |
| `@deepseek-ai/schemastery` `^3.18.2` | Configuration schema validation | DSH profile (`peerDependencies`) |
| `react` / `react-dom` 18 | Client UI, marked external at bundle time | The DSH web runtime |
| `git` | Every repository operation | The user's environment (must be on `PATH`; version follows the system) |
| `@hugeicons/core-free-icons`, `@hugeicons/react`, `@radix-ui/react-dialog` | Icon and dialog components, **build time only**, already inlined into `client/client.js` | The build machine (`devDependencies`) |

Third-party runtime dependencies are **zero**: `package.json` carries no `dependencies` key, `scripts` holds
no `preinstall`/`install`/`postinstall` lifecycle script, and the repository contains no prebuilt binary or
executable artifact.

## File-permission signals

- No `chmod`/`chown`/`utimes`, no `mode`, no setuid/setgid/sticky bit; new files and directories get Node's
  default permissions (subject to umask).
- No symbolic or hard links are created.
- No native or executable artifact (`.exe`, `.node`, `.dll`, `.so`) is shipped; the npm package contents are
  checked against a deliberate allowlist by `scripts/check-package-contents.mjs` (`npm pack --dry-run`).
- No secret is read from the environment, and no user home directory is written.

## Failure boundaries (structured, never silent)

| Situation | Behaviour |
| --- | --- |
| More directories than `maxScanDirectories` | That scan stops and reports `Worktree scan limit reached; choose a more specific Workspace.`; no half result is returned |
| `git` missing or cannot be started | The `subprocess.spawn` error is thrown up; the request fails and the UI shows git's own diagnostic |
| Any `git` subcommand exits non-zero | Throws `git <args> failed (exit N): <stderr>` with git's text preserved; the query helpers (`tryRunGit`/`gitSucceeded`) degrade a failure to "unknown/no" without changing repository state |
| One repository's worktree fails during create | That repository is reported failed, the others are still created, and what was built is reported as it stands — no silent rollback |
| A commit fails (hook refusing, missing `user.name`/`user.email`, gpg signing, `index.lock`, a file in use) | Affects that repository only: it is neither merged nor removed and keeps its state, the others carry on, and the result names each one |
| A merge conflicts | Not aborted and not reverted — the conflict stays in that worktree (keeping `MERGE_HEAD` and its unresolved files); the finish reports partial success (`failed: true`) with `mergeSite` and `conflictedFiles` and waits for the user to authorise an agent |
| Removing a worktree fails | Reported as a failure (with `worktree prune` as the remedy); the task space directory and the Workspace registration stay, and the directory is never force-deleted |
| Archiving fails to copy | Reports the error and keeps the source files; the task space is not deleted |
| A session in that Workspace is still running | Finishing is refused until that session ends or is stopped |
| The task space directory still holds anything | The directory is not deleted and the Workspace stays registered |
| Something cannot be confirmed | This file and `README.md` say "unknown / unverified" rather than reading "not found" as "does not access" |

## Relation to the DSH STORE contract

- **Supply chain**: zero third-party runtime dependencies; all four `peerDependencies` are provided by the
  DSH profile; `@hugeicons/*` and `@radix-ui/react-dialog` are build-time only and already inlined into
  `client/client.js`. No lifecycle script, no native artifact, no submodule, no symlink, and the package
  contents are checked against an explicit allowlist.
- **Permission signals**: file access and command execution (`git`) *are* what this plugin does, so it
  **cannot** satisfy DSH STORE's automatic-approval condition of empty file/network/command/credential
  signals. The point of this file is to declare those signals completely and honestly for human re-review and
  for the listing details — the correct state for a high-capability project is "declared high capability",
  not "apparently no capability".
- **Lifecycle**: the disposable-profile install, start and uninstall steps, with the evidence available today,
  are in `docs/store-evidence.md`.

## Language versions

- English: this file
- 简体中文: [`PERMISSIONS.md`](PERMISSIONS.md)

# PERMISSIONS — dsh-worktree-space permissions and failure boundaries

This file exists for DSH STORE's automated review and for human re-review: it states plainly what this
plugin does at runtime, what it does not do, and where it stops.

Declared baseline: `dsh-worktree-space@1.2.0`, at the fixed commit on this repository's default branch. The plugin version, `engines` and `dsh` fields are in `package.json`.

## Runtime behaviour

- **Purpose**: make "one task spanning several repositories" a Workspace beside the repositories'
  directory — never inside it, never above it. Every
  selected repository gets its own `git worktree` at `<container root>/<project>/<task>/<repository>`, all on
  the same task branch; the **project** layer is one the plugin derives from the source Workspace's own
  directory name, so there is nothing for the user to fill in; `<container root>/<project>/<task>` is
  registered as a DSH Workspace and opened with a session whose working directory is the task space.

- **Reads**:
  - The Workspace directory tree, read-only: a breadth-first `readdir` walk, at most `scanDepth` levels
    (1–5, default 2) and at most `maxScanDirectories` directories (default 1000), reading up to eight
    directories at a time per level. `node_modules`, `Library`, `dist`, `build`, `vendor` and hidden
    directories are skipped (except `.worktrees`). The scan only decides *which directory is a Git
    repository* — it **does not read file contents**.
  - The task space's two metadata files `worktree-space.json` and `worktree-space.md`, plus each repository
    worktree's `<worktree>/.git` marker file (used to tell whether that worktree has gone stale).
  - The container root's `<container root>/.git` and `<container root>/README.md`: the first, if present,
    means the container root is itself a Git repository and creation is refused; the second, if present, is
    never written over. Both are existence checks only.
  - `assets/skill/task-worktree-space/SKILL.md` inside this package (registered as a bundled skill, read
    only, never copied anywhere).
  - The paths the user chooses (source root; the Worktree Space container root, either typed into the create dialog
    or named by the Custom Worktree Space container root setting; and the archive directory).
  - On finish, the **contents** of the files git lists in a worktree through `git diff --name-only HEAD` and
    `git diff --name-only --diff-filter=U`: each is read back only to decide whether a merge still carries
    conflict markers (line by line, for lines starting with `<<<<<<<`, `=======` or `>>>>>>>`). A listed path
    that cannot be read (a submodule, a directory) is skipped. Nothing but those markers is inspected, and no
    content is written to a log or a response.

- **Writes**: only inside the task space directory the user chose, its archive directory, the one directory
  identified as a stale worktree, and one merge checkout the plugin creates under the **system temporary
  directory** (below); **never** into the files of a source repository's checkout, and never into the DSH
  installation or a configuration file.
  - Create: `mkdir` the container root, the project directory beneath it and the task space directory; write
    one `README.md` at the container root the first time it is used (declaring it the worktree-only area;
    an existing one is left alone); `git worktree add` creates each checkout (git writes it); write
    `worktree-space.json` and the `worktree-space.md` rendered from it.
  - Archive: `cp` the task space's documents to `<project>/<task>-<YYYYMMDD-HHMMSS>/` under the **archive
    root** the configuration names; the default root is the task space's **own container root**
    (`<container root>/archived-docs`, the very directory chosen when the task space was created), and it
    can also point at any directory you choose.
  - Clean up: `git worktree remove --force` removes a checkout; a **stale worktree** whose `.git` points at a
    gitdir that no longer exists has that one directory removed with `fs.rm(directory, { recursive: true })`;
    the task space directory itself is deleted and its Workspace registration removed only once it really is
    empty.
  - Merge: when the target branch is the one the source repository has checked out, the merge runs in place
    there (`git merge`, which writes that repository's own branch and working tree). Otherwise the plugin
    `mkdtemp`s `os.tmpdir()/dsh-worktree-space-merge-<random>/`, runs `git worktree add` for a temporary
    checkout of the target branch inside it, merges there, then `worktree remove --force` (falling back to
    `worktree prune`) and `rm`s the whole temporary directory — a merge that already succeeded is not reported
    as failed because that directory would not delete.
  - Rehearsal: a finishing run that has to merge first rehearses the merge inside **that repository's own
    worktree in the task space**. A conflict is left there as it stands; a clean rehearsal is `reset --hard`
    back to the commit recorded before it, after which the step above records the merge on the target branch.
  - Operation log: one line of JSON appended with `fs.appendFile` to **`worktree-space-log.jsonl` at the
    container root**; described below.
  - git's own bookkeeping: `git worktree add/remove` writes git's own registration and index under
    `<source repo>/.git/worktrees/<name>/` (the `.git` marker, `HEAD`, `index`, …). That is git's doing; the
    plugin never edits files in a source repository's checkout.
  - Configuration (the entry switches, scan depth, default branch prefix, Worktree Space container root, archive
    location) is stored by
    DSH's own plugin configuration service (the Plugins page's live form); **the plugin writes no
    configuration file**, and its `task.preference` endpoint is read-only.

- **Command execution**: `git` is invoked through the host's `subprocess` service with a **fixed argv**
  (`argv: ['git', '-C', <cwd>, ...args]`): **no shell**, no string interpolation, no user-supplied command,
  and no executable other than `git`. Every subcommand is listed in the table below.

- **The plugin does not commit**: `git add` and `git commit` are **not in this plugin's command table**. When
  a worktree still holds uncommitted work at finish, that repository stops and is named (see the failure
  boundaries) — the plugin writes no commit for it. "Hand the commit to an agent" means the plugin **opens a
  separate session**, in which the **host's agent** runs `git add` / `git commit`: those commands are not
  issued by this plugin and are not part of its permission signals.

- **Network**: the plugin itself issues **no HTTP request at all** and runs **no `git push`**. Every `git`
  subcommand it runs is local (see the table below) and writes no remote ref. Git's own credential helpers and
  proxy settings are outside this plugin's control.

- **Credentials/keys**: the plugin **does not read, store or forward** credentials. It does not read
  `process.env`, `~/.git-credentials`, `~/.ssh`, `.netrc` or an OS keychain, and it writes no credential into a
  log or a response.

- **Operation log**: **`worktree-space-log.jsonl` at the container root**, a JSONL file that is only ever
  appended to, never rewritten and never deleted. One line per `git` call that changes repository state, per
  failing `git` call, and per error or warning: `ts` (ISO time), `kind` (`git` / `error` / `warning`), `op`
  (the endpoint), `task`, `project`, and that record's own fields — `argv`, `cwd`, `exit` and `stderr` (past
  2 KB truncated) for a command, `message`, `stack`, `code` and the repository and phase it happened in for an
  error.
  - **Only paths, commands and git's own diagnostic text are recorded. No file contents**, and no file
    content is read in order to record one.
  - Credentials inside a URL are replaced with `***` before the write (`https://user:token@host/x` becomes
    `https://***@host/x`); an `@` in a path is left alone.
  - A successful **read-only** `git` call is not recorded (`status`, `rev-parse`, `for-each-ref` and the
  like); a state-changing command and **any failure** are, including one whose failure the caller was going
  to swallow — such as the query that asks whether a branch already exists.
  - **It writes only where the container root already exists, and never creates a directory.** There the
    append fails and is ignored, so calls that belong to no task space — `worktree.scan`, `worktree.status` —
    record nothing at all.
  - Any failure of the write itself (file deleted, directory read-only, disk full) is swallowed and **changes
    no outcome of any operation**. The write is `await`ed: the record is on disk when the call returns, in
    the order the commands ended.
  - Past 10 MB the current file is renamed to `worktree-space-log.<YYYYMMDD-HHMMSS>.jsonl` and a new one
    starts; **the old file is kept**.
  - **No endpoint reads it and it leaves this machine**: nothing is sent, uploaded or returned.
  - Deleting the container root deletes the log with it. It is not a backup and not an audit record.

- **External services**: none. No account, no server, no telemetry.

- **Global resources**: no global packages installed, no daemon, no system service, no permission changes, no
  symbolic links; the scan cache lives in the DSH instance's memory only and is gone when the instance exits.

### Every git subcommand invoked

| Kind | Subcommands |
| --- | --- |
| Queries (read-only) | `rev-parse --show-toplevel`, `rev-parse --git-common-dir`, `rev-parse --abbrev-ref HEAD`, `rev-parse HEAD`, `rev-parse --verify --quiet <ref>^{commit}`, `rev-parse --verify --quiet MERGE_HEAD`, `symbolic-ref --quiet --short refs/remotes/origin/HEAD`, `for-each-ref --format=%(refname:short) <refs>`, `show-ref --verify --quiet`, `status --short`, `status --porcelain`, `status --short --branch`, `worktree list --porcelain`, `rev-list --count`, `merge-base --is-ancestor`, `diff --name-only HEAD`, `diff --name-only --diff-filter=U` |
| Worktrees | `worktree add`, `worktree remove [--force]`, `worktree prune` |
| Branches and merges | `branch -d`, `branch -D`, `merge --no-ff --no-edit <ref>`, `merge --abort`, `reset --hard <sha>` |

## Dependencies

| Dependency | Purpose | Provided by |
| --- | --- | --- |
| Node.js `>=22.19.0` | Runtime (`engines.node` in `package.json`) | The user's environment |
| DSH `>=0.1.7-rc.1 <0.3.0-0` | Host: client contract and service injection (`engines.dsh` / `dsh.compatibility.dsh`, declarative) | The user's environment |
| `@deepseek-ai/cordis` `^4.0.2` | Plugin framework | DSH profile (`peerDependencies`) |
| `@deepseek-ai/dsh-client-connection` `>=0.1.7-rc.1 <0.3.0-0` | Client connection and host RPC (`/api/dsh-worktree-space`); from DSH 0.2.0 on, install and startup enforce this range | DSH profile (`peerDependencies`) |
| `@deepseek-ai/dsh-tools` `>=0.1.7-rc.1 <0.3.0-0` | Host tool definition, `defineTool`; enforced by DSH the same way | DSH profile (`peerDependencies`) |
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
| A worktree still holds uncommitted work at finish | That repository stops (`force` is the caller saying "these changes can go"): it reports `uncommitted work is waiting in <worktree>; commit it before the task can be finished` and **writes no commit**; the others carry on and the result names each one |
| A merge is resolved but not committed | Not committed for you: reports `the merge in <worktree> is resolved but not committed` and keeps the state as it stands until whoever resolved it commits |
| The resolved files still carry conflict markers | Reports `the resolved merge still has conflict markers in <files>` and keeps them as they stand — it takes no side |
| A merge conflicts | Not aborted and not reverted — the conflict stays in that worktree (keeping `MERGE_HEAD` and its unresolved files); the finish reports partial success (`failed: true`) with `mergeSite` and `conflictedFiles` and waits for the user to authorise an agent |
| Removing a worktree fails | Reports `failed to remove the worktree (uncommitted changes? force it deliberately)` (with `worktree prune` as the remedy); the task space directory and the Workspace registration stay, and the directory is never force-deleted |
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
- **Fixed commit**: `57bf17b` (`build: bundles for 1.2.0`) — the commit the compatibility matrix actually
  installed; every row in section 5 of `store-evidence.md` comes from that run. The tag `v1.2.0` has
  **not been pushed**, so the hash is not yet checkable on GitHub. When `v1.2.0` is pushed it must point
  at this same commit, or the evidence describes an artifact other than the one released.
- **Lifecycle**: the disposable-profile install, start and uninstall steps, with the evidence available today,
  are in `docs/store-evidence.md`.

## Language versions

- English: this file
- 简体中文: [`PERMISSIONS.md`](PERMISSIONS.md)

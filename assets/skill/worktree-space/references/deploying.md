## Deploying for acceptance

When the user wants to try the work, or a change only shows itself at runtime,
deploy the task space's services to an isolated Docker environment instead of
starting them on the host: ports cannot collide with anything the user already
runs, the services reach each other over their own network, and tearing the
whole environment down afterwards is one command.

A task space is deployable when one of its repositories carries a
`deploy/deploy.sh` of its own, or when the space holds the plugin's own deploy root,
`.worktree-space/deploy/` — a `docker-compose.yml` whose build contexts name the sibling
worktrees, copied in from the source root or scaffolded by the create. A source root that
keeps its own deploy root, `.worktree-space/deploy/`, has that directory copied **whole to the
same relative place** in every task space made from it — so look before scaffolding one. That
root sits one directory deeper than a top-level `deploy/` did: a compose file's build contexts
that were `../<repo>` become `../../<repo>`, and the same shift applies to the workspace's copy
and to the task space's alike. A create
may instead name one script with the `deployScript` argument, a path relative to the
source root that has to sit **under its `.worktree-space/deploy/` directory** (any depth); it travels
into the task space under its own name, at the same relative place, and the task's record
remembers it as the
entry to run, so nothing is renamed and no file is overwritten. Anything outside that
directory, or naming no file, is refused (E4014) before anything is made.
There is no manifest to declare targets in: the entry script is the whole contract,
and docker is the only target.

**A task created with `deployTarget: docker` needs something to deploy with**, and a
create that has none is refused (E4015) rather than made undeployable. Any one of the
three counts: a `.worktree-space/deploy/deploy.sh` at the source root, a script named by `deployScript`,
or a selected repository carrying its own `deploy/deploy.sh`. So before creating a
deploying task, check that one of those exists — and if the user wants a deployment and
none does, building that `.worktree-space/deploy/` root from the repositories' own run
commands is ordinary session work; what must not happen is starting the services on the
host instead.

**The deploy root writes its own delivery state, and the gate reads that file.** The file is
`<task space>/.worktree-space/deploy/.state.json` — fixed, whatever the entry script is
called and wherever under the deploy root it sits. The plugin passes that absolute path to
every script it runs as
`DEPLOY_STATE_FILE`, so a script writes `${DEPLOY_STATE_FILE}` and never has to work out
where the deploy root is. It is what the panel and the merge gate read:

- `<entry> up` writes `url` (and whatever `services` it likes) once the environment is up;
- `<entry> smoke` merges `lastSmoke: { result, at }` into it **without dropping the fields
  already there** — a pretty rewrite that loses `destroyedAt` forgets that the environment is
  down;
- **`up` and `smoke` must never write `destroyedAt`.** They run while the environment is up,
  and a stale-down stamp left behind by a previous teardown is the plugin's to clear, not
  theirs to guess at.

**A `destroy` subcommand is optional, and the plugin never calls one.** The panel's destroy
button finds this task's containers by their `dsh.env-id` label and takes them down itself, so
an entry that implements only `up` and `smoke` is complete. Implement `destroy` only as a
convenience for a person or a session working by hand — and if you do, **it must leave the
state file exactly as the plugin's own teardown would**: set `url` to `null` (its dynamic port
is dead) and stamp `destroyedAt` with the current UTC time, keeping `lastSmoke` and every other
field. A `destroy` that only runs `docker compose down` leaves a live-looking acceptance URL
behind, and the panel then shows a dead address as if it worked.

**Nothing else may write that file**: not a hand edit, and not a transcript of a run that
happened somewhere else. The gate reads it as the evidence that the step happened, so
writing it from outside turns the gate into a formality — if the state is missing, fix the
script that should have written it, or tell the user; the human's own way past the gate is
the panel's "finish anyway". A missing file, or a `lastSmoke.result` that is not `pass`, is
exactly why the panel shows no acceptance URL and why `done` refuses the merge
(E5006 — the same code for both, because the next step is the same).

**Scaffolding writes logs so that the host can still read and archive them.** When a
service's log directory is bind-mounted out of the container, the service must not be
asked to split its log by day *and* keep a "current log" symlink beside it: a symlink a
Linux process creates inside a directory mounted from Windows lands on NTFS as a Linux
symlink (`IO_REPARSE_TAG_LX_SYMLINK`), which Windows can neither recreate nor follow. The
finish cannot file that leftover into the archive, so it stops with the task space still
in place and asks the user to deal with the file.

Ask for one plain file instead — the service's own knob, passed **in the environment the
container actually reads**. For a service whose appender is built from
`LOG_DIR`/`LOG_ROTATION`, that is `LOG_ROTATION: never` in the compose file's
`environment:`; check which input drives it rather than writing the value into a YAML
config the process may never read (a gateway whose appender comes from
`FileLogConfig::from_env` ignores the same key in its own config file, and the task then
looks solved while the link keeps appearing). Leaving the logs inside the container and
reading them with `docker logs` works too, and is what `<entry> logs <service>` does
anyway.

Retrofitting it into a running stack means the log directory gains a reparse point; if one
is already there, the user removes that single file and finishes the task again.

- A container engine has to be reachable for any of this to work: the `docker` command on PATH
  with its daemon running. Docker Desktop, Podman, colima and a native Linux engine all count.
  Nothing here checks that for you, so when a deploy fails on
  `docker` itself rather than on the entry, read it as the engine and say so plainly rather than
  retrying: `The command 'docker' could not be found in this WSL 2 distro` is Docker Desktop's
  WSL integration being off for that distribution, not a missing docker.
- Take the environment id from `.worktree-space/worktree-space.md` (`DEPLOY_ENV_ID=...`) and pass it
  to **every** deploy command. It is what keeps this task's containers, images and
  acceptance URL apart from every other task's — never guess one, and never reuse
  another's.
- Run the task's own deploy entry — `<entry>` below is the path the note names, run from
  `.worktree-space/`, and `.worktree-space/deploy/deploy.sh` when it names none. `<entry> up`
  builds and starts the environment
  and prints the acceptance URL. Run `<entry> smoke` and let it pass **before** reporting
  the URL: an address that answers 500 is not a deliverable. When it fails, the reason is
  usually in `<entry> logs <service>`.
- Report the URL together with what to click to see the change, and say that the
  environment keeps running until it is destroyed.
- Leave the environment to the user. The panel's destroy button takes it down, and every
  deployed container carries a `dsh.env-id` label, so an environment can also be found and
  cleaned up after the fact. Use `<entry> destroy` only when the entry provides one and you are
  working by hand — the plugin's own button does not need it.

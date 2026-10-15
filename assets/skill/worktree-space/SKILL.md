---
name: worktree-space
description: Use when the user starts a task or feature spanning one or more repositories and wants the work isolated in its own git worktree workspace rather than the source checkouts - multi-repo, parallel sessions, an isolated branch - or asks to list, merge or clean up a finished task, or to deploy a task's services to a Docker environment for acceptance - 部署验收, 隔离环境, 验收地址. Chinese phrasings that mean the same include 多仓库并行开发、独立工作目录、工作区隔离、任务空间、Worktree Space、收尾合并清理、部署验收.
---

# Task Worktree Space

Isolate work per task using git worktrees, in a source root that holds one or
more git repositories. One task is one directory beside the repositories' directory holding
a worktree of every selected repository, all on the same branch, so a single
session can edit across repositories while other sessions and the source
repositories stay untouched.

Drive the whole workflow through the `wts_worktree_space` tool. Do not run
`git worktree` commands by hand for it.

> **Beta (experimental)**: handing a merge conflict to an agent is the part of this plugin
> that may still change, and the plugin's own configuration can hide the two entries that
> offer it - so never promise the user a button that may not be on screen. Tell them that
> reports belong at
> https://github.com/kangtsang/dsh-worktree-space/issues when something goes wrong.

## The model

```
~/workspace/                        ← the root workspace: the first directory below the volume root
├── projects/                        ← source root: the repositories, stay on main
│   ├── project_a/
│   └── project_b/
├── deep/other-project/              ← another source root, filed deeper — same container
└── worktree-space/                  ← container root: one level below the root workspace
    └── projects/                    ← project layer: the source root's own directory name
        └── fix-login/               ← the task directory — the session's cwd
            ├── project_a/           ← worktree, branch task/fix-login
            └── project_b/
```

The container root holds one directory per **project** — the source root's own
directory name, derived rather than asked for — and each project holds its tasks.
That is what keeps two projects' tasks of the same name apart, and it is the same
depth in every case, so the task directory is always `<container root>/<project>/<task>`.

For a single repository the shape is the same: the source root is that one
repository and the task directory holds a single worktree of it. Where the source
root **is** the repository, the project layer and the repository take the same
name — `~/workspace/repo-x` gives `<container root>/repo-x/fix-login/repo-x` —
and that repeat is deliberate, not a mistake to correct.

The container root is the plugin's own zone: the first task space created under it
writes a `README.md` there saying so, and a container root that is itself a git
repository (it has a `.git`) is refused outright.

Why this shape:

- **File isolation** — each task directory is a physically separate checkout, so
  sessions cannot overwrite each other's uncommitted work.
- **Commit isolation** — every worktree is on `task/<task>`, so commits from
  different tasks never interleave on one branch.
- **Cross-repo coherence** — every repository in a task shares the branch name;
  that is what links the task's commits across repositories.
- **Source/work separation** — the task space is a directory of its own: never
  inside the repositories' directory, and never a parent of it; the tool refuses
  both.

## Starting a task (ask first, then create)

Follow this order. Never create a workspace with a guessed location.

1. **Task name** — take it from the user's message; ask when it is missing.
2. **Source root** — the directory holding the repositories, usually the
   session's working directory. If that directory is itself a git repository it
   is used directly; a git worktree checkout is not a source root.
3. **Run `action: "suggest-root"`** with that directory as `sourceRoot`. It
   reports the repositories the task would span and the recommended container
   root — `worktree-space` one level below the **root workspace**, that is, in
   the first directory the source root sits in below its volume root. Two source
   roots under the same root workspace are offered the same container however
   deep their own project is filed (`~/workspace/projects` and
   `~/workspace/deep/other-project` both recommend
   `~/workspace/worktree-space`). The task space and the source tree therefore
   share a prefix, and a session opened on their common ancestor can still reach
   each worktree's index (which lives under the source repository's
   `.git/worktrees/<name>/`) to commit and to resolve a conflict. A source root
   sitting directly under the volume root shares nothing but that root with its
   worktrees, so a session there has to be approved in by the user.
   The plugin's own configuration can name the container root instead — that
   setting is the user's standing answer to where task spaces go — and
   `suggest-root` reports that one when it is set, so report what it returns
   rather than a location of your own.
4. **Ask the user where the task space should live**, offering the recommendation
   first and one or two alternatives. Skip the question only when the user
   already stated the location, and expect the recommendation to be the
   configured container root when the plugin has one. Never offer a location
   inside the repositories' directory, and never one that would hold it.
5. **Ask which repositories** to include when the source root holds several and
   the user did not say; pass the chosen directory names as `repos`.
6. **Ask which commit to start from** — recommend each repository's current HEAD
   (omit `baseRef`); alternatives are another active branch or the main branch.
7. **Branch prefix** — `task/` unless the user asks for another one; pass the
   choice as `branchPrefix` and expect the branch to be that prefix plus the task
   name (`hotfix/<task>`, `release-<task>`, …).
8. **Ask about the acceptance fence — before the create, and before any session is
   opened in it.** The one delivery decision a create makes is `deployTarget`, it is
   settled there, and nothing can add or change it afterwards. Put the question plainly:
   is this task deployed for acceptance — the task space brings its own environment up
   and a smoke has to pass before the work may land (`deployTarget: "docker"`) — or is
   there nothing to deploy (`deployTarget: "none"`, the built-in default)?
   **Do not answer it for the user, and do not create the space, or open a session in
   one, with the question still open.** A fence nobody chose cannot be fitted afterwards,
   and no record says one was ever wanted, so the task goes on with no acceptance check
   at all and nothing in the interface says so. `none` is a good answer for work that
   carries no runtime behaviour to accept; state which answer is being passed and why.
   *Deploying for acceptance* below says what a deploying space owes.
9. **Run `action: "create"`.** It does both halves: it makes the task directory,
   the branch and one worktree per repository **and registers the result as a DSH
   Workspace**, which is what puts the task space in the workspace list under
   `<source workspace title>/<task>`. Pass `registerWorkspace: false` only when the
   user asked for a task space that stays out of that list: it is then on disk with
   nothing in the interface showing it, and the result says so.
   **Given a `prompt` as well, it also opens a session in the new task space and
   hands it that job in the same call** — one step, which is what the panel's
   **Create and open** does in one press, except that the session there starts empty
   and this one is already working. Do that when the user wants the work started, not
   merely a place to work in; see *Putting a session on the work* below.
   **The delivery answer is step 8's `deployTarget`, and it is settled here.** `docker`
   means the task expects a deployment, and its finish gate is live: `done` with
   `merge: true` is refused until `.worktree-space/deploy/.state.json` records a passing
   smoke — and that smoke is the finish line rather than a formality: `up` writes the
   acceptance URL, `smoke` records the pass, and those two are what a completion report
   carries. `none` means no deployment and no gate. A create that passes `docker` with
   nothing to deploy with is refused (E4015). Everything else a finish
   decides (whether to merge, which branch, whether to delete it, what happens to
   untracked files) is passed on the `done` call instead, where you can see the work
   it applies to. See *Finishing* below.
   **The gate is not something this tool can sign off.** `done` takes no
   acknowledgement argument, and `force` is refused outright (E7007); the user's own
   overrule exists only on the Worktree Space panel. When `done` answers with E5006,
   the way past is to deploy and run the smoke through the task space's own deploy entry
   — report what is missing and do that, or tell the user they can
   finish anyway from the panel. Never retry the same call expecting a different
   answer, and never reach for a flag this tool does not have.
10. **Report where it is, and say which entry opens the session.** When this call
   opened one, name the session id it answered with — the same id is now written into
   the task's record, and `action: "list"` reports it — and use it to watch or correct
   that session (see "Watching the member session" below). When it did not, a
   session is opened by hand — the panel's **Create and open** in the Worktree Space
   dialog, or picking the registered Workspace in the workspace list. Report the task
   directory path and the branch name, then name that entry rather than leaving the
   user to find it.
   A create that answers with a warning that the Workspace was **not** registered
   means one of three things, and the warning names which: the call asked for a task
   space that stays out of the list (`registerWorkspace: false`), the deployment
   serves no workspace registry, or the registration itself failed. Register the
   directory before anything is opened in it — **Create and open**, or **Register
   again** when a create is refused — and do not report the task as under way until
   that is done, because until then nothing in the interface shows the task space.
11. **Work in the task directory**: it is where the task's session belongs.

### Putting a session on the work

Two roles are named from here on. **You are the leader agent** (the leader): the session
that creates the task space and dispatches the work. **The session you dispatch into it is
the member agent** (the member); its session is the **member session**, also called the
**task session** — the same session under two names.

Choose between those two names by context, because both are accurate and neither is a
correction of the other. **Use the member wording when the two are set against each
other** — who talks to whom, who reports to whom, who watches whom — where the pairing
gives the sentence a foil and makes the relation plain at a glance. **Use task session
everywhere else**, where no role relation is in play and the plainer name is more direct.
Do not mix the two names inside one sentence.

A session is a conversation with its own context: it does not see this one, so the
`prompt` has to stand alone. Two ways to open one, and they differ only in *when*:

- **`create` with a `prompt`** starts the task and hands over the first job in one
  call. This is the one to reach for when the user asks for work to be done rather
  than for a place to do it.
- **`dispatch` with a `prompt`** hands a job to a session in a task space that
  already exists — for the second and later jobs (make it, then smoke it, then fix
  what the smoke found), because a task space outlives any one conversation.

Both open the session in the task space itself, so it reads under that task in the
workspace list and can be followed from there, and both answer with the session id.
Both are given **the permission the calling session carries as its own sandbox
override, and nothing more** — a session opened this way can never be wider than the
one that opened it. Pass `permission` only when the user asked for more:
`danger-full-access` is the whole machine, and it is written as the whole of what DSH
means by it — that mode together with `never`, which is what the panel's own switch
produces ("full file access without approval prompts"). What a session in the task space
can do without asking is write **inside the task space**, which is enough to build, test
and deploy there; committing still writes the source repository's `.git` outside it, so
that stays with the handoff below. A deployment that serves no session service says
so in a warning instead of opening anything — then the session is the panel's to
open, and the work is the user's to start.

Task branches are local only. Pushing one to a remote is the user's own action:
this plugin never writes to a remote, so never push from here.

### Watching the member session (and correcting it)

The member session is **not your child**: it has its own context and its own approval
gate, and `send_message` refuses it outright (`belongs to another parent session`).
Reach it with the session-control tools instead. The id you need is already in hand —
`create` and `dispatch` write it into the task's record, and `action: "list"` reports
it — so `wts_session_tool_find` is the fallback for when it is not.

- **`wts_session_tool_status` is how "stuck" is told from "busy".** `lastActivity` is
  the only reliable signal: during a build, file times, mtimes and log tails all sit
  still, while the session's own clock keeps running. Pass `stalledMsThreshold` and a
  **running** session is marked `stalled` past it; an idle one never is, because a
  finished session being quiet is not stuck. `lastReply` and the reasoning tail say
  what it currently believes it is doing. `lastTurnEnd` names a turn that did not end
  `completed` (`error` / `interrupted` / `blocked` / `max-tokens`) — the one way to
  tell "the task finished" from "an error killed it into silence", since both look
  like idle with nothing queued.
- **A correction that matters now must be a `steer`, never a `queue`.** `queue` is
  read at the session's next **turn boundary**, and a long task is often one long
  turn — so the message sits unread in the inbox while the session looks exactly like
  one ignoring you. Use `wts_session_tool_send` with `mode: "steer"` for anything
  time-sensitive ("stop, there are 23 uncommitted files and the finish needs it
  clean"); reserve `queue` for what can genuinely wait for a boundary.
- **To tell "never arrived" from "did not do it", read the log.**
  `wts_session_tool_read` returns the messages with their `seq`; a message you sent
  that is not there was not delivered, which is a different problem from one that
  arrived and was ignored.
- **A report you send is attributed to you and shown as an agent's report.** The
  message carries your session as its sender, so the receiving interface gives it its
  own row ("Task message received", "from session X") instead of presenting it as
  something the user typed. **The tool adds a header for you** — the task, the
  workspace, the task-space path, the branch and your session id — so write the body
  only: what you did, what you verified, and what you did not. Do not repeat the
  header's facts in the body.
- **You will be told if the session dies mid-turn, even though it cannot reach you
  itself.** A turn that ends `error`, `interrupted`, `blocked` or `max-tokens` sends
  you a notice naming the task and the **session id**. It says the work is not
  finished — do not treat that task as done. `completed` and `aborted` send nothing:
  the second is the user stopping it on purpose. When a notice arrives, use
  `wts_session_tool_status` to see where it stopped and `wts_session_tool_send` to put
  it back to work.
- **A timeout is not an empty answer.** `wts_session_tool_wait` returns the output
  that already existed, marked `stale`, when its budget runs out — so you always
  learn what the session last said.
- **The recovery chain, in order.** `status` first, to tell "running but stuck" from
  "offline" → `wts_session_tool_resume` for the offline one (a host restart puts
  every session offline), or `wts_session_tool_create` in **the same task space** for
  one that is lost → and **read its last state before deciding what to send**.
  `wts_session_tool_cancel` is the brake: it aborts the active turn, and `keepInbox`
  decides whether the queued work survives.

Do not poll in a loop, and do not steer or cancel on a timer: look at the real state
when something suggests you should, then decide. That judgement is yours, not a
watchdog's.

## Adding a repository to a task already under way

Run `action: "add"` when a task that already exists turns out to need a repository
it did not start with. Do **not** create a second task for it, and do not run
`git worktree` by hand.

- Pass `tasksRoot` (the container root), `task`, and `project` — or `sourceRoot`
  instead of `project`, as for `done`.
- Pass each repository in `repos` as an **absolute path**, not a name. A repository
  added this way does not have to sit under the source root the task began from:
  it may be under another source root, or on another volume entirely.
- `baseRef` is optional. Omitted, each repository starts from its own HEAD; pass the
  task's own `baseRef` to have them start from what the task started from.
- The new repository joins the branch the task is already on, and the task's
  metadata records where its source repository lives.
- Nothing is removed from a task this way. There is no "remove a repository"
  action: if the user asks for one, say so rather than approximating it with
  `git worktree remove` or a delete.

Where a repository lives changes nothing about finishing. A finish reads each
worktree's own source repository, so the merge, the worktree removal and the
branch deletion all work the same from any volume. What it does change is the
write boundary of a session that commits here: a linked worktree keeps its git
metadata inside its source repository, so a repository that shares no common
directory with the task space — another volume, certainly — is outside a session
opened on the task space. The finish dialog already says so when it hands commits
or a conflict to an agent, and asks for the elevation in that session. Say it
when you add such a repository rather than letting the user meet it at the end.

## Working inside a task space

When the working directory is a task directory — a folder whose subfolders are
worktrees of different repositories:

- The task directory itself is **not** a git repository; run git commands inside
  each repository subdirectory.
- Commit in **each repository separately**; there is no cross-repo commit. The
  branch name is the same everywhere.
- **Never edit or commit in the source repositories, and never hand-merge there** —
  for the session they are read-only references. A `git merge` you run yourself in a
  source checkout is not the same thing as finishing the task, which the plugin does
  for you and which the next point covers.
- **Who finishes is the user's decision, and both flows work.** Either the session
  working in the task space calls `done` itself once the work is complete, or it
  reports back and the leader — or the user — calls it. The authorisation runs down the
  chain: the user authorised the leader, which instructed the member session, so a session
  finishing the work it was told to do is that authorisation
  carried out, not a decision of its own. **Ask which flow is wanted when it is not
  stated**, because the two differ in one way that matters: `done` is atomic.
  - A session that finishes its own work is **not** its own blocker: the E5012 guard
    below leaves the caller out of the sessions it counts, so the flow is reachable
    from inside a running turn. Every *other* session in the task space still blocks it.
  - `merge: true` lands the task branch on the target, removes the worktrees and
    clears the task space in one call. This is the step a finish cannot take back, so
    it is the user's authorisation and not a formality — merge only when the work was
    asked to land.
  - `merge: false` leaves the branch where it is. The commits are kept, but the
    worktree is still removed, so a conflict left over would have to be resolved in
    the source repository rather than in the isolated checkout. That is worth avoiding,
    but it is not a loss: **the commits are on the task branch**, and whether and when
    to merge them afterwards is the user's call — the plugin does not interfere.
- Read the task's `.worktree-space/worktree-space.md` for its branch, base and repositories
  rather than guessing (the same facts as data live in `.worktree-space/worktree-space.json`);
  if another session created the workspace, follow that file.

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

- Take the environment id from `.worktree-space/worktree-space.md` (`DEPLOY_ENV_ID=...`) and pass it
  to **every** deploy command. It is what keeps this task's containers, images and
  acceptance URL apart from every other task's — never guess one, and never reuse
  another task's.
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

## Finishing a task

Run `action: "done"`. It **removes the worktrees** and, by default, **keeps every branch**.
Two arguments are the whole of the decision, and one of them is required.

**A deploying task is not finished until its fence has passed.** With `deployTarget: docker`
the finish is not merely gated by the smoke, it is defined by it: the work is done when the
task space's own smoke has run and recorded `pass`, and the acceptance URL that `up` wrote
is what the user is handed. Never report such a task complete on the grounds that the code
is written, and never treat the gate as a formality to clear — `done` refuses the merge
while it is unsatisfied (E5006), this tool has no override to send, and the user's own
"finish anyway" lives on the panel.

**Who calls it is the user's decision, and both flows are supported.**

| Flow | How it goes | What it costs |
| --- | --- | --- |
| **The session finishes its own work** | the session in the task space calls `done` when the work is complete, resolving any conflict itself | nothing — and it is the one that can resolve a conflict in the isolated checkout, where the merge is rehearsed |
| **The leader finishes** | the member session reports back; the leader, or the user, calls `done` | one more round trip, and whoever calls it is not looking at the work |

The plugin does not prefer either and does not restrict either. **The authorisation runs down
the chain**: the user authorised the leader, which instructed the member session, so a
session finishing the work it was told to do is that authorisation carried out. What it must
not do is invent one — merge only where the work was asked to land, and ask when the brief
does not say which flow is wanted.

Both flows are reachable: the E5012 guard counts the sessions working in the task space
**except the caller**, so the member session that calls `done` mid-turn is not refused with itself as
the blocker. Other sessions in there still are.

**`merge` is required — `done` refuses a call that omits it (E7006).** Pass `merge: true`
to land the task branches on their targets, or `merge: false` to leave the work where it
is. There is no default because this is the one step a finish cannot take back: a merge
that landed has to be reverted by hand, and a branch that was not merged keeps its
commits where they are. Decide it from what the user asked for — do not guess, and do not
call `done` without it. Nothing about the merge is recorded in the task any more, so
there is no standing answer to fall back on: the call says what happens.

**`done` is refused while a session is still working in the task space (E5012).** A finish
removes the worktrees and the task space, so a session whose working directory is inside it
would lose the ground under it mid-turn — it keeps running, its next write lands on a path that
is gone, and the work it had not committed is unrecoverable. The refusal names the sessions and
what each is doing (running, mid-turn, or holding queued work). **Stop them first**, with
`wts_session_tool_cancel`, and call `done` again; `wts_session_tool_status` says what each is
doing before you stop it. If the work is not meant to stop, leave the task space standing —
nothing has been removed, and it is still there.

**The caller is not one of those sessions.** The member session finishing its own work is running, with a
turn open, inside the task space it is asking to remove — so it is left out of the count, and
`done` from inside the working turn is not refused with the caller as its own blocker. (That is
what makes the session-finishes-its-own-work flow reachable at all; cancelling yourself first
would end the turn and the report with it.) Every *other* session in the task space still
counts.

**`strays` says what happens to the files git never tracked**, and omitting it means
`archive`:

| `strays` | The user's untracked files | Build output | The task space |
| --- | --- | --- | --- |
| `archive` (default) | copied into the archive directory, then removed | cleared | removed and unregistered |
| `keep` | left exactly where they are | left | kept (it is not empty) |
| `discard` | **deleted** | cleared | removed and unregistered |

**`discard` is refused here (E7007) and you must not reach for it.** It is the only
choice that loses anything, and deleting the user's own writing is theirs to decide -
there is no reflog behind those files and no branch to recover them from. Only the
Worktree Space panel can do it, where the box says what it costs. When the user asks
for the leftovers to be thrown away, tell them to finish from the panel; do not
substitute `archive` silently either, because that is a different outcome than the one
they asked for. `keepEntries` names individual entries to leave alone whatever
`strays` says. Where `archive` files them is not this call's to name: they go to
the archive directory the plugin is configured with, or to the plugin's own
`archived-docs` folder under the container root when none is set, and the panel's
finish dialog shows the user that path before they confirm.

Name the task's own layer as well as the container: pass `tasksRoot` (the container
root), `task`, and `project` — the source root's directory name. Passing `sourceRoot`
instead of `project` is enough, since the name is derived from it; passing neither is
refused, because the container root alone cannot say which project's task of that name
was meant.

Confirm each destructive step with the user before passing it:

1. **Merge?** Only when the user explicitly says to merge. Pass `merge: true`. There is
   no longer any record that can answer this for you, so the call always says it — and
   an unsatisfied deployment gate still refuses it. A policy with `deployTarget: docker`
   needs that deployment and its passing smoke before the merge, because those are
   checks on the work rather than answers from a person. The
   merge puts the **task branch into the target branch** and it lands in the source
   repository; by default the target is the branch each source repository has checked
   out — the task's own starting point. Ask which branch to merge into when the user
   has another one in mind, and pass it as `target` (one branch for every repository);
   a branch that is checked out nowhere is merged in a temporary worktree, so no
   source checkout is ever switched. Before the target is touched, the target is
   merged into the task branch **in the opposite direction**, inside the task space's
   own worktree (`git merge --no-ff --no-edit <target>`): a clean pre-merge is undone
   again (`git reset --hard` to the HEAD from before it), while a conflict is left
   standing there — the worktree keeps its `MERGE_HEAD` and its unresolved files —
   and that repository's worktree and branch stay in place. Either way the target
   branch and the source checkout are untouched, and the other repositories still
   complete. The pre-merge is skipped only when the target is already contained in the
   task branch (`git merge-base --is-ancestor <target> <branch>`).
2. **Work nobody committed?** Nothing to decide and nothing to pass: `done` reports
   every repository the plan showed uncommitted changes for, keeps its worktree, and
   flags the row **`needsCommit: true`** with the checkout named in `error` —
   `uncommitted work is waiting in <path>`. **Read the flag, not the sentence.**
   Nothing is committed until someone who has read the changes writes the message, and
   that is the job of the session working in the task space. In the panel it is the
   user pressing **Hand the commits to the agent**; from a `done` the leader dispatched, it is
   yours to route: `wts_session_tool_send` with `mode: "steer"` to the session id the
   finish answers with (or `wts_session_tool_find` by the checkout's directory; open one
   with `wts_session_tool_create` when the record names none), asking it to commit in
   **each** of those repositories, on the task branch, with a
   message that says what the changes were for and why; read them first and never
   commit over the user's work blind, and never push. Committing changes the source
   repository's `.git` directory and may need elevated permission, which is granted in
   the session itself — the plugin never asks for it. Where those repositories share
   nothing but the volume root, one session working in the task space reaches every one
   of their worktrees but need not reach the index inside the source repositories'
   `.git`, so tell it to ask the user to approve the elevation there rather than
   assuming the git commands will go through. The wait is skipped for a
   branch being deleted unmerged (a commit would be deleted with it), for a worktree
   in the middle of an unfinished merge (step 3 takes it), and for `force: true`,
   which discards uncommitted work along with the worktree. A commit that fails keeps
   that repository as it is — not merged, not removed — while the others carry on.
   The commits do not carry the finish on by themselves either: once that session
   stops the plugin reads the plan again, and where the worktrees have all come back
   clean the panel says the commits are done under a green light and waits for the
   user's own **Finish task** press — the step after it is the merge. From a `done` the leader
   dispatched, call `done` again once the session reports the commits are in — or let
   that session call it, if it was told to finish its own work.

   **Where the setting is on, both of these sessions are opened differently.** The
   profile setting **Full access for the sessions handed to the agent for conflicts and
   commits** (`handoffFullAccess`) opens each of them on the **container root** instead of the
   common ancestor — so they collect under the plugin's own Workspace in the workspace
   list rather than in Ungrouped — and gives each one `danger-full-access` right after
   it exists. That is what replaces the elevation above: nothing will be refused, and
   there is nothing to ask the user to approve, because the whole machine is writable
   rather than just the directory the metadata sits in. Read what the first message
   says about the working directory instead of assuming either arrangement: it names
   the directory and says which access the session was given. Off — the default, and
   what a Host that does not have the setting does — everything above holds.
3. **A conflict?** The answer for a repository left on a conflict is flagged
   **`mergeInProgress: true`**, and reports `mergeSite` — the checkout the conflict
   stands in, inside the task space — and `conflictedFiles`. The panel opens it with
   **Hand the conflict to the agent**; from a `done` the leader dispatched, route it the same
   way as step 2 (`wts_session_tool_send`, `mode: "steer"`, to the session the finish
   named). That session is
   shared by every conflicting repository and works in the common ancestor of their
   sites (or of each site and its source repository, when the Host named it), and in the
   task space where those sites share nothing but the volume root; a
   repository that already has the session from step 2 reuses it. Resolve
   exactly those files in that checkout,
   write a version that keeps both sides' intentions, and **commit the merge there
   yourself**: `git add`, then `git commit` with a message saying how you reconciled
   the two sides. Never resolve a conflict by picking a side the user has not picked,
   never push, and leave merging back into the target branch to `done`. `done` checks
   that no conflict markers remain and that the merge is committed, and it does **not**
   commit for you: a resolved but uncommitted merge is reported as `the merge in
   <path> is resolved but not committed` and leaves the repository as it stands.
   Committing the merge puts the target into the task branch, so the next `done` merges
   for real without rehearsing again; if the target branch has moved on since, the
   rehearsal runs once more, and a fresh conflict is left standing the same way. That next
   `done` does not start by itself: once the session stops, the panel reads the plan again and,
   where the merge has been committed and nothing is left uncommitted, its headline turns into a
   green light and **The conflict is resolved: carry on and finish the task.** — the panel's
   **Continue finishing** button is one way to ask for that next `done`: what it does is merge
   the branch into the user's own checkout, so it waits for them. A session that was told to
   finish can also call that `done` itself, the same as any other finish. Either way, resolving a
   conflict does not end the task, and only that second `done` finishes it.
   **There is no policy field that pre-delegates this.** A conflict is resolved when
   the user hands it over — by the panel's button, or by telling you to resolve it.
   Nothing in the task's record can have decided that in advance, so do not wait for
   the panel button when the user has already asked you to resolve it: fix the
   conflicted files in the checkout, commit the merge there, and call `done` again
   with the same request, in this session. Committing a merge may need elevated
   permission in the session; ask for it openly rather than retrying around it, and if
   the user is not there to grant it, stop and report.
   **Not the same as `dirtyCheckout`.** A row flagged **`dirtyCheckout: true`** is the
   user's own working checkout, which a merge would overwrite. No merge was started and
   there are no markers to reconcile, so sending anyone after conflict files wastes the
   trip. That work is the user's and may have nothing to do with this task: do **not**
   commit or stash it on their behalf. Say what is in the way, name the checkout, and
   let them deal with it — then call `done` again.
4. **Delete the branch?** After a merge, and only when the user asks for it: the
   branch is **kept** unless the call says otherwise — pass
   `deleteBranch: true` together with `merge: true`, or leave it out and the branch
   stays. That default is the reversible one: once the task space is gone, the branch is
   the only record left of how the work was made, and a delete cannot be walked back.
   Nothing in the task's record can say to delete it for you. When the user wants the task
   space gone without merging anything, that is the abandon path: pass
   `deleteBranch: true` with `force: true` and `merge: false`, which removes the
   worktrees and force-deletes the branches with the commits on them.
5. **Stray files?** Pass `strays` — `archive` (the default when omitted) files them into
   the archive directory and clears build output, so the task space can be removed in the
   same finish; `keep` leaves everything exactly as it stands and the space stays.
   `discard` deletes the user's untracked files outright and **this tool refuses it
   (E7007)** — it is irreversible and the user's own decision, so only the panel can do
   it. When they want that, say so and let them finish from the panel; do not quietly
   archive instead, because that is not what they asked for. Show what the outcome lists,
   and pass `keepEntries: [...]` to name entries that must stay exactly where they are
   whatever the choice says — the user's own documents, say.

The Workspace registration follows the directory. When the finish removes the task space
itself, `done` drops the registration too, so the task space leaves the workspace list and
its sessions move to "Ungrouped" — **unless the call passed `unregisterWorkspace: false`**,
which keeps the registration so those sessions stay in that group with nothing left on
disk behind it. Pass that only when the user asked for it: nothing warns about it, because
it is the answer that was asked for rather than something that went wrong, and the finish
result is otherwise the same. A finish that keeps the container — a conflict left standing,
uncommitted work, strays that were kept — keeps the registration either way, because the
directory is still there and the list has to go on showing it. A registration that could
not be dropped,
while the entry is still in the list, is reported as a **warning** over a finish that still
happened; remove it from the workspace list by hand. An entry that has already gone is not a
failure to report: that is the outcome, not something to fix.

Each repository row answers `mergeInProgress`, `mergeSite` and `conflictedFiles`;
`mergeInProgress` is what marks a repository the finish left on a conflict.

## Failure modes worth knowing

- A task space inside the repositories' directory, or a directory that holds them,
  is refused: work and source must stay isolated.
- A container root that is itself a git repository (it holds a `.git`) is refused
  before anything is created — that zone is for worktrees, not for a checkout of
  its own. Point `tasksRoot` somewhere that is not a repository.
- `create` refuses a task name whose branch already exists in any repository —
  pick another name.
- `create` refuses with **E2002** when a task space for exactly this task, project
  and branch is already on disk — which means an earlier create made the container
  and stopped before its Workspace was registered, usually one made by this tool
  before it registered anything. The worktrees and the branch are still there, so
  nothing is lost: register it (**Create and open**, or **Register again** in the
  dialog once the refusal is shown), or finish and remove it. Creating again under
  that name keeps failing until one of the three is done. An **E2001** on the same
  name is the other situation — the name belongs to a different task space — and it
  is not recoverable this way.
- `create` reports a **warning** rather than a failure when the task space was made
  but its Workspace could not be registered. The task space is real and usable; what
  is missing is only the entry in the workspace list, and the warning says so.
- `done` asks first whether its worktrees can actually be removed, and refuses with
  **E5011** while any of them is held by something outside the process — a dev server,
  a browser, an editor started in the task space. Nothing has been merged, removed or
  filed at that point: close it, then finish again. The answer names each directory and
  what blocked it, and the check only renames a directory and puts the name back, so a
  refusal leaves the task space exactly as it was.
- A stray that holds a **link** cannot be filed on a machine that will not create
  symbolic links — an ordinary Windows installation, without Developer Mode: `done`
  keeps it and names the entries in the way. A link is a name for somewhere else, so
  the plugin will not copy whatever it points at instead. Removing or moving those
  entries out is one delete each and needs no privilege, and finishing again then
  files the rest.
- A repository whose worktree `git` has **unregistered but could not delete** is
  reported as a repository still on disk, never as a stray: `done` will not file a
  checkout away as the user's documents, and will not delete it either. Read that
  row's `error`, remove the directory by hand, then finish again. This is rare —
  `done` finishes git's own delete itself when it can — and happens only while
  something outside the plugin is holding those files.
- `create` refuses a base that any repository does not have.
- `add` refuses a repository the task already holds a worktree of: every worktree
  is named after its source repository's directory, so two of them cannot share a
  name inside one task.
- `add` refuses a repository that sits inside the task space or holds it — a
  worktree cut from such a repository would be written inside itself.
- `add` takes back only the worktrees it made when it fails partway. The task's
  own repositories are left exactly as they were; a repository that could not be
  removed is named in the message and still on disk.
- Removing a worktree refuses when it still has uncommitted changes; `done` waits for
  an agent to commit those first, so this is the exception rather than the rule. It
  reports the refusal and keeps the worktree so nothing is lost. Pass `force: true`
  only when the user has deliberately decided to discard that work.
- `create` rolls back the worktrees and the task space when any repository fails,
  so a failed create leaves no half task behind.
- A task name may not contain `/`, `\` or whitespace: it becomes the task space
  directory name and the branch suffix.

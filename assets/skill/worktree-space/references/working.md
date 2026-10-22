## Working on the task

### Putting a session on the work

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
it — so `wts_session_tool find` is the fallback for when it is not.

- **`wts_session_tool status` is how "stuck" is told from "busy".** `lastActivity` is
  the only reliable signal: during a build, file times, mtimes and log tails all sit
  still, while the session's own clock keeps running. Pass `stalledMsThreshold` and a
  **running** session is marked `stalled` past it; an idle one never is, because a
  finished session being quiet is not stuck. `lastReply` and the reasoning tail say
  what it currently believes it is doing. `lastTurnEnd` names a turn that did not end
  `completed` (`error` / `interrupted` / `blocked` / `max-tokens`) — the one way to
  tell "the task finished" from "an error killed it into silence", since both look
  like idle with nothing queued.
- **`wts_session_tool send` steers by default.** `mode` defaults to `steer`, so a
  correction interrupts the running turn at its next step. That default is the point: a
  long task is often one long turn, and a `queue`d message is read only at the session's
  next **turn boundary** — so it sits unread in the inbox while the session looks exactly
  like one ignoring you. Name `mode: "queue"` only for what can genuinely wait for a
  boundary ("here is reference material, read it when you are done").
- **To tell "never arrived" from "did not do it", read the log.**
  `wts_session_tool read` returns the messages with their `seq`; a message you sent
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
  `wts_session_tool status` to see where it stopped and `wts_session_tool send` to put
  it back to work.
- **There is no way to wait, and none is needed.** A session reports its own progress, and
  a turn that ends badly is pushed to you by the watcher, so nothing goes unnoticed while
  you are doing something else. Look with `status` or `read` when you have a reason to,
  act on what you find, and go back to your own work.
- **The recovery chain, in order.** `status` first, to tell "running but stuck" from
  "offline" → `wts_session_tool resume` for the offline one (a host restart puts
  every session offline), or `wts_session_tool create` in **the same task space** for
  one that is lost → and **read its last state before deciding what to send**.
  `wts_session_tool cancel` is the brake: it aborts the active turn, and `keepInbox`
  decides whether the queued work survives.

Do not poll in a loop, and do not steer or cancel on a timer: look at the real state
when something suggests you should, then decide. That judgement is yours, not a
watchdog's. A caller that blocks on a session is not making it either — it is only
waiting to become responsive again.


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
    (see `references/finishing.md`) leaves the caller out of the sessions it counts,
    so the flow is reachable from inside a running turn. Every *other* session in the task space still blocks it.
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


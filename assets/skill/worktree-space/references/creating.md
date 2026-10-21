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
   `references/deploying.md` says what a deploying space owes.
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
   it applies to. See `references/finishing.md`.
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


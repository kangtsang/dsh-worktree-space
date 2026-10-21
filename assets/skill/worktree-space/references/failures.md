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

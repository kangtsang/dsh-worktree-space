---
name: worktree-space
description: Use when a task spans one or more repositories and the work should be isolated in its own git worktree workspace - multi-repo, parallel sessions, an isolated branch - or when listing, merging, cleaning up, or deploying a finished task for acceptance. 部署验收、任务空间、多仓库并行、收尾合并。
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

## Getting the tools first

**This skill is the entry point; the tools are mounted on demand.** A session that is
not already inside a task space starts with one small tool, `load_worktree_space`, and
none of the real ones:

- **Call `load_worktree_space` once, before the first `wts_worktree_space` or
  `wts_session_tool` call.** It mounts both into this session and removes itself.
  Nothing else changes — the tool set is the only thing that arrives.
- **A session inside a task space already has both**, and calling the loader there
  answers that they are loaded. Never call it speculatively: a session you open in a
  task space starts with them.
- Loading the tools does **not** load the rest of this skill. Read the stage you are in,
  when you are in it — see the table below.

The tools carry enough of their own description to be used without this skill — that is
deliberate, so a session that needs one quick action does not have to read anything first.
What this skill adds is the part a description cannot hold: the order to do things in, the
questions to put to the user, and what each stop means. **Read the stage you are in.**

## The shape of a task space

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

- **File isolation** — each task directory is a physically separate checkout, so sessions
  cannot overwrite each other's uncommitted work.
- **Commit isolation** — every worktree is on `task/<task>`, so commits from different
  tasks never interleave on one branch.
- **Cross-repo coherence** — every repository in a task shares the branch name; that is
  what links the task's commits across repositories.
- **Source/work separation** — the task space is a directory of its own: never inside the
  repositories' directory, and never a parent of it; the tool refuses both.

## The two roles

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

## How this skill is laid out

A task runs in three stages, and this file is only the map. **Read the stage you are in,
when you are in it** — nothing below is loaded for you merely because the skill was:

| Stage | What you are doing | Read |
| --- | --- | --- |
| **Creating** | asking the user, then making the task space | `references/creating.md` |
| **Working** | dispatching a session, watching it, adding a repository | `references/working.md` |
| **Finishing** | merging, cleaning up, closing the task out | `references/finishing.md` |

Three more, read when the task calls for them rather than on every start:
`references/deploying.md` for a task deployed for acceptance, `references/conflicts.md`
when a finish answers with `mergeInProgress` or `dirtyCheckout`, and
`references/failures.md` for what a refusal code is telling you to do.

## Further reading

- **`references/creating.md`** — asking the user before anything is made: the task name,
  the container root, and the acceptance fence; then the `create` call itself.
- **`references/working.md`** — putting a session on the work, watching and correcting it
  with `wts_session_tool`, and adding a repository to a task already under way.
- **`references/finishing.md`** — the whole of a finish: the merge decision, work nobody
  committed, stray files, deleting a branch, and the deploy gate.
- **`references/conflicts.md`** — the one part of a finish that is not routine: a conflict
  left standing on `mergeInProgress`, and a checkout of the user's own that a merge would
  overwrite (`dirtyCheckout`).
- **`references/deploying.md`** — deploying the task space's services to Docker for
  acceptance: the deploy root, `up` and `smoke`, the acceptance URL, and what "finished"
  means for a task that deploys.
- **`references/failures.md`** — the refusals worth knowing by their code — E2002, E4015,
  E5011, E5006, E5012, E7006, E7007 and the rest — and what each is telling you to do.

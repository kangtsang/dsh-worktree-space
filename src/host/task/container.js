/**
 * The container root, and what it is for.
 *
 * Every task space lives under one container root, and the root itself is a
 * plain directory the user keeps their worktree spaces in. Two things follow,
 * and both are this module's whole job: the root must not be a git repository,
 * and it carries a note saying so.
 *
 * Why the note is written by the plugin rather than left to the user: the one
 * mistake this layout invites is running `git init` (or cloning into) the
 * container root, which quietly makes every task space below it part of a
 * checkout. A reader who opens the directory sees a file explaining what it is
 * for, where they would otherwise have to find the answer in a plugin's docs.
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The note the plugin leaves in a container root.
 *
 * Named `README.md` because the audience is a person who just opened the
 * directory. Unlike the task space's own note, this name is free: nothing else
 * writes into the container root, so there is no user file to collide with -
 * and when one is already there it is left alone.
 */
export const CONTAINER_README = 'README.md'

/**
 * The folder archived documents are filed into by default.
 *
 * Named here because the container root is where it lands, and this module owns
 * what the container root holds: a reader that walks the root has to know this
 * one is not a project. It repeats `DOCUMENTS_FOLDER` in the client's
 * `src/client/lib/documents.ts`, which is where the archive is actually
 * computed — the two halves are built as separate bundles, so nothing crosses
 * between them.
 */
export const CONTAINER_ARCHIVE_FOLDER = 'archived-docs'

/** What {@link CONTAINER_README} says, in both languages this plugin speaks. */
export const CONTAINER_NOTICE = `# Worktree Space

本目录由 **Worktree Space** 插件管理，用来存放各个任务的工作区（Git Worktree）。

- 每个任务空间是 \`<项目>/<任务>/\`，下面每个仓库一份 worktree。
- 这里**不要**直接 \`git init\`，也**不要** \`git clone\` 进来：本目录一旦成为 Git 仓库，
  每个 worktree 都会落在某个检出之内，任务里的改动就可能被误当成源仓库的一部分。
- 插件在创建任务空间前会检查本目录下没有 \`.git\`，发现时拒绝创建。
- 归档文档默认收在本目录下的 \`archived-docs/<项目>/<任务>-<时间戳>/\`（插件配置里可以改到别处）。

可以放心在本目录里放自己的文件。这份 README 只在不存在时写入，插件不会覆盖已有的同名文件。

## English

This directory is managed by the **Worktree Space** plugin and holds the working
spaces (Git worktrees) of its tasks.

- A task space is \`<project>/<task>/\`, with one worktree per repository.
- Do **not** run \`git init\` here, and do **not** \`git clone\` into it: the moment
  this directory is a repository, every worktree sits inside a checkout and the
  changes made for a task can be mistaken for part of the source tree.
- The plugin checks that this directory holds no \`.git\` before it creates a
  task space, and refuses to create one when it does.
- Archived documents are filed into \`archived-docs/<project>/<task>-<stamp>/\`
  in this same directory by default (the plugin's configuration can point them
  elsewhere).

You are free to keep your own files here. This README is written only when one is
not already present, and is never overwritten.
`

/**
 * Prepare a container root for a task space: check it, make it, and label it.
 *
 * The check comes first so a refusal leaves the filesystem untouched. A root
 * that is itself a repository is refused rather than warned about: every task
 * space below it would then be inside a checkout, where `git status` reports the
 * whole task tree and a stray `git add` stages it - a state a warning cannot
 * undo once worktrees exist.
 * @param tasksRoot - the container root.
 * @throws Error when the root is a git repository.
 */
export async function prepareContainerRoot(tasksRoot) {
  const root = String(tasksRoot ?? '').trim()
  if (root === '') throw new Error('a tasks root is required')
  if (existsSync(join(root, '.git'))) {
    throw new Error(
      `the tasks root ${root} is a git repository\n  worktree spaces must be filed under a directory that is not one, or every task would be committed into it; put the container beside the repositories instead`,
    )
  }
  await mkdir(root, { recursive: true })

  const notice = join(root, CONTAINER_README)
  // Only when absent: a `README.md` in the container root is as likely to be the
  // user's own, and this note is a reminder rather than a record the plugin owns.
  if (!existsSync(notice)) await writeFile(notice, CONTAINER_NOTICE, 'utf8')
}

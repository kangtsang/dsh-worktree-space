/**
 * The model-facing tool.
 *
 * The Web UI is still the upstream single-repository surface, so this tool is
 * what makes the multi-repository workflow usable end to end in the meantime:
 * it drives exactly the same operations the `/api` endpoints do.
 */
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { projectNameFor } from './naming.js'
import { addTaskRepositories, createTask, finishTask, listTasks, suggestTaskRoot } from './operations.js'
import { absolutePath, canonicalPath, isInside } from './paths.js'
import { coded } from './codes.js'
import { deliveryPolicyOf } from './delivery.js'
import { normalizeSessions, readTaskMetadata, recordTaskSession, taskSpacePath } from './shared.js'

/**
 * Model-facing description: what this is for, the order to drive it in, and the
 * decisions that are never the model's to make. The workflow itself lives in the
 * bundled skill's SKILL.md, which a session loads when it takes a task on; this
 * carries only what a caller needs before that.
 */
const DESCRIPTION = [
  'Create, list and finish a per-task Git worktree workspace that spans one or more repositories: inside the task space container, one directory per project (the source root\'s own directory name) holding one directory per task, and under that a worktree of every selected repository, all on one branch.',
  '',
  'Drive it in order: suggest-root, then create, then list, then done. Ask the user for the task name and the Worktree Space container root before creating anything.',
  '**Ask about the acceptance fence before you create a task space or dispatch a session into one, and never answer it for the user.** The delivery answer is settled once, on the create, and nothing can add or change it afterwards: deployTarget is the whole of it. Put the question plainly - is this task deployed for acceptance, meaning the task space brings its own environment up and a smoke has to pass before the work may land (deployTarget "docker"), or is there nothing to deploy ("none", the built-in default)? `none` is a good answer for work with no runtime behaviour to accept; what is not acceptable is creating a space, or opening a session in one, with that question still open - a fence nobody chose cannot be fitted afterwards, and no record says one was ever wanted. **When the answer is docker, the smoke is the finish line**: `up` writes the acceptance URL, `smoke` records `lastSmoke.result` "pass", and only then may `done` merge. Report the acceptance URL and the smoke result as the evidence that the task is finished, and never report a deploying task complete on the grounds that the code is written.',
  'A create does both halves by default: it makes the directory and the worktrees, and registers the result as a DSH Workspace, which is what puts the task space in the workspace list. Given a prompt as well, it also opens a session in the new task space and hands it that job in the same call - one step, which is what the panel\'s "Create and open" does in one press, except that the session there starts empty and this one is already working. Pass registerWorkspace false only when the user asked for a task space that stays out of that list - it is then on disk, nothing in the interface shows it, and opening a session in it means registering it from the panel. A create that answers with a warning instead says its Workspace was not registered, and names what to do about it.',
  'Every repository shares one branch, `task/<task>` unless the user asks for another prefix and it is passed as branchPrefix.',
  'A create may name a deploy script inside the workspace\'s own `.worktree-space/deploy/` directory: pass deployScript as a path relative to the workspace (e.g. ".worktree-space/deploy/notify.sh"). It must live under that directory (E4014 refuses anything else), it travels into the task space under its own name with the rest of the deploy root, and the task\'s record remembers it as the entry to run. Nothing is renamed or overwritten. The workspace\'s `.worktree-space/deploy/` is copied whole to the same relative place in the task space, which is where the entry runs from: omit deployScript and the entry is `.worktree-space/deploy/deploy.sh`, run in the task space as `./.worktree-space/deploy/deploy.sh`.',
  'When a task that already exists turns out to need another repository, add it with action "add" rather than creating a second task: name the container (tasksRoot or sourceRoot), the project and the task, and pass each repository as an absolute path. A repository added this way may sit anywhere on disk, on another volume included — nothing later depends on where it is — but it joins the branch the task is already on and starts from its own HEAD unless baseRef says otherwise. Nothing is removed from a task this way.',
  'done REQUIRES merge. Pass merge: true to land the task branches on their targets, or merge: false to leave the work where it is. There is no default, because this is the one decision a finish cannot take back: a merge that landed has to be reverted by hand, and a branch that was not merged keeps its commits where they are. Decide it from what the user asked for - do not guess, and do not call done without it (E7006).',
  'Dispatch to a session of its own when the work should carry on without you: action "dispatch" opens a session inside the task space - so it reads under that task in the workspace list, and can be followed there - and hands it one self-contained prompt. It is opened with the permission this session carries as its own sandbox override and nothing more, so it can never be wider than this one; pass permission danger-full-access only when the user asked for it, because that is the whole machine - and it is refused (E4012) unless the user has switched on the setting that grants it. The session id a create or a dispatch opened is written into the task\'s own record, and `list` reports it together with what each task\'s deploy recorded (the acceptance URL and the last smoke) - so neither has to be searched for or read out of a file.',
  'Watch and correct that session through the session-control tools: wts_session_tool_find locates a session by directory, title or id; wts_session_tool_status reports running, openTurn, lastActivity, pendingWork and lastReply; wts_session_tool_read reads its messages; wts_session_tool_send says something to it; wts_session_tool_wait waits for one output; wts_session_tool_resume brings an offline session back; wts_session_tool_cancel stops it. A dispatched session is NOT this session\'s child, so send_message cannot reach it. Send with the default mode "steer": it reaches a running turn at its next step, which is what a correction needs, because a long task is often one long turn. Name mode "queue" only for something that may wait for a turn boundary.',
  'You are told when that session dies mid-turn: unless watchSession is false, a turn that ends error, interrupted, blocked or max-tokens reports back to you with the session id and the failure, because a session that dies cannot report itself. A turn that completes, and one the user cancels, are never reported. Treat such a notice as the task NOT being done, and use the session-control tools to see where it stopped and put it back to work.',
  'This tool cannot do `force`, and asking for it is an error rather than a warning: discarding uncommitted work, and force-deleting a branch whose commits landed nowhere, are irreversible and have to be the user\'s own decision. Abandoning a task needs force too, so it is not available here either. When a task really has to be abandoned that way, say so and ask them to open the Worktree Space management page and finish it there, rather than retrying.',
  'Finishing commits nothing itself: a worktree still holding uncommitted work stops the finish and is named, and the commit is the caller\'s to make - an agent session opened in the task space writes a better message than a fixed one. force discards that work as the worktree goes.',
  'A finish that really removes the task space unregisters it too, which is what leaves the workspace list without an entry pointing at a directory that is gone; its sessions then fall back to Ungrouped. Pass unregisterWorkspace false only when the user asked to keep that task\'s group: the entry stays, those sessions stay under it, and the list has a Workspace whose directory is gone. An entry that was already gone - the user deleted it, or it was never registered - is not an error.',
  'A finish can stop on three things that are work rather than failures, and each row says which by flag: `mergeInProgress` (a conflict to reconcile), `needsCommit` (work in the task space nobody has committed), and `dirtyCheckout` (work in the user\'s own checkout that the merge would overwrite). Read the flags, not the sentence - the wording is not a contract.',
  'A `mergeInProgress` row holds an unresolved merge at `mergeSite`: the files are listed in `conflictedFiles`. Hand that job back to the session that owns the checkout - `wts_session_tool_send` with mode "steer", to the id the finish answers with, or find it by directory with `wts_session_tool_find`; open one with `wts_session_tool_create` when the record names none - have it resolve the files and commit the merge there, then call done again with the same merge request. Never resolve a conflict by picking a side the user has not picked, and never commit it yourself on the user\'s behalf unless the user said to.',
  'A `needsCommit` row has uncommitted work in the task space, and the commit is not this tool\'s to write: the message has to come from whoever read the changes, which is the session working there. Hand it the same way - have it commit each repository\'s work on that repository\'s own branch, in the language and style of that repository\'s existing commits - then call done again. The panel\'s own "hand the commits to the agent" is this same job.',
  'A `dirtyCheckout` row is the user\'s own working checkout, which a merge would overwrite. It is NOT a conflict: no merge was started and there are no markers to reconcile. That work is theirs and may have nothing to do with this task, so do not commit or stash it for them - say what is in the way and let them deal with it, then call done again.',
  'A merge lands on the branch each source repository has checked out unless another is named; a branch that is checked out nowhere is merged in a worktree of its own, so no source checkout is ever switched.',
  'A task that deploys (deployTarget docker) has a finish gate: done with merge: true is refused while `.worktree-space/deploy/.state.json` records no passing smoke (E5006 - either the file does not exist, or its `lastSmoke.result` is not "pass"). The way past is to deploy and run the smoke through the task space\'s own deploy entry (the record\'s deployScript, or `deploy/deploy.sh`, both run from `.worktree-space/`) - never to retry, and never to ask for an override, because this tool cannot send one. A task with no deployment (deployTarget none) has no gate at all - a good answer when the user chose it, never one to reach by leaving the acceptance question unasked.',
  'strays says what happens to the files in the task space that git never tracked: "archive" (the default when omitted) files them into the archive directory and clears build output, so one finish removes the space; "keep" touches nothing, which leaves the directory non-empty and the task space on disk. "discard" deletes them outright and this tool refuses it (E7007) - deleting the user\'s own writing is theirs to decide, on the panel, so archive the content or leave the space standing instead. `keepEntries` names individual entries to leave alone whatever the choice. Where the archive files them is not this call\'s to name: they go to the configured archive directory, or to the plugin\'s own archived-docs folder under the container root when none is set, and the panel\'s own finish dialog shows the user that path. The plugin\'s own `.worktree-space/` is never one of these entries: it goes with the container when the space is cleared, and `keep` leaves it standing with everything else.',
].join('\n')

/**
 * One repository row, with every property present so the declared output schema
 * holds for every action.
 * @param name - the repository directory name.
 * @returns a row with empty facts.
 */
function emptyRow(name) {
  return {
    name,
    path: '',
    branch: '',
    changedFiles: 0,
    merged: false,
    removed: false,
    branchDeleted: false,
    mainRepo: '',
    conflict: false,
    mergeInProgress: false,
    mergeSite: '',
    conflictedFiles: [],
    needsCommit: false,
    dirtyCheckout: false,
    error: '',
  }
}

/**
 * Output shape shared by every action.
 *
 * The value schema DSL carries requiredness per property inside `properties`;
 * a `required` key on an object schema itself (the root, or an array's `items`)
 * is rejected, so absence is expressed by always filling every field instead.
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', required: true },
    summary: { type: 'string', required: true },
    task: { type: 'string', required: true },
    project: { type: 'string', required: true },
    branch: { type: 'string', required: true },
    container: { type: 'string', required: true },
    tasksRoot: { type: 'string', required: true },
    suggested: { type: 'string', required: true },
    sessionId: { type: 'string', required: true },
    /**
     * The sessions this task space has been worked in, newest first, as the
     * record carries them. Filled by `list`, and by the `create` / `dispatch`
     * that just opened one; empty when nothing has been recorded.
     */
    sessions: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          role: { type: 'string', required: true },
          at: { type: 'string', required: true },
        },
      },
    },
    /**
     * What each task's deploy recorded, as `list` reads it: the acceptance URL and
     * the last smoke, so a caller does not have to open `.worktree-space/deploy/.state.json`.
     */
    deployment: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task: { type: 'string', required: true },
          url: { type: 'string', required: true },
          smoke: { type: 'string', required: true },
          smokeAt: { type: 'string', required: true },
        },
      },
    },
    failed: { type: 'boolean', required: true },
    warnings: { type: 'array', required: true, items: { type: 'string' } },
    repositories: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          path: { type: 'string', required: true },
          branch: { type: 'string', required: true },
          changedFiles: { type: 'integer', required: true },
          merged: { type: 'boolean', required: true },
          removed: { type: 'boolean', required: true },
          branchDeleted: { type: 'boolean', required: true },
          mainRepo: { type: 'string', required: true },
          conflict: { type: 'boolean', required: true },
          mergeInProgress: { type: 'boolean', required: true },
          mergeSite: { type: 'string', required: true },
          conflictedFiles: { type: 'array', required: true, items: { type: 'string' } },
          needsCommit: { type: 'boolean', required: true },
          dirtyCheckout: { type: 'boolean', required: true },
          error: { type: 'string', required: true },
        },
      },
    },
  },
}

/**
 * Base value every action starts from.
 * @param action - the action being reported.
 * @returns the shared, fully populated envelope.
 */
function envelope(action) {
  return {
    action,
    summary: '',
    task: '',
    project: '',
    branch: '',
    container: '',
    tasksRoot: '',
    suggested: '',
    sessionId: '',
    sessions: [],
    deployment: [],
    failed: false,
    warnings: [],
    repositories: [],
  }
}

/**
 * Read a parameter the action cannot proceed without.
 * @param value - the raw parameter.
 * @param name - its model-facing name.
 * @returns the trimmed value.
 * @throws Error when it is missing.
 */
function required(value, name) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') throw coded('E7006', `${name} is required for this action`)
  return text
}

/**
 * Resolve the container root a list or done action should read: an explicit root,
 * else whatever the configuration names, else the recommendation for the source root.
 *
 * The middle answer is here for the same reason it is in `create`: a list, an add
 * or a done that names only a source root has to read the container the creates
 * have been landing in, or it would report on, or write to, a directory nobody
 * uses.
 * @param subprocess - the profile's subprocess service.
 * @param tasksRoot - the explicit container root, if any.
 * @param sourceRoot - the source root, if any.
 * @param configuredRoot - the container root the configuration names, possibly empty.
 * @returns the container root to use.
 * @throws Error when neither is available.
 */
async function containerFor(subprocess, tasksRoot, sourceRoot, configuredRoot = '') {
  const explicit = absolutePath(tasksRoot)
  if (explicit !== '') return explicit
  const source = absolutePath(sourceRoot)
  if (source === '') throw coded('E7006', 'tasksRoot is required (or sourceRoot, to use its recommended task space)')
  return (await suggestTaskRoot(subprocess, source, { configuredRoot })).suggested
}

/**
 * Resolve the project layer a list or done action should read.
 *
 * The layout puts one directory layer between the container root and a task name,
 * and that layer is the source root's own directory name - the same rule
 * `createTask` derives it by. A caller that knows the source root does not have to
 * name it; one that does not has to say it, because the container root alone
 * cannot tell which project's task of that name was meant.
 * @param project - the explicit project name, if any.
 * @param sourceRoot - the source root, if any.
 * @returns the project name to use.
 * @throws Error when neither is available.
 */
function projectFor(project, sourceRoot) {
  const explicit = typeof project === 'string' ? project.trim() : ''
  if (explicit !== '') return explicit
  const source = typeof sourceRoot === 'string' ? sourceRoot.trim() : ''
  if (source === '') throw coded('E7006', 'project is required (or sourceRoot, whose directory name it is)')
  return projectNameFor(source)
}

/** The registry methods this plugin calls. A service double need not carry all of them. */
const REGISTRY_METHODS = ['create', 'list', 'delete']

/** Why a task space could not be registered: there was nothing registry-shaped to ask. */
const NO_WORKSPACE_REGISTRY = 'this deployment serves no Workspace registry to register it with'

/**
 * The Host's Workspace registry, when this deployment serves one.
 *
 * Making the directory and the worktrees is only half of a create: the other half
 * is telling DSH the result is a Workspace, and that half is a Host service rather
 * than a client-only capability. The dialog does it through `ctx.workspaces.create`
 * on the client, which is this registry over the wire; a tool call that skipped it
 * left a container on disk DSH did not know about, and one no second create could
 * take the name of - `createTask` reads a leftover of its own as E2002 and refuses.
 * Finishing a task has the mirror of it, which is why this is read there as well.
 *
 * Probed rather than injected: it is a peer service a deployment need not serve,
 * and a plugin that demanded it would refuse to load instead of reporting a task
 * space the user can still register or unregister by hand.
 *
 * Anything carrying at least one of {@link REGISTRY_METHODS} counts as one. Each
 * caller then checks the method it is about to call, so a service double holding
 * only some of them is used exactly where it has what is needed and reported as
 * "nothing to register with" where it has not - which is the same answer, and the
 * same warning, as a deployment that serves no registry at all.
 * @param ctx - the host plugin context.
 * @returns the registry, or undefined when there is nothing registry-shaped.
 */
function workspaceRegistryOf(ctx) {
  if (typeof ctx.get !== 'function') return undefined
  const registry = ctx.get('workspaceRegistry')
  if (registry === null || registry === undefined) return undefined
  return REGISTRY_METHODS.some((name) => typeof registry[name] === 'function') ? registry : undefined
}

/**
 * Register a task space that has just been made as a DSH Workspace.
 *
 * The title follows the dialog's own rule - `<source workspace title>/<task>` - so a
 * task space created from a session reads in the workspace list exactly like one
 * created from the panel, and two projects' tasks of one name cannot be read as one.
 * The registry keeps an existing record's title, so registering a directory that is
 * already a Workspace is the idempotent no-op it looks like.
 *
 * Nothing here throws: whether this succeeded is reported to the caller as a warning
 * by the action that asked for it, because the create it belongs to has already
 * happened on disk by then.
 * @param registry - the Host's Workspace registry.
 * @param taskPath - the task space the create made.
 * @param sourceRoot - the directory the task's repositories live in.
 * @param task - the task's name.
 * @returns an empty string on success, else why it could not be registered.
 */
async function registerTaskWorkspace(registry, taskPath, sourceRoot, task) {
  if (typeof registry.create !== 'function') return NO_WORKSPACE_REGISTRY
  let title
  try {
    const source = typeof registry.resolveByPath === 'function' ? await registry.resolveByPath(sourceRoot) : undefined
    if (source !== null && source !== undefined && typeof source.title === 'string' && source.title !== '') {
      title = `${source.title}/${task}`
    }
  } catch {
    // The source root is not a registered Workspace, or its path no longer resolves.
    // The registry's own default - the task directory's name - is the right title
    // then, and neither is a reason to report the create as incomplete.
  }
  try {
    await registry.create(taskPath, title)
    return ''
  } catch (error) {
    return String(error?.message ?? error)
  }
}

/**
 * Drop the Workspace registration that named a task space which is now gone.
 *
 * The panel draws the same line for the same reason (`ArchiveTaskDialog`): the
 * registration goes only once the directory behind it really went. A finish that
 * keeps the container - a conflict left standing, uncommitted work, strays kept -
 * has to keep its Workspace too, or the task space would vanish from the list
 * while it sits there on disk and its sessions would scatter into "Ungrouped".
 *
 * The record is found among the registry's own, rather than through
 * `resolveByPath`: the whole reason this runs here is that the directory has
 * already been removed, and that lookup canonicalizes through `fs.realpath`, which
 * is the one thing that cannot answer for a directory that is not there any more.
 * Record paths are stored canonicalized, so the comparison is the same one the rest
 * of this plugin makes between two spellings of one location. A registration whose
 * record path differs from ours in a way that comparison does not cover - a
 * symlinked container root - is left alone rather than guessed at; removing it by
 * hand is one click, and a wrong delete is not.
 *
 * Nothing here throws: what it could not do is reported to the caller as a warning,
 * and a finish that has already taken the worktrees down is not re-reported as a
 * failure over a list entry.
 * @param registry - the Host's Workspace registry, if this deployment serves one.
 * @param taskPath - the task space that was removed.
 * @returns an empty string when there is nothing to report.
 */
/**
 * Whether a task space is still registered, asked again after a delete failed.
 *
 * The state is what matters, not the code one Host spells the failure with: a record can be
 * removed in the interface between the read above and the delete here, and a delete of
 * something that is no longer there is the outcome this was after rather than a problem.
 * An unreadable list answers `true`, because then it cannot be said that the entry is gone -
 * the original failure stands rather than being talked away.
 * @param registry - the Host's Workspace registry.
 * @param taskPath - the task space whose registration is in question.
 * @returns whether an entry for that path is still in the list.
 */
async function stillRegistered(registry, taskPath) {
  try {
    const target = canonicalPath(taskPath)
    return registry.list().some((entry) => entry !== null && entry !== undefined && canonicalPath(entry.path) === target)
  } catch {
    return true
  }
}

async function dropTaskWorkspace(registry, taskPath) {
  if (registry === undefined || typeof registry.list !== 'function' || typeof registry.delete !== 'function') return ''
  const byHand = '; remove it from the workspace list by hand if it is still there'
  let registered
  try {
    const target = canonicalPath(taskPath)
    registered = registry.list().filter((entry) => entry !== null && entry !== undefined && canonicalPath(entry.path) === target)
  } catch (error) {
    return `the task space is gone but its DSH Workspace registration could not be read (${String(error?.message ?? error)})${byHand}`
  }
  const problems = []
  for (const entry of registered) {
    try {
      await registry.delete(entry.id)
    } catch (error) {
      // Already gone is not a failure: it is the state this was trying to reach, and it is the
      // ordinary answer for a task space the user deleted from the list themselves before
      // finishing it. Asked rather than inferred from the error, because the next Host may
      // spell "not found" differently and this must not turn that into a false report.
      if (!(await stillRegistered(registry, taskPath))) continue
      problems.push(String(error?.message ?? error))
    }
  }
  if (problems.length === 0) return ''
  return `the task space is gone but its DSH Workspace registration could not be dropped (${problems.join('; ')})${byHand}`
}

/**
 * The sandbox mode the calling session carries as an explicit override, if there is one.
 *
 * Only an override is read: never the deployment default, which the new session lands on by
 * itself, and never a one-shot grant, which is not a state a delegation may copy. This is the
 * rule DSH's own delegation uses (`dsh-subagent`'s `captureDelegatedPolicyOverrides`), and it
 * is the reason `inherit` can be the default: the session this opens can never be wider than
 * the one that opened it.
 * @param ctx - the host plugin context.
 * @param exec - the tool run context.
 * @returns the mode, or undefined when the caller carries no override.
 */
function inheritedMode(ctx, exec) {
  const policy = typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined
  const caller = exec?.agent?.session
  if (policy === undefined || policy === null || typeof policy.overrideOf !== 'function' || caller === undefined) return undefined
  try {
    const mode = policy.overrideOf(caller)
    return typeof mode === 'string' && mode !== '' ? mode : undefined
  } catch {
    // A caller whose policy cannot be read is not a reason to refuse the work: the session is
    // opened, on the deployment default, which is what "no override to inherit" means anyway.
    return undefined
  }
}

/**
 * The standing part of every task brief, written once instead of retyped per task.
 *
 * A dispatched session cannot be reached by `send_message` - it belongs to the task
 * space, not to the caller - so a brief that forgot the reporting channel, the
 * discipline about the source checkouts, or the isolation rule about the acceptance
 * stack cannot be corrected afterwards. Those three are the same for every task, so
 * they are stated here and the caller only supplies the work itself.
 *
 * Facts this side actually knows are filled in - the container root, the task, the
 * branch, the caller's session id - because a brief that says "your parent session"
 * without an id cannot be acted on. What this side does NOT know (which repositories
 * matter, what "done" means, what to clean up) is deliberately absent rather than
 * guessed: a preamble that invented the acceptance criteria would be worse than none.
 * @param facts - the container root, task, branch, the caller's session id, and the
 *   delivery target the task's record settled (`docker` adds the completion line).
 * @returns the standing section, as text, or '' when there is nothing to state.
 */
function taskBriefPreamble(facts) {
  const { tasksRoot, task, branch, callerSessionId, deployTarget } = facts
  if (typeof task !== 'string' || task === '') return ''
  const lines = [
    '# Standing instructions (added by Worktree Space)',
    '',
    `- You are working in a task space for **${task}**, at \`${tasksRoot}\`. Its repositories are`,
    `  separate checkouts on the branch \`${branch}\`; git commands run inside each repository`,
    '  subdirectory, not in the task space root.',
    '- **Never edit or commit in a source checkout, and never hand-merge there.** The task space is',
    '  where the work goes: `git push`, and a `git merge` you run yourself in a source repository, are',
    '  not yours to do. That is a different thing from finishing the task, which this plugin does for',
    '  you and which is the next point.',
    '- **Finishing is the user\'s decision, and either flow works.** Call `done` yourself once the work',
    '  is complete, or report back and let whoever dispatched you - or the user - call it. Ask which is',
    '  wanted when the task brief does not say, and never merge without that authorisation: `merge: true`',
    '  lands the work and is the one step a finish cannot take back. `merge: false` leaves the branch',
    '  where it is (the commits are kept, the worktree is still removed, so a leftover conflict would',
    '  have to be resolved in the source repository).',
    // Present only when the task space was created to deploy: the policy is settled at
    // create and this is the session that has to carry it out, so the one thing it must
    // not be able to say afterwards is that nobody told it the smoke was the finish line.
    ...(deployTarget === 'docker' ? [
      '- **This task is deployed for acceptance, so its smoke is the finish line.** Nothing is finished',
      '  until this task space\'s own deploy entry has run `smoke` and the result recorded is `pass`, and the',
      '  acceptance URL `up` wrote is what the report hands over. Code that is written is not the finish, and',
      '  a summary of it is not either: say what the smoke actually reported, or say that it has not run yet.',
    ] : []),
    '- **The acceptance stack is this task\'s own.** Do not reuse a dev server or a stack that is',
    '  already running: a repository\'s own e2e configuration often points at one, and a suite run',
    '  against it reports green for code this task never built. Point it at this task\'s own',
    '  instance, or bring a configuration that does.',
    '- **Record delivery facts where the plugin reads them** (`.worktree-space/deploy/.state.json`): `url` after a',
    '  deploy, `lastSmoke` merged in after a smoke. Neither `up` nor `smoke` may write',
    '  `destroyedAt` - that stamp is the plugin\'s; only the entry\'s own optional `destroy`',
    '  writes it, together with nulling `url`.',
    '- **Long actions go to the background or a child session** (starting a stack, a full test run).',
    '  Do not hold the main flow on them.',
  ]
  if (typeof callerSessionId === 'string' && callerSessionId !== '') {
    lines.push(
      `- **Report back to \`${callerSessionId}\`** with \`wts_session_tool_send\`. It is not your parent`,
      '  session, so `send_message` cannot reach it. The default `mode` is `steer`, which is what a',
      '  dispatched task needs - `mode: "queue"` is only read at a turn boundary, and a long task is',
      '  often one long turn, so name it only for something that may wait.',
      '  Your report is delivered attributed to this session and shown to the caller as an agent\'s',
      '  report, and the tool puts a header on it - the task, the workspace, the task-space path, the',
      '  branch and your session id - so write the body only: a self-contained account of what you did',
      '  and what you did not verify, not a note to yourself, and without repeating the header.',
    )
  } else {
    lines.push(
      '- **Report with `wts_session_tool_send`.** Its default `mode` is `steer`; name',
      '  `mode: "queue"` only for something that may wait for a turn boundary.',
    )
  }
  // The reporting contract, as its own section rather than one line at the end of the standing
  // instructions. It used to be a single sentence - "Report at each milestone and at the end" -
  // sitting after the paragraph that says finishing is the user's decision, which read as though
  // reporting were part of the optional half of that choice. It is not: the session that
  // dispatched this work cannot see this session from the outside, so a turn that ends without a
  // report ends in silence, and the caller has nothing to act on until it goes looking. Hence
  // its own heading, the three moments named, and the one sentence that has to be here.
  lines.push(
    '',
    '# Reporting back is required',
    '',
    'The session that dispatched you cannot see this one from the outside: your commands, your',
    'tests and your commits are invisible to it until you send it something. That is why the',
    'channel above is not a courtesy. **The three moments below are never optional.** Nor does',
    'finishing the work yourself replace reporting it: a session that calls `done` and then stops',
    'still leaves the caller with nothing but a task space that changed underneath it.',
    '',
    '- **Every finished unit of delivery.** A unit is the smallest piece of the work that can be',
    '  committed and handed over on its own. If this task is really several of those - a plan of',
    '  independent steps, one repository done while another is still being written - report as each',
    '  one lands, not once at the end: that is what lets the caller redirect the next one before',
    '  it is built on an assumption nobody checked. A long stretch with no report is itself the',
    '  problem, so if you are unsure whether a moment counts, report it.',
    '- **The moment you are stuck.** A decision you cannot make alone, a question only the caller',
    '  or the user can answer, or a wall you cannot get past - an environment this plugin will not',
    '  give access to, a permission, a failing dependency, a design choice with a cost either way.',
    '  Say what you tried and what the options are. Report this **immediately**, not after a',
    '  second attempt and not only at the end: a session that silently grinds on a blocker wastes',
    '  the caller\'s time twice - once while it tries, and again while the caller assumes it is',
    '  working. "I am blocked on X, I think it needs Y" is a complete report.',
    '- **When the task is finished.** Even if you finished it, even if you called `done`, and',
    '  especially when it stopped short. A final report must state:',
    '  - the commit hash of each repository, and the subject line of each commit;',
    '  - the acceptance URL and where to look, when this task deployed something;',
    '  - what passed and what the evidence was (the command, and its result - not "tests pass");',
    '  - **what you did not verify**, and what a reader should not assume from your report;',
    '  - anything still in the way, or a decision of yours the caller may want to revisit.',
    '',
    'Between those three, report when you judge a report helps the caller act: something landed',
    'that changes what comes next, an assumption turned out false, or the shape of the work changed',
    'enough that the brief the caller wrote no longer describes it. Outside the three, a report',
    'that would only say nothing happened is one to skip.',
  )
  lines.push(
    '',
    '# The work',
    '',
  )
  return lines.join('\n')
}

/**
 * Put one session at a sandbox mode, as DSH's own preset table means it.
 *
 * The table bundles two knobs, and one of its entries is more than a mode:
 * `danger-full-access` is "Full file access without approval prompts", paired with `never`.
 * A session given the first without the second is not that entry - the pair matches no
 * preset, so the interface reads it as `custom`, and an approval request that does arise is
 * put to the user instead of being refused. Both are written here, so what this plugin opens
 * is exactly what the panel's own switch produces. `workspace-write` needs no such pairing:
 * its preset carries `ask`, which is the deployment default already.
 *
 * `source: 'delegation'` marks a switch a tool made on the user's behalf rather than one
 * they made themselves. Nothing keys on it - it is the marker DSH seeds into a child agent's
 * log, and it is written here for the same reason: a reader of that log can tell the two
 * apart.
 * @param session - the session to write to.
 * @param mode - the sandbox mode it is being put at.
 * @returns whether anything was written.
 */
export function setSessionPermission(session, mode) {
  if (session === undefined || session === null || typeof session.append !== 'function') return false
  session.append('sandbox/mode', { mode, source: 'delegation' })
  if (mode === 'danger-full-access') session.append('approval/policy', { policy: 'never', source: 'delegation' })
  return true
}

/**
 * Open a session inside a task space and hand it one turn of work.
 *
 * Four steps, and each is a Host service a deployment may or may not serve: the task space
 * has to be a Workspace before a session can belong to it, the session is created through the
 * session controller, its permission is one event on its own log, and the work is a prompt.
 * A deployment without those services is not a failure of the rest of the tool - the task
 * space is still there - so the answer says no session was opened and what to do instead.
 *
 * The session is named by `workspaceId` rather than by its directory: the controller attaches
 * a session to its Workspace only when it is named (see its own `create`), and that
 * attachment is what puts the session in that group in the sidebar instead of in Ungrouped.
 * The directory is the fallback for a deployment that serves no registry at all.
 *
 * The permission is written as the same `sandbox/mode` event `dsh-subagent` seeds into a
 * child, marked the same way, so that a mode a call delegated can be told apart from one the
 * user switched themselves.
 * @param ctx - the host plugin context.
 * @param exec - the tool run context.
 * @param request - the task space, the work, the permission the call named, and whether to
 *   watch the session for abnormal turn ends (`watch`, on unless the call says false).
 * @param watcher - the plugin's session watcher, when the entry made one.
 * @returns the session id (empty when none was opened) and what the caller should be told.
 */
async function dispatchToSession(ctx, exec, request, watcher) {
  const service = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)
  const controller = service('sessionController')
  const sessions = service('sessions')
  if (controller === undefined || controller === null
    || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
    return {
      sessionId: '',
      reason: 'this deployment serves no session service, so no session was opened; open one in the task space from the '
        + 'Worktree Space panel ("Create and open") instead',
    }
  }
  // Handed a Workspace by the caller - a create that has just registered one - this does not
  // look it up again; the fallback is for the caller that has none to hand over.
  let place = request.place === undefined ? { cwd: request.taskPath } : request.place
  let reason = ''
  const registry = workspaceRegistryOf(ctx)
  if (request.place === undefined && registry !== undefined) {
    const unregistered = await registerTaskWorkspace(registry, request.taskPath, request.sourceRoot, request.task)
    if (unregistered !== '') {
      reason = `the task space could not be registered as a DSH Workspace (${unregistered}), so the session may not appear `
        + 'in that group in the workspace list'
    } else if (typeof registry.resolveByPath === 'function') {
      const record = await registry.resolveByPath(request.taskPath)
      if (record !== undefined && record !== null && typeof record.id === 'string' && record.id !== '') {
        place = { workspaceId: record.id }
      }
    }
  }
  let sessionId = ''
  try {
    const created = await controller.create(place)
    sessionId = typeof created?.sessionId === 'string' ? created.sessionId : ''
  } catch (error) {
    return { sessionId: '', reason: `the session could not be opened (${String(error?.message ?? error)})` }
  }
  if (sessionId === '') {
    return { sessionId: '', reason: 'the session service answered without a session id, so no session was opened' }
  }
  const mode = request.requested === 'inherit' ? inheritedMode(ctx, exec) : request.requested
  if (mode !== undefined && typeof sessions?.get === 'function') {
    setSessionPermission(sessions.get(sessionId), mode)
  }
  try {
    // The Host's prompt request is a typed shape whose fields are required, and its own client
    // (`Session.prompt` in the session-controller) is the reference for one: a freshly minted
    // requestId, the delivery mode, the content, and the caller's time zone. This call used to
    // send the session id and the content alone, and admission threw inside itself - which the
    // Host reports as `prompt rejected` under `session/agent-busy`, the wrapper it puts around
    // every non-Remote failure in there.
    //
    // The second argument is the cancellation signal the contract also names. It is declared
    // required and dereferenced without a guard (the same package's `list` guards that call), so
    // omitting it crashed the handoff outright; a handoff is not a cancellable read, so it passes
    // a signal that never aborts. `mode: 'queue'` is what a handoff is: it waits for the session
    // to take it rather than steering a turn already running.
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    // The delivery policy the record settled when the space was created. Read here rather
    // than handed in by each caller: this is the one place every dispatch passes through, so
    // a call site cannot forget it and hand a deploying task's session a brief that says
    // nothing about the smoke it has to pass. A space with no record - one made before the
    // policy existed - answers the built-in default, `none`, exactly as a finish reads it.
    const recorded = await readTaskMetadata(request.taskPath)
    const deployTarget = recorded === undefined ? 'none' : deliveryPolicyOf(recorded).deploy.target
    // The standing section is put in front of whatever the caller wrote, so a brief
    // that forgot the reporting channel or the isolation rule still carries them.
    // Prepended rather than appended because these are instructions the work is read
    // in the light of, not a footnote to it.
    const preamble = taskBriefPreamble({
      tasksRoot: request.tasksRoot,
      task: request.task,
      branch: request.branch,
      callerSessionId: exec?.agent?.session?.id,
      deployTarget,
    })
    await controller.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: `${preamble}${request.prompt}` }],
      ...(typeof timeZone === 'string' && timeZone !== '' ? { clientTimeZone: timeZone } : {}),
    }, new AbortController().signal)
  } catch (error) {
    return {
      sessionId,
      reason: `the session was opened but the work could not be handed to it (${String(error?.message ?? error)}); `
        + 'open it and say what to do',
    }
  }
  // The work is handed over, so start watching for a turn that ends badly - unless the call
  // asked not to. Armed here rather than at either call site because this is the one place
  // every dispatch passes through, and armed *after* the prompt rather than before it: a watch
  // on a session whose work never arrived would report a failure that never happened.
  if (request.watch !== false) watchDispatchedSession(watcher, sessionId, request, exec)
  return { sessionId, reason }
}

/**
 * Record the dispatching session as this task's leader, beside its member.
 *
 * A dispatch knows both ends: the session it just opened, and the session that
 * called the tool. Writing only the first left the record unable to say who the
 * member's report answers to, so every reader that cares had to infer it from a
 * directory. The caller id comes from `exec`, which the harness sets on every tool
 * run - the same expression the `done` branch uses for the session to leave out of
 * the active-session check - so it is a fact about the run rather than a value a
 * model can name in the arguments.
 *
 * A session that dispatched its own task space records one entry, the member's, not
 * two spellings of one id. And a write that fails is a warning, exactly as the
 * member's is: the session is running, and losing the work to save the note about it
 * would be the worse trade.
 * @param taskPath - the task space whose record is being written.
 * @param memberSessionId - the session the work was handed to, already recorded.
 * @param exec - the tool run context, for the calling session's id.
 * @param warnings - where a write that could not happen is reported.
 */
async function recordDispatchLeader(taskPath, memberSessionId, exec, warnings) {
  const callerSessionId = exec?.agent?.session?.id ?? exec?.agent?.id ?? ''
  if (typeof callerSessionId !== 'string' || callerSessionId === '') return
  if (callerSessionId === memberSessionId) return
  // Read again rather than reusing the caller's copy: the member was written a moment
  // ago, and an append to the record that no longer says what is on disk would drop it.
  const current = await readTaskMetadata(taskPath).catch(() => undefined)
  if (!(await recordTaskSession(taskPath, current, callerSessionId, 'leader'))) {
    warnings.push(`the dispatching session (${callerSessionId}) could not be written into the task's record at `
      + `${taskPath} as its leader, so a report from the member cannot name who it answers to; the session it `
      + 'dispatched is still recorded, and its id is in this answer')
  }
}

/**
 * Start watching a dispatched session for the turns that end badly or end quietly.
 *
 * The watcher is handed in by the entry rather than looked up, so a deployment that serves no
 * such service simply gets no interruption notices - reported, never thrown out of a dispatch
 * that otherwise succeeded.
 *
 * The task's path and the source root go in with the watch: the first is where the record is
 * read while the task space exists, and the second is where the archive is read once a `done`
 * has removed it. Both are facts this call has and a later turn end does not, because by then
 * the directory being watched may be gone.
 * @param watcher - the plugin's session watcher, when the entry made one.
 * @param sessionId - the session the work was handed to.
 * @param request - the dispatch request: its task name, task path and source root.
 * @param exec - the tool run context, for the dispatching session id.
 */
function watchDispatchedSession(watcher, sessionId, request, exec) {
  if (sessionId === '') return
  if (watcher === undefined || watcher === null || typeof watcher.watch !== 'function') return
  // The dispatcher is the session that called this tool - the one a notice is addressed to.
  const senderSessionId = exec?.agent?.session?.id ?? exec?.agent?.id ?? ''
  try {
    watcher.watch(
      sessionId,
      request.task,
      typeof senderSessionId === 'string' ? senderSessionId : '',
      request.taskPath,
      request.sourceRoot,
    )
  } catch {
    // A watch that cannot be armed must not fail the dispatch: the session is running.
  }
}

/**
 * Refuse a call that would open a session wider than the user has authorised.
 *
 * The one request this side may not answer by itself. `danger-full-access` in DSH's own
 * table is the whole machine without approval prompts, and the user's grant of it is a
 * setting they switch - the same setting, read through the same function the panel's own
 * endpoint uses. The tool's description says "ask the user first", and a description is
 * content a model can be talked out of, which is exactly why this is a gate instead:
 * refused with E4012, the way the panel path refuses it.
 *
 * Only an explicitly named `danger-full-access` is asked about. `inherit` copies the
 * caller's own explicit override and nothing else, so it can never be wider than the
 * session that called - that is a grant the user already made, not an escalation - and
 * `workspace-write` narrows. Checking either would be this side second-guessing the
 * user's own authorisation rather than refusing one the model invented.
 *
 * Asked at the entry to each branch that can open a session, before anything is made:
 * a create that refused here after cutting the worktrees would leave a task space with no
 * session on it and a caller told the call failed.
 * @param requested - the permission the call named, already defaulted.
 * @param granted - the setting, `on` when the user has authorised it.
 * @throws Error carrying E4012 when full access is asked for while the setting is off.
 */
function refuseUngrantedFullAccess(requested, granted) {
  if (requested !== 'danger-full-access' || granted === 'on') return
  throw coded(
    'E4012',
    'Full access for the sessions handed to an agent is switched off, so this call cannot open a session with '
      + '`danger-full-access`. Turn the setting on first, or open the session at `workspace-write` (or leave the '
      + 'permission at `inherit`, which copies this session\'s own override and nothing more).',
  )
}

/**
 * Refuse the requests a call cannot answer for itself.
 *
 * Two of them, and they are the same kind of thing: irreversible, and therefore
 * never the model's to decide.
 *
 * `force` is irreversible twice over - it discards uncommitted work, and it swaps
 * `git branch -d` for `branch -D` (`archive.js`), which deletes a branch whose
 * commits landed nowhere. `strays: 'discard'` is a plain deletion of files git
 * never tracked: there is no reflog behind them and no branch to recover them from,
 * so it is at least as final as `force` and gets the same answer.
 *
 * Both are gated on the user's own hand rather than on a flag the model also
 * holds. A model can be talked into either by anything it reads, and a description
 * that says "ask first" is guidance, not a gate - so neither is expressible here at
 * all. The way to either is the Worktree Space panel, where the user ticks the box
 * that warns what it costs.
 *
 * Everything else this tool can do to finish a task is recoverable or is git's own
 * decision. Merging lands the work; `deleteBranch` after a merge is `git branch -d`,
 * which refuses an unmerged branch on its own. `strays` reaches only the entries
 * sitting directly in a task space that carries this plugin's record and at least
 * one linked worktree, and `archive` - which files them away rather than losing
 * them - is both its default and the furthest this side will go.
 * Abandoning a task needs `deleteBranch` without a merge, which `archive.js`
 * already refuses without `force` - so refusing `force` closes that door too.
 * @param args - the tool's arguments.
 * @throws Error carrying E7007 when the call asks for `force` or for `strays: 'discard'`.
 */
function refuseIrreversible(args) {
  if (args.strays === 'discard') {
    throw coded(
      'E7007',
      'strays "discard" cannot be done from a tool call: it deletes the files in the task space that '
      + 'git never tracked, and nothing brings them back - there is no reflog behind them and no branch '
      + 'to recover them from. Deleting the user\'s own writing is theirs to decide, so ask them to do it '
      + 'from the Worktree Space panel, where the box says what it costs. Use "archive" to file the content '
      + 'away instead, or "keep" to leave the space exactly as it stands.',
    )
  }
  if (args.force !== true) return
  throw coded(
    'E7007',
    'force cannot be done from a tool call: discarding uncommitted work, and force-deleting a branch '
    + 'whose commits landed nowhere, are irreversible and have to be the user\'s own decision. '
    + 'Abandoning a task (deleteBranch without merge) needs force too, so it is not available here either. '
    + 'Ask them to open the Worktree Space management page and finish this task space there. '
    + 'Merging, and removing a branch once it has landed, are both still available here.',
  )
}

/**
 * The sessions still working in one task space, when this deployment can tell.
 *
 * A finish removes the worktrees and the task space itself, so a session whose working
 * directory is inside it loses the ground under it mid-turn: it keeps running, its next write
 * lands in a directory that is gone or on a path that no longer resolves, and the work it was
 * doing is quietly unrecoverable. The operating system blocks the directory removal while a
 * process holds it as its cwd - which is why a finish under a running session leaves an empty
 * task space behind rather than nothing - but that is a lock on Windows, not a decision this
 * plugin made, and it is no protection at all for the worktrees that were already removed.
 *
 * So the finish asks first. A session counts as working when the registry says it is running,
 * or when its log still holds an open turn, or when its inbox has something queued: the first
 * misses a turn that has ended but whose work is queued, and the last misses a turn that is
 * running but whose inbox is empty. Each is cheap and together they cover the three ways a
 * session can be mid-work.
 *
 * Best effort by construction. A deployment that serves no agent registry cannot be asked, and
 * an unreadable session contributes nothing - the answer is then "nothing found", which is what
 * a finish with no evidence should do rather than block on a question it cannot ask.
 *
 * Exported so the panel can show the answer without computing it a second way: `task.plan`
 * carries these to the dialog, and the dialog's own pre-check reads them rather than asking the
 * session list a narrower question. Two implementations of "is a session working" is exactly how
 * the panel and the endpoint came to disagree once already.
 * @param ctx - the host plugin context.
 * @param taskPath - the task space being finished.
 * @returns the sessions still working in it, most likely first.
 */
export function sessionsWorkingIn(ctx, taskPath) {
  if (typeof ctx?.get !== 'function') return []
  let agents
  try {
    agents = ctx.get('agents')
  } catch {
    return []
  }
  if (agents === undefined || agents === null || typeof agents.list !== 'function') return []
  let listed
  try {
    listed = agents.list()
  } catch {
    return []
  }
  const found = []
  for (const agent of Array.isArray(listed) ? listed : []) {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') continue
    // A session in the task space itself, or in one of the worktrees under it - both lose their
    // ground to the same finish, and the worktree case is the one that is already being removed.
    if (canonicalPath(cwd) !== canonicalPath(taskPath) && !isInside(taskPath, cwd)) continue
    const running = agent.status === 'running'
    const openTurn = turnIsOpen(agent.session)
    const inbox = agent.inbox
    const queued = inbox?.hasPending === true
      || (inbox?.nextTurn?.length ?? 0) + (inbox?.nextStep?.length ?? 0) > 0
    if (!running && !openTurn && !queued) continue
    found.push({ sessionId: String(agent.id), running, openTurn, queued })
  }
  return found
}

/**
 * Whether a session's log still holds a turn that has started and not ended.
 * @param session - the session to read.
 * @returns whether a turn is open.
 */
function turnIsOpen(session) {
  if (session === undefined || session === null || typeof session.snapshotEvents !== 'function') return false
  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return false
  }
  let open = false
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'turn/start') open = true
    if (event?.type === 'turn/end') open = false
  }
  return open
}

/**
 * Refuse a finish while a session is still working in the task space.
 *
 * Refused rather than reported as a warning, because everything a finish does is destructive and
 * most of it is not reversible: the worktrees go, the task space goes, and the session that was
 * mid-write has no way to notice. The caller has two honest ways forward and the message names
 * both - stop the sessions and finish, or leave the space standing.
 *
 * The caller itself is excluded, and that exclusion is what makes the session-finishes-its-own-work
 * flow real. A session that calls `done` is by definition running, with a turn open, in the task
 * space it is asking to remove - so counting it would refuse every self-finish with the caller as
 * its own blocker, and the only escape (cancel yourself first) ends the turn and the reporting with
 * it. It is the caller's own work being torn down, and the caller is the one party that knows
 * whether it is done writing; every *other* session in there is still refused, which is what the
 * guard is for.
 *
 * Exported because the panel's own finish reaches `finishTask` through a different door
 * (`task.done`), and the two must not disagree: a guard on the tool alone would mean the model
 * is refused where the panel is not, which is exactly backwards for the path a person drives.
 * @param ctx - the host plugin context.
 * @param taskPath - the task space being finished.
 * @param callerSessionId - the session asking to finish, left out of the answer when given.
 * @throws Error carrying E5012 when another session is still working there.
 */
export function refuseWhileSessionsWork(ctx, taskPath, callerSessionId = '') {
  const caller = typeof callerSessionId === 'string' ? callerSessionId : ''
  const working = sessionsWorkingIn(ctx, taskPath).filter((entry) => caller === '' || entry.sessionId !== caller)
  if (working.length === 0) return
  const described = working.map((entry) => {
    const why = [
      entry.running ? 'running' : '',
      entry.openTurn ? 'mid-turn' : '',
      entry.queued ? 'with work queued' : '',
    ].filter(Boolean).join(', ')
    return `${entry.sessionId}${why === '' ? '' : ` (${why})`}`
  }).join('; ')
  throw coded(
    'E5012',
    `a session is still working in this task space: ${described}. Finishing removes the worktrees and the `
      + 'task space, so a session that is mid-turn would lose the directory it is writing into and the work '
      + 'it has not committed. Stop those sessions first - `wts_session_tool_cancel` stops one, and '
      + '`wts_session_tool_status` says what each is doing - then call done again. If the work is not meant to '
      + 'stop, leave the task space standing: it is still there, and nothing has been removed.',
    // Structured as well as spoken, so the panel can say it in the reader's language the way it
    // already does for E5011. The English above is the model's and the log's copy.
    { sessions: working },
  )
}

/**
 * Build the model-facing summary line for one action.
 * @param action - the action performed.
 * @param value - the action's normalized envelope.
 * @returns the summary sentence.
 */
function summarize(action, value) {
  if (action === 'suggest-root') {
    const names = value.repositories.map((row) => row.name).join(', ')
    return `Recommended task space for ${value.tasksRoot === '' ? 'the source root' : value.tasksRoot}: ${value.suggested}. ${value.repositories.length} source repositor${value.repositories.length === 1 ? 'y' : 'ies'}${names === '' ? '' : `: ${names}`}.`
  }
  if (action === 'create') {
    const names = value.repositories.map((row) => row.name).join(', ')
    // The session, when the call asked for one, is the difference between a task space
    // somebody is working in and one that only exists: it is said here rather than left to
    // the caller to notice the empty field.
    const working = value.sessionId === ''
      ? ''
      : ` Session '${value.sessionId}' is on the work; open it from the Worktree Space panel, or from the workspace list.`
    return `Task '${value.task}' is ready at ${value.container} on branch '${value.branch}', with worktrees of: ${names}.${working}${value.warnings.length === 0 ? '' : ` Warnings: ${value.warnings.join('; ')}.`}`
  }
  if (action === 'add') {
    const names = value.repositories.map((row) => row.name).join(', ')
    return `Added to task '${value.task}' at ${value.container} on branch '${value.branch}': ${names}.${value.warnings.length === 0 ? '' : ` Warnings: ${value.warnings.join('; ')}.`}`
  }
  if (action === 'list') {
    if (value.repositories.length === 0 && value.container === '') return `No task space at ${value.tasksRoot}.`
    const perTask = value.repositories.filter((row) => row.name !== '').length
    // The two facts a caller would otherwise have to fetch per task: the session
    // that is on the work, and the acceptance URL a deploy recorded.
    const sessions = value.sessions.length === 0
      ? ''
      : ` Sessions: ${value.sessions.map((entry) => entry.sessionId).join(', ')}.`
    const deployed = value.deployment.filter((entry) => entry.url !== '')
    const acceptance = deployed.length === 0
      ? ''
      : ` Acceptance: ${deployed.map((entry) => `${entry.task} -> ${entry.url}${entry.smoke === '' ? '' : ` (smoke ${entry.smoke})`}`).join('; ')}.`
    return `${value.repositories.length} task${value.repositories.length === 1 ? '' : 's'} under ${value.tasksRoot} (${perTask} worktree${perTask === 1 ? '' : 's'}).${sessions}${acceptance}`
  }
  if (action === 'dispatch') {
    const opened = value.sessionId === ''
      ? `No session was opened in task '${value.task}' at ${value.container}.`
      : `Session '${value.sessionId}' is on the work in task '${value.task}' at ${value.container}; open it from the Worktree Space panel, or from the workspace list.`
    return `${opened}${value.warnings.length === 0 ? '' : ` Warnings: ${value.warnings.join('; ')}.`}`
  }
  const failed = value.failed ? ' Some repositories need attention:' : ''
  // Three stops are worth a sentence of their own, because each names a next step rather
  // than a problem: a conflict to reconcile, work nobody committed, and the user's own
  // checkout standing in the way. Each is kept out of the plain attention list so the same
  // repository is not reported twice, and they are told apart by flag - never by matching
  // git's English, which is not a contract this side can hold.
  const conflicted = value.repositories.filter((row) => row.conflict === true)
  const uncommitted = value.repositories.filter((row) => row.needsCommit === true)
  const blocked = value.repositories.filter((row) => row.dirtyCheckout === true)
  const settled = new Set([...conflicted, ...uncommitted, ...blocked])
  // Everything with a reason that none of those three sections rendered. The rule is
  // "has an error and was not spoken for", not "is not a conflict": a plain failure -
  // a merge target that is not a local branch, a `rev-parse` that would not answer, a
  // worktree that could not be removed - has no section of its own, and leaving it out
  // is how the summary came to say "Some repositories need attention:" and then name
  // nothing at all. Read from the flags, never from git's wording.
  const attention = value.repositories
    .filter((row) => row.error !== '' && !settled.has(row))
    .map((row) => `${row.name}: ${row.error}`).join('; ')
  // A handed-on conflict is not a failure to report and move past: it is the step
  // that is left, so the summary says where it is rather than calling the task done.
  const handedOn = value.repositories.filter((row) => row.mergeInProgress)
  // What is still on disk because a repository failed and was neither merged nor
  // removed. `handedOn` is not the only way a finish is unfinished: a plain failure
  // leaves its worktree and branch exactly as they were, and a headline that said
  // "finished" over that told the model the task was done when nothing had landed.
  const stranded = value.repositories.filter((row) => row.error !== '' && row.merged !== true && row.removed !== true)
  const headline = handedOn.length > 0
    ? `Task '${value.task}' is unfinished: a merge is waiting to be resolved in ${handedOn.map((row) => row.mergeSite).join(', ')}.`
    : stranded.length > 0
      // Named by path, so the reader knows what to go and look at rather than only that
      // something went wrong. "Unfinished" is the claim; the list is what backs it.
      ? `Task '${value.task}' is unfinished: ${stranded.length === 1 ? 'one repository' : `${stranded.length} repositories`} could not be finished and ${stranded.length === 1 ? 'is' : 'are'} still on disk at ${stranded.map((row) => row.path).join(', ')}.`
      : `Task '${value.task}' finished. Task space ${value.container === '' ? 'removed' : `kept at ${value.container}`}.`
  // Who to hand work to, said here rather than left to a lookup. The caller that can act
  // is the one that dispatched the work, and what it needs is the session that owns these
  // checkouts - named when the record has one, and otherwise with the way to get one. A
  // stop nobody is told how to route is a finish that ends with no way forward but the panel.
  const who = value.sessionId === ''
    ? ' No session is recorded for this task space, so open one (wts_session_tool_create, cwd at the task space or the checkout) and hand it the job.'
    : ` Hand it to session '${value.sessionId}' (wts_session_tool_send, mode "steer"), or do it yourself in the checkout.`
  const handoff = handedOn.length === 0
    ? ''
    : ` Resolve ${handedOn.map((row) => row.conflictedFiles.join(', ')).filter((list) => list !== '').join('; ') || 'the conflict'}, commit the merge there, then call done again.${who}`
  // Work nobody committed is the same shape of answer: it needs a commit, and the message
  // has to come from whoever read the changes - this side has not, and will not invent one.
  const commit = uncommitted.length === 0
    ? ''
    : ` Uncommitted work is waiting in ${uncommitted.map((row) => row.path).join(', ')}: have it committed on ${uncommitted.length === 1 ? 'that repository\'s branch' : 'each repository\'s own branch'}, then call done again.${who}`
  // The user's own checkout, which is not this flow's to touch and not something a session
  // may commit on their behalf: the work in it is theirs and may be nothing to do with this
  // task. Said plainly, because "commit or stash" is the whole of the way forward.
  const dirty = blocked.length === 0
    ? ''
    : ` The checkout the user works in (${blocked.map((row) => row.mainRepo || row.path).join(', ')}) has uncommitted work this merge would overwrite. That work is theirs to commit or stash - do not commit it for them - then call done again.`
  return `${headline}${failed}${attention}${handoff}${commit}${dirty}${value.warnings.length === 0 ? '' : ` Warnings: ${value.warnings.join('; ')}.`}`
}

/** How many repository rows a result card carries. */
const CARD_ROW_LIMIT = 20

/** How many warnings a result card carries. */
const CARD_WARNING_LIMIT = 3

/** How much text a result card carries, in characters. */
const CARD_TEXT_LIMIT = 4000

/**
 * The text of a completed call's card.
 *
 * Built from the durable projection when the Host passed one, and from the
 * model-facing content when it did not (a nested or otherwise projection-less
 * call), so a UI without the projection still gets something true. It is pure —
 * the same result gives the same text on the live path and on a session-log
 * replay — never longer than {@link CARD_TEXT_LIMIT}, and it says so when it cuts.
 * @param result - the completed call as the Host hands it to a presenter.
 * @returns the card's text.
 */
function cardText(result) {
  const meta = result !== null && typeof result === 'object'
    && result.meta !== null && typeof result.meta === 'object' && !Array.isArray(result.meta)
    ? result.meta
    : null
  const parts = []
  if (meta !== null) {
    if (typeof meta.summary === 'string' && meta.summary !== '') parts.push(meta.summary)
    const rows = Array.isArray(meta.repositories) ? meta.repositories : []
    const lines = rows.map((row) => {
      const name = typeof row?.name === 'string' ? row.name : '?'
      const state = row?.error ? `failed: ${String(row.error)}` : row?.merged === true ? 'merged' : 'not merged'
      return `${name}: ${state}${row?.removed === true ? ', worktree removed' : ''}`
    })
    const total = typeof meta.total === 'number' && Number.isFinite(meta.total) ? meta.total : rows.length
    if (total > rows.length) lines.push(`... and ${total - rows.length} more repositories`)
    if (lines.length > 0) parts.push(lines.join('\n'))
    const warnings = Array.isArray(meta.warnings) ? meta.warnings.filter((one) => typeof one === 'string') : []
    if (warnings.length > 0) parts.push(`warnings: ${warnings.join('; ')}`)
  } else if (Array.isArray(result?.content)) {
    const text = result.content
      .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .filter((one) => one !== '')
      .join('\n\n')
    if (text !== '') parts.push(text)
  }
  const text = parts.join('\n\n')
  return text.length > CARD_TEXT_LIMIT ? `${text.slice(0, CARD_TEXT_LIMIT)}\n... (truncated)` : text
}

/**
 * Register the `wts_worktree_space` tool when the deployment serves tools.
 *
 * Both guards matter: a deployment without a tool runtime must keep its
 * endpoints, and a bare context double (as the host tests build) has no service
 * lookup at all, so probing it must not throw.
 * @param ctx - the host plugin context.
 * @param options - `configuredRoot` answers the container root the plugin's own
 * configuration names, read when an action needs one. A deployment that passes
 * nothing leaves every action on the recommendation.
 * @returns the registration disposer, or undefined when tools are unavailable.
 */
export function registerTaskTool(ctx, options = {}) {
  if (typeof ctx.get !== 'function') return undefined
  const tools = ctx.get('tools')
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return undefined
  // Read per call rather than captured once: the setting can change while a
  // session is running, and the next create should follow it.
  const configuredRoot = () => typeof options.configuredRoot === 'function' ? options.configuredRoot() : ''
  // Whether the user has granted full access to the sessions this plugin opens for them.
  // Read per call rather than captured once, for the same reason the container root is:
  // the setting can change while a session is running, and the next dispatch should follow
  // it. A deployment that passes nothing answers `off`, which is the setting's own default.
  const configuredFullAccess = () => typeof options.configuredFullAccess === 'function' ? options.configuredFullAccess() : 'off'
  // Where the strays handling files content away, when a done asks for `archive`
  // without naming a directory: the same archive preference the finish dialog reads.
  const configuredArchive = () => typeof options.configuredArchive === 'function' ? options.configuredArchive() : undefined
  // The watcher that reports a dispatched session's abnormal turn ends back to whoever
  // dispatched it. Handed in rather than looked up as a service: it is this plugin's own
  // component, and a deployment that serves no such service must still dispatch normally.
  const sessionWatch = options.sessionWatch

  return tools.register(defineTool({
    name: 'wts_worktree_space',
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['suggest-root', 'create', 'add', 'list', 'dispatch', 'done'],
        description: 'suggest-root, create, add, list, dispatch, or done.',
      },
      task: { type: 'string', description: 'Name (create, add, done): the task space directory and branch suffix, with no separators or spaces.' },
      project: { type: 'string', description: 'Project layer (add, list, done): the source root\'s own directory name. Omit when sourceRoot is given, since it is derived from it.' },
      sourceRoot: { type: 'string', description: 'Directory of the repositories. Required for suggest-root and create.' },
      tasksRoot: { type: 'string', description: 'Container for task spaces: beside the repositories\' directory, never inside it or a parent of it. Omit for the recommendation.' },
      repos: { type: 'array', items: { type: 'string' }, description: 'Repository paths, as reported by suggest-root (create, add). Omit for every discovered (create). A bare name is read as relative to sourceRoot, which only names a repository sitting directly in it.' },
      baseRef: { type: 'string', description: 'Start point (create, add). Omit for each repository HEAD.' },
      branchPrefix: { type: 'string', description: 'Branch prefix (create, suggest-root): the branch is this plus the task name. Omit for the default task/.' },
      deployTarget: {
        type: 'string',
        enum: ['docker', 'none'],
        description: 'Whether this task is deployed for acceptance (create). Ask the user for this value before anything is created or dispatched: it is settled on the create and cannot be added or changed afterwards, so letting the default answer it leaves the task with no acceptance fence and no record that one was wanted. "docker" means the task expects a deployment and its finish gate is live - the work is not finished until the task space\'s own smoke records pass, and `done` with merge: true is refused until `.worktree-space/deploy/.state.json` does (E5006). "none" (the built-in default) expects no deployment and has no gate. Choosing docker requires something to deploy with: a `deploy/deploy.sh` at the source root, a script named by deployScript, or a repository carrying its own `deploy/deploy.sh`. With none of those the create is refused (E4015) rather than made undeployable.',
      },
      deployScript: { type: 'string', description: 'Deploy script (create): a path relative to the workspace, naming a file under its `.worktree-space/deploy/` directory (e.g. ".worktree-space/deploy/notify.sh"). It travels into the task space under its own name and the record remembers it as this task\'s entry - nothing is renamed or overwritten. Anything outside that directory is refused (E4014). Omit it and the entry is `.worktree-space/deploy/deploy.sh`, the same relative path on either side. Only meaningful with deployTarget docker.' },
      registerWorkspace: { type: 'boolean', description: 'Register what this create made as a DSH Workspace (create). Omitted it registers, which is what the panel does; pass false only when the user asked for a task space that stays out of the workspace list.' },
      merge: { type: 'boolean', description: 'REQUIRED for done: true merges the task branches into their targets before the worktrees are removed, false leaves the work on the task branches. There is no default - a finish that omits it is refused with E7006, because a merge is the one step here that cannot be walked back.' },
      prompt: { type: 'string', description: 'The complete, self-contained job for a session (create, dispatch). Given on create, the session is opened in the new task space and handed this in the same call; given on dispatch, it is handed to a session in a task space that already exists. A session does not share this conversation\'s context, so include everything it needs.' },
      permission: { type: 'string', enum: ['inherit', 'workspace-write', 'danger-full-access'], description: 'What the session opened by this call may write (create, dispatch). inherit, the default, copies this session\'s own explicit sandbox override and nothing more, so the new session is never wider than this one. `danger-full-access` is the whole machine without approval prompts, and it is refused (E4012) unless the user has switched on the setting that grants it - ask them before naming it, and expect the refusal when they have not.' },
      watchSession: { type: 'boolean', description: 'Whether to watch the session this call opens and report back to you when a turn ends abnormally (create, dispatch). True by default. A session that dies mid-turn cannot report itself - its model call failed, it hit the output ceiling, a pre-step hook refused it, or the process crashed - so with this on you are told, with the session id, instead of having to poll a session you had no reason to suspect. Pass false for a task whose failures you do not need to hear about. Turns that complete, and turns the user cancels, are never reported either way.' },
      target: { type: 'string', description: 'Branch to merge into (done), for every repository. Omit for the branch each source repository has checked out.' },
      deleteBranch: { type: 'boolean', description: 'Delete each branch (done), after a merge. Needs merge: true; deleting a branch that never landed is refused here. Omitted the branch is kept, which is the half that can be walked back.' },
      strays: {
        type: 'string',
        enum: ['archive', 'keep', 'discard'],
        description: 'What happens to the files in the task space that git never tracked (done). "archive" (the default when omitted) files them into the archive directory and clears build output, so this finish can remove the space. "keep" touches nothing, which leaves the directory non-empty and the task space on disk - use it when the user wants to come back to that content. "discard" deletes them outright and is REFUSED here (E7007): it is irreversible and the user\'s own decision, so it is reachable only from the Worktree Space panel. Never reach for it to get a finish to go through - archive the content, or leave the space standing and say why.',
      },
      keepEntries: { type: 'array', items: { type: 'string' }, description: 'Entry names in the task space to leave alone whatever strays says (done). Omit when nothing specific has to survive.' },
      force: { type: 'boolean', description: 'Discard uncommitted changes (done). Refused here, always - the user decides that themselves, on the management page.' },
      unregisterWorkspace: { type: 'boolean', description: 'Unregister the Workspace of the task space a finish removed (done). Omitted it unregisters, which is what the panel does; pass false only when the user asked to keep that task\'s group after finishing.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.summary }],
      // The card's own projection, bounded here as well as at the card: a
      // hundred-repository task must neither bloat the session log nor a card.
      // `total` stays in place, so a capped list can never be read as the whole
      // answer.
      presentationMeta: (_args, value) => ({
        summary: value.summary,
        total: value.repositories.length,
        repositories: value.repositories.slice(0, CARD_ROW_LIMIT).map((row) => ({
          name: row.name,
          merged: row.merged,
          removed: row.removed,
          error: row.error,
        })),
        warnings: value.warnings.slice(0, CARD_WARNING_LIMIT),
      }),
    },
    async execute(args, exec) {
      const action = args.action

      if (action === 'suggest-root') {
        // Resolved, because this path is about to be compared - `suggestTaskRoot`
        // hands it to `assertIsolated` against the recommendation - and a spelling
        // with a `..` in it compares as a string, not as the directory it names.
        const sourceRoot = absolutePath(required(args.sourceRoot, 'sourceRoot'))
        const result = await suggestTaskRoot(ctx.subprocess, sourceRoot, {
          tasksRoot: args.tasksRoot,
          branchPrefix: typeof args.branchPrefix === 'string' ? args.branchPrefix : undefined,
          // The plugin's own setting outranks the recommendation: it is the user's
          // standing answer to where task spaces go, so the model proposes it too.
          configuredRoot: configuredRoot(),
        })
        const value = envelope(action)
        value.tasksRoot = result.sourceRoot
        value.suggested = result.suggested
        value.repositories = result.repositories.map((entry) => ({ ...emptyRow(entry.name), path: entry.path, branch: entry.branch ?? '' }))
        value.summary = summarize(action, value)
        return value
      }

      if (action === 'create') {
        const sourceRoot = absolutePath(required(args.sourceRoot, 'sourceRoot'))
        // Asked before the task space is cut, not after: a create that refused once the
        // worktrees were on disk would leave a space with no session on it and a caller
        // told the call failed. A create with no prompt opens no session, so it asks
        // nothing.
        if (typeof args.prompt === 'string' && args.prompt.trim() !== '') {
          const requested = typeof args.permission === 'string' && args.permission.trim() !== '' ? args.permission.trim() : 'inherit'
          refuseUngrantedFullAccess(requested, configuredFullAccess())
        }
        // The one delivery decision this call makes: whether the task expects a
        // deployment. It is a plain argument now, not a JSON policy blob, so the
        // schema's own enum refuses a bad value before this line and the value
        // travels as what it is. A create that names nothing gets the built-in
        // default, which deploys nothing and therefore gates nothing.
        const deployTarget = typeof args.deployTarget === 'string' && args.deployTarget.trim() !== ''
          ? args.deployTarget.trim()
          : undefined
        const result = await createTask(ctx.subprocess, {
          sourceRoot,
          task: required(args.task, 'task'),
          tasksRoot: args.tasksRoot,
          repos: Array.isArray(args.repos) ? args.repos : undefined,
          baseRef: typeof args.baseRef === 'string' ? args.baseRef : undefined,
          branchPrefix: typeof args.branchPrefix === 'string' ? args.branchPrefix : undefined,
          deployScript: typeof args.deployScript === 'string' ? args.deployScript : undefined,
          configuredRoot: configuredRoot(),
          // Stated by this call, or nothing: create.js resolves it once, before
          // anything is made. An invalid target is refused there, with E4010.
          delivery: deployTarget === undefined ? undefined : { deploy: { target: deployTarget } },
        })
        const value = envelope(action)
        value.task = result.task
        value.project = result.project
        value.branch = result.branch
        value.container = result.path
        value.tasksRoot = result.tasksRoot
        // The other half of a create: the directory and the worktrees are on disk,
        // and DSH has to be told the result is a Workspace. Registering it here is
        // what keeps an agent-made task space from being a container the workspace
        // list never shows and no second create can take the name of.
        //
        // Left to the panel when the call asks for it, and then it is the user's own press
        // rather than this tool's. The warning below is written either way, because what a
        // caller needs to know is the same in both cases: nothing in the interface shows this
        // task space yet, and until something registers it the same name cannot be used again.
        //
        // Reported as a warning and never thrown, because the create has already
        // succeeded: a caller told it failed would not know the worktrees are there,
        // and the same name would stay unusable either way.
        const leaveToThePanel = args.registerWorkspace === false
        // What create.js found while making the space - currently the links a
        // worktree holds that this machine would refuse to recreate. Carried first,
        // so the order a caller reads is the order the facts were established:
        // what the space contains, then whether it is registered.
        for (const warning of result.warnings ?? []) value.warnings.push(warning.message)
        const registry = leaveToThePanel ? undefined : workspaceRegistryOf(ctx)
        const unregistered = leaveToThePanel
          ? ''
          : registry === undefined
            ? NO_WORKSPACE_REGISTRY
            : await registerTaskWorkspace(registry, result.path, sourceRoot, result.task)
        if (leaveToThePanel) {
          value.warnings.push(
            'the task space is on disk but not registered as a DSH Workspace, because this call asked for one '
            + 'that stays out of the workspace list. Register it from the Worktree Space panel - "Create and '
            + 'open", or "Register again" after a create is refused - and open the task\'s session there; until '
            + 'it is registered, creating this task again is refused as E2002',
          )
        } else if (unregistered !== '') {
          value.warnings.push(
            `the task space is on disk but not registered as a DSH Workspace (${unregistered}); register it from the `
            + 'Worktree Space panel - "Create and open", or "Register again" after a create is refused - and open the '
            + 'task\'s session there; until it is registered, creating this task again is refused as E2002',
          )
        }
        // The same call can put someone on the work: given a prompt, the session is opened in
        // the task space now and handed that job, which is what the panel's "Create and open"
        // does in one press - except that the session there starts empty. Without a prompt
        // nothing is opened, which is what a create that only wants the task space asks for.
        if (typeof args.prompt === 'string' && args.prompt.trim() !== '') {
          const requested = typeof args.permission === 'string' && args.permission.trim() !== '' ? args.permission.trim() : 'inherit'
          // Watching is on unless the call says otherwise: a session that dies mid-turn cannot
          // report itself, so the caller that asked for the work is the one who has to be told.
          const watch = args.watchSession !== false
          // The Workspace was registered a moment ago by this same branch, so its record is
          // read once more and handed over rather than registered again.
          const record = unregistered === '' && registry !== undefined && typeof registry.resolveByPath === 'function'
            ? await registry.resolveByPath(result.path)
            : undefined
          const opened = await dispatchToSession(ctx, exec, {
            taskPath: result.path,
            task: result.task,
            tasksRoot: result.tasksRoot,
            branch: result.branch,
            sourceRoot,
            prompt: args.prompt,
            requested,
            watch,
            ...(record === undefined || record === null || typeof record.id !== 'string' || record.id === ''
              ? {}
              : { place: { workspaceId: record.id } }),
          }, sessionWatch)
          value.sessionId = opened.sessionId
          if (opened.reason !== '') value.warnings.push(opened.reason)
          // §4.3: the session id this call already knows is written into the task's
          // own record, so the dispatching session - and the note a session in the
          // task space reads - can name it without searching for it. Reported as a
          // warning when it could not be written, never as a failure: the session
          // is running, and losing the work to save the note about it would be the
          // worse trade.
          if (opened.sessionId !== '') {
            const recorded = await readTaskMetadata(result.path)
            if (!(await recordTaskSession(result.path, recorded, opened.sessionId, 'task'))) {
              value.warnings.push(`the session id (${opened.sessionId}) could not be written into the task's record at `
                + `${result.path}; find it again with wts_session_tool_find, by the task space directory`)
            }
            // The other end of the dispatch, in the same record: the session that asked for
            // the work. The member is written first so a failure between the two leaves a
            // record naming the session doing the work rather than one naming only the asker.
            await recordDispatchLeader(result.path, opened.sessionId, exec, value.warnings)
          }
        }
        value.repositories = result.repositories.map((entry) => ({ ...emptyRow(entry.name), path: entry.path, branch: result.branch }))
        value.summary = summarize(action, value)
        return value
      }

      if (action === 'add') {
        const task = required(args.task, 'task')
        const tasksRoot = await containerFor(ctx.subprocess, args.tasksRoot, args.sourceRoot, configuredRoot())
        const project = projectFor(args.project, args.sourceRoot)
        const result = await addTaskRepositories(ctx.subprocess, {
          task,
          project,
          tasksRoot,
          // Absolute paths, not names: a repository added to an existing task need
          // not sit under the source root that task began from, so there is no
          // directory to resolve a name against. Each is resolved all the same,
          // because `addTaskRepositories` compares it against the task space.
          repositories: Array.isArray(args.repos) ? args.repos.map(absolutePath) : [],
          baseRef: typeof args.baseRef === 'string' && args.baseRef.trim() !== '' ? args.baseRef.trim() : undefined,
        })
        const value = envelope(action)
        value.task = result.task
        value.project = result.project
        value.branch = result.branch
        value.container = result.path
        value.tasksRoot = result.tasksRoot
        value.repositories = result.repositories.map((entry) => ({ ...emptyRow(entry.name), path: entry.path, branch: result.branch }))
        value.summary = summarize(action, value)
        return value
      }

      if (action === 'list') {
        const tasksRoot = await containerFor(ctx.subprocess, args.tasksRoot, args.sourceRoot, configuredRoot())
        const result = await listTasks(ctx.subprocess, { tasksRoot })
        const value = envelope(action)
        value.tasksRoot = result.tasksRoot
        for (const task of result.tasks) {
          // Named the way the layout reads - project, task, repository - so two
          // projects' tasks of the same name cannot be read as one.
          const label = `${task.project}/${task.name}`
          // The task's own two facts, so a caller can name the session that is
          // working on it and read the acceptance URL without a second call. Both
          // are the task's, not a repository's, which is why they are reported
          // once per task and not once per row.
          for (const entry of [...(task.sessions ?? [])].reverse()) {
            value.sessions.push({ sessionId: entry.sessionId, role: entry.role, at: entry.at ?? '' })
          }
          const state = task.delivery ?? { url: null, lastSmoke: null }
          value.deployment.push({
            task: label,
            url: state.url ?? '',
            smoke: state.lastSmoke?.result ?? '',
            smokeAt: state.lastSmoke?.at ?? '',
          })
          if (task.repositories.length === 0) {
            value.repositories.push({ ...emptyRow(label), path: task.path })
            continue
          }
          for (const repository of task.repositories) {
            value.repositories.push({
              ...emptyRow(`${label}/${repository.name}`),
              path: repository.path,
              branch: repository.branch ?? '',
              changedFiles: repository.changedFiles,
            })
          }
        }
        value.summary = summarize(action, value)
        return value
      }

      if (action === 'done') {
        const task = required(args.task, 'task')
        refuseIrreversible(args)
        // The one answer a finish cannot be allowed to leave implicit, because it is
        // the one that decides whether the work lands on a branch the user already
        // has or stays where it is. Everything else a finish does is reversible or
        // is git's own decision; this is not, so a call that did not say is refused
        // with a sentence that says why rather than defaulted into an answer.
        //
        // Checked here rather than in the parameter schema because that schema is
        // flat and shared by every action: marking `merge` required there would
        // demand it of `create`, `list` and the rest.
        if (typeof args.merge !== 'boolean') {
          throw coded(
            'E7006',
            'merge is required for done: pass true to merge the task branches into their targets, or false to '
              + 'leave them where they are. This is the decision that cannot be taken back - a merge that landed '
              + 'has to be reverted by hand, and a branch that was not merged keeps its work where it is. Say '
              + 'which one the user wants; do not leave it to a default.',
          )
        }
        const tasksRoot = await containerFor(ctx.subprocess, args.tasksRoot, args.sourceRoot, configuredRoot())
        const project = projectFor(args.project, args.sourceRoot)
        // Asked before anything is removed, and refused rather than warned: a finish takes the
        // worktrees and the task space away, so a session still writing in there would lose the
        // ground under it with no way to notice. The refusal names the sessions and what to do.
        //
        // The caller is left out of that list: a session finishing its own work is running, with a
        // turn open, inside the very task space it is asking to remove, so counting it would make
        // that flow impossible - it would be refused with itself as the blocker. Every other
        // session in there still counts.
        const callerSessionId = exec?.agent?.session?.id ?? exec?.agent?.id ?? ''
        refuseWhileSessionsWork(ctx, taskSpacePath(tasksRoot, project, task), callerSessionId)
        // Read before the finish, not after: a finish that completes removes the task
        // space and with it the record this is read from, and the caller still needs to
        // know which session was on the work. Read leniently - a missing or unreadable
        // record is "nothing is recorded", never a reason to refuse a finish that would
        // otherwise go through.
        const beforeFinish = await readTaskMetadata(taskSpacePath(tasksRoot, project, task)).catch(() => undefined)
        const result = await finishTask(ctx.subprocess, {
          task,
          project,
          tasksRoot,
          // The early refusal above is the cheap one. Handing the context on is what lets
          // the finish ask again inside its own lock, where no session can start working
          // between the question and the removal - see `finishTask`.
          ctx,
          callerSessionId,
          merge: args.merge,
          target: typeof args.target === 'string' ? args.target : undefined,
          deleteBranch: typeof args.deleteBranch === 'boolean' ? args.deleteBranch : undefined,
          force: args.force === true,
          // What happens to the files git never tracked. Absent means archive: the
          // answer that neither loses anything nor leaves the task space standing.
          strays: typeof args.strays === 'string' ? args.strays : undefined,
          keepEntries: Array.isArray(args.keepEntries) ? args.keepEntries : [],
          deliveryArchive: configuredArchive(),
        })
        const value = envelope(action)
        value.task = task
        value.project = project
        value.container = result.containerRemoved ? '' : result.path
        value.tasksRoot = tasksRoot
        value.failed = result.failed
        // The finish reports each warning with the values a screen needs to say it in
        // the reader's language; a model reads the sentence, so that is what it is
        // given. The panel gets the whole object through the endpoint, which is why
        // the sentence stays exactly as the Host wrote it.
        value.warnings = result.warnings.map((entry) => entry.message)
        // The registration follows the directory. Dropped only when the finish
        // really removed the task space, and kept while the container is still
        // there - the panel's own rule, for the panel's own reason: a registration
        // whose directory is still on disk has to keep showing it. The create from
        // this tool registered it, so this is the half that keeps a finished task
        // from leaving an entry pointing at a directory that is gone.
        //
        // Unless the call asks for the group to outlive the directory: off, the entry stays and
        // the task's sessions stay under it instead of falling back to Ungrouped, and what the
        // user has is a Workspace whose directory is gone. Nothing is said about that here - it
        // is what was asked for, not something that went wrong.
        if (result.containerRemoved && args.unregisterWorkspace !== false) {
          const stranded = await dropTaskWorkspace(workspaceRegistryOf(ctx), result.path)
          if (stranded !== '') value.warnings.push(stranded)
        }
        value.repositories = result.repositories.map((entry) => ({
          ...emptyRow(entry.name),
          path: entry.path,
          branch: entry.branch ?? '',
          merged: entry.merged === true,
          removed: entry.removed === true,
          branchDeleted: entry.branchDeleted === true,
          mainRepo: entry.mainRepo ?? '',
          // Whether this row stopped on a merge somebody has to reconcile, as opposed
          // to any other way a repository can fail. The distinction matters to a caller
          // that intends to act on it: a conflict has a place to go and files to fix,
          // while a dirty source checkout (E5004) is the user's own work and is not
          // this flow's to touch. Without the flag a caller has to match git's English
          // to tell them apart, which is exactly the reading this field replaces.
          conflict: entry.conflict === true,
          mergeInProgress: entry.mergeInProgress === true,
          mergeSite: entry.mergeSite ?? '',
          conflictedFiles: Array.isArray(entry.conflictedFiles) ? entry.conflictedFiles : [],
          // The two stops whose way forward is an agent rather than a retry: work in the
          // task space nobody has committed, and work in the user's own checkout that a
          // merge would overwrite. Flags rather than sentences, because a caller acting on
          // them has to tell them from a conflict and from a plain failure.
          needsCommit: entry.needsCommit === true,
          dirtyCheckout: entry.dirtyCheckout === true,
          error: entry.error ?? '',
        }))
        // The session this task space was being worked in, so a caller that has to hand
        // work back to it - a conflict to reconcile, say - knows who to talk to without a
        // lookup. `create` and `dispatch` answer with the session they opened; this is the
        // same fact for a finish, read from the record before the finish removed it.
        // Empty when the record names none, which is the honest answer: nothing is
        // running there, and a caller that needs one has to open it (see
        // wts_session_tool_create).
        const recordedSessions = normalizeSessions(beforeFinish?.sessions ?? beforeFinish?.sessionId)
        if (recordedSessions.length > 0) {
          value.sessionId = recordedSessions[recordedSessions.length - 1].sessionId
          value.sessions = recordedSessions.map((entry) => ({ sessionId: entry.sessionId, role: entry.role, at: entry.at ?? '' }))
        }
        value.summary = summarize(action, value)
        return value
      }

      /**
       * Hand the work to a session of its own, inside the task space.
       *
       * This is the one step of the workflow a session could not do for itself: opening a
       * session is a press in the interface, and a session opened here is what carries the
       * work on when nobody is at the screen. It is also the only place this plugin decides
       * a session's permission, so it is decided the way delegation is decided everywhere
       * else - the caller's own explicit override, and nothing more, unless the call names
       * one itself (see {@link dispatchToSession}).
       */
      if (action === 'dispatch') {
        const task = required(args.task, 'task')
        const tasksRoot = await containerFor(ctx.subprocess, args.tasksRoot, args.sourceRoot, configuredRoot())
        const project = projectFor(args.project, args.sourceRoot)
        const prompt = required(args.prompt, 'prompt')
        const taskPath = taskSpacePath(tasksRoot, project, task)
        // The metadata is what makes a directory a task space. Without it this would open a
        // session in a directory the plugin never made, and nothing on the way would say so.
        const metadata = await readTaskMetadata(taskPath)
        if (metadata === undefined) throw coded('E2003', `no task space at ${taskPath}`)
        // The declared enum is what refuses a name outside these three, before this branch is
        // reached; what is left here is the default and what the call asked for.
        const requested = typeof args.permission === 'string' && args.permission.trim() !== '' ? args.permission.trim() : 'inherit'
        // Asked here, before the session is opened: a dispatch that refused after opening
        // one would leave a session in the task space with no work and nothing recording it.
        refuseUngrantedFullAccess(requested, configuredFullAccess())
        // Same default as a create: watch unless the call says not to.
        const watch = args.watchSession !== false
        const value = envelope(action)
        value.task = task
        value.project = project
        value.container = taskPath
        value.tasksRoot = tasksRoot
        const opened = await dispatchToSession(ctx, exec, {
          taskPath,
          task,
          tasksRoot,
          // The branch the task is already on, read off its own record - a dispatch
          // must name it in the standing section, and the record is where it is.
          branch: typeof metadata.branch === 'string' ? metadata.branch : '',
          sourceRoot: typeof args.sourceRoot === 'string' ? args.sourceRoot : '',
          prompt,
          requested,
          watch,
        }, sessionWatch)
        value.sessionId = opened.sessionId
        if (opened.reason !== '') value.warnings.push(opened.reason)
        // §4.3, the same recording a create does: a dispatch knows the session id it
        // just opened, and writing it into the task's record is what saves the
        // caller from searching for it by directory later.
        if (opened.sessionId !== '') {
          if (!(await recordTaskSession(taskPath, metadata, opened.sessionId, 'task'))) {
            value.warnings.push(`the session id (${opened.sessionId}) could not be written into the task's record at `
              + `${taskPath}; find it again with wts_session_tool_find, by the task space directory`)
          }
          // The other end of the dispatch, in the same record (see the create's own note above).
          await recordDispatchLeader(taskPath, opened.sessionId, exec, value.warnings)
        }
        value.summary = summarize(action, value)
        return value
      }

      throw coded('E7005', `unknown action: ${action}`)
    },
    // Both presenters are pure: the same arguments and the same result give the
    // same view on the live path and on a session-log replay. Neither reads a
    // session, the clock, the environment or anything else outside its inputs.
    presentCall: (args) => ({
      card: 'generic',
      title: `wts_worktree_space: ${args.action}`,
      kind: 'other',
      // The task name is the one input a reader wants while the call runs; the
      // whole args object (paths, flags, an archive directory) is not.
      rawInput: typeof args?.task === 'string' && args.task !== '' ? args.task : undefined,
    }),
    presentResult: (args, result) => ({
      card: 'generic',
      title: `wts_worktree_space: ${args?.action ?? 'call'}`,
      content: [{ type: 'text', text: cardText(result) }],
    }),
  }))
}

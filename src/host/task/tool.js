/**
 * The model-facing tool.
 *
 * The Web UI is still the upstream single-repository surface, so this tool is
 * what makes the multi-repository workflow usable end to end in the meantime:
 * it drives exactly the same operations the `/api` endpoints do.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { projectNameFor } from './naming.js'
import { addTaskRepositories, createTask, finishTask, listTasks, suggestTaskRoot } from './operations.js'
import { canonicalPath } from './paths.js'
import { coded } from './codes.js'
import { deliveryPolicyOf } from './delivery.js'
import { readTaskMetadata, taskSpacePath } from './shared.js'

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
  'A create does both halves by default: it makes the directory and the worktrees, and registers the result as a DSH Workspace, which is what puts the task space in the workspace list. Given a prompt as well, it also opens a session in the new task space and hands it that job in the same call - one step, which is what the panel\'s "Create and open" does in one press, except that the session there starts empty and this one is already working. Pass registerWorkspace false only when the user asked for a task space that stays out of that list - it is then on disk, nothing in the interface shows it, and opening a session in it means registering it from the panel. A create that answers with a warning instead says its Workspace was not registered, and names what to do about it.',
  'Every repository shares one branch, `task/<task>` unless the user asks for another prefix and it is passed as branchPrefix.',
  'A create may name a deploy script to copy in as the fixed `deploy/deploy.sh`: pass deployScript, a file path relative to the source root, and it replaces whatever the source root\'s own deploy root carried, so a manifest that names `./deploy.sh` keeps working while the script behind it changes per task.',
  'When a task that already exists turns out to need another repository, add it with action "add" rather than creating a second task: name the container (tasksRoot or sourceRoot), the project and the task, and pass each repository as an absolute path. A repository added this way may sit anywhere on disk, on another volume included — nothing later depends on where it is — but it joins the branch the task is already on and starts from its own HEAD unless baseRef says otherwise. Nothing is removed from a task this way.',
  'Pass merge only when the user asked to merge - unless the task\'s own record already answers: merge.mode "auto" is that record saying the task merges back by itself, and then done merges without the argument, while merge.mode "never" refuses the ask (E4013) and leaves the merge to the user\'s own hand in the panel. The rest of the delivery gate stands either way: a policy that expects a deployment still needs that deployment and a passing smoke, because those are checks on the work rather than answers from a person. The branch is kept unless something explicitly says to delete it: deleteBranch true on this call, or that same standing answer in the task\'s record.',
  'Dispatch to a session of its own when the work should carry on without you: action "dispatch" opens a session inside the task space - so it reads under that task in the workspace list, and can be followed there - and hands it one self-contained prompt. It is opened with the permission this session carries as its own sandbox override and nothing more, so it can never be wider than this one; pass permission danger-full-access only when the user asked for it, because that is the whole machine.',
  'This tool cannot do `force`, and asking for it is an error rather than a warning: discarding uncommitted work, and force-deleting a branch whose commits landed nowhere, are irreversible and have to be the user\'s own decision. Abandoning a task needs force too, so it is not available here either. When a task really has to be abandoned that way, say so and ask them to open the Worktree Space management page and finish it there, rather than retrying.',
  'Finishing commits nothing itself: a worktree still holding uncommitted work stops the finish and is named, and the commit is the caller\'s to make - an agent session opened in the task space writes a better message than a fixed one. force discards that work as the worktree goes.',
  'A finish that really removes the task space unregisters it too, which is what leaves the workspace list without an entry pointing at a directory that is gone; its sessions then fall back to Ungrouped. Pass unregisterWorkspace false only when the user asked to keep that task\'s group: the entry stays, those sessions stay under it, and the list has a Workspace whose directory is gone. An entry that was already gone - the user deleted it, or it was never registered - is not an error.',
  'A repository answered with `mergeInProgress` holds an unresolved merge at `mergeSite`: resolve the files listed in `conflictedFiles` in that checkout, commit the merge there, then call done again with the same merge request to finish. Never resolve a conflict by picking a side the user has not picked.',
  'A merge lands on the branch each source repository has checked out unless another is named; a branch that is checked out nowhere is merged in a worktree of its own, so no source checkout is ever switched.',
  'The task\'s delivery policy - whether a merge waits for a passing deployment smoke, and for a human acceptance ack - is the user\'s to set, and a create can state it: `delivery` on the create call wins over the project\'s stored default for that one task, and either way the policy is recorded in the task metadata at create time. State it when the user has said how this task should be delivered, and say which fields you set; do not quietly lower the bar for your own task. done enforces the policy: a refused merge names what is missing, and the way past it is to deploy, smoke, and be accepted - not to retry.',
  'The task\'s note names the conflict mode too: a task whose policy is conflicts=agent-auto expects the caller to resolve a returned conflict itself - ask no one, fix the files listed in conflictedFiles in that checkout, commit the merge there, and call done again. Under any other mode a returned conflict is reported and waits for the user.',
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
    mergeInProgress: false,
    mergeSite: '',
    conflictedFiles: [],
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
          mergeInProgress: { type: 'boolean', required: true },
          mergeSite: { type: 'string', required: true },
          conflictedFiles: { type: 'array', required: true, items: { type: 'string' } },
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
  const explicit = typeof tasksRoot === 'string' ? tasksRoot.trim() : ''
  if (explicit !== '') return explicit
  const source = typeof sourceRoot === 'string' ? sourceRoot.trim() : ''
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
 * @param request - the task space, the work, and the permission the call named.
 * @returns the session id (empty when none was opened) and what the caller should be told.
 */
async function dispatchToSession(ctx, exec, request) {
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
    await controller.prompt({ sessionId, content: [{ type: 'text', text: request.prompt }] })
  } catch (error) {
    return {
      sessionId,
      reason: `the session was opened but the work could not be handed to it (${String(error?.message ?? error)}); `
        + 'open it and say what to do',
    }
  }
  return { sessionId, reason }
}

/**
 * Refuse the one request a call cannot answer for itself.
 *
 * `force` is the whole of the irreversible surface here, and it is irreversible
 * twice over: it discards uncommitted work, and it swaps `git branch -d` for
 * `branch -D` (`archive.js`), which deletes a branch whose commits landed
 * nowhere. A model can be talked into either by anything it reads, so it is not
 * gated on a flag the model also holds - it is not expressible here at all, and
 * the way out is the management page, where the user ticks it.
 *
 * Everything else this tool can do to finish a task is recoverable or is git's
 * own decision. Merging lands the work; `deleteBranch` after a merge is
 * `git branch -d`, which refuses an unmerged branch on its own. `cleanStray`
 * reaches only the entries sitting directly in a task space that carries this
 * plugin's record and at least one linked worktree, and the user's own
 * documents are never among them: filing them away is `documentsDirectory` and
 * throwing them out is `discardDocuments`, and this tool passes neither.
 * Abandoning a task needs `deleteBranch` without a merge, which `archive.js`
 * already refuses without `force` - so refusing `force` closes that door too.
 * @param args - the tool's arguments.
 * @throws Error carrying E7007 when the call asks for `force`.
 */
function refuseIrreversible(args) {
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
    return `${value.repositories.length} task${value.repositories.length === 1 ? '' : 's'} under ${value.tasksRoot} (${perTask} worktree${perTask === 1 ? '' : 's'}).`
  }
  if (action === 'dispatch') {
    const opened = value.sessionId === ''
      ? `No session was opened in task '${value.task}' at ${value.container}.`
      : `Session '${value.sessionId}' is on the work in task '${value.task}' at ${value.container}; open it from the Worktree Space panel, or from the workspace list.`
    return `${opened}${value.warnings.length === 0 ? '' : ` Warnings: ${value.warnings.join('; ')}.`}`
  }
  const failed = value.failed ? ' Some repositories need attention:' : ''
  const attention = value.repositories.filter((row) => row.error !== '').map((row) => `${row.name}: ${row.error}`).join('; ')
  // A handed-on conflict is not a failure to report and move past: it is the step
  // that is left, so the summary says where it is rather than calling the task done.
  const handedOn = value.repositories.filter((row) => row.mergeInProgress)
  const headline = handedOn.length === 0
    ? `Task '${value.task}' finished. Task space ${value.container === '' ? 'removed' : `kept at ${value.container}`}.`
    : `Task '${value.task}' is unfinished: a merge is waiting to be resolved in ${handedOn.map((row) => row.mergeSite).join(', ')}.`
  const handoff = handedOn.length === 0
    ? ''
    : ` Resolve ${handedOn.map((row) => row.conflictedFiles.join(', ')).filter((list) => list !== '').join('; ') || 'the conflict'}, commit the merge there, then call done again.`
  return `${headline}${failed}${attention}${handoff}${value.warnings.length === 0 ? '' : ` Warnings: ${value.warnings.join('; ')}.`}`
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
 * Register the `task_worktree_space` tool when the deployment serves tools.
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
  // The same rule for the per-project delivery defaults: the policy a create
  // records is the user's standing answer for that project, and a create the
  // model makes has to land on the same answer a dialog-made create would.
  const configuredDeliveryDefaults = () => typeof options.configuredDeliveryDefaults === 'function' ? options.configuredDeliveryDefaults() : {}
  // Where the strays policy files content away, when a done leaves the handling
  // to the policy: the same archive preference the finish dialog reads.
  const configuredArchive = () => typeof options.configuredArchive === 'function' ? options.configuredArchive() : undefined

  return tools.register(defineTool({
    name: 'task_worktree_space',
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
      deployScript: { type: 'string', description: 'Deploy script (create): a file path relative to the source root, copied into the task space as deploy/deploy.sh. The name is fixed so the manifest\'s ./deploy.sh keeps working while the script behind it differs per task. Omit to copy only what the source root already carries there.' },
      delivery: {
        type: 'string',
        description: 'The delivery policy for this one task (create), as a JSON object: an explicit policy wins over the project\'s stored default - which is what a create without it follows - and the built-in default is the last word after that. State it when the user has said how this task should be delivered, and say which fields you set and why; do not quietly lower the bar for your own task. Fields: deploy.target (docker | host | none), deploy.mode (auto | on-request), verification (agent | agent-then-human | human), merge.mode (auto | ask | never), merge.target (a branch name, or omit for each source repository\'s checked-out branch), merge.deleteBranch, conflicts (agent-auto | ask | stop), strays (archive | keep). merge.mode "auto" merges by itself at the finish and cannot be combined with a verification that waits for a person: that pair is refused when the task is created. Example: {"merge":{"mode":"auto","deleteBranch":false},"verification":"agent"}',
      },
      registerWorkspace: { type: 'boolean', description: 'Register what this create made as a DSH Workspace (create). Omitted it registers, which is what the panel does; pass false only when the user asked for a task space that stays out of the workspace list.' },
      merge: { type: 'boolean', description: 'Merge before removing the worktrees (done). Only on request - or without the argument when the task records merge.mode "auto", which is the user\'s standing answer that it merges by itself.' },
      prompt: { type: 'string', description: 'The complete, self-contained job for a session (create, dispatch). Given on create, the session is opened in the new task space and handed this in the same call; given on dispatch, it is handed to a session in a task space that already exists. A session does not share this conversation\'s context, so include everything it needs.' },
      permission: { type: 'string', enum: ['inherit', 'workspace-write', 'danger-full-access'], description: 'What the session opened by this call may write (create, dispatch). inherit, the default, copies this session\'s own explicit sandbox override and nothing more, so the new session is never wider than this one. Ask the user before naming danger-full-access: that is the whole machine.' },
      target: { type: 'string', description: 'Branch to merge into (done), for every repository. Omit for the branch each source repository has checked out.' },
      deleteBranch: { type: 'boolean', description: 'Delete each branch (done), after a merge. Needs merge; deleting a branch that never landed is refused here. Omit it and the branch is kept, unless the task\'s own record asks for the deletion.' },
      cleanStray: { type: 'boolean', description: 'Remove leftovers in the task space (done), except keep. Never reaches the user\'s own documents here.' },
      keep: { type: 'array', items: { type: 'string' }, description: 'Entries to keep with cleanStray (done).' },
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
        const sourceRoot = required(args.sourceRoot, 'sourceRoot')
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
        const sourceRoot = required(args.sourceRoot, 'sourceRoot')
        // The policy this call states, if any. It arrives as JSON because the parameter dialect
        // is flat - no object parameters - and it is parsed here rather than passed on as text
        // so that a typo is refused with the same E4010 family the policy itself uses, before
        // anything is made. Carried rather than decided: the delivery bar is the user's to set,
        // so the call repeats what they said and names the fields it set.
        let statedPolicy
        if (typeof args.delivery === 'string' && args.delivery.trim() !== '') {
          try {
            statedPolicy = JSON.parse(args.delivery)
          } catch (error) {
            throw coded('E4010', `delivery is not valid JSON: ${error.message}`)
          }
          if (statedPolicy === null || typeof statedPolicy !== 'object' || Array.isArray(statedPolicy)) {
            throw coded('E4010', 'delivery must be a JSON object, e.g. {"merge":{"mode":"auto"},"verification":"agent"}')
          }
        }
        const result = await createTask(ctx.subprocess, {
          sourceRoot,
          task: required(args.task, 'task'),
          tasksRoot: args.tasksRoot,
          repos: Array.isArray(args.repos) ? args.repos : undefined,
          baseRef: typeof args.baseRef === 'string' ? args.baseRef : undefined,
          branchPrefix: typeof args.branchPrefix === 'string' ? args.branchPrefix : undefined,
          deployScript: typeof args.deployScript === 'string' ? args.deployScript : undefined,
          configuredRoot: configuredRoot(),
          // Stated by this call, or nothing: create.js then resolves it against the project's
          // stored defaults once, before anything is made. A create that states nothing lands on
          // the same project defaults a panel-made create would.
          delivery: statedPolicy,
          deliveryDefaults: configuredDeliveryDefaults(),
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
          // The Workspace was registered a moment ago by this same branch, so its record is
          // read once more and handed over rather than registered again.
          const record = unregistered === '' && registry !== undefined && typeof registry.resolveByPath === 'function'
            ? await registry.resolveByPath(result.path)
            : undefined
          const opened = await dispatchToSession(ctx, exec, {
            taskPath: result.path,
            task: result.task,
            sourceRoot,
            prompt: args.prompt,
            requested,
            ...(record === undefined || record === null || typeof record.id !== 'string' || record.id === ''
              ? {}
              : { place: { workspaceId: record.id } }),
          })
          value.sessionId = opened.sessionId
          if (opened.reason !== '') value.warnings.push(opened.reason)
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
          // directory to resolve a name against.
          repositories: Array.isArray(args.repos) ? args.repos : [],
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
        const tasksRoot = await containerFor(ctx.subprocess, args.tasksRoot, args.sourceRoot, configuredRoot())
        const project = projectFor(args.project, args.sourceRoot)
        // A task whose own record says the merge is not this flow's to make: the ask is
        // refused here, naming the way past, rather than passed down to be dropped in
        // silence. The panel's own press is the user's, and that one is not this tool's.
        if (args.merge === true) {
          const recorded = await readTaskMetadata(taskSpacePath(tasksRoot, project, task))
          if (deliveryPolicyOf(recorded).merge.mode === 'never') {
            throw coded(
              'E4013',
              `task '${task}' records merge.mode 'never', so this flow does not merge it. `
                + 'Finish it from the Worktree Space panel if the user wants it merged anyway.',
            )
          }
        }
        const result = await finishTask(ctx.subprocess, {
          task,
          project,
          tasksRoot,
          // Absent, not false, when the call did not say: the task's own record answers
          // "merge by itself" with `merge.mode: auto`, and an explicit `false` has to stay a
          // no rather than be read as one.
          merge: typeof args.merge === 'boolean' ? args.merge : undefined,
          target: typeof args.target === 'string' ? args.target : undefined,
          deleteBranch: typeof args.deleteBranch === 'boolean' ? args.deleteBranch : undefined,
          force: args.force === true,
          cleanStray: args.cleanStray === true,
          keep: Array.isArray(args.keep) ? args.keep : [],
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
          mergeInProgress: entry.mergeInProgress === true,
          mergeSite: entry.mergeSite ?? '',
          conflictedFiles: Array.isArray(entry.conflictedFiles) ? entry.conflictedFiles : [],
          error: entry.error ?? '',
        }))
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
        const value = envelope(action)
        value.task = task
        value.project = project
        value.container = taskPath
        value.tasksRoot = tasksRoot
        const opened = await dispatchToSession(ctx, exec, {
          taskPath,
          task,
          sourceRoot: typeof args.sourceRoot === 'string' ? args.sourceRoot : '',
          prompt,
          requested,
        })
        value.sessionId = opened.sessionId
        if (opened.reason !== '') value.warnings.push(opened.reason)
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
      title: `task_worktree_space: ${args.action}`,
      kind: 'other',
      // The task name is the one input a reader wants while the call runs; the
      // whole args object (paths, flags, an archive directory) is not.
      rawInput: typeof args?.task === 'string' && args.task !== '' ? args.task : undefined,
    }),
    presentResult: (args, result) => ({
      card: 'generic',
      title: `task_worktree_space: ${args?.action ?? 'call'}`,
      content: [{ type: 'text', text: cardText(result) }],
    }),
  }))
}

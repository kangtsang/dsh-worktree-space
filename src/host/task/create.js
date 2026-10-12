/**
 * Task creation
 *
 * Creating a task: the container, the branch, one worktree per repository, and the file that tells a session what the task is.
 */
import { existsSync, statSync } from 'node:fs'
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { auditEnter, recordError, recordEvent } from './audit-log.js'
import { ERROR_CODES, coded, warned } from './codes.js'
import { prepareContainerRoot } from './container.js'
import { resolveDeliveryPolicy } from './delivery.js'
import { discoverSourceRepos, resolveSourceRepos } from './discover.js'
import { E2E_NAMES_SHOWN, inspectE2eConfigs } from './e2e.js'
import { gitSucceeded, runGit, tryRunGit } from './git.js'
import { findLinks, symlinksRefused } from './links.js'
import { branchNameFor, DEFAULT_BRANCH_PREFIX, projectNameFor, validateBranchPrefix, validateTaskName } from './naming.js'
import { assertIsolated, isInside, refuseDelete } from './paths.js'

import { DEPLOY_DIR, DEPLOY_ROOT, TASK_OWNED_ENTRIES, readTaskMetadata, resolveTasksRoot, sourceDeployRootPath, taskDeployRootPath, taskMetadata, taskSpacePath, writeTaskMetadata } from './shared.js'

/** How many links a create-time warning names before it says how many more there are. */
const LINK_NAMES_SHOWN = 3

/**
 * The state script a scaffolded deploy root carries.
 *
 * Why it exists: a task space with no `deploy/` has no state file and nothing
 * that could write one, so `done` refuses its merge (E5006) over a handshake no
 * session there can carry out. Shipping the handshake in executable form is the
 * difference between a refusal that names the file and a space that can produce
 * it. It is deliberately self-contained - `sh`, `awk`, `sed` and `date`, no
 * `jq`, because there is none - and it merges rather than rewrites, because
 * `destroyedAt` in the file is the plugin's own and a deploy that dropped it
 * would forget that the environment is down.
 *
 * Exported so the step that proves the script really runs can execute the very
 * bytes a create writes, rather than a copy of them that may have drifted.
 */
export const WRITE_STATE_SCRIPT = String.raw`#!/bin/sh
# Merge one deployment fact into this deploy root's .state.json.
#
# Why a script: that file is the handshake with the Worktree Space plugin, and
# every writer of it has to keep the fields it does not own. destroyedAt is
# written by the plugin when the environment is destroyed; a deploy that rewrote
# the file from scratch would forget that it is down. So this merges: it reads
# whatever is there, replaces only the one top-level field it was asked for, and
# writes the whole object back as one line - the shape every reader of it expects.
#
# There is no jq on this machine, so the merge is done with awk, which is.
#
#   ./write-state.sh url <url>          after up, the acceptance URL
#   ./write-state.sh smoke pass|fail    after smoke, stamped with the UTC now
#   ./write-state.sh services <json>    optional service list, as raw JSON
#
# The file it writes is the one the plugin names in DEPLOY_STATE_FILE, so a script
# in a subdirectory writes the same file as one at the top: nothing here has to know
# where the deploy root is. Without that variable it falls back to the file beside
# this script, which is where a deploy root at the top puts it.
#
# It never writes destroyedAt: that is the plugin's own.
set -eu

state="${'${'}DEPLOY_STATE_FILE:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/.state.json}"

usage() {
  echo "usage: write-state.sh url <url> | smoke pass|fail | services <json>" >&2
  exit 2
}

# A value is data, not JSON: quote and escape it so it can sit in the object.
json_string() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/^/"/' -e 's/$/"/'
}

# Rewrite the object with top-level key replaced, or added when it was absent.
# value is raw JSON. It travels by environment rather than awk -v, because -v
# would eat the backslashes inside it.
merge() {
  key="$1"
  value="$2"
  [ -f "$state" ] || printf '{}\n' > "$state"
  # A file that is not an object cannot be merged into. Refusing leaves the
  # bytes alone, which is the one outcome that cannot lose somebody's ack.
  if [ "$(sed -e 's/^[[:space:]]*//' "$state" | cut -c1)" != "{" ]; then
    echo "write-state.sh: $state is not a JSON object; left untouched" >&2
    exit 1
  fi
  tmp="$state.$$.tmp"
  VALUE="$value" awk -v want="$key" '
    { text = text $0 }
    END {
      n = length(text)
      i = index(text, "{") + 1
      out = ""
      found = 0
      while (i <= n) {
        while (i <= n) {
          c = substr(text, i, 1)
          if (c == "," || c == " " || c == "\t" || c == "\r") i++; else break
        }
        if (i > n) break
        if (substr(text, i, 1) != "\"") break
        ks = i
        i++
        while (i <= n) {
          c = substr(text, i, 1)
          if (c == "\\") { i += 2; continue }
          if (c == "\"") { i++; break }
          i++
        }
        kraw = substr(text, ks, i - ks)
        while (i <= n && substr(text, i, 1) ~ /[ \t\r\n]/) i++
        if (substr(text, i, 1) != ":") break
        i++
        while (i <= n && substr(text, i, 1) ~ /[ \t\r\n]/) i++
        vs = i
        c = substr(text, i, 1)
        if (c == "\"") {
          i++
          while (i <= n) {
            c = substr(text, i, 1)
            if (c == "\\") { i += 2; continue }
            if (c == "\"") { i++; break }
            i++
          }
        } else if (c == "{" || c == "[") {
          opener = c
          closer = (c == "{") ? "}" : "]"
          d = 0
          instr = 0
          while (i <= n) {
            c = substr(text, i, 1)
            if (instr) {
              if (c == "\\") { i += 2; continue }
              if (c == "\"") instr = 0
              i++
              continue
            }
            if (c == "\"") { instr = 1; i++; continue }
            if (c == opener) d++
            else if (c == closer) { d--; if (d == 0) { i++; break } }
            i++
          }
        } else {
          while (i <= n) {
            c = substr(text, i, 1)
            if (c == "," || c == "}") break
            i++
          }
        }
        vraw = substr(text, vs, i - vs)
        sub(/[ \t\r\n]+$/, "", vraw)
        if (substr(kraw, 2, length(kraw) - 2) == want) { vraw = ENVIRON["VALUE"]; found = 1 }
        if (out != "") out = out ","
        out = out kraw ":" vraw
      }
      if (!found) {
        if (out != "") out = out ","
        out = out "\"" want "\":" ENVIRON["VALUE"]
      }
      printf "{%s}\n", out
    }
  ' "$state" > "$tmp" || { rm -f "$tmp"; exit 1; }
  mv "$tmp" "$state"
}

[ "$#" -ge 1 ] || usage

case "$1" in
  url)
    [ "$#" -ge 2 ] || usage
    merge url "$(json_string "$2")"
    ;;
  smoke)
    [ "$#" -ge 2 ] || usage
    case "$2" in
      pass|fail) ;;
      *) usage ;;
    esac
    merge lastSmoke "{\"result\":\"$2\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
    ;;
  services)
    [ "$#" -ge 2 ] || usage
    merge services "$2"
    ;;
  *)
    usage
    ;;
esac
`

/**
 * The shape of the state file, one line of valid JSON.
 *
 * JSON has no comments, so this carries the shape and nothing else; why each
 * field exists is in {@link WRITE_STATE_SCRIPT} beside it.
 */
export const STATE_EXAMPLE = '{"url":"http://localhost:5173","services":["web","api"],"lastSmoke":{"result":"pass","at":"2026-01-01T00:00:00Z"}}\n'

/**
 * The facts only the source repository can answer, read before a worktree is
 * cut from it: the branch its HEAD is on, and the exact commit the new branch
 * will start from. Recorded so the task can still be described when the source
 * checkout is somewhere else, or gone.
 *
 * Exported because adding a repository to an existing task cuts its worktree the
 * same way a create does, and has to record the same two facts about it.
 * @param subprocess - the profile's subprocess service.
 * @param repoPath - the source repository.
 * @returns the branch name and the starting commit, either possibly absent.
 */
export async function sourceFacts(subprocess, repoPath) {
  const [branch, commit] = await Promise.all([
    tryRunGit(subprocess, repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    tryRunGit(subprocess, repoPath, ['rev-parse', 'HEAD']),
  ])
  return {
    // A detached HEAD prints `HEAD`, which is no branch to name.
    ...(branch === '' || branch === 'HEAD' ? {} : { sourceBranch: branch }),
    ...(commit === '' ? {} : { startCommit: commit }),
  }
}

/**
 * Whether a container holds nothing but what this plugin put there.
 * @param leftovers - the container's entries.
 * @param created - the worktrees this call created.
 * @param owned - the top-level entry names this call may remove. That is the
 *   plugin's own directory (plus the legacy note), one entry whatever it holds:
 *   the record, the note and the deploy copy - scaffolded or copied from the
 *   source root - all live inside it. The source root's own `deploy/` is not
 *   touched by any of this; what sits in the task space is this call's copy.
 * @returns whether a failed create may remove the container.
 */
function holdsOnlyOurs(leftovers, created, owned) {
  return leftovers.every((name) => owned.includes(name) || created.some((entry) => basename(entry.path) === name))
}

async function rollbackTask(subprocess, tasksRoot, taskPath, branch, created) {
  const owned = TASK_OWNED_ENTRIES
  const stranded = []
  for (const entry of created) {
    // The worktree was created by this call and never handed to a caller, so a
    // forced removal is safe and is the only reliable way to clean a
    // half-registered worktree - but only while it is still the directory this
    // call put there, so it is asked first.
    const refused = refuseDelete(tasksRoot, entry.path, `the worktree '${entry.name}'`)
    if (refused !== '') { stranded.push(entry.name); continue }
    if (!(await gitSucceeded(subprocess, entry.repoPath, ['worktree', 'remove', '--force', entry.path]))) {
      stranded.push(entry.name)
      continue
    }
    // Removing the worktree is half of what has to go back: the branch was made
    // by `worktree add -b`, and git does not delete it with the checkout that
    // held it. Left behind it takes the name, and the same task cannot be
    // created again - which is the opposite of what the record below then says.
    //
    // Deleting it is safe because it cannot be anybody else's: this create
    // refused every repository that already had this branch before it made
    // anything, and the worktree that was holding it is gone. `-D` because it
    // has no commits and can have none now, and `--` for the reason archive.js
    // gives - this is the one call here that leaves the container.
    if (!(await gitSucceeded(subprocess, entry.repoPath, ['branch', '-D', '--', branch]))) {
      stranded.push(`${entry.name}'s branch ${branch}`)
    }
  }
  if (stranded.length > 0) return stranded

  // The container is the last thing standing, and "no task space was left behind"
  // is a claim about it, so the claim is made only when it is demonstrably gone.
  // Four ways that fails, and only the first is a clean no-op: a readdir failing
  // because the directory is already absent PROVES it is gone, while one failing
  // for any other reason proves nothing and has to be reported; a container holding
  // something this call did not put there is left alone on purpose, which still
  // takes the name; and a removal that throws leaves it.
  const container = `the task space ${basename(taskPath)}`
  let leftovers
  try {
    leftovers = await readdir(taskPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') stranded.push(container)
    return stranded
  }
  if (!holdsOnlyOurs(leftovers, created, owned)) {
    stranded.push(container)
    return stranded
  }
  try {
    await rm(taskPath, { recursive: true, force: true })
  } catch {
    stranded.push(container)
  }
  return stranded
}


/**
 * Resolve the one script a create may name, relative to the source root.
 *
 * The value is judged where the other request-shape guards are, before anything is
 * made: a path that escapes the source root, or names nothing, has to refuse the
 * request rather than surface once a task space exists to clean up.
 *
 * The path is confined to the workspace's own `.worktree-space/deploy/` directory. That is
 * where the deploy contract lives, so a script named from anywhere else would be a second,
 * invisible contract - and that directory is what gets copied, so a script from outside it
 * would arrive without the siblings it names.
 *
 * What comes back is the WORKSPACE-RELATIVE path, and that is what the record keeps: the
 * deploy root is copied into the task space at the same relative place, so the caller's
 * spelling is the one to remember - and the one that resolves on either side - rather than
 * a fixed file name that overwrote something.
 * @param sourceRoot - the directory the path is relative to.
 * @param requested - the caller's value; empty means no script was named.
 * @returns the workspace-relative path, or '' when none was named.
 * @throws when the value is not a file under the workspace's `.worktree-space/deploy/`.
 */
function resolveDeployScript(sourceRoot, requested) {
  const value = String(requested ?? '').trim()
  if (value === '') return ''
  if (isAbsolute(value)) {
    throw coded('E4014', `the deploy script must be a path relative to the source root, not an absolute one: ${value}`)
  }
  const resolved = resolve(sourceRoot, value)
  if (!isInside(sourceRoot, resolved)) {
    throw coded('E4014', `the deploy script must name a file inside the source root, not one outside it: ${value}`)
  }
  // Confined to the deploy root: the one directory that travels into the task space, and
  // the one place a deploy contract can live. Compared canonically, so
  // `./.worktree-space/deploy/x.sh` and `.worktree-space/deploy/x.sh` are the same answer and
  // a `..` that walks back out is caught here.
  const deployRoot = sourceDeployRootPath(sourceRoot)
  if (!isInside(deployRoot, resolved)) {
    throw coded('E4014', `the deploy script must live under the workspace's \`${DEPLOY_DIR}/\` directory: ${value}`)
  }
  // A directory carrying that name is not a script either, and copying it would fail once
  // the worktrees were already cut.
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw coded('E4014', `the deploy script must name a file that exists inside the source root: ${value}`)
  }
  // Normalised to forward slashes so the record reads the same on every platform. It stays
  // relative to the workspace, and because the deploy root sits at the same relative place
  // inside the task space, this one string is the script's path on either side.
  return value.replace(/^\.\//, '').replace(/\\/g, '/')
}

export async function createTask(subprocess, options) {
  const {
    sourceRoot,
    task,
    tasksRoot: requestedRoot,
    repos,
    baseRef,
    branchPrefix = DEFAULT_BRANCH_PREFIX,
    // A file path relative to the workspace, naming the entry under its
    // `.worktree-space/deploy/` directory. It travels into the task space under its own
    // name and the record remembers it as this task's entry. Empty means the entry is
    // `.worktree-space/deploy/deploy.sh`, which is what the create would produce anyway.
    deployScript = '',
    configuredRoot = '',
    // How far to look for the repositories a task covers. The same bounds the
    // classification and the suggestion used, so the count on the Workspace card,
    // the list in the create dialog, and what this actually takes are one number
    // rather than three that happen to disagree.
    scanBounds = {},
    // The delivery policy as this request stated it. One field now: whether this
    // task expects a deployment. Resolved below, once, before anything is made.
    delivery,
  } = options

  const name = validateTaskName(task)
  // Resolved before anything is touched: an unusable prefix must fail as a
  // request, not halfway through a worktree.
  const prefix = validateBranchPrefix(branchPrefix)
  const tasksRoot = resolveTasksRoot(sourceRoot, requestedRoot, configuredRoot)
  assertIsolated(sourceRoot, tasksRoot)
  // The layer this source root's task spaces live under, so one container holding
  // several projects never mixes their tasks. Derived from the source root rather
  // than asked for: the dialog never has to name it, and the layout cannot drift
  // from the directory the user sees on disk.
  const project = projectNameFor(sourceRoot)
  // The delivery policy is resolved once, before anything is created: an invalid
  // one must fail the request, not surface halfway through a rollback.
  const policy = resolveDeliveryPolicy(delivery)

  // An absent list means "every discovered repository"; an explicitly empty one
  // is a caller that selected nothing, which must not silently become all.
  if (Array.isArray(repos) && repos.length === 0) {
    throw coded('E4001', 'select at least one repository for the task')
  }
  const selected = Array.isArray(repos)
    ? await resolveSourceRepos(sourceRoot, repos)
    : await discoverSourceRepos(sourceRoot, scanBounds)
  if (selected.length === 0) {
    throw coded(
      'E6001',
      `no source repositories found under ${sourceRoot}: expected a repository, or .git directories within ${scanBounds.maxDepth ?? 1} level(s) below it`,
    )
  }

  const names = selected.map((repoPath) => basename(repoPath))
  const duplicate = names.find((entry, index) => names.indexOf(entry) !== index)
  if (duplicate !== undefined) {
    throw coded('E4002', `two selected repositories are both named '${duplicate}'; select repositories with distinct names`)
  }
  // Resolved with the other guards rather than at the copy: a deploy script that cannot
  // be used is a request that does not add up, and it must fail before the worktrees exist.
  const deployScriptPath = resolveDeployScript(sourceRoot, deployScript)

  // A task that says it deploys has to have something to deploy with, and this is checked
  // before anything is made rather than discovered at the finish gate. Ticking the box and
  // getting a task space whose card can only ever answer "nothing to deploy" is the silent
  // failure this refuses: the request promised a deployment, and there is no script to run.
  //
  // The three sources are the same three, in the same order, that the deploy side looks in -
  // so this accepts exactly what a deploy would later find, and refuses exactly what it would
  // not. Any one of them is enough:
  //
  //   1. a script the caller named, which E4014 above has already proven exists and is a file;
  //   2. the workspace's own `.worktree-space/deploy/deploy.sh`, which travels over whole;
  //   3. a repository carrying its own `deploy/deploy.sh` (the single-repository shape).
  //
  // The check is for the ENTRY FILE, not for a `deploy/` directory. A directory holding only
  // other scripts would pass a directory test and still leave nothing to run, which is the
  // very outcome this guard exists to prevent.
  if (policy.deploy.target !== 'none') {
    // A named script needs no re-check here: `resolveDeployScript` above already refused the
    // request (E4014) unless it exists, is a file, and sits under the workspace's
    // `.worktree-space/deploy/`. Re-testing it would be a second, weaker copy of a check
    // that has already passed.
    const named = deployScriptPath !== ''
    const sourceEntry = existsSync(join(sourceDeployRootPath(sourceRoot), 'deploy.sh'))
    const repoEntry = selected.some((repoPath) => existsSync(join(repoPath, DEPLOY_ROOT, 'deploy.sh')))
    if (!named && !sourceEntry && !repoEntry) {
      throw coded(
        'E4015',
        `the task is set to deploy (deployTarget docker), but nothing can deploy it: no deploy script was named, `
          + `${sourceRoot} carries no \`${DEPLOY_DIR}/deploy.sh\`, and none of the selected repositories carries its own. `
          + `Add that file, name an existing one under \`${DEPLOY_DIR}/\` with deployScript, or create the task with `
          + `deployTarget none and deploy it by hand.`,
        { sourceRoot },
      )
    }
  }

  const branch = branchNameFor(name, prefix)
  const taskPath = taskSpacePath(tasksRoot, project, name)
  // What every record this create writes carries, entered before the guards
  // below so that a refused create is still attributable to this task, project
  // and container root. Entered before the container root exists on purpose: the
  // probes below are worth having, and an append that finds no directory to write
  // in drops the line rather than creating one.
  auditEnter({ task: name, project, tasksRoot })
  // A task space that is already there is not a plain name clash: when its
  // breadcrumb names this task, this project and this branch, it is a create
  // whose Workspace registration failed and left the container behind. The code
  // lets the dialog tell the two apart and offer recovery instead of a dead end.
  if (existsSync(taskPath)) {
    const existing = await readTaskMetadata(taskPath).catch(() => undefined)
    const ours = existing !== undefined
      && existing.task === name
      && existing.project === project
      && existing.branch === branch
    const error = coded('E2001', `task space already exists: ${taskPath}`, { path: taskPath })
    // E2001 and E2002 are two situations behind one guard, and they are read
    // apart by the dialog: one is a name clash to report, the other is a recovery
    // it can offer. The code says which; the sentence says what it means and what
    // can be done about it, which the message alone cannot.
    if (ours) error.code = 'E2002'
    error.msg = ours
      ? `Nothing was created. A task space for exactly this task, project and branch is already on disk at ${taskPath}, which means an earlier create got as far as making it and stopped before its Workspace was registered. Creating again under this name will keep failing until that one is registered, finished or removed.`
      : `Nothing was created. The name is already taken by a different task space at ${taskPath}, so this create would have overwritten somebody else's work. Pick another task name, or finish the existing task first.`
    throw error
  }

  for (const repoPath of selected) {
    if (await gitSucceeded(subprocess, repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) {
      throw coded(
        'E3001',
        `branch '${branch}' already exists in '${basename(repoPath)}'; pick another task name`,
      ).withMsg(
        `Nothing was created. The branch ${branch} already exists in ${basename(repoPath)}, so a new worktree could not be named after it and cutting one would have pointed this task's work at work already in progress. Pick another task name, or start from a branch that is free.`,
      )
    }
  }
  if (baseRef !== undefined && `${baseRef}`.trim() !== '') {
    for (const repoPath of selected) {
      if (!(await gitSucceeded(subprocess, repoPath, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]))) {
        throw coded('E3002', `base '${baseRef}' not found in '${basename(repoPath)}'`)
      }
    }
  }

  await prepareContainerRoot(tasksRoot)
  // The project directory may already hold other tasks, so only the task's own
  // directory is asked for strictly: a second one with the same name is reported
  // rather than silently reused.
  await mkdir(join(tasksRoot, project), { recursive: true })
  await mkdir(taskPath)

  const created = []
  // What this create wants the caller to know without the create having failed.
  // Declared before the try below, so a create that rolls back still reports what
  // it found before it gave up rather than losing the finding with the worktrees.
  const warnings = []
  try {
    // The workspace's own deploy root travels with the task space, whole, into the plugin's
    // own directory on both sides: `<workspace>/.worktree-space/deploy/` is copied to
    // `<task space>/.worktree-space/deploy/`, which is the only place this plugin writes.
    // The scripts beside the entry run from that directory, so a script that names its
    // siblings is a deploy that never runs if only part of it travels. A workspace that
    // carries none is skipped: the space then deploys whatever its own repositories carry,
    // if anything.
    //
    // The same relative layout on both sides is what lets one path serve both: the record
    // keeps the workspace-relative entry, and it resolves unchanged in the task space. A
    // named deploy script needs nothing more - it lives under this directory (E4014 keeps it
    // there), so it is already in the copy, under its own name, and the record says which
    // entry to run.
    const sourceDeploy = sourceDeployRootPath(sourceRoot)
    if (existsSync(sourceDeploy)) {
      await cp(sourceDeploy, taskDeployRootPath(taskPath), { recursive: true, force: true })
    }

    // Nothing copied a deploy root and no script was named, so the space would
    // otherwise have neither a state file nor a way to write one - and `done`
    // then refuses its merge over a handshake no session there can carry out.
    // The scaffold is that handshake in executable form. It is written only when
    // the directory is still absent, so a create never overwrites a repository's
    // own deploy root.
    if (!existsSync(taskDeployRootPath(taskPath))) {
      await mkdir(taskDeployRootPath(taskPath), { recursive: true })
      await writeFile(join(taskDeployRootPath(taskPath), 'write-state.sh'), WRITE_STATE_SCRIPT, { mode: 0o755 })
      await writeFile(join(taskDeployRootPath(taskPath), '.state.json.example'), STATE_EXAMPLE)
    }

    for (const repoPath of selected) {
      const worktreePath = join(taskPath, basename(repoPath))
      // Read the source facts before the branch exists, so they describe the
      // checkout the worktree was cut from rather than the worktree itself.
      const facts = await sourceFacts(subprocess, repoPath)
      const args = baseRef === undefined || `${baseRef}`.trim() === ''
        ? ['worktree', 'add', worktreePath, '-b', branch]
        : ['worktree', 'add', worktreePath, '-b', branch, `${baseRef}`]
      await runGit(subprocess, repoPath, args)
      created.push({ name: basename(repoPath), path: worktreePath, repoPath, ...facts })
    }

    await writeTaskMetadata(taskPath, taskMetadata({
      task: name,
      project,
      tasksRoot,
      sourceRoot,
      branch,
      baseRef: baseRef === undefined || `${baseRef}`.trim() === '' ? undefined : `${baseRef}`,
      delivery: policy,
      // Which entry under `.worktree-space/deploy/` this task runs, when the create named
      // one. Absent means `.worktree-space/deploy/deploy.sh`, so a record made before this
      // field existed reads the same way it always did.
      deployScript: deployScriptPath === '' ? undefined : deployScriptPath,
      repositories: created.map((entry) => ({
        name: entry.name,
        sourcePath: entry.repoPath,
        branch,
        ...(entry.sourceBranch === undefined ? {} : { sourceBranch: entry.sourceBranch }),
        ...(entry.startCommit === undefined ? {} : { startCommit: entry.startCommit }),
      })),
    }))
  } catch (error) {
    const stranded = await rollbackTask(subprocess, tasksRoot, taskPath, branch, created)
    const suffix = stranded.length === 0 ? '' : ` (could not roll back: ${stranded.join(', ')})`
    // The code is decided once, here, and goes into the two places that must not
    // disagree: the record below and the error the caller reads. `recover` takes
    // the code off the error and no caller hands it a classifier, so an error
    // rebuilt without one reaches the caller as E9001 - which names nothing the
    // log does not, but names it a different way from the record written here.
    //
    // A failure that carries one of ours keeps it: which git call failed, and why,
    // is more use to a caller than the fact that a rollback ran, and the client
    // already tells E3004 from E3005. A code from outside the table is not kept -
    // a Node filesystem error brings a `code` of its own (`EISDIR`), and passing
    // that on would put a second vocabulary in the log and on the wire, which
    // `recover` would flatten to E9001 anyway. So those answer for what the
    // rollback managed, which is the only distinction left to make there.
    const own = typeof error?.code === 'string' && Object.hasOwn(ERROR_CODES, error.code) ? error.code : ''
    const code = own !== '' ? own : (stranded.length === 0 ? 'E2005' : 'E2006')
    // What the rollback could not undo is the part a create that failed leaves
    // behind, and it is not in the message the caller reads - so it is here.
    // The sentence says which of the two outcomes this is, because "rolled back"
    // and "left something behind" call for different amounts of attention and
    // neither is visible in `exit` or `code` on their own.
    await recordError(error, {
      phase: 'create',
      code,
      msg: stranded.length === 0
        ? 'Creating the task space failed. The rollback removed the worktrees, the branch and the task space this call had made, so the same name can be used again.'
        : 'Creating the task space failed and the rollback could not remove everything. The leftovers named in `stranded` are still on disk and have to be dealt with by hand.',
      ...(created.length === 0 ? {} : { created: created.map((entry) => entry.name) }),
      ...(stranded.length === 0 ? {} : { stranded }),
    })
    // Rebuilt rather than rethrown, because the rollback's outcome is part of what
    // the caller has to be told. The code is carried over for the reason above:
    // an error rebuilt without one is one the caller learns nothing from.
    const rolled = new Error(`${error.message}${suffix}`)
    rolled.code = code
    throw rolled
  }

  await recordEvent(
    'info',
    `Created the task space. Every selected repository has a worktree on ${branch} and the task metadata is written, so this is the point from which the task exists.`,
    { phase: 'create', branch, path: taskPath, worktrees: created.map((entry) => entry.name) },
  )

  // Links are looked for HERE, at the start, rather than only when the finish tries to
  // file a stray. The finish cannot file a stray holding a link on a machine that
  // refuses to recreate one (`fs.cp` recreates links, it does not copy through them),
  // and discovering that at the finish means the task space cannot be cleared until a
  // person moves the link out by hand - a problem that existed from the first minute
  // of the task and was invisible until the last.
  //
  // Both halves are asked, because they mean different things to the reader: whether
  // this machine would refuse to recreate a link at all (a fact about the machine,
  // which no amount of work in the task space changes), and whether the worktrees this
  // call just cut actually hold any (a fact about this task space). Reported as
  // warnings and never thrown: the task space exists and the work is not wrong, so
  // refusing the create would be reporting a delivery-time hazard as a failure.
  const links = []
  if (await symlinksRefused()) {
    for (const entry of created) links.push(...await findLinks(entry.path))
  }
  if (links.length > 0) {
    const named = links.slice(0, LINK_NAMES_SHOWN).join(', ')
    const more = links.length > LINK_NAMES_SHOWN ? ` (and ${links.length - LINK_NAMES_SHOWN} more)` : ''
    warnings.push(warned(
      'workspace-holds-links',
      `this machine will not recreate a symbolic link, and the worktrees hold ${links.length} of them: ${named}${more}. They cannot be filed when this task is finished; move or delete them before then, or the finish will leave them in place and stop.`,
      { count: links.length, links: links.slice(0, LINK_NAMES_SHOWN), shown: LINK_NAMES_SHOWN },
    ))
  }

  // A repository's own e2e configuration is read here for the same reason the links
  // are: it is a hazard that exists from the first minute of the task and is only
  // discovered when someone trusts its result. A suite pointed at the host's stack
  // reports green for code this task never built, and that report is indistinguishable
  // from a real one - which makes it worse than a suite that fails.
  //
  // Reported, never refused. A fixed port can be deliberate, and a create is not the
  // place to overrule a repository's own configuration; what the reader needs is to
  // know before they read a result as a regression.
  const stacks = []
  for (const entry of created) {
    for (const finding of await inspectE2eConfigs(entry.path)) {
      stacks.push({ repo: entry.name, ...finding })
    }
  }
  if (stacks.length > 0) {
    const named = stacks.slice(0, E2E_NAMES_SHOWN).map((one) => `${one.repo}: ${one.path}`).join(', ')
    const more = stacks.length > E2E_NAMES_SHOWN ? ` (and ${stacks.length - E2E_NAMES_SHOWN} more)` : ''
    const reused = stacks.some((one) => one.reusesExistingServer)
    warnings.push(warned(
      'workspace-e2e-points-elsewhere',
      `the repositories' own end-to-end configuration names the stack it runs against: ${named}${more}. `
      + (reused ? 'At least one of them reuses a server that is already running' : 'They name fixed local addresses')
      + ', so a suite run from this task space may verify whatever is already listening rather than this task\'s own '
      + 'instance. Point it at this task\'s acceptance address, or bring a configuration that does, before reading '
      + 'its result as a regression.',
      { configs: stacks.slice(0, E2E_NAMES_SHOWN), count: stacks.length, shown: E2E_NAMES_SHOWN, reused },
    ))
  }

  return {
    task: name,
    project,
    branch,
    path: taskPath,
    tasksRoot,
    baseRef: baseRef === undefined || `${baseRef}`.trim() === '' ? undefined : `${baseRef}`,
    repositories: created.map((entry) => ({ name: entry.name, path: entry.path })),
    warnings,
  }
}



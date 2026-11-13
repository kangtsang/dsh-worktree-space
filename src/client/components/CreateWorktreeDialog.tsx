import { useEffect, useId, useRef, useState } from "react"
import { AlertCircle, CircleQuestionMark, GitPullRequest, Loader2 } from "./icons"
import { HoverHint } from "./HoverHint"
import { BaseRefPicker } from "./BaseRefPicker"
import { BranchPicker } from "./BranchPicker"
import { createWorktreeApi } from "../lib/api"
import { format, useT } from "../lib/i18n"
import { errorText } from "../lib/error-text"
import { nameOf, normalizedSlugOf, slashPath, taskDirectory } from "../lib/paths"
import type { RepositoryBranchMap, TaskRootSuggestion, WorkspaceNavigation, WorkspacesService, Workspace } from "../lib/types"
import type { ConfigFormLike } from "./PluginConfigCard"
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input, Select } from "./ui"

/**
 * The one delivery decision a create makes: whether the task expects a deployment.
 *
 * This used to be eight dropdowns. Seven of them are gone, and the reason is worth
 * keeping: every one of them was a default recorded here for a decision taken
 * somewhere else - what to merge, which branch, whether to delete it, what a
 * conflict does, what happens to leftovers. Four were read by nothing at all. What
 * is left is the one answer a later step cannot derive, because it turns the
 * finish gate on or off: what does this task owe before its work may land - nothing,
 * a passing smoke, or a passing smoke of a deployment it stands up?
 *
 * The rest is passed on the `done` call, where the caller can see the work it
 * applies to.
 */
interface DeliveryChoice {
  acceptanceKind: string
}

/** Where the choice starts: no acceptance, which is also what a create without it gets. */
const DEFAULT_DELIVERY: DeliveryChoice = {
  acceptanceKind: "none",
}

/** The three answers the field offers, in the order the menu lists them. */
const ACCEPTANCE_KINDS = ["none", "smoke", "deploy"] as const

/**
 * The one choice, as the policy the Host records.
 *
 * A create says exactly what the user chose and nothing more. It used to send seven
 * more fields, every one of them a default standing in for a decision taken later;
 * what the Host records now is the acceptance kind alone, because that is the only
 * answer a later step cannot derive.
 */
function deliveryPolicyOf(choice: DeliveryChoice) {
  const kind = (ACCEPTANCE_KINDS as readonly string[]).includes(choice.acceptanceKind)
    ? choice.acceptanceKind
    : "none"
  return { acceptance: { kind } }
}

/** Prefix the host uses when the caller names none; a suggestion normally carries it. */
const FALLBACK_BRANCH_PREFIX = "task/"

/** Characters Git refuses anywhere in a ref, plus the sequences it refuses. */
const ILLEGAL_BRANCH_CHARACTERS = /[\s~^:?*\[\]\\\u0000-\u001f\u007f]/

/**
 * Whether a branch prefix would make Git refuse the branch, so the dialog can
 * say so before the host has to. The host remains the authority; this only keeps
 * a request that cannot succeed from being sent.
 * @param prefix - the prefix as typed, already trimmed.
 * @returns the message key to show, or `""` when the prefix can be used.
 */
function branchPrefixProblem(prefix: string) {
  if (prefix === "") return ""
  if (ILLEGAL_BRANCH_CHARACTERS.test(prefix)) return "invalidBranchPrefix"
  if (prefix.includes("..") || prefix.includes("@{") || prefix.includes("//")) return "invalidBranchPrefix"
  if (prefix.startsWith("/") || prefix.startsWith("-")) return "invalidBranchPrefix"
  return ""
}

interface CreateWorktreeDialogProps {
  target: Pick<Workspace, "path" | "title">
  api: ReturnType<typeof createWorktreeApi>
  workspaces: WorkspacesService
  uiWorkspace: WorkspaceNavigation
  /**
   * This plugin's configuration form, when the shell serves one.
   *
   * Two jobs: the prefix the dialog starts from is the configured default rather than
   * a constant, and the checkbox under the field writes a new default back through
   * the same form the Plugins page edits.
   */
  config?: ConfigFormLike
  onCreated: (path: string) => void
  onClose: () => void
}

/**
 * Create a task space: one worktree per selected repository, all on one
 * branch, in a container beside the repositories' directory.
 *
 * The dialog drives the same host operations the `wts_worktree_space` tool uses, so
 * a single repository and a directory holding repositories take one path — the
 * one this plugin exists for.
 * @param props - the source root to create in, the services to reach, and the
 * created/closed callbacks.
 * @returns the dialog element.
 */
export function CreateWorktreeDialog({ target, api, workspaces, uiWorkspace, config, onCreated, onClose }: CreateWorktreeDialogProps) {
  const t = useT()
  const id = useId()
  const [suggestion, setSuggestion] = useState<TaskRootSuggestion | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [taskName, setTaskName] = useState("")
  const [branchPrefix, setBranchPrefix] = useState("")
  const [tasksRoot, setTasksRoot] = useState("")
  const [selected, setSelected] = useState<string[]>([])
  // The one branch every selected repository carries, chosen from the dialog's
  // own field; empty means "each repository starts from its own HEAD", which is
  // what an untouched dialog does.
  const [uniformBase, setUniformBase] = useState("")
  // The batch of branch lists the per-repository pickers read from, started when
  // the dialog opens rather than when a picker is clicked. `undefined` is the
  // "not asked yet" state and is deliberately different from an empty answer:
  // a picker showing an empty list is read as "this repository has no branches".
  const [branches, setBranches] = useState<RepositoryBranchMap | undefined>(undefined)
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [branchesError, setBranchesError] = useState("")
  const [branchesAttempt, setBranchesAttempt] = useState(0)
  // Per-repository overrides, keyed by the repository's basename: that is what
  // the tool-side `baseRefs` takes. Only a repository the user actually changed
  // gets an entry, so an untouched one falls through to the dialog's own global
  // default and then to its HEAD.
  const [baseRefs, setBaseRefs] = useState<Record<string, string>>({})
  const [delivery, setDelivery] = useState<DeliveryChoice>(DEFAULT_DELIVERY)
  // The one deployment parameter this dialog does set: which file under the workspace's
  // `.worktree-space/deploy/` this task runs as its entry. It keeps its own name and the
  // record remembers it, so two tasks can deploy differently without either overwriting the
  // other. Empty means the entry is `.worktree-space/deploy/deploy.sh`.
  const [deployScript, setDeployScript] = useState("")
  const [saveAsDefault, setSaveAsDefault] = useState(false)
  const [saveRootAsDefault, setSaveRootAsDefault] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  // Prevent duplicate mutations even before React commits the disabled state.
  const busyRef = useRef(false)
  const [recovery, setRecovery] = useState<{ task: string; project: string; tasksRoot: string; path: string; branch: string } | null>(null)

  useEffect(() => {
    setTaskName("")
    setUniformBase("")
    setBaseRefs({})
    setRecovery(null)
    setSaveAsDefault(false)
    setSaveRootAsDefault(false)
    setDelivery(DEFAULT_DELIVERY)
    setDeployScript("")
  }, [target.path])

  // The configured default is read from the form the Plugins page edits, and kept
  // current while the dialog is open: saving a prefix below lands in this same form,
  // and so does an edit made on the Plugins page in another tab. The ref is what the
  // suggestion effect below reads, because that effect resolves after this one has only
  // just been scheduled, and it must see the configured value rather than its initial "".
  const [configuredPrefix, setConfiguredPrefix] = useState("")
  const configuredPrefixRef = useRef("")
  useEffect(() => {
    if (config === undefined) return
    const read = () => {
      const value = (config.getSnapshot().value as { defaultBranchPrefix?: unknown } | undefined)?.defaultBranchPrefix
      const next = typeof value === "string" ? value : ""
      configuredPrefixRef.current = next
      setConfiguredPrefix(next)
    }
    read()
    return config.subscribe(read)
  }, [config])

  useEffect(() => {
    let alive = true
    setSuggestion(null)
    setLoading(true)
    setError("")
    api.suggestRoot(target.path).then((next) => {
      if (!alive) return
      setSuggestion(next)
      // Shown the way this plugin shows every other path: the footer already prints
      // the task directory with forward slashes, so the field above it agrees.
      setTasksRoot(slashPath(next.suggested))
      // The prefix a new task space starts from: the configured default when there is
      // one, otherwise whatever this Host would fall back to, so the prefilled field is
      // not a guess.
      setBranchPrefix(configuredPrefixRef.current || next.branchPrefix || FALLBACK_BRANCH_PREFIX)
      // Every discovered repository is in the task until the user narrows it.
      setSelected(next.repositories.map((repository) => repository.path))
    }).catch((reason) => {
      if (alive) setError(errorText(t, reason))
    }).finally(() => {
      if (alive) setLoading(false)
    })
    return () => { alive = false }
  }, [api, target.path, loadAttempt])

  // The per-repository start points, read as soon as the repositories are known
  // rather than when a picker is first opened: a click that has to wait for a
  // round trip opens a panel with nothing in it, and that emptiness reads as
  // "this repository has no branches". The whole selection goes in one request,
  // so N repositories cost one round trip rather than N.
  //
  // The error is kept beside the list rather than in the dialog's own error: it
  // is about one field's reading, and it carries its own retry.
  useEffect(() => {
    if (suggestion === null) return undefined
    const paths = suggestion.repositories.map((repository) => repository.path)
    if (paths.length === 0) return undefined
    let alive = true
    setBranchesLoading(true)
    setBranchesError("")
    api.branches(paths).then((answer) => {
      if (alive) setBranches(answer ?? {})
    }).catch((reason) => {
      // The list stays as it was: a failed refresh must not empty a picker that
      // already had branches in it, and `branchesError` is what says so instead.
      if (alive) setBranchesError(errorText(t, reason))
    }).finally(() => {
      if (alive) setBranchesLoading(false)
    })
    return () => { alive = false }
  }, [api, suggestion, branchesAttempt])

  const repositories = suggestion?.repositories ?? []
  const suggestedPrefix = suggestion?.branchPrefix ?? FALLBACK_BRANCH_PREFIX
  // Clearing the field asks for the host's own default rather than for no prefix
  // at all, which is what the preview and the request then both say.
  const typedPrefix = branchPrefix.trim()
  const effectivePrefix = typedPrefix === "" ? configuredPrefix || suggestedPrefix : typedPrefix
  // The value that is actually sent, not the field: an empty field falls back to the
  // configured default, and validating only what was typed let an illegal configured
  // prefix pass this check and be refused by the Host instead. The fallback is not a
  // guess either way - `configuredPrefix` is what the Plugins page holds and
  // `suggestedPrefix` is what the Host itself resolved.
  const prefixProblem = branchPrefixProblem(effectivePrefix)
  // The empty field is the one case where the offending prefix is not on screen: it
  // is the configured default, so the note names it rather than saying "invalid"
  // about a field the user left blank.
  const prefixNote = prefixProblem === ""
    ? format(t("branchPrefixHint"), { prefix: effectivePrefix || suggestedPrefix })
    : typedPrefix === "" && configuredPrefix !== ""
      ? format(t("invalidConfiguredBranchPrefix"), { prefix: effectivePrefix })
      : t(prefixProblem)
  // The checkbox promises a new default for the *next* task space, so it is offered
  // only for a prefix that could actually become one: an unset one has nothing to
  // save, an unusable one would be refused by the Host, and there is nothing to save
  // it into when the shell serves no configuration form at all — which the entry that
  // mounts this dialog promises. The field is prefilled with the current default, so
  // the box starts clear rather than already ticked.
  const hasForm = config !== undefined
  const canSaveDefault = hasForm && typedPrefix !== "" && prefixProblem === "" && typedPrefix !== configuredPrefix
  // The suggestion carries the container root the configuration names, when it names
  // one, so this is one comparison rather than a second read of the settings: a field
  // left where the dialog put it is already the default, one that was moved is a
  // location the user may want next time too, and neither is anything without a form
  // to write it through.
  const typedRoot = tasksRoot.trim()
  const defaultRoot = suggestion === null ? "" : slashPath(suggestion.suggested)
  const canSaveDefaultRoot = hasForm && typedRoot !== "" && defaultRoot !== "" && typedRoot !== defaultRoot
  // The host refuses separators and whitespace; this form additionally keeps the
  // name a valid Git ref, so the branch cannot fail later.
  //
  // One rule decides both what is submitted and whether there is anything to submit:
  // the same normalization `slugOf` uses, without its placeholder. Spelling it a
  // second time is how a name comes to be shown as valid here and sent as another
  // one there — the emptiness check was reading a copy that could drift away from
  // the validation.
  const taskSlug = normalizedSlugOf(taskName)
  const validSlug = /^[a-z0-9_][a-z0-9._-]*$/.test(taskSlug)
    && !taskSlug.includes("..") && !taskSlug.endsWith(".") && !taskSlug.endsWith(".lock")
  const taskBranch = validSlug && prefixProblem === "" ? `${effectivePrefix}${taskSlug}` : ""
  // The project layer is the source root's own directory name, which is how the
  // Host files it - so the preview reads `<container root>/<project>/<task>` and
  // matches what `task.create` will write.
  const project = nameOf(target.path)
  const taskPath = taskSlug !== "" && tasksRoot.trim() !== "" && project !== ""
    ? taskDirectory(taskDirectory(tasksRoot.trim(), project), taskSlug)
    : ""
  const invalidName = taskName.length > 0 && !validSlug
  // Which rule it broke, in the order the checks run.
  const nameProblem = !invalidName ? "" : taskSlug === "" ? "invalidNameEmpty" : taskSlug.startsWith(".") ? "invalidNameLeadingDot" : taskSlug.includes("..") ? "invalidNameConsecutiveDots" : taskSlug.endsWith(".lock") ? "invalidNameLockSuffix" : taskSlug.endsWith(".") ? "invalidNameTrailingDot" : "invalidNameGeneric"
  // Each field's explanation rides on its own label line; the copy also stays in the
  // markup, hidden, for a reader that only hears the field.
  const nameNoteClass = invalidName ? "dws-field-note dws-field-note-warning" : "dws-field-note"
  const prefixNoteClass = prefixProblem !== "" ? "dws-field-note dws-field-note-warning" : "dws-field-note"
  const sourceReady = suggestion !== null && repositories.length > 0
  const fieldsDisabled = busy || loading || !sourceReady || !!recovery
  // The one start point every selected repository carries. A branch offered here
  // has to exist in ALL of them, because a create passes one ref to every
  // worktree: choosing a branch one repository lacks fails the whole call with
  // E3002 rather than starting that repository somewhere else. So the list is the
  // intersection, recomputed as the selection changes, and a choice that stops
  // being common is dropped instead of being sent.
  const commonBranches = (() => {
    const chosen = repositories.filter((repository) => selected.includes(repository.path))
    if (chosen.length === 0) return [] as string[]
    let shared: string[] | undefined
    for (const repository of chosen) {
      // A repository whose list has not arrived yet contributes nothing: an
      // intersection built from half the answers would offer a branch the rest
      // may not have, which is the failure this list exists to prevent.
      const entry = branches?.[repository.path]
      if (entry === undefined) return [] as string[]
      const names = new Set(entry.branches)
      shared = shared === undefined ? [...names] : shared.filter((branch) => names.has(branch))
      if (shared.length === 0) return [] as string[]
    }
    return (shared ?? []).sort((left, right) => left.localeCompare(right))
  })()
  // A uniform choice survives only while every selected repository still carries
  // it. Losing one repository to an untick can take the branch out of the
  // intersection, and sending it anyway is the E3002 this whole field avoids.
  const uniformRef = uniformBase !== "" && commonBranches.includes(uniformBase) ? uniformBase : ""
  // The global field keeps its old meaning: the default for every repository the
  // user did not override below, corresponding to `baseRef`. The per-repository
  // map is sent only for the ones that were actually changed.
  const baseRef = uniformRef
  // Only the overrides of repositories actually in the task are sent. A branch
  // chosen and then unticked is kept on screen (decision 6) but is not a start
  // point for a repository that will not have a worktree.
  const sentBaseRefs = () => {
    const sent: Record<string, string> = {}
    for (const repository of repositories) {
      if (!selected.includes(repository.path)) continue
      const value = baseRefs[repository.name]
      if (value !== undefined) sent[repository.name] = value
    }
    return Object.keys(sent).length === 0 ? undefined : sent
  }
  const effectiveBaseRefs = sentBaseRefs()
  // Whether this task records an acceptance at all. It decides one thing in this dialog:
  // whether the entry-script field is offered, because naming a script for a task that owes
  // none would say nothing. The kind itself is sent as what it is; everything else a finish
  // decides moved to the finish, so there is no longer a grid of fields to show or hide.
  const deploys = delivery.acceptanceKind !== "none"
  const canCreate = validSlug && selected.length > 0 && tasksRoot.trim() !== "" && prefixProblem === ""

  const startBusy = () => { busyRef.current = true; setBusy(true); setError("") }
  const endBusy = () => { busyRef.current = false; setBusy(false) }
  const dismiss = () => { if (!busyRef.current) onClose() }

  /**
   * Undo a create that got as far as making the task space.
   *
   * Registration is the last step that can fail, and by then the worktrees and the
   * branch exist. They go back the way they came: the Workspace row first, because
   * it points at the directory, then the directory and the branch together, so the
   * next attempt at this name meets neither.
   *
   * `force` is what makes the branch deletable. It was cut seconds ago and carries
   * no commits of its own, and this is the Host's own request to abandon it - not a
   * user discarding work. A branch that refuses to go leaves the error to report
   * rather than being forced past a check that exists for finished tasks.
   */
  const rollbackCreated = async (
    made: { path: string; task: string; project: string },
    workspace: Workspace | undefined,
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    const problems: string[] = []
    if (workspace?.workspaceId) {
      try { await workspaces.delete(workspace.workspaceId) }
      catch (reason: any) { problems.push(errorText(t, reason)) }
    }
    try {
      await api.doneTask({
        task: made.task,
        project: made.project,
        tasksRoot: tasksRoot.trim(),
        // A rollback is not a delivery: this removes what a create had already made, so it
        // says "no merge" explicitly. `merge` is required on every finish, and a rollback
        // that left the question open would land the half-made work on the target branch.
        merge: false,
        deleteBranch: true,
        force: true,
        // Without this the Host records a task space and a branch being deleted
        // and can say nothing about why. It is the one thing that distinguishes
        // this removal from a user finishing a task, and the audit log is where
        // the next person looks when a create has left the disk in a state they
        // did not expect.
        cause: "creating its Workspace in the dialog failed, so the create was rolled back rather than left half-made.",
      })
    } catch (reason: any) {
      problems.push(errorText(t, reason))
    }
    return problems.length === 0 ? { ok: true } : { ok: false, error: problems.join("; ") }
  }

  const registerAndOpen = async (createdPath: string, slug: string) => {
    const workspace = await workspaces.create({ path: createdPath })
    try {
      await workspaces.rename(workspace.workspaceId, `${target.title}/${slug}`)
      await uiWorkspace.openWorkspace(workspace.workspaceId)
      onCreated(createdPath)
      onClose()
    } catch (reason) {
      // A failed retry must not leave another partially registered Workspace.
      await workspaces.delete(workspace.workspaceId)
      throw reason
    }
  }

  const retryRegister = async () => {
    if (!recovery || busyRef.current) return
    startBusy()
    try { await registerAndOpen(recovery.path, recovery.task); setRecovery(null) }
    catch (reason: any) { setError(`${t("registerFailed")} ${errorText(t, reason)}`) }
    finally { endBusy() }
  }

  /**
   * Write one preference, answering a refusal and a failure the same way.
   *
   * The configuration form reports the Host's verdict two ways: `false` when the
   * Host turned the write down, and a rejection when there was never a verdict at
   * all - a connection dropped mid round trip rejects every write still queued on it.
   * Only the first is a refusal, but neither is a reason to undo the task space that
   * has just been created, and the second is the one that used to: it escaped into
   * the catch around the whole create, which cannot tell a preference write that
   * failed from a registration that did and would take the worktrees and the branch
   * down with it. So it is caught here, where the only thing left to do is report the
   * setting as unsaved - which is exactly what the refusal does.
   * @param field - the configuration field to write.
   * @param value - the value to put in it.
   * @returns whether the Host now has it.
   */
  const writePreference = async (field: string, value: string) => {
    try { return (await config?.set(field, value)) === true }
    catch { return false }
  }

  const create = async () => {
    if (busyRef.current || recovery || loading || !sourceReady) return
    if (!validSlug) {
      setError(t(taskName.trim() !== "" && nameProblem !== "" ? nameProblem : "fillTaskName"))
      return
    }
    if (prefixProblem !== "") {
      // The field's own sentence, not the bare rule: an illegal configured default
      // is not visible in the field, so the error has to name the prefix that was
      // refused rather than say "invalid" about something the user cannot see.
      setError(prefixNote)
      return
    }
    if (selected.length === 0) {
      setError(t("repositoriesHint"))
      return
    }
    startBusy()
    let created: { path: string; task: string; project: string } | undefined
    let workspace: Workspace | undefined
    // Which step failed decides what the user is offered: only a registration the
    // plugin made itself is worth undoing or retrying as one unit.
    let phase: "create" | "register" | "rename" | "open" = "create"
    try {
      const result = await api.createTask({
        sourceRoot: target.path,
        task: taskSlug,
        tasksRoot: tasksRoot.trim(),
        repos: selected,
        baseRef: baseRef === "" ? undefined : baseRef,
        // Per-repository overrides, and only the ones the user actually set: an
        // untouched repository is deliberately absent, so it falls back to
        // `baseRef` and then to its own HEAD rather than being pinned to a value
        // the dialog merely displayed. A repository that has since been dropped
        // from the selection carries no entry either - the value is kept while
        // the box is cleared, but it is not sent for a repository not in the task.
        ...(effectiveBaseRefs === undefined ? {} : { baseRefs: sentBaseRefs() }),
        branchPrefix: effectivePrefix,
        // The one acceptance decision, sent flat rather than as a policy blob: the
        // Host reads it as the kind and records it. `none` is sent too, so what the
        // user chose is what is recorded.
        acceptanceKind: deliveryPolicyOf(delivery).acceptance.kind,
        // Named only when there is one: an empty field leaves the request exactly as it
        // was, so the Host copies what the source root carries and nothing else.
        ...(deployScript.trim() === "" ? {} : { deployScript: deployScript.trim() }),
      })
      // The Host's own project name, not the one this dialog derived: cleanup
      // names the task space back to it, so it must be the one that was written.
      created = { path: result.path, task: result.task, project: result.project }
      // Ticking the box is a promise about the *next* task space, so the new default
      // is written only once this one exists - and a form that refuses it cannot
      // undo the task that was just created. Nor can one that fails to answer: both
      // arrive here as `false`, having stopped at `writePreference`.
      if (saveAsDefault && canSaveDefault) {
        const accepted = await writePreference("defaultBranchPrefix", typedPrefix)
        setSaveAsDefault(false)
        if (!accepted) setError(t("branchPrefixNotSaved"))
      }
      // The location is two settings rather than one - the strategy names the rule and
      // the directory is what the custom one reads - so they are written in the order
      // that leaves nothing odd behind: a directory the Host refuses is never paired
      // with a strategy that would read it, and a directory it accepted while the
      // strategy write failed stays inert under the default.
      if (saveRootAsDefault && canSaveDefaultRoot) {
        const savedDirectory = await writePreference("tasksRootDirectory", typedRoot)
        const savedStrategy = savedDirectory
          ? await writePreference("tasksRootStrategy", "custom")
          : false
        setSaveRootAsDefault(false)
        if (!savedStrategy) setError(t("tasksRootNotSaved"))
      }
      phase = "register"
      workspace = await workspaces.create({ path: result.path })
      phase = "rename"
      await workspaces.rename(workspace.workspaceId, `${target.title}/${result.task}`)
      phase = "open"
      await uiWorkspace.openWorkspace(workspace.workspaceId)
      onCreated(result.path)
      onClose()
    } catch (reason: any) {
      const detail = errorText(t, reason)
      if (phase === "open") {
        // The task and its registration are fine; only showing the Session failed.
        if (created) onCreated(created.path)
        setError(`${t("openFailed")}${detail}`)
        return
      }
      // The container on disk is this task's own, left by an earlier version that
      // could not register its Workspace. It is not a name clash the user should
      // have to clear by hand, so it is reported with a way to clear it here.
      if (reason?.code === "task-space-unregistered" && !created) {
        setRecovery({
          // taskPath is the preview path, built the way task.create builds it.
          path: taskPath,
          task: taskSlug,
          project,
          tasksRoot: tasksRoot.trim(),
          branch: taskBranch,
        })
        setError(format(t("resumeUnregistered"), { path: taskPath }))
        return
      }
      // A create is one thing: the task space, its worktrees and its branch, or
      // none of them. Once the containers exist but the registration failed, they
      // are undone here rather than handed back, because a task space that was
      // never registered is not half a task - and the branch outliving its
      // directory is what would make the next attempt at this name fail.
      if (created) {
        const undone = await rollbackCreated(created, workspace)
        if (undone.ok) {
          setError(format(t("createRolledBack"), { error: detail }))
        } else {
          setError(format(t("rollbackIncomplete"), {
            error: detail,
            undo: undone.error,
            path: created.path,
            branch: taskBranch || created.task,
          }))
        }
        return
      }
      setError(`${t("operationError")}${detail}`)
    } finally {
      endBusy()
    }
  }

  // Selected entries are paths, not names. Discovery walks to maxDepth, so a
  // repository is not always a direct child of the source root, and a bare name
  // cannot say which of them it meant - the Host would rebuild the wrong path.
  const toggleRepository = (path: string, include: boolean) => {
    setSelected((current) => (include
      ? [...new Set([...current, path])]
      : current.filter((entry) => entry !== path)))
  }
  // Every card acts on one list, so the pair of actions below them is a property of the
  // field rather than of any one card: it says what the next click does to all of them.
  const setAllRepositories = (include: boolean) => {
    setSelected(include ? repositories.map((repository) => repository.path) : [])
  }

  // The picker leads the form — it is the decision this dialog exists for, and the only
  // one whose answer is already made for the user. Its legend is the group's name and
  // nothing else: the count is not part of what the group *is*, and it changes on every
  // click, so it lives in the live region beside the bulk actions instead of inside the
  // label the group is announced by. Those actions are one run under the cards, read as
  // the field's own footnote and closed at the edge the cards end on.
  const picker = <fieldset className="dws-field dws-repositories-fieldset" disabled={fieldsDisabled} aria-describedby={selected.length === 0 ? `${id}-repositories-note` : undefined}>
    <legend className="dws-field-legend"><span id={`${id}-repositories`} className="dws-field-label">{t("repositoriesLabel")}</span></legend>
    <div className="dws-repo-picker">
      <div className="dws-repo-choices">
        {/* Keyed and identified by position, not by name: with repositories coming from
            more than one level, two of them can share a basename, and a path is not
            something to put in an element id. The label still reads the name. */}
        {/* A card, not a label. The card used to be one, so a click anywhere on
            it toggled the tick - and that is what made the branch button below
            unusable: a label forwards a click on any of its controls to the
            input, so pressing it also ticked the repository. The text is still
            its own target, through the label it keeps, and the button beside it
            is one of its own. */}
        {repositories.map((repository, index) => {
          const chosen = baseRefs[repository.name]
          // What the card says the repository starts from: the override when
          // there is one, otherwise the branch it has checked out. An override
          // that names the same branch reads as the current one, because it is.
          const shown = chosen ?? repository.branch
          return <div key={repository.path} className="dws-check-option">
          <input id={`${id}-repo-${index}`} className="dws-checkbox" type="checkbox" checked={selected.includes(repository.path)} onChange={(event) => toggleRepository(repository.path, event.target.checked)} />
          {/* The same name-then-branch line the repository view renders, so a
              repository reads the same wherever this plugin lists it. */}
          <label className="dws-check-copy" htmlFor={`${id}-repo-${index}`}>
            <span className="dws-check-name">
              <span className="dws-check-label">{repository.name}</span>
              {shown === undefined ? null : <span className="dws-branch-label" title={`${t(chosen === undefined ? "currentBranchLabel" : "baseRefChosen")}: ${shown}`}><GitPullRequest size={12} /><span className="dws-branch-value">{shown}</span></span>}
              {chosen === undefined ? null : <span className="dws-visually-hidden">{format(t("baseRefValue"), { branch: chosen })}</span>}
            </span>
            <span className="dws-check-path" title={slashPath(repository.path)}>{slashPath(repository.path)}</span>
          </label>
          {/* Outside the label on purpose: a button inside one is a click that
              toggles the tick as well. */}
          <BranchPicker
            repository={repository.name}
            entry={branches?.[repository.path]}
            // Reading until the batch answers. A repository with no entry and no
            // error is one whose read has not come back, which is a waiting state
            // and not "this repository has no branches".
            loading={branchesLoading || (branches === undefined && branchesError === "")}
            error={branchesError}
            chosen={chosen}
            current={repository.branch}
            onChoose={(branch) => setBaseRefs((current) => {
              // A cleared override is removed rather than recorded as empty:
              // the map is "these repositories were overridden", and an entry
              // saying "no override" is the same as no entry.
              const next = { ...current }
              if (branch === undefined) delete next[repository.name]
              else next[repository.name] = branch
              return next
            })}
            onRetry={() => setBranchesAttempt((attempt) => attempt + 1)}
          />
        </div>})}
      </div>
      {/* The rule comes back only when it has something to say. The count and the bulk
          actions are not here any more: they close the field on the band the next field's
          name sits on, so the list's own answer and that name share one line. */}
      {selected.length === 0 ? <div className="dws-repo-picker-foot">
        <p id={`${id}-repositories-note`} className="dws-field-note">{t("repositoriesHint")}</p>
      </div> : null}
    </div>
  </fieldset>

  // The three fields that describe the task are one fieldset on one surface: they are the
  // same question asked three ways — what this space is called, where it goes and what it
  // sits next to — while the fieldset below asks a question of its own.
  const details = <fieldset className="dws-field dws-details-fieldset" disabled={fieldsDisabled}>
    <legend className="dws-field-label dws-fieldset-legend">{t("detailsLabel")}</legend>
    <div className="dws-details">
      <div className="dws-field-row">
        <label className="dws-field-label" htmlFor={`${id}-name`}><span id={`${id}-name-label`}>{t("taskName")}</span><span className={nameNoteClass}>{invalidName ? t(nameProblem) : t("taskNameHint")}</span></label>
        <Input id={`${id}-name`} aria-labelledby={`${id}-name-label`} value={taskName} disabled={fieldsDisabled} onChange={(event) => setTaskName(event.target.value)} placeholder={t("taskNamePlaceholder")} autoFocus autoComplete="off" spellCheck={false} aria-invalid={invalidName || undefined} aria-describedby={`${id}-name-note`} />
        <span id={`${id}-name-note`} className="dws-field-note dws-visually-hidden">{invalidName ? t(nameProblem) : t("taskNameHint")}</span>
      </div>
      <div className="dws-field-row">
        <label className="dws-field-label" htmlFor={`${id}-prefix`}><span id={`${id}-prefix-label`}>{t("branchPrefix")}</span><span className={prefixNoteClass}>{prefixNote}</span></label>
        <Input id={`${id}-prefix`} aria-labelledby={`${id}-prefix-label`} value={branchPrefix} disabled={fieldsDisabled} onChange={(event) => setBranchPrefix(event.target.value)} placeholder={suggestedPrefix} autoComplete="off" spellCheck={false} aria-invalid={prefixProblem !== "" || undefined} aria-describedby={`${id}-prefix-note`} />
        <span id={`${id}-prefix-note`} className="dws-field-note dws-visually-hidden">{prefixNote}</span>
        {/* The offer disappears rather than sitting disabled once it has nothing to
            promise: the field already holds the default, or the value cannot be one. */}
        {canSaveDefault ? <label className="dws-default-prefix" htmlFor={`${id}-default-prefix`}>
          <input
            id={`${id}-default-prefix`}
            className="dws-checkbox"
            type="checkbox"
            aria-label={t("rememberPrefix")}
            checked={saveAsDefault}
            disabled={fieldsDisabled}
            onChange={(event) => setSaveAsDefault(event.target.checked)}
          />
          <span className="dws-check-copy">
            <span className="dws-check-label">{t("rememberPrefix")}</span>
          </span>
        </label> : null}
      </div>
      <div className="dws-field-row">
        <label className="dws-field-label" htmlFor={`${id}-container`}>
          <span className="dws-field-name"><span id={`${id}-container-label`}>{t("containerLocation")}</span>
            {/* Too long for the slot beside the name, so it lives here instead. */}
            <HoverHint label={t("containerHint")} className="dws-field-hint"><CircleQuestionMark size={13} aria-hidden="true" /></HoverHint>
          </span>
          <span className="dws-field-note">{t("containerLocationHint")}</span>
        </label>
        <Input id={`${id}-container`} aria-labelledby={`${id}-container-label`} value={tasksRoot} disabled={fieldsDisabled} onChange={(event) => setTasksRoot(event.target.value)} autoComplete="off" spellCheck={false} aria-describedby={`${id}-container-note`} />
        <span id={`${id}-container-note`} className="dws-field-note dws-visually-hidden">{t("containerHint")}</span>
        {/* Offered on the same terms as the prefix above: a field left where the dialog
            put it has nothing to promise, and a moved one can become the next task
            space's default. The note under it is the one the setting carries in the
            configuration, because it is the same trade-off the user is deciding. */}
        {canSaveDefaultRoot ? <>
          <label className="dws-default-prefix" htmlFor={`${id}-default-root`}>
            <input
              id={`${id}-default-root`}
              className="dws-checkbox"
              type="checkbox"
              aria-label={t("rememberTasksRoot")}
              checked={saveRootAsDefault}
              disabled={fieldsDisabled}
              onChange={(event) => setSaveRootAsDefault(event.target.checked)}
            />
            <span className="dws-check-copy">
              <span className="dws-check-label">{t("rememberTasksRoot")}</span>
            </span>
          </label>
          <p className="dws-field-note">{t("tasksRootStrategyHint")}</p>
        </> : null}
      </div>
      {/* The one acceptance decision, and it is the only one left: what this task owes
          before its work may land. A menu now rather than a tick, because there are three
          answers and two of them gate the finish - "a deploy" and "a smoke on its own" are
          different things to owe, and one tick could not say which. Everything else a
          finish decides is asked at the finish, where the caller can see the work it
          applies to. */}
      <div className="dws-field-row">
        <label className="dws-field-label" htmlFor={`${id}-acceptance-kind`}>
          <span className="dws-field-name"><span id={`${id}-acceptance-kind-label`}>{t("deliveryAcceptanceKind")}</span>
            {/* The contract's own explanation, which is several paragraphs long: it belongs in
                the bubble rather than beside the menu, where it would push the rest of the
                form down on every create. */}
            <HoverHint label={t("deliveryAcceptanceNote")} className="dws-field-hint"><CircleQuestionMark size={13} aria-hidden="true" /></HoverHint>
          </span>
          {/* The chosen answer's cost, in one line, changing with the menu: the menu names
              the kind, this says what it will make the finish wait for. */}
          <span className="dws-field-note" id={`${id}-acceptance-kind-note`}>
            {delivery.acceptanceKind === "deploy"
              ? t("deliveryAcceptanceDeployHint")
              : delivery.acceptanceKind === "smoke"
                ? t("deliveryAcceptanceSmokeHint")
                : t("deliveryAcceptanceNoneHint")}
          </span>
        </label>
        <Select
          id={`${id}-acceptance-kind`}
          aria-labelledby={`${id}-acceptance-kind-label`}
          aria-describedby={`${id}-acceptance-kind-note`}
          value={delivery.acceptanceKind}
          disabled={fieldsDisabled}
          onChange={(event) => setDelivery({ acceptanceKind: event.target.value })}
        >
          <option value="none">{t("deliveryAcceptanceNone")}</option>
          <option value="smoke">{t("deliveryAcceptanceSmoke")}</option>
          <option value="deploy">{t("deliveryAcceptanceDeploy")}</option>
        </Select>
        {/* Shown only once the task records an acceptance a script has to produce. Naming
            a script for a task that owes none would say nothing. */}
        {deploys ? <>
          <div className="dws-field-row">
            <label className="dws-field-label" htmlFor={`${id}-deploy-script`}>
              <span className="dws-field-name"><span id={`${id}-deploy-script-label`}>{t("deployScript")}</span>
                <HoverHint label={t("deployScriptNote")} className="dws-field-hint"><CircleQuestionMark size={13} aria-hidden="true" /></HoverHint>
              </span>
              <span className="dws-field-note">{t("deployScriptHint")}</span>
            </label>
            <Input id={`${id}-deploy-script`} aria-labelledby={`${id}-deploy-script-label`} value={deployScript} disabled={fieldsDisabled} onChange={(event) => setDeployScript(event.target.value)} placeholder={t("deployScriptPlaceholder")} autoComplete="off" spellCheck={false} aria-describedby={`${id}-deploy-script-note`} />
            <span id={`${id}-deploy-script-note`} className="dws-field-note dws-visually-hidden">{t("deployScriptNote")}</span>
          </div>
        </> : null}
      </div>
    </div>
  </fieldset>

  const base = <div className="dws-field dws-base-fieldset">
    {/* The band that closes the repository list: the list's count and bulk actions on the
        right, this field's name on the left. One line, because the field answers the
        question the list just asked - where every repository starts - and a name on a row
        of its own above a control standing right under the cards was one row too many. */}
    <div className="dws-base-heading">
      <span id={`${id}-base-label`} className="dws-field-label">{t("basedOn")}</span>
      {/* The whole rule set behind the `?`, because the field answers one question at
          two levels and the one sentence under the control can only carry the part a
          reader needs before choosing. */}
      <HoverHint label={t("baseRefRules")} className="dws-field-hint"><CircleQuestionMark size={13} aria-hidden="true" /></HoverHint>
      <div className="dws-repo-actions">
        <span className="dws-check-count" aria-live="polite">{format(t("repositoriesCountLabel"), { count: String(selected.length), total: String(repositories.length) })}</span>
        <span className="dws-picker-tools">
          <button type="button" className="dws-link-button" disabled={fieldsDisabled} onClick={() => setAllRepositories(true)}>{t("selectAll")}</button>
          <span className="dws-picker-divider" aria-hidden="true" />
          <button type="button" className="dws-link-button" disabled={fieldsDisabled} onClick={() => setAllRepositories(false)}>{t("selectNone")}</button>
        </span>
      </div>
    </div>
    {/* The list holds the branches EVERY selected repository carries, because one
        shared ref is what `baseRef` sends. A branch only some of them have would
        fail the create at E3002, so the common set is the honest menu: a branch
        that is not here cannot be used by every repository anyway. */}
    <div className="dws-base-control" role="group" aria-labelledby={`${id}-base-label`}>
      <BaseRefPicker
        id={`${id}-uniform-base`}
        value={uniformRef}
        branches={commonBranches}
        loading={branches === undefined || branchesLoading}
        error={branchesError}
        disabled={fieldsDisabled}
        describedBy={`${id}-base-rules`}
        onChoose={setUniformBase}
        onRetry={() => setBranchesAttempt((attempt) => attempt + 1)}
      />
      {/* Said here, beside the field, because the two controls answer one question at
          two levels: a card's own picker overrides this value for that repository, and
          this value covers every repository the cards left alone. Without the sentence
          the field reads as "the" start point, and a reader who has already switched one
          card wonders why changing this one did not move it. */}
      <p className="dws-form-note">{t("baseRefUniformHint")}</p>
      {/* The hint's text, for a reader who cannot hover: same rules, in the field's own
          description rather than in a bubble. */}
      <span id={`${id}-base-rules`} className="dws-visually-hidden">{t("baseRefRules")}</span>
    </div>
  </div>

  const preview = <dl className="dws-preview" aria-live="polite" aria-atomic="true">
    <div className="dws-preview-row"><dt className="dws-preview-label">{t("branch")}</dt><dd className="dws-preview-value">{recovery?.branch ?? (taskBranch || "—")}</dd></div>
    <div className="dws-preview-row"><dt className="dws-preview-label">{t("taskDirectoryLabel")}</dt><dd className="dws-preview-value">{slashPath(recovery?.path ?? taskPath) || "—"}</dd></div>
  </dl>

  return (
    <Dialog open onOpenChange={(open) => { if (!open) dismiss() }}>
      <DialogContent busy={busy} className="dws-create-dialog">
        <header className="dws-dialog-heading">
          <DialogTitle className="dws-dialog-title">{t("dialogTitle")}</DialogTitle>
          <DialogDescription className="dws-form-note">{t("createDescription")}</DialogDescription>
          <div className="dws-repo-context"><strong>{target.title}</strong><code title={slashPath(target.path)}>{slashPath(target.path)}</code></div>
        </header>

        <form className="dws-create-form" onSubmit={(event) => { event.preventDefault(); void create() }} aria-busy={busy}>
          <div className="dws-dialog-body">
            {!loading && sourceReady ? picker : null}
            {loading ? <div className="dws-dialog-loading" role="status">
              <div><Loader2 size={16} className="dws-spin" aria-hidden="true" /> {t("loadingSourceRoot")}</div>
              <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
            </div> : !sourceReady ? <div className="dws-empty">
              <p>{t("notSourceRoot")}</p>
              <Button type="button" className="dws-button-ghost" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>{t("retry")}</Button>
            </div> : <div className="dws-form-fields">
              {base}
              {details}
              {preview}
            </div>}
          </div>

          {/* Outside the scrolling body, so it cannot scroll away from the button
              that acts on it. The body is the only part of this dialog that
              scrolls, and with two repositories selected the form is taller than
              the dialog - an error inside it was reachable only by scrolling up,
              and the sticky heading covers the first line when you do. */}
          {error ? <div className="dws-error dws-error-above-footer" role="alert"><AlertCircle size={16} aria-hidden="true" /><span>{error}</span></div> : null}

          <footer className="dws-dialog-footer">
            {recovery ? <>
              <Button type="button" className="dws-button-primary" disabled={busy} onClick={() => void retryRegister()}>{busy ? <Loader2 size={16} className="dws-spin" aria-hidden="true" /> : null}{t("retryRegister")}</Button>
            </> : <>
              <Button type="button" className="dws-button-ghost" disabled={busy} onClick={dismiss}>{t("cancel")}</Button>
              <Button type="submit" className="dws-button-primary" disabled={busy || loading || !canCreate}>
                {busy ? <Loader2 size={16} className="dws-spin" aria-hidden="true" /> : null}
                {busy ? t("creating") : t("createAndOpen")}
              </Button>
            </>}
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  )
}

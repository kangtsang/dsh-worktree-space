import { useEffect, useId, useRef, useState } from "react"
import { AlertCircle, GitPullRequest, Loader2 } from "./icons"
import { createWorktreeApi } from "../lib/api"
import { format, useT } from "../lib/i18n"
import { slashPath, slugOf, taskDirectory } from "../lib/paths"
import type { TaskRootSuggestion, WorkspaceNavigation, WorkspacesService, Workspace } from "../lib/types"
import type { ConfigFormLike } from "./PluginConfigCard"
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input } from "./ui"

type BaseMode = "head" | "named"

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
 * The dialog drives the same host operations the `task_worktree_space` tool uses, so
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
  const [baseMode, setBaseMode] = useState<BaseMode>("head")
  const [namedBase, setNamedBase] = useState("")
  const [saveAsDefault, setSaveAsDefault] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  // Prevent duplicate mutations even before React commits the disabled state.
  const busyRef = useRef(false)
  const [recovery, setRecovery] = useState<{ task: string; tasksRoot: string; path: string; branch: string } | null>(null)

  useEffect(() => {
    setTaskName("")
    setBaseMode("head")
    setNamedBase("")
    setRecovery(null)
    setSaveAsDefault(false)
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
      setSelected(next.repositories.map((repository) => repository.name))
    }).catch((reason) => {
      if (alive) setError(String(reason?.message ?? reason))
    }).finally(() => {
      if (alive) setLoading(false)
    })
    return () => { alive = false }
  }, [api, target.path, loadAttempt])

  const repositories = suggestion?.repositories ?? []
  const suggestedPrefix = suggestion?.branchPrefix ?? FALLBACK_BRANCH_PREFIX
  // Clearing the field asks for the host's own default rather than for no prefix
  // at all, which is what the preview and the request then both say.
  const typedPrefix = branchPrefix.trim()
  const effectivePrefix = typedPrefix === "" ? configuredPrefix || suggestedPrefix : typedPrefix
  const prefixProblem = branchPrefixProblem(typedPrefix)
  // The checkbox promises a new default for the *next* task space, so it is offered
  // only for a prefix that could actually become one: an unset one has nothing to
  // save, and an unusable one would be refused by the Host. The field is prefilled
  // with the current default, so the box starts clear rather than already ticked.
  const canSaveDefault = typedPrefix !== "" && prefixProblem === "" && typedPrefix !== configuredPrefix
  // The host refuses separators and whitespace; this form additionally keeps the
  // name a valid Git ref, so the branch cannot fail later.
  const normalizedName = taskName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  const taskSlug = normalizedName ? slugOf(taskName) : ""
  const validSlug = /^[a-z0-9_][a-z0-9._-]*$/.test(taskSlug)
    && !taskSlug.includes("..") && !taskSlug.endsWith(".") && !taskSlug.endsWith(".lock")
  const taskBranch = validSlug && prefixProblem === "" ? `${effectivePrefix}${taskSlug}` : ""
  const taskPath = taskSlug !== "" && tasksRoot.trim() !== "" ? taskDirectory(tasksRoot.trim(), taskSlug) : ""
  const invalidName = taskName.length > 0 && !validSlug
  // Which rule it broke, in the order the checks run.
  const nameProblem = !invalidName ? "" : taskSlug === "" ? "invalidNameEmpty" : taskSlug.startsWith(".") ? "invalidNameLeadingDot" : taskSlug.includes("..") ? "invalidNameConsecutiveDots" : taskSlug.endsWith(".lock") ? "invalidNameLockSuffix" : taskSlug.endsWith(".") ? "invalidNameTrailingDot" : "invalidNameGeneric"
  // Each field's explanation rides on its own label line; the copy also stays in the
  // markup, hidden, for a reader that only hears the field.
  const nameNoteClass = invalidName ? "dws-field-note dws-field-note-warning" : "dws-field-note"
  const prefixNoteClass = prefixProblem !== "" ? "dws-field-note dws-field-note-warning" : "dws-field-note"
  const sourceReady = suggestion !== null && repositories.length > 0
  const fieldsDisabled = busy || loading || !sourceReady || !!recovery
  const baseRef = baseMode === "named" ? namedBase.trim() : ""
  const canCreate = validSlug && selected.length > 0 && tasksRoot.trim() !== "" && prefixProblem === ""

  const startBusy = () => { busyRef.current = true; setBusy(true); setError("") }
  const endBusy = () => { busyRef.current = false; setBusy(false) }
  const dismiss = () => { if (!busyRef.current) onClose() }

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
    catch (reason: any) { setError(`${t("registerFailed")} ${String(reason?.message ?? reason)}`) }
    finally { endBusy() }
  }

  const cleanupCreated = async () => {
    if (!recovery || busyRef.current) return
    startBusy()
    try {
      // The task is freshly created, so finishing it removes its worktrees and
      // the container while keeping the branches.
      await api.doneTask({ task: recovery.task, tasksRoot: recovery.tasksRoot })
      setRecovery(null)
      onClose()
    } catch (reason: any) {
      setError(format(t("cleanupFailed"), { error: String(reason?.message ?? reason), path: recovery.path }))
    } finally { endBusy() }
  }

  const create = async () => {
    if (busyRef.current || recovery || loading || !sourceReady) return
    if (!validSlug) {
      setError(t(taskName.trim() !== "" && nameProblem !== "" ? nameProblem : "fillTaskName"))
      return
    }
    if (prefixProblem !== "") {
      setError(t(prefixProblem))
      return
    }
    if (selected.length === 0) {
      setError(t("repositoriesHint"))
      return
    }
    startBusy()
    let created: { path: string; task: string } | undefined
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
        branchPrefix: effectivePrefix,
      })
      created = { path: result.path, task: result.task }
      // Ticking the box is a promise about the *next* task space, so the new default
      // is written only once this one exists - and a form that refuses it cannot
      // undo the task that was just created.
      if (saveAsDefault && canSaveDefault) {
        const accepted = await config?.set("defaultBranchPrefix", typedPrefix)
        setSaveAsDefault(false)
        if (!accepted) setError(t("branchPrefixNotSaved"))
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
      const detail = String(reason?.message ?? reason)
      if (phase === "open") {
        // The task and its registration are fine; only showing the Session failed.
        if (created) onCreated(created.path)
        setError(`${t("openFailed")}${detail}`)
        return
      }
      if (workspace?.workspaceId) {
        try {
          await workspaces.delete(workspace.workspaceId)
        } catch (cleanupError: any) {
          if (created) setRecovery({ ...created, tasksRoot: tasksRoot.trim(), branch: taskBranch })
          setError(format(t("cleanupFailed"), { error: String(cleanupError?.message ?? cleanupError), path: created?.path ?? "" }))
          return
        }
      }
      if (created) {
        setRecovery({ ...created, tasksRoot: tasksRoot.trim(), branch: taskBranch })
        setError(`${t("registerFailed")} ${detail}`)
      } else {
        setError(`${t("operationFailed")}${detail}`)
      }
    } finally {
      endBusy()
    }
  }

  const toggleRepository = (name: string, include: boolean) => {
    setSelected((current) => (include
      ? [...new Set([...current, name])]
      : current.filter((entry) => entry !== name)))
  }
  // Every card acts on one list, so the pair of actions below them is a property of the
  // field rather than of any one card: it says what the next click does to all of them.
  const setAllRepositories = (include: boolean) => {
    setSelected(include ? repositories.map((repository) => repository.name) : [])
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
        {repositories.map((repository) => <label key={repository.name} className="dws-check-option" htmlFor={`${id}-repo-${repository.name}`}>
          <input id={`${id}-repo-${repository.name}`} className="dws-checkbox" type="checkbox" checked={selected.includes(repository.name)} onChange={(event) => toggleRepository(repository.name, event.target.checked)} />
          {/* The same name-then-branch line the repository view renders, so a
              repository reads the same wherever this plugin lists it. */}
          <span className="dws-check-copy">
            <span className="dws-check-name">
              <span className="dws-check-label">{repository.name}</span>
              {repository.branch === undefined ? null : <span className="dws-branch-label" title={`${t("branch")}: ${repository.branch}`}><GitPullRequest size={12} /><span className="dws-branch-value">{repository.branch}</span></span>}
            </span>
            <span className="dws-check-path" title={slashPath(repository.path)}>{slashPath(repository.path)}</span>
          </span>
        </label>)}
      </div>
      {/* The rule comes back only when it has something to say: with nothing chosen, the
          sentence saying so sits where the actions would, so the field never grows a
          second empty line. */}
      <div className="dws-repo-picker-foot">
        {selected.length === 0 ? <p id={`${id}-repositories-note`} className="dws-field-note">{t("repositoriesHint")}</p> : null}
        <div className="dws-repo-actions">
          <span className="dws-check-count" aria-live="polite">{format(t("repositoriesCountLabel"), { count: String(selected.length), total: String(repositories.length) })}</span>
          <span className="dws-picker-tools">
            <button type="button" className="dws-link-button" onClick={() => setAllRepositories(true)}>{t("selectAll")}</button>
            <span className="dws-picker-divider" aria-hidden="true" />
            <button type="button" className="dws-link-button" onClick={() => setAllRepositories(false)}>{t("selectNone")}</button>
          </span>
        </div>
      </div>
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
        <label className="dws-field-label" htmlFor={`${id}-prefix`}><span id={`${id}-prefix-label`}>{t("branchPrefix")}</span><span className={prefixNoteClass}>{prefixProblem ? t(prefixProblem) : format(t("branchPrefixHint"), { prefix: effectivePrefix || suggestedPrefix })}</span></label>
        <Input id={`${id}-prefix`} aria-labelledby={`${id}-prefix-label`} value={branchPrefix} disabled={fieldsDisabled} onChange={(event) => setBranchPrefix(event.target.value)} placeholder={suggestedPrefix} autoComplete="off" spellCheck={false} aria-invalid={prefixProblem !== "" || undefined} aria-describedby={`${id}-prefix-note`} />
        <span id={`${id}-prefix-note`} className="dws-field-note dws-visually-hidden">{prefixProblem ? t(prefixProblem) : format(t("branchPrefixHint"), { prefix: effectivePrefix || suggestedPrefix })}</span>
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
        <label className="dws-field-label" htmlFor={`${id}-container`}><span id={`${id}-container-label`}>{t("containerLocation")}</span><span className="dws-field-note">{t("containerHint")}</span></label>
        <Input id={`${id}-container`} aria-labelledby={`${id}-container-label`} value={tasksRoot} disabled={fieldsDisabled} onChange={(event) => setTasksRoot(event.target.value)} autoComplete="off" spellCheck={false} aria-describedby={`${id}-container-note`} />
        <span id={`${id}-container-note`} className="dws-field-note dws-visually-hidden">{t("containerHint")}</span>
      </div>
    </div>
  </fieldset>

  const base = <fieldset className="dws-field dws-base-fieldset" disabled={fieldsDisabled}>
    <legend className="dws-field-legend"><span className="dws-field-label">{t("basedOn")}</span></legend>
    <div className="dws-radio-group" role="radiogroup" aria-label={t("basedOn")}>
      {(["head", "named"] as const).map((mode) => <label key={mode} htmlFor={`${id}-${mode}`} className="dws-radio-option" data-selected={baseMode === mode ? "true" : undefined}>
        <input id={`${id}-${mode}`} className="dws-radio-input" type="radio" name={`${id}-base`} value={mode} checked={baseMode === mode} onChange={() => setBaseMode(mode)} />
        <span className="dws-radio-copy"><span className="dws-radio-label">{t(mode === "head" ? "baseHead" : "baseNamed")}</span></span>
      </label>)}
    </div>
    {baseMode === "named" ? <>
      <Input className="dws-base-ref" value={namedBase} disabled={fieldsDisabled} onChange={(event) => setNamedBase(event.target.value)} placeholder={t("baseRefPlaceholder")} autoComplete="off" spellCheck={false} aria-label={t("baseNamed")} aria-describedby={`${id}-base-note`} />
      <p id={`${id}-base-note`} className="dws-form-note">{t("baseRefHint")}</p>
    </> : null}
  </fieldset>

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
            {error ? <div className="dws-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><span>{error}</span></div> : null}
            {!loading && sourceReady ? picker : null}
            {loading ? <div className="dws-dialog-loading" role="status">
              <div><Loader2 size={16} className="dws-spin" aria-hidden="true" /> {t("loadingSourceRoot")}</div>
              <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
            </div> : !sourceReady ? <div className="dws-empty">
              <p>{t("notSourceRoot")}</p>
              <Button type="button" className="dws-button-ghost" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>{t("retry")}</Button>
            </div> : <div className="dws-form-fields">
              {details}
              {base}
              {preview}
            </div>}
          </div>

          <footer className="dws-dialog-footer">
            {recovery ? <>
              <Button type="button" className="dws-button-danger" disabled={busy} onClick={() => void cleanupCreated()}>{t("cleanupTask")}</Button>
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

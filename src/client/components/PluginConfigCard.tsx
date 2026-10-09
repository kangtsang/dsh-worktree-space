import { useEffect, useRef, useState } from "react"
import { Check, ChevronDown } from "./icons"
import { Button, Dialog, DialogContent, DialogDescription, Input } from "./ui"
import { format, useT } from "../lib/i18n"
import { previewValue, setPreview, settlePreview, subscribePreview } from "../lib/config-preview"
import { ScanIgnoreEditor } from "./ScanIgnoreEditor"
import { DEFAULT_IGNORED_SCAN_DIRECTORIES, forcedIgnoreNames, sameIgnoreNames } from "../lib/scan-ignore"

/** How many directory levels a scan may descend. */
const DEPTHS = [1, 2, 3, 4, 5]
/** Directory caps the control offers. */
const DIRECTORY_LIMITS = [500, 1000, 2000, 3000, 5000, 10000]

/** One choice in a row: either a copy key or a literal shown as it stands. */
interface Choice {
  value: string
  key?: string
  text?: string
}

/** One row of this plugin's configuration. */
interface ChoiceField {
  kind?: "choices"
  field: string
  label: string
  fallback: string
  /** Numeric fields are written as numbers: the Host validates them against `z.number()`. */
  numeric?: boolean
  /** What the setting is for, shown under the label in the plugin's own grey. */
  hint?: string
  choices: Choice[]
}

/** A row whose value is typed rather than picked from a list. */
interface TextField {
  kind: "text"
  field: string
  label: string
  fallback: string
  hint?: string
  /**
   * Whether saving may send an empty value.
   *
   * False for the branch prefix, whose emptiness is a mistake the Host would only
   * catch after the round trip. True for the archive destination, where empty is the
   * setting's own "not set" and therefore a value worth sending.
   */
  allowEmpty?: boolean
}

/**
 * A row whose value is a list of names rather than one choice or one string.
 *
 * It gets a row of its own shape - a button that opens a dialog - because a list
 * cannot be shown in a pill without either truncating it or turning the control
 * into something that has to be scrolled. The dialog is the only place it is
 * edited, and nothing reaches the Host until that dialog is saved.
 */
interface ListField {
  kind: "list"
  field: string
  label: string
  /** The names the Host ships, shown read-only beneath the ones a user added. */
  builtIn: string[]
  hint?: string
}

type Field = ChoiceField | TextField | ListField

/**
 * Copy for a key the dictionary in force may not carry.
 *
 * `t` answers with the key itself when it has no entry for it, so the key is what
 * tells us the copy is missing: the row then shows a wording of its own rather than
 * putting `archiveDocumentsDirectory` on screen.
 * @param t - the translation function in force.
 * @param key - the key this row would like.
 * @param fallback - what to show while the key is not there.
 * @returns the translation, or the fallback.
 */
const copyOr = (t: (key: string) => string, key: string, fallback: string): string => {
  const translated = t(key)
  return translated === key ? fallback : translated
}

/** The copy key the archive destination row prefers, and what it shows without that key. */
export const ARCHIVE_DIRECTORY_LABEL = "archiveDocumentsDirectory"
export const ARCHIVE_DIRECTORY_LABEL_FALLBACK = "Custom archive directory"
/** The key for the note under it, and the wording shown without that key. */
export const ARCHIVE_DIRECTORY_HINT = "archiveDocumentsDirectoryHint"
export const ARCHIVE_DIRECTORY_HINT_FALLBACK = "Used only by the custom strategy; empty files them under the container root instead."

/** The row that decides which root archived documents are filed under. */
const ARCHIVE_STRATEGY_FIELD = "archiveDocumentsStrategy"
/** The strategy in force when the Host serves none, which is the schema's own default. */
const ARCHIVE_STRATEGY_FALLBACK = "container"

/** The row that names the directories a scan walks past. */
const IGNORED_SCAN_DIRECTORIES_FIELD = "ignoredScanDirectories"
const REMOVED_SCAN_DIRECTORIES_FIELD = "removedScanDirectories"

/** The row that decides where a new task space goes, and the directory it may name. */
const TASKS_ROOT_STRATEGY_FIELD = "tasksRootStrategy"
const TASKS_ROOT_DIRECTORY_FIELD = "tasksRootDirectory"
/** The strategy in force when the Host serves none, which is the schema's own default. */
const TASKS_ROOT_STRATEGY_FALLBACK = "default"

/** The row that decides whether a record of every operation is written. */
const AUDIT_LOG_FIELD = "auditLog"/**
 * The two states, as the Host schema spells them. The default is on: a log that
 * starts empty and is only turned on when something goes wrong arrives too late
 * to be the record of what went wrong.
 */
const AUDIT_LOG_ON = "on"
const AUDIT_LOG_OFF = "off"

/** The row that decides how much access the sessions handed an agent are opened with. */
const HANDOFF_ACCESS_FIELD = "handoffFullAccess"
/**
 * The two states, as the Host schema spells them. Off is the default and the one that
 * keeps the sandbox in the conversation: the session is opened on the directory that
 * reaches the git metadata a commit writes. On opens it on the container root with the
 * whole disk in reach, so it never has to ask.
 */
const HANDOFF_ACCESS_ON = "on"
const HANDOFF_ACCESS_OFF = "off"

/** The two rows that decide what the plugin does with DSH's own workspace list. */
const TOOL_REGISTERS_FIELD = "toolRegistersWorkspace"
const FINISH_UNREGISTERS_FIELD = "finishUnregistersWorkspace"
/**
 * Both are on/off, and both default to on. Off is the deliberate choice in each case - a
 * task space an agent made that never joins the list, or a finished one whose group is kept
 * - so the row names what on does rather than leaving "off" to be guessed at.
 */
const WORKSPACE_LIST_ON = "on"
const WORKSPACE_LIST_OFF = "off"

/**
 * The fields this plugin declares in its Host configuration.
 *
 * Rendered the way the Plugins page already shows this kind of choice: a label on
 * the left and a pill control on the right that opens a menu of named states. The
 * branch prefix is the exception - it is free text, so its row is an input and a
 * save button.
 */
const fieldsFor = (t: (key: string) => string): Field[] => [
  {
    field: "panelEntry",
    label: t("entryPanelLabel"),
    fallback: "hide",
    choices: [{ value: "show", key: "configShow" }, { value: "hide", key: "configHide" }],
  },
  {
    field: "sidebarEntry",
    label: t("entrySidebarLabel"),
    fallback: "show",
    choices: [{ value: "show", key: "configShow" }, { value: "hide", key: "configHide" }],
  },
  {
    // The experimental part of the finish: the two entries that hand uncommitted work,
    // and a merge conflict, to an agent. Shown is the default, so the row reads as a way
    // to turn it off rather than as something to discover.
    field: "handoffEntry",
    label: t("entryHandoffLabel"),
    fallback: "show",
    hint: t("entryHandoffHint"),
    choices: [{ value: "show", key: "configShow" }, { value: "hide", key: "configHide" }],
  },
  {
    // How much access those two entries get. Off is what the plugin has always done -
    // the session is opened where it can reach the repository's git metadata and asks
    // when it has to write outside that - and on is the arrangement that puts those
    // sessions under one Workspace at the price of the whole disk being in reach. The
    // hint is long on purpose: one of these two states is a permission, and the row is
    // the only place the cost can be said before someone picks it.
    field: HANDOFF_ACCESS_FIELD,
    label: t("handoffFullAccess"),
    fallback: HANDOFF_ACCESS_OFF,
    hint: t("handoffFullAccessHint"),
    choices: [
      { value: HANDOFF_ACCESS_OFF, key: "handoffFullAccessOff" },
      { value: HANDOFF_ACCESS_ON, key: "handoffFullAccessOn" },
    ],
  },
  {
    // What an agent's create does with DSH's own workspace list. On is what keeps an
    // agent-made task space from being one nothing in the interface shows and no second
    // create can take the name of; off leaves the registering to the user's own press.
    field: TOOL_REGISTERS_FIELD,
    label: t("toolRegistersWorkspace"),
    fallback: WORKSPACE_LIST_ON,
    hint: t("toolRegistersWorkspaceHint"),
    choices: [
      { value: WORKSPACE_LIST_ON, key: "toolRegistersWorkspaceOn" },
      { value: WORKSPACE_LIST_OFF, key: "toolRegistersWorkspaceOff" },
    ],
  },
  {
    // And what a finish does with it. On is the behaviour the panel has always had - the
    // directory is gone, so the entry is one nothing can open; off keeps the group, so that
    // task's sessions stay together instead of falling back to Ungrouped.
    field: FINISH_UNREGISTERS_FIELD,
    label: t("finishUnregistersWorkspace"),
    fallback: WORKSPACE_LIST_ON,
    hint: t("finishUnregistersWorkspaceHint"),
    choices: [
      { value: WORKSPACE_LIST_ON, key: "finishUnregistersWorkspaceOn" },
      { value: WORKSPACE_LIST_OFF, key: "finishUnregistersWorkspaceOff" },
    ],
  },
  {
    field: "scanDepth",
    label: t("scanDepth"),
    fallback: "2",
    numeric: true,
    hint: t("scanDepthHint"),
    choices: DEPTHS.map((depth) => ({ value: String(depth), text: format(t("scanDepthOption"), { count: String(depth) }) })),
  },
  {
    field: "maxScanDirectories",
    label: t("maxScanDirectories"),
    fallback: "2000",
    numeric: true,
    hint: t("maxScanDirectoriesHint"),
    choices: DIRECTORY_LIMITS.map((limit) => ({ value: String(limit), text: String(limit) })),
  },
  {
    // The one row that is neither a choice nor a single string. A list of
    // directory names does not fit a pill, and the part of it worth showing in
    // the row is only how many the scan skips beyond its own.
    kind: "list",
    field: IGNORED_SCAN_DIRECTORIES_FIELD,
    label: t("ignoredScanDirectories"),
    builtIn: DEFAULT_IGNORED_SCAN_DIRECTORIES,
    hint: t("ignoredScanDirectoriesHint"),
  },
  {
    kind: "text",
    field: "defaultBranchPrefix",
    label: t("defaultBranchPrefixSettingsLabel"),
    fallback: "task/",
    hint: t("defaultBranchPrefixHint"),
  },
  {
    // Where a new task space goes. The same shape as the archive location below, and
    // for the same reason: the default is a rule rather than a path, and only the
    // other choice is a directory the user names - in the row under this one. It is
    // offered first because it is asked before anything is created.
    field: TASKS_ROOT_STRATEGY_FIELD,
    label: t("tasksRootStrategy"),
    fallback: TASKS_ROOT_STRATEGY_FALLBACK,
    hint: t("tasksRootStrategyHint"),
    choices: [
      { value: "default", key: "tasksRootStrategyDefault" },
      { value: "custom", key: "tasksRootStrategyCustom" },
    ],
  },
  {
    // The container root only the custom strategy reads. Clearing it is how the
    // setting says "not set", which leaves the derived recommendation in place.
    kind: "text",
    field: TASKS_ROOT_DIRECTORY_FIELD,
    label: t("tasksRootDirectory"),
    fallback: "",
    hint: t("tasksRootDirectoryHint"),
    allowEmpty: true,
  },
  {
    // Which root archived documents are filed under. A choice rather than free text
    // because the shipped root is computed - from the container itself - and only the
    // other is a directory the user names, in the row below this one.
    field: ARCHIVE_STRATEGY_FIELD,
    label: t("archiveDocumentsStrategy"),
    fallback: ARCHIVE_STRATEGY_FALLBACK,
    hint: t("archiveDocumentsStrategyHint"),
    choices: [
      { value: "container", key: "archiveStrategyContainer" },
      { value: "custom", key: "archiveStrategyCustom" },
    ],
  },
  {
    // The root only the custom strategy reads. Clearing it is how the setting says
    // "not set", which falls back to the container root rather than leaving the archive
    // nowhere to go - so the field may be emptied as well as typed into. The row is
    // drawn only while that strategy is in force: a destination nothing reads would
    // look like a setting that is being ignored.
    kind: "text",
    field: "archiveDocumentsDirectory",
    label: copyOr(t, ARCHIVE_DIRECTORY_LABEL, ARCHIVE_DIRECTORY_LABEL_FALLBACK),
    fallback: "",
    hint: copyOr(t, ARCHIVE_DIRECTORY_HINT, ARCHIVE_DIRECTORY_HINT_FALLBACK),
    allowEmpty: true,
  },
  {
    // Whether a record of every operation is written. Last, because it is the setting
    // read least - the log is there, it is on, and nothing about using the plugin
    // depends on it. Written as on/off rather than as a checkbox so the row cannot be
    // read as "unchecked means off" without the words being there: turning this off
    // stops new records and leaves the log already on disk, which is not what
    // unticking something named "delete log" would suggest.
    field: AUDIT_LOG_FIELD,
    label: t("auditLog"),
    fallback: AUDIT_LOG_ON,
    hint: t("auditLogHint"),
    choices: [
      { value: AUDIT_LOG_ON, key: "auditLogOn" },
      { value: AUDIT_LOG_OFF, key: "auditLogOff" },
    ],
  },
]

/** The slice of the Host configuration form this card reads and writes. */
export interface ConfigFormLike {
  getSnapshot: () => { value?: unknown }
  subscribe: (listener: () => void) => () => void
  set: (field: string, value: unknown) => Promise<boolean>
}

/**
 * A row whose value is text rather than a choice.
 *
 * Locked it wears the same pill every other row's value wears, so the card reads as one
 * list; Edit swaps that pill for a field and turns itself into Save. Two reasons for the
 * swap rather than a read-only input. The Host page styles inputs itself - a border there
 * is not the plugin's to keep, and the plain markup of a value is - and a value nobody may
 * type into is not an input.
 *
 * Two rows use it now, and they differ on one point: the branch prefix refuses to be
 * emptied (a branch is its prefix plus a name, so an empty one is not a setting but a
 * mistake), while the archive destination is emptied on purpose - that is how the setting
 * says "not set" and hands each task back its own computed folder.
 */
function TextFieldRow({ field, label, fallback, hint, allowEmpty, form, notify }: {
  field: string
  label: string
  fallback: string
  hint?: string
  allowEmpty?: boolean
  form: ConfigFormLike
  notify: (message: string | null) => void
}) {
  const t = useT()
  const served = textOf(form.getSnapshot().value)[field] ?? fallback
  const [draft, setDraft] = useState(() => previewValue(field) ?? served)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const read = () => setDraft(previewValue(field) ?? textOf(form.getSnapshot().value)[field] ?? fallback)
    read()
    const stopPreview = subscribePreview(read)
    const stopForm = form.subscribe(read)
    return () => {
      stopPreview()
      stopForm()
    }
  }, [field, fallback, form])
  const save = () => {
    const value = draft.trim()
    // A row that may be cleared sends its emptiness on, rather than refusing it.
    if (value === "" && allowEmpty !== true) return
    setBusy(true)
    setPreview(field, value)
    notify(null)
    void form.set(field, value).then((accepted) => {
      setBusy(false)
      if (!accepted) {
        setPreview(field, undefined)
        notify(t("configNotSaved"))
        return
      }
      setEditing(false)
      notify(t("configSaved"))
    }).catch(() => {
      setBusy(false)
      setPreview(field, undefined)
      notify(t("configNotSaved"))
    })
  }
  return <div className="dws-plugin-config-row dws-plugin-config-prefix">
    <span className="dws-plugin-config-label">{label}
      {hint === undefined ? null : <span className="dws-plugin-config-hint">{editing ? t("configPrefixEditHint") : hint}</span>}
    </span>
    <span className="dws-plugin-config-field">
      <span className="dws-plugin-config-text">
        <Button className="dws-plugin-config-save" disabled={busy}
          onClick={editing ? save : () => { setEditing(true); notify(null) }}>
          {editing ? t("configSave") : t("configEdit")}
        </Button>
        {editing
          ? <span className="dws-plugin-config-edit"><Input value={draft} disabled={busy} aria-label={label} autoComplete="off" spellCheck={false}
            onChange={(event) => setDraft(event.target.value)} /></span>
          : <span className="dws-plugin-config-locked" aria-label={label}>{draft}</span>}
      </span>
    </span>
  </div>
}

/**
 * The question behind 恢复默认.
 *
 * A dialog rather than the button turning into 确认 with a 取消 beside it. That
 * pattern was here first and it failed quietly: the sentence explaining what the
 * click will undo lived in a `title`, which only exists on a hover, so on a
 * touchscreen the second click restored the defaults with nothing on screen having
 * said so. The words have to be visible at the moment of the click.
 */
function ResetConfirmDialog({ busy, onConfirm, onCancel }: {
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const t = useT()
  return <Dialog open onOpenChange={(open) => { if (!open) onCancel() }}>
    <DialogContent className="dws-confirm-dialog dws-confirm-narrow" busy={busy} showClose={false}>
      {/* One sentence, so no heading at all - see the same dialog in
          `ScanIgnoreEditor`. The sentence is the body. */}
      <div className="dws-dialog-body">
        <DialogDescription className="dws-confirm-body">{t("ignoredScanDirectoriesResetConfirm")}</DialogDescription>
      </div>
      <footer className="dws-dialog-footer">
        <Button disabled={busy} onClick={onCancel}>{t("cancel")}</Button>
        <Button className="dws-button-primary" disabled={busy} onClick={onConfirm}>{t("configConfirm")}</Button>
      </footer>
    </DialogContent>
  </Dialog>
}

/**
 * A row whose value is a list of directory names.
 *
 * The row itself carries no list: it carries how many names differ from what the
 * Host ships, because that is the only part of the answer that changes. The names
 * are in the dialog, which is the only place they are edited, and which is why
 * nothing here writes to the Host - a button that opens a dialog cannot half-save
 * a list.
 *
 * Two settings, because the dialog edits two: names added, and built-in names
 * switched back on. They are written together, because a user who turned a
 * built-in off and a user who added one made the same single decision - what the
 * scan walks past - and a dialog that saved half of it would be a dialog that
 * saved something nobody asked for. Both writes are awaited before the row closes,
 * so a refusal on either leaves it open with what it actually holds.
 */
function ListFieldRow({ field, removedField, label, hint, builtIn, form, notify }: {
  field: string
  removedField: string
  label: string
  hint?: string
  builtIn: string[]
  form: ConfigFormLike
  notify: (message: string | null) => void
}) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  // Restore defaults throws away every name in both settings at once, and up to
  // two hundred of them can be names a person typed. There is no undo for that,
  // so it is two clicks with the question in between - the same shape the dialog
  // uses for removing one built-in name, for the same reason.
  const [confirmingReset, setConfirmingReset] = useState(false)
  const list = (name: string): string[] => {
    const value = (form.getSnapshot().value as Record<string, unknown>)[name]
    if (!Array.isArray(value)) return []
    return value.map((entry) => String(entry ?? "")).filter((entry) => entry !== "")
  }
  // How many directories the scan skips, not how many settings differ from the
  // shipped ones. The row answers "how big is this list", and the count has to be
  // read off the same list the dialog opens on - hence forcedIgnoreNames rather
  // than a sum of the two array lengths, which would count a name twice.
  const [forced, setForced] = useState(() => forcedIgnoreNames(builtIn, list(field), list(removedField)))
  useEffect(() => {
    const read = () => setForced((current) => {
      const next = forcedIgnoreNames(builtIn, list(field), list(removedField))
      return sameIgnoreNames(current, next) ? current : next
    })
    read()
    return form.subscribe(read)
  }, [form, builtIn, field, removedField])
  const changed = list(field).length > 0 || list(removedField).length > 0
  const save = async (added: string[], removed: string[]) => {
    setBusy(true)
    // The count moves now, the way every other row in this card shows a choice
    // the moment it is made rather than a round trip later.
    setForced(forcedIgnoreNames(builtIn, added, removed))
    notify(null)
    try {
      const accepted = await form.set(field, added)
      // The second write only follows a first that landed. A dialog that added a
      // name and failed to switch a built-in on would leave the scan doing neither,
      // which is a state the user never asked for and cannot see.
      const switched = accepted && await form.set(removedField, removed)
      setBusy(false)
      if (!switched) {
        setForced(forcedIgnoreNames(builtIn, list(field), list(removedField)))
        notify(t("configNotSaved"))
        return
      }
      setEditing(false)
      notify(t("configSaved"))
    } catch {
      setBusy(false)
      setForced(forcedIgnoreNames(builtIn, list(field), list(removedField)))
      notify(t("configNotSaved"))
    }
  }
  // Both settings emptied, which is not a shorter list but the shipped one: the
  // names the user removed come back and the names they added go away.
  const reset = async () => {
    setConfirmingReset(false)
    setBusy(true)
    notify(null)
    try {
      const accepted = await form.set(field, [])
      const switched = accepted && await form.set(removedField, [])
      setBusy(false)
      if (!switched) {
        setForced(forcedIgnoreNames(builtIn, list(field), list(removedField)))
        notify(t("configNotSaved"))
        return
      }
      setForced(forcedIgnoreNames(builtIn, [], []))
      notify(t("configSaved"))
    } catch {
      setBusy(false)
      setForced(forcedIgnoreNames(builtIn, list(field), list(removedField)))
      notify(t("configNotSaved"))
    }
  }
  return <>
    <div className="dws-plugin-config-row">
      <span className="dws-plugin-config-label">{label}
        {hint === undefined ? null : <span className="dws-plugin-config-hint">{hint}</span>}
      </span>
      <span className="dws-plugin-config-field">
        <span className="dws-plugin-config-text">
          {/* Order: the two actions, then the count. The count is a fact about the
              list rather than a control, and trailing it keeps the two buttons
              together instead of putting a number between them. */}
          <span className="dws-plugin-config-actions">
          {/* Offered only when there is something to undo, and it disables itself
              while nothing is on the list. A button that is always there and always
              inert is one more thing to read past on every visit. */}
          <Button className="dws-plugin-config-save" disabled={busy || !changed}
            aria-label={t("ignoredScanDirectoriesReset")}
            title={t("ignoredScanDirectoriesReset")}
            onClick={() => { notify(null); setConfirmingReset(true) }}>
            {t("ignoredScanDirectoriesReset")}
          </Button>
          <Button className="dws-plugin-config-save" aria-label={t("ignoredScanDirectoriesEdit")} title={t("ignoredScanDirectoriesEdit")} disabled={busy}
            onClick={() => { notify(null); setEditing(true) }}>
            {t("configEdit")}
          </Button>
          </span>
          <span className="dws-plugin-config-locked" aria-label={label}>{format(t("ignoredScanDirectoriesCount"), { count: String(forced.length) })}</span>
        </span>
      </span>
    </div>
    {editing
      ? <ScanIgnoreEditor builtIn={builtIn} configured={list(field)} disabled={list(removedField)} busy={busy}
        onSave={(added, removed) => { void save(added, removed) }} onClose={() => { if (!busy) setEditing(false) }} />
      : null}
    {confirmingReset
      ? <ResetConfirmDialog busy={busy} onConfirm={() => { void reset() }} onCancel={() => { if (!busy) setConfirmingReset(false) }} />
      : null}
  </>
}

interface PluginConfigCardProps {
  /** The form the Host serves for this plugin, or undefined when there is none. */
  form?: ConfigFormLike
}

/** The pending choices, as the controls read them. */
function previewValues(): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of ["panelEntry", "sidebarEntry", "handoffEntry", HANDOFF_ACCESS_FIELD, TOOL_REGISTERS_FIELD, FINISH_UNREGISTERS_FIELD, "scanDepth", "maxScanDirectories", "defaultBranchPrefix", TASKS_ROOT_STRATEGY_FIELD, TASKS_ROOT_DIRECTORY_FIELD, ARCHIVE_STRATEGY_FIELD, "archiveDocumentsDirectory", AUDIT_LOG_FIELD]) {
    const value = previewValue(field)
    if (value !== undefined) values[field] = value
  }
  return values
}

/** The served section as strings: the Host resolves numbers and the copy shows text. */
function textOf(section: unknown): Record<string, string> {
  if (section === null || typeof section !== "object") return {}
  const entries = Object.entries(section as Record<string, unknown>)
  return Object.fromEntries(entries.map(([key, value]) => [key, value === undefined || value === null ? "" : String(value)]))
}

/**
 * This plugin's configuration, as the Plugins page shows it.
 *
 * The page draws a configuration section for a bundle that fills
 * `plugins.bundle.config`; declaring a Host schema is not enough on its own.
 *
 * A choice is shown the moment it is made and only settles into the served value
 * once the Host answers, which takes a round trip: without that the control looks
 * unresponsive for a second or two and invites a second click. A refused write
 * takes the optimistic value back, so the row never claims a setting that is not
 * in force.
 */
export function PluginConfigCard({ form }: PluginConfigCardProps) {
  const t = useT()
  // Read from the snapshot once up front, not only when it changes: the form is a
  // snapshot rather than something to wait on, so the first paint can already carry the
  // values in force. It matters here because the strategy among them is what decides
  // whether the custom archive directory row is drawn at all.
  const [served, setServed] = useState<Record<string, string>>(() => form === undefined ? {} : textOf(form.getSnapshot().value))
  const [chosen, setChosen] = useState<Record<string, string>>(() => previewValues())
  const [open, setOpen] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // The notice is dismissed on a timer, and the timer belongs to whichever
  // notice is on screen right now. It is scheduled here rather than in the
  // render body below, because a body runs on every render: each pass would
  // leave behind another timer it can never cancel, and the toast would then be
  // cleared by the *earliest* of them, well before the time it asks for. Above
  // the early return, so the hook count does not change with `form`.
  useEffect(() => {
    if (notice === null) return
    const timer = window.setTimeout(() => setNotice(null), 2400)
    return () => window.clearTimeout(timer)
  }, [notice])
  const card = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (form === undefined) return
    const read = () => {
      const next = textOf(form.getSnapshot().value)
      setServed(next)
      // A choice the Host has caught up with is no longer pending.
      settlePreview(next)
      setChosen(previewValues())
    }
    read()
    const stopForm = form.subscribe(read)
    const stopPreview = subscribePreview(() => setChosen(previewValues()))
    return () => {
      stopForm()
      stopPreview()
    }
  }, [form])
  useEffect(() => {
    if (open === null) return
    const close = (event: Event) => {
      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Escape") return
      if (event.type === "pointerdown" && card.current?.contains(event.target as Node)) return
      setOpen(null)
    }
    document.addEventListener("pointerdown", close)
    document.addEventListener("keydown", close)
    return () => {
      document.removeEventListener("pointerdown", close)
      document.removeEventListener("keydown", close)
    }
  }, [open])
  if (form === undefined) return null
  const pick = (field: string, choice: Choice, numeric?: boolean) => {
    setOpen(null)
    // Shown at once, and the sidebar follows through the same store.
    setPreview(field, choice.value)
    setNotice(t("configSaved"))
    // The Host's verdict is `false`; there being no verdict at all is a rejection,
    // and it answers about this row exactly as a refusal does. Only the first is
    // handled by the callback below, so without the `catch` a dropped connection
    // left the pending value set for good: this row and the sidebar's entry-visibility
    // both read it, and nothing on screen said the setting was never in force.
    void form.set(field, numeric ? Number(choice.value) : choice.value).then((accepted) => {
      if (accepted) return
      setPreview(field, undefined)
      setNotice(t("configNotSaved"))
    }).catch(() => {
      setPreview(field, undefined)
      setNotice(t("configNotSaved"))
    })
  }
  // The strategy in force decides whether the custom destination is worth a row, so it
  // is read here rather than inside the map, which filters on it. The pending value is
  // read first, so the row appears the moment the choice is made rather than a round
  // trip later. Both pairs work the same way: a directory that nothing reads would look
  // like a setting being ignored.
  const strategy = chosen[ARCHIVE_STRATEGY_FIELD] ?? served[ARCHIVE_STRATEGY_FIELD] ?? ARCHIVE_STRATEGY_FALLBACK
  const tasksRootStrategy = chosen[TASKS_ROOT_STRATEGY_FIELD] ?? served[TASKS_ROOT_STRATEGY_FIELD] ?? TASKS_ROOT_STRATEGY_FALLBACK
  const shown = (field: Field) => field.field === "archiveDocumentsDirectory"
    ? strategy === "custom"
    : field.field === TASKS_ROOT_DIRECTORY_FIELD ? tasksRootStrategy === "custom" : true
  return <div className="dws-plugin-config" ref={card}>
    {notice === null ? null : <div className="dws-config-toast" role="status">{notice}</div>}
    {fieldsFor(t).filter(shown).map((field) => {
      if (field.kind === "text") {
        return <TextFieldRow key={field.field} field={field.field} label={field.label} fallback={field.fallback} hint={field.hint} allowEmpty={field.allowEmpty} form={form} notify={setNotice} />
      }
      if (field.kind === "list") {
        return <ListFieldRow key={field.field} field={field.field} removedField={REMOVED_SCAN_DIRECTORIES_FIELD} label={field.label} hint={field.hint} builtIn={field.builtIn} form={form} notify={setNotice} />
      }
      const { field: name, label, fallback, numeric, choices, hint } = field
      const current = chosen[name] ?? served[name] ?? fallback
      // A value in force that the list does not offer joins it, so the control
      // shows what is set rather than the nearest preset.
      const offered = choices.some((choice) => choice.value === current)
      const all: Choice[] = offered ? choices : [...choices, { value: current, text: current }]
      const labelOf = (choice: Choice) => choice.text ?? t(choice.key ?? choice.value)
      const active = all.find((choice) => choice.value === current)
      return <div className="dws-plugin-config-row" key={name}>
        <span className="dws-plugin-config-label">{label}{hint === undefined ? null : <span className="dws-plugin-config-hint">{hint}</span>}</span>
        <span className="dws-plugin-config-field">
          <button type="button" className="dws-plugin-config-select" aria-label={label} aria-haspopup="menu" aria-expanded={open === name}
            onClick={() => setOpen(open === name ? null : name)}>
            <span className="dws-plugin-config-value">{active ? labelOf(active) : current}</span>
            <ChevronDown size={14} strokeWidth={1.3} aria-hidden="true" />
          </button>
          {open === name ? <div className="dws-plugin-config-menu" role="menu">
            {all.map((choice) => <button type="button" role="menuitem" key={choice.value} className="dws-plugin-config-item"
              data-selected={choice.value === current ? "true" : "false"}
              onClick={() => pick(name, choice, numeric)}>
              <span className="dws-plugin-config-item-label">{labelOf(choice)}</span>
              {choice.value === current ? <Check size={16} strokeWidth={1} aria-hidden="true" /> : null}
            </button>)}
          </div> : null}
        </span>
      </div>
    })}
  </div>
}

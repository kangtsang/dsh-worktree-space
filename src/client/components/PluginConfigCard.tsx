import { useEffect, useRef, useState } from "react"
import { Check, ChevronDown } from "./icons"
import { Button, Input } from "./ui"
import { format, useT } from "../lib/i18n"
import { previewValue, setPreview, settlePreview, subscribePreview } from "../lib/configPreview"

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
   * Whether the value needs room for a path rather than a word.
   *
   * The narrow column fits the pill's own width — right for a branch prefix, whose
   * values are short and whose row should read as one with the selects above it —
   * but an absolute directory would be cut off there, and a path nobody can read to
   * the end is not a setting anyone can check.
   */
  wide?: boolean
  /**
   * Whether saving may send an empty value.
   *
   * False for the branch prefix, whose emptiness is a mistake the Host would only
   * catch after the round trip. True for the archive destination, where empty is the
   * setting's own "not set" and therefore a value worth sending.
   */
  allowEmpty?: boolean
}

/** A row whose value is on or off. */
interface BooleanField {
  kind: "boolean"
  field: string
  label: string
  fallback: string
  hint?: string
}

type Field = ChoiceField | TextField | BooleanField

/**
 * Copy for a key that may not exist yet.
 *
 * Two sessions share this repository, and the one that owns `src/client/lib/i18n.ts`
 * carries the copy for this row. Until that lands, `t` answers with the key itself —
 * so the key is what tells us the copy is missing, and the row falls back to a
 * wording of its own rather than putting `archiveDocumentsDirectory` on screen.
 * @param t - the translation function in force.
 * @param key - the key this row would like.
 * @param fallback - what to show while the key is not there.
 * @returns the translation, or the fallback.
 */
const copyOr = (t: (key: string) => string, key: string, fallback: string): string => {
  const translated = t(key)
  return translated === key ? fallback : translated
}

/** The copy key the archive destination row prefers, and what it shows until that key exists. */
export const ARCHIVE_DIRECTORY_LABEL = "archiveDocumentsDirectory"
export const ARCHIVE_DIRECTORY_LABEL_FALLBACK = "Archive documents directory"
/** The key for the note under it, and the wording shown until that key exists. */
export const ARCHIVE_DIRECTORY_HINT = "archiveDocumentsDirectoryHint"
export const ARCHIVE_DIRECTORY_HINT_FALLBACK = "Leave it empty to file documents under each workspace's own default directory."

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
    field: "scanDepth",
    label: t("scanDepth"),
    fallback: "3",
    numeric: true,
    hint: t("scanDepthHint"),
    choices: DEPTHS.map((depth) => ({ value: String(depth), text: format(t("scanDepthOption"), { count: String(depth) }) })),
  },
  {
    field: "maxScanDirectories",
    label: t("maxScanDirectories"),
    fallback: "3000",
    numeric: true,
    hint: t("maxScanDirectoriesHint"),
    choices: DIRECTORY_LIMITS.map((limit) => ({ value: String(limit), text: String(limit) })),
  },
  {
    kind: "text",
    field: "defaultBranchPrefix",
    label: t("defaultBranchPrefixSettingsLabel"),
    fallback: "task/",
    hint: t("defaultBranchPrefixHint"),
  },
  {
    // The destination an archived task's documents are filed into. Empty is the
    // setting's "not set", so the field is allowed to be cleared as well as typed
    // into - clearing it puts every task back on its own computed folder.
    kind: "text",
    field: "archiveDocumentsDirectory",
    label: copyOr(t, ARCHIVE_DIRECTORY_LABEL, ARCHIVE_DIRECTORY_LABEL_FALLBACK),
    fallback: "",
    hint: copyOr(t, ARCHIVE_DIRECTORY_HINT, ARCHIVE_DIRECTORY_HINT_FALLBACK),
    wide: true,
    allowEmpty: true,
  },
  {
    // Both switches only decide what finishing does by itself. Neither overrides an
    // explicit `autoCommit`/`autoResolve` on the call, and neither ever picks a side.
    kind: "boolean",
    field: "autoCommitUncommitted",
    label: t("autoCommitUncommitted"),
    fallback: "false",
    hint: t("autoCommitUncommittedHint"),
  },
  {
    kind: "boolean",
    field: "autoResolveConflicts",
    label: t("autoResolveConflicts"),
    fallback: "false",
    hint: t("autoResolveConflictsHint"),
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
function TextFieldRow({ field, label, fallback, hint, wide, allowEmpty, form, notify }: {
  field: string
  label: string
  fallback: string
  hint?: string
  wide?: boolean
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
  return <div className={"dws-plugin-config-row dws-plugin-config-prefix" + (wide === true ? " dws-plugin-config-wide" : "")}>
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
 * A row whose value is on or off.
 *
 * Shown the moment it is switched and settled when the Host answers, like the choices: a
 * refusal puts the switch back, so the row never claims a setting that is not in force.
 * The label carries the meaning — "commit uncommitted work" — because "on" alone does not.
 */
function BooleanFieldRow({ field, label, fallback, hint, form, notify }: {
  field: string
  label: string
  fallback: string
  hint?: string
  form: ConfigFormLike
  notify: (message: string | null) => void
}) {
  const t = useT()
  const served = textOf(form.getSnapshot().value)[field] ?? fallback
  const [chosen, setChosen] = useState(() => previewValue(field) ?? served)
  useEffect(() => {
    const read = () => setChosen(previewValue(field) ?? textOf(form.getSnapshot().value)[field] ?? fallback)
    read()
    const stopPreview = subscribePreview(read)
    const stopForm = form.subscribe(read)
    return () => {
      stopPreview()
      stopForm()
    }
  }, [field, fallback, form])
  const on = chosen === "true"
  const turn = () => {
    const next = !on
    setChosen(String(next))
    setPreview(field, String(next))
    notify(null)
    void form.set(field, next).then((accepted) => {
      if (accepted) return
      setPreview(field, undefined)
      setChosen(served)
      notify(t("configNotSaved"))
    })
  }
  return <div className="dws-plugin-config-row">
    <span className="dws-plugin-config-label">{label}{hint === undefined ? null : <span className="dws-plugin-config-hint">{hint}</span>}</span>
    <span className="dws-plugin-config-field">
      <button type="button" role="switch" aria-checked={on} aria-label={label} className="dws-plugin-config-switch" data-on={on ? "true" : "false"} onClick={turn}>
        <span className="dws-plugin-config-switch-knob" aria-hidden="true" />
      </button>
    </span>
  </div>
}

interface PluginConfigCardProps {
  /** The form the Host serves for this plugin, or undefined when there is none. */
  form?: ConfigFormLike
}

/** The pending choices, as the controls read them. */
function previewValues(): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of ["panelEntry", "sidebarEntry", "scanDepth", "maxScanDirectories", "defaultBranchPrefix", "archiveDocumentsDirectory", "autoCommitUncommitted", "autoResolveConflicts"]) {
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
  const [served, setServed] = useState<Record<string, string>>({})
  const [chosen, setChosen] = useState<Record<string, string>>(() => previewValues())
  const [open, setOpen] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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
    void form.set(field, numeric ? Number(choice.value) : choice.value).then((accepted) => {
      if (accepted) return
      setPreview(field, undefined)
      setNotice(t("configNotSaved"))
    })
  }
  if (notice !== null) window.setTimeout(() => setNotice(null), 2400)
  return <div className="dws-plugin-config" ref={card}>
    {notice === null ? null : <div className="dws-config-toast" role="status">{notice}</div>}
    {fieldsFor(t).map((field) => {
      if (field.kind === "text") {
        return <TextFieldRow key={field.field} field={field.field} label={field.label} fallback={field.fallback} hint={field.hint} wide={field.wide} allowEmpty={field.allowEmpty} form={form} notify={setNotice} />
      }
      if (field.kind === "boolean") {
        return <BooleanFieldRow key={field.field} field={field.field} label={field.label} fallback={field.fallback} hint={field.hint} form={form} notify={setNotice} />
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

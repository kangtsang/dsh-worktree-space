import { useEffect, useRef, useState } from "react"
import { Check, ChevronDown } from "lucide-react"
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
interface Field {
  field: string
  label: string
  fallback: string
  /** Numeric fields are written as numbers: the Host validates them against `z.number()`. */
  numeric?: boolean
  choices: Choice[]
}

/**
 * The fields this plugin declares in its Host configuration.
 *
 * Rendered the way the Plugins page already shows this kind of choice: a label on
 * the left and a pill control on the right that opens a menu of named states.
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
    choices: DEPTHS.map((depth) => ({ value: String(depth), text: format(t("scanDepthOption"), { count: String(depth) }) })),
  },
  {
    field: "maxScanDirectories",
    label: t("maxScanDirectories"),
    fallback: "3000",
    numeric: true,
    choices: DIRECTORY_LIMITS.map((limit) => ({ value: String(limit), text: String(limit) })),
  },
]

/** The slice of the Host configuration form this card reads and writes. */
export interface ConfigFormLike {
  getSnapshot: () => { value?: unknown }
  subscribe: (listener: () => void) => () => void
  set: (field: string, value: unknown) => Promise<boolean>
}

interface PluginConfigCardProps {
  /** The form the Host serves for this plugin, or undefined when there is none. */
  form?: ConfigFormLike
}

/** The pending choices, as the controls read them. */
function previewValues(): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of ["panelEntry", "sidebarEntry", "scanDepth", "maxScanDirectories"]) {
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
    {fieldsFor(t).map(({ field, label, fallback, numeric, choices }) => {
      const current = chosen[field] ?? served[field] ?? fallback
      // A value in force that the list does not offer joins it, so the control
      // shows what is set rather than the nearest preset.
      const offered = choices.some((choice) => choice.value === current)
      const all: Choice[] = offered ? choices : [...choices, { value: current, text: current }]
      const labelOf = (choice: Choice) => choice.text ?? t(choice.key ?? choice.value)
      const active = all.find((choice) => choice.value === current)
      return <div className="dws-plugin-config-row" key={field}>
        <span className="dws-plugin-config-label">{label}</span>
        <span className="dws-plugin-config-field">
          <button type="button" className="dws-plugin-config-select" aria-label={label} aria-haspopup="menu" aria-expanded={open === field}
            onClick={() => setOpen(open === field ? null : field)}>
            <span className="dws-plugin-config-value">{active ? labelOf(active) : current}</span>
            <ChevronDown size={14} strokeWidth={1.3} aria-hidden="true" />
          </button>
          {open === field ? <div className="dws-plugin-config-menu" role="menu">
            {all.map((choice) => <button type="button" role="menuitem" key={choice.value} className="dws-plugin-config-item"
              data-selected={choice.value === current ? "true" : "false"}
              onClick={() => pick(field, choice, numeric)}>
              <span className="dws-plugin-config-item-label">{labelOf(choice)}</span>
              {choice.value === current ? <Check size={16} strokeWidth={1} aria-hidden="true" /> : null}
            </button>)}
          </div> : null}
        </span>
      </div>
    })}
  </div>
}

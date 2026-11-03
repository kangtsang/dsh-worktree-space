import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ChevronDown } from "./icons"
import { format, useT } from "../lib/i18n"
import { panelHost } from "../lib/panel-host"

/**
 * The branch a finished task merges into, chosen from the ones the Host listed.
 *
 * A native select showed the same list, but a repository can carry dozens of branches and
 * a select gives no way to narrow them: the list had to be scrolled branch by branch. The
 * control is therefore a button that opens a list with a search box, the shape the start
 * pickers in the create dialog already use. Its geometry stays the select's - the row is
 * one line of small text - so the plan reads the way it did.
 *
 * The panel is rendered inside the dialog that owns the button (see {@link panelHost}) and
 * fixed over the body, so the dialog's focus scope keeps the search box focusable.
 */
export interface TargetBranchPickerProps {
  /** The control's own accessible name, which names the repository it is for. */
  label: string
  value: string
  options: string[]
  disabled: boolean
  onChoose: (branch: string) => void
}

const PANEL_WIDTH = 240
const GAP = 6

export function TargetBranchPicker({ label, value, options, disabled, onChoose }: TargetBranchPickerProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [place, setPlace] = useState<{ left: number; top: number; width: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)

  const close = () => { setOpen(false); setQuery("") }

  // Placed on open and again when the viewport changes under it; a scroll closes it, the
  // way the start pickers do, rather than letting a fixed panel float away from its row.
  useLayoutEffect(() => {
    if (!open) return undefined
    const placeNow = () => {
      const box = button.current?.getBoundingClientRect()
      if (box === undefined) return
      const height = panel.current?.offsetHeight ?? 0
      const width = Math.min(Math.max(box.width, PANEL_WIDTH), window.innerWidth - 16)
      const below = box.bottom + height + GAP <= window.innerHeight
      setPlace({
        // Right edges line up when there is room: the row's own text sits to the left of
        // the control, so the list grows leftwards over the line it belongs to.
        left: Math.min(Math.max(box.right - width, 8), window.innerWidth - width - 8),
        top: below ? box.bottom + GAP : Math.max(8, box.top - height - GAP),
        width,
      })
    }
    placeNow()
    window.addEventListener("resize", placeNow)
    return () => window.removeEventListener("resize", placeNow)
  }, [open, options.length])

  useEffect(() => {
    if (!open) return undefined
    search.current?.focus()
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (panel.current?.contains(target ?? null) || button.current?.contains(target ?? null)) return
      close()
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close() }
    window.addEventListener("scroll", close, true)
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("keydown", onKeyDown, true)
    return () => {
      window.removeEventListener("scroll", close, true)
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("keydown", onKeyDown, true)
    }
  }, [open])

  const wanted = query.trim().toLowerCase()
  const shown = wanted === "" ? options : options.filter((branch) => branch.toLowerCase().includes(wanted))

  return <>
    <button
      ref={button}
      type="button"
      // The select's own classes: the row reads the same, and this stays the control the
      // plan's one line has room for.
      className="dws-select dws-plan-target dws-plan-picker"
      disabled={disabled}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={label}
      onClick={() => (open ? close() : setOpen(true))}
    >
      <span className="dws-plan-picker-value">{value === "" ? "—" : value}</span>
      <ChevronDown size={12} className="dws-plan-picker-caret" aria-hidden="true" />
    </button>
    {open ? createPortal(<div
      ref={panel}
      className="dws-branch-picker"
      role="group"
      aria-label={label}
      style={place === null ? { left: 0, top: 0, visibility: "hidden" } : { left: `${place.left}px`, top: `${place.top}px`, width: `${place.width}px` }}
    >
      <input
        ref={search}
        className="dws-input dws-branch-search"
        type="text"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("baseRefPickerSearch")}
        aria-label={t("baseRefPickerSearch")}
        autoComplete="off"
        spellCheck={false}
      />
      {shown.length === 0
        ? <p className="dws-field-note dws-branch-state">{format(t("baseRefFilterEmpty"), { query: query.trim() })}</p>
        : <div className="dws-branch-list"><ul className="dws-branch-options">
          {shown.map((branch) => <li key={branch}>
            <button
              type="button"
              className={branch === value ? "dws-branch-option dws-branch-option-chosen" : "dws-branch-option"}
              onClick={() => { onChoose(branch); close() }}
            >
              {branch}
            </button>
          </li>)}
        </ul></div>}
    </div>, panelHost(button.current)) : null}
  </>
}

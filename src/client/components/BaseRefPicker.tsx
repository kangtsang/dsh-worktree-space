import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { format, useT } from "../lib/i18n"
import { panelHost } from "../lib/panel-host"

/**
 * The task-wide start point, chosen from the branches every selected repository
 * carries.
 *
 * **The list is an intersection, and that is the whole of this control.** A
 * create sends one `baseRef` to every worktree it cuts, so a branch one
 * repository lacks fails the call at E3002 rather than starting that repository
 * somewhere else. Offering the union would hand the user a menu whose options
 * can fail; offering the intersection means every option works, and a branch
 * missing from here is one that could not have been used by all of them anyway.
 *
 * **It is a picker rather than a text field for the same reason.** A typed ref
 * cannot be checked until the create runs, so a typo costs the whole call. A
 * list built from what the repositories actually carry makes a wrong branch
 * unofferable instead of unlucky.
 *
 * The panel belongs to the dialog that owns the button (see
 * {@link panelHost}), and is placed from the button's own box: the dialog's body is a
 * scroller of its own, so the panel is fixed over it rather than nested in it, and it
 * stays inside the dialog's focus scope so its search box can be typed into.
 */
export interface BaseRefPickerProps {
  id: string
  /** The chosen shared branch, or "" for "each repository's own HEAD". */
  value: string
  /** Branches every selected repository carries, already intersected and sorted. */
  branches: string[]
  /** Whether the batch that carries the branch lists is still in flight. */
  loading: boolean
  /** Why the read failed; empty when it did not. */
  error: string
  disabled: boolean
  /** The element holding the long form of the rule, when the caller keeps one. */
  describedBy?: string
  onChoose: (branch: string) => void
  onRetry: () => void
}

const PANEL_WIDTH = 280
const GAP = 6

export function BaseRefPicker({ id, value, branches, loading, error, disabled, describedBy, onChoose, onRetry }: BaseRefPickerProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)

  const close = () => { setOpen(false); setQuery("") }

  useLayoutEffect(() => {
    if (!open) { setPlace(null); return }
    const box = button.current?.getBoundingClientRect()
    if (box === undefined) return
    const width = Math.min(Math.max(box.width, PANEL_WIDTH), 420)
    // Measured against the viewport, because the panel is fixed to it while the
    // dialog's body scrolls underneath: a position taken from the dialog's own
    // content box would drift by the scroll offset.
    const height = Math.min(320, 44 + branches.length * 28)
    const below = box.bottom + GAP
    const room = window.innerHeight - below
    // Upward when the field sits near the bottom, and then the panel's BOTTOM is
    // what meets the button - a top that was merely "above" would overlap the
    // field it belongs to.
    const top = room >= height + GAP
      ? below
      : Math.max(8, box.top - GAP - height)
    setPlace({
      left: Math.max(8, Math.min(box.left, window.innerWidth - width - 8)),
      top,
    })
  }, [open, branches.length])

  useEffect(() => {
    if (!open) return
    search.current?.focus()
    const onPointerDown = (event: PointerEvent) => {
      const node = event.target as Node
      if (panel.current?.contains(node) || button.current?.contains(node)) return
      close()
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close() }
    // Re-anchor rather than close: the dialog's body is the scroller here, and a
    // panel that vanished on the first wheel notch would be worse than one that
    // follows its field. Capture phase reaches the dialog's own scroller, which
    // never bubbles a scroll event to the window.
    const onScroll = () => {
      const box = button.current?.getBoundingClientRect()
      if (box === undefined) return
      setPlace((current) => current === null ? current : { ...current, top: Math.max(8, Math.min(box.bottom + GAP, window.innerHeight - 8)) })
    }
    window.addEventListener("scroll", onScroll, true)
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("keydown", onKeyDown, true)
    return () => {
      window.removeEventListener("scroll", onScroll, true)
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("keydown", onKeyDown, true)
    }
  }, [open])

  const wanted = query.trim().toLowerCase()
  const shown = wanted === "" ? branches : branches.filter((branch) => branch.toLowerCase().includes(wanted))
  // The state is always named. An empty list with nothing beside it would read as
  // "your repositories share no branches", which is a different claim from "the
  // lists have not arrived" or "they could not be read".
  const state = loading
    ? t("baseRefLoading")
    : error !== ""
      ? format(t("baseRefFailed"), { error })
      : branches.length === 0
        ? t("baseRefNoCommon")
        : shown.length === 0
          ? format(t("baseRefFilterEmpty"), { query: query.trim() })
          : ""

  return <>
    <button
      ref={button}
      id={id}
      type="button"
      className="dws-input dws-base-ref dws-base-ref-button"
      disabled={disabled}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-describedby={describedBy}
      onClick={() => (open ? close() : setOpen(true))}
    >
      <span className="dws-base-ref-value">{value === "" ? t("baseRefEachOwnHead") : value}</span>
    </button>
    {state === "" ? null : <p className="dws-form-note dws-branch-state">
      {state}
      {error === "" || loading ? null : <>{" "}<button type="button" className="dws-link-button" onClick={onRetry}>{t("baseRefRetry")}</button></>}
    </p>}
    {open ? createPortal(<div
      ref={panel}
      className="dws-branch-picker"
      role="group"
      aria-label={t("baseRefUniformLabel")}
      style={place === null ? { left: 0, top: 0, visibility: "hidden" } : { left: `${place.left}px`, top: `${place.top}px`, width: `${PANEL_WIDTH}px` }}
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
      {shown.length === 0 ? null : <ul className="dws-branch-options">
        {shown.map((branch) => <li key={branch}>
          <button
            type="button"
            className={branch === value ? "dws-branch-option dws-branch-option-chosen" : "dws-branch-option"}
            onClick={() => { onChoose(branch); close() }}
          >
            {branch}
          </button>
        </li>)}
      </ul>}
      {/* The way back to "each repository starts from its own HEAD", which is what
          an untouched dialog does and what a cleared field must restore. */}
      <button
        type="button"
        className={value === "" ? "dws-branch-option dws-branch-option-chosen" : "dws-branch-option"}
        onClick={() => { onChoose(""); close() }}
      >
        {t("baseRefEachOwnHead")}
      </button>
    </div>, panelHost(button.current)) : null}
  </>
}

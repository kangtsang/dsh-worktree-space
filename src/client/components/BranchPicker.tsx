import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { format, useT } from "../lib/i18n"
import { panelHost } from "../lib/panel-host"
import type { RepositoryBranches } from "../lib/types"

/**
 * A repository's start point, chosen from the branches that repository has.
 *
 * One flat list, because the Host offers local branches only. A remote tracking
 * branch would be a second spelling of a history the repository already carries
 * locally, so there is nothing here for a heading to keep apart.
 *
 * The panel is rendered inside the dialog that owns the button (see `panelHost`) and
 * placed from the button's own box: the dialog's body is a scroller of its own, so the
 * panel is fixed over it rather than nested in it, and it belongs to the dialog in the
 * DOM so its search box can keep focus.
 */
export interface BranchPickerProps {
  /** The repository the picker is for, named in the panel's own label. */
  repository: string
  /** What the Host knows of this repository's branches; undefined while unread. */
  entry: RepositoryBranches | undefined
  /** Whether the batch that carries this repository's branches is in flight. */
  loading: boolean
  /** Why the read failed; empty when it did not. */
  error: string
  /** The chosen start point, or undefined for "no override on this repository". */
  chosen: string | undefined
  /** The branch the repository has checked out, shown as the current default. */
  current: string | undefined
  onChoose: (branch: string | undefined) => void
  onRetry: () => void
}

const PANEL_WIDTH = 260
const PANEL_MIN = 220
const GAP = 6

export function BranchPicker({ repository, entry, loading, error, chosen, current, onChoose, onRetry }: BranchPickerProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [place, setPlace] = useState<{ left: number; top: number; width: number; below: boolean } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)

  const close = () => { setOpen(false); setPlace(null); setQuery("") }

  // The panel is fixed, so it is placed on open and placed again when the
  // viewport moves under it; a scroll closes it rather than following, which is
  // what this plugin's own hints do and what keeps a fixed panel from floating
  // away from the button it belongs to.
  useLayoutEffect(() => {
    if (!open) return undefined
    const placeNow = () => {
      const box = button.current?.getBoundingClientRect()
      if (box === undefined) return
      const height = panel.current?.offsetHeight ?? 0
      // Anchored to the card rather than to its button: a list as wide as the control it
      // hangs off reaches past the card into the next column, so the panel takes the
      // card's own box and ends where the card ends.
      const card = button.current?.closest<HTMLElement>(".dws-check-option")?.getBoundingClientRect()
      const width = Math.min(Math.max(card?.width ?? PANEL_WIDTH, PANEL_MIN), window.innerWidth - 16)
      const below = box.bottom + height + GAP > window.innerHeight
      setPlace({
        left: Math.min(Math.max(card?.left ?? box.left, 8), window.innerWidth - width - 8),
        top: below ? Math.max(8, box.top - height - GAP) : box.bottom + GAP,
        width,
        below,
      })
    }
    placeNow()
    window.addEventListener("resize", placeNow)
    return () => window.removeEventListener("resize", placeNow)
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    search.current?.focus()
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (panel.current?.contains(target ?? null)) return
      if (button.current?.contains(target ?? null)) return
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

  const all = entry?.branches ?? []
  const wanted = query.trim().toLowerCase()
  const shown = wanted === "" ? all : all.filter((branch) => branch.toLowerCase().includes(wanted))
  const truncated = entry?.truncated ?? 0

  const panelBody = <div
    ref={panel}
    className="dws-branch-picker"
    role="group"
    aria-label={format(t("baseRefPickerLabel"), { repository })}
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
    {/* A state is always named. An empty list with nothing beside it would be
        read as "this repository has no branches", which is a different claim
        from "the branches have not arrived" or "they could not be read". */}
    {loading ? <p className="dws-field-note dws-branch-state">{t("baseRefLoading")}</p> : error !== "" ? <p className="dws-field-note dws-branch-state dws-field-note-warning">
      {format(t("baseRefFailed"), { error })}
      {" "}
      <button type="button" className="dws-link-button" onClick={onRetry}>{t("baseRefRetry")}</button>
    </p> : all.length === 0 ? <p className="dws-field-note dws-branch-state">{t("baseRefEmpty")}</p> : shown.length === 0
      ? <p className="dws-field-note dws-branch-state">{format(t("baseRefFilterEmpty"), { query: query.trim() })}</p>
      : null}
    {shown.length === 0 ? null : <div className="dws-branch-list">
      <ul className="dws-branch-options">
        {shown.map((branch) => <li key={branch}>
          <button
            type="button"
            className={branch === chosen ? "dws-branch-option dws-branch-option-chosen" : "dws-branch-option"}
            onClick={() => { onChoose(branch); close() }}
          >
            {branch}
          </button>
        </li>)}
      </ul>
    </div>}
    {truncated === 0 ? null : <p className="dws-field-note dws-branch-state">{format(t("baseRefTruncated"), { count: String(truncated) })}</p>}
    {/* The way back to the dialog's own default: without it, a branch chosen
        once could never be un-chosen. */}
    <button
      type="button"
      className={chosen === undefined ? "dws-branch-option dws-branch-option-chosen" : "dws-branch-option"}
      onClick={() => { onChoose(undefined); close() }}
    >
      {t("baseRefReset")}
    </button>
  </div>

  return <>
    <button
      ref={button}
      type="button"
      className="dws-branch-button"
      onClick={() => setOpen((was) => !was)}
      aria-expanded={open}
      // The button names its own state, and then says what the choice is not: it picks
      // where this task's worktree starts, and never touches the branch the source
      // repository has checked out - which "switch branch" used to imply it would.
      title={`${chosen === undefined ? current === undefined ? t("baseRefReset") : format(t("baseRefCurrent"), { branch: current }) : format(t("baseRefChosen"), { branch: chosen })} · ${t("baseRefNotCheckout")}`}
    >
      {t("changeBaseRef")}
    </button>
    {open ? createPortal(panelBody, panelHost(button.current)) : null}
  </>
}

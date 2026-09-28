import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { ReactNode } from "react"

interface HoverHintProps {
  /** The bubble's text — what the anchor's icon is for. */
  label: string
  /** The class the anchor keeps: the hint wraps the caller's element, it does not restyle it. */
  className?: string
  /** Suppress the bubble without unmounting the anchor, which would cut its transitions. */
  disabled?: boolean
  /** Hover delay in milliseconds; keyboard focus stays immediate. */
  delayMs?: number
  children: ReactNode
}

const GAP = 8
const EDGE = 8

/**
 * A hover and focus hint, drawn in a bubble of the plugin's own.
 *
 * The composer, where the new-session entry lives, is a clipping and stacking context of
 * the shell's: a bubble positioned inside it would be cut off, or painted under the
 * surface beside it. The bubble is therefore portalled to the document body and placed
 * from the anchor's own box, in the shape the shell gives its own tooltips — fixed,
 * shrink-to-fit, and out of the pointer's way. The anchor is wrapped rather than cloned,
 * so whatever it does on click keeps doing it. The bubble restates the anchor's own
 * accessible name rather than describing it: the wrapper is not the focusable element,
 * and an `aria-describedby` there would be read by nothing.
 */
export function HoverHint({ label, className = "", disabled = false, delayMs = 120, children }: HoverHintProps) {
  const anchor = useRef<HTMLSpanElement>(null)
  const bubble = useRef<HTMLSpanElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<{ left: number; top: number; below: boolean } | null>(null)

  const close = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = undefined
    setOpen(false)
    setPlace(null)
  }, [])

  const openSoon = useCallback(() => {
    if (disabled) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOpen(true), delayMs)
  }, [delayMs, disabled])

  useEffect(() => () => window.clearTimeout(timer.current), [])
  useEffect(() => {
    if (disabled) close()
  }, [disabled, close])

  // The bubble is fixed, so it is placed on every open, and placed again when the
  // viewport changes under it; a scroll closes it, the way the shell closes its own.
  useLayoutEffect(() => {
    if (!open) return undefined
    const place1 = () => {
      const box = anchor.current?.getBoundingClientRect()
      if (box === undefined) return
      const half = (bubble.current?.offsetWidth ?? 0) / 2
      const height = bubble.current?.offsetHeight ?? 0
      // Above the anchor is the shell's default; below is the fallback when the anchor
      // sits too close to the top of the viewport for the bubble to fit.
      const below = box.top - height - GAP < EDGE
      setPlace({
        left: Math.min(Math.max(box.left + box.width / 2, half + EDGE), window.innerWidth - half - EDGE),
        top: below ? box.bottom + GAP : box.top - GAP,
        below,
      })
    }
    place1()
    window.addEventListener("resize", place1)
    window.addEventListener("scroll", close, true)
    return () => {
      window.removeEventListener("resize", place1)
      window.removeEventListener("scroll", close, true)
    }
  }, [open, close])

  return (
    <>
      <span
        ref={anchor}
        className={className}
        onMouseEnter={openSoon}
        onMouseLeave={close}
        onFocus={openSoon}
        onBlur={close}
        onKeyDown={(event) => {
          if (event.key === "Escape") close()
        }}
      >
        {children}
      </span>
      {open
        ? createPortal(
            <span
              ref={bubble}
              role="tooltip"
              className={place?.below === true ? "dws-hint dws-hint-below" : "dws-hint"}
              // The first pass measures the bubble before it is shown, so it must not
              // flash at the viewport's corner while it does.
              style={place === null ? { left: 0, top: 0, visibility: "hidden" } : { left: `${place.left}px`, top: `${place.top}px` }}
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </>
  )
}

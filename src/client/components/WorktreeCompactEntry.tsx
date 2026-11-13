import { createPortal } from "react-dom"
import { useEffect, useRef, useState } from "react"
import { BrandGlyph } from "./icons"
import { useT } from "../lib/i18n"

/**
 * The selector the host's settings row is found by.
 *
 * The shell exposes no slot at the end of that row, so the compact entry is portalled
 * into it. Both halves are class fragments rather than exact names because the host's
 * stylesheets are CSS modules: the class a build emits carries a hashed suffix, while
 * the name inside it is the one its source declares.
 *
 * `settingsArea` is the foot of the sidebar and `triggerRow` is the row inside it that
 * holds the Settings button and the account control. Anchoring on the row rather than
 * on the button keeps this icon beside the account, which is where the host puts its
 * own trailing controls, and out of the button that opens Settings.
 */
const SETTINGS_ROW = '[class*="settingsArea"] [class*="triggerRow"]'

/**
 * How many times the anchor is looked for before this settles for the fallback.
 *
 * The row mounts with the sidebar, which is after this component does. Twenty attempts
 * at 50ms is one second: long enough for the foot to appear on a slow first paint, and
 * short enough that a shell which will never have that row does not leave a timer
 * running for the rest of the session.
 */
const ANCHOR_ATTEMPTS = 20
const ANCHOR_RETRY_MS = 50

/**
 * The plugin's way in, as one icon at the end of the sidebar's settings row.
 *
 * The two other entries are the shell's own: a row in its panel list, and an action in
 * its footer. This one has no slot to register into — the row belongs to the host — so
 * the button is portalled into it, and it wears the plugin's own mark so it is
 * recognisable beside the account control it sits next to.
 *
 * It degrades rather than disappearing. Before the row exists, and on any shell whose
 * foot is not the one this was written against, the same button renders where the
 * component itself is mounted — which is the shell overlay, over the whole window. A
 * missing anchor costs the reader a differently placed icon, never a way in that is
 * silently gone.
 */
export function WorktreeCompactEntry({ onOpen }: { onOpen: () => void }) {
  const t = useT()
  const [anchor, setAnchor] = useState<Element | null>(null)
  const host = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (typeof document === "undefined") return undefined
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let observer: MutationObserver | undefined
    let disposed = false

    const attach = () => {
      if (disposed) return
      const row = document.querySelector(SETTINGS_ROW)
      if (row === null) {
        if (attempt < ANCHOR_ATTEMPTS) {
          attempt += 1
          timer = setTimeout(attach, ANCHOR_RETRY_MS)
        }
        return
      }
      const element = document.createElement("span")
      element.className = "dws-compact-entry"
      // The host re-renders its row without knowing about this node, so it is put back
      // whenever the row drops it. Watching the row rather than the document keeps the
      // observer's work proportional to one small element.
      observer = new MutationObserver(() => {
        if (host.current !== null && !host.current.isConnected) row.append(host.current)
      })
      observer.observe(row, { childList: true })
      row.append(element)
      host.current = element
      setAnchor(element)
    }

    attach()
    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      observer?.disconnect()
      host.current?.remove()
      host.current = null
    }
  }, [])

  const button = (
    <button
      type="button"
      className="dws-compact-entry-button"
      title={t("worktrees")}
      aria-label={t("worktrees")}
      onClick={onOpen}
    >
      <BrandGlyph size={18} className="dws-brand-glyph" />
    </button>
  )
  // The fallback is the same button, not nothing: a shell this could not attach to still
  // has a way in, and the overlay it lands in is the one the dialogs already use.
  return anchor === null
    ? <div className="dws-compact-entry dws-compact-entry-floating">{button}</div>
    : createPortal(button, anchor)
}

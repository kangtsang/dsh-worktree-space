import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"

/**
 * DSH currently exposes the hero workspace/preset as single slots, not an
 * action-list slot. Keep their official controls intact and place our owned
 * portal immediately before the preset, scoped to this composer's slot tree.
 * No generated CSS class names, translated labels or global selectors.
 * If the host topology changes, hide this shortcut (Settings still works).
 */
export function WorkspaceActionPlacement({ children }: { children: ReactNode }) {
  const marker = useRef<HTMLSpanElement>(null)
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const composer = marker.current?.closest('[data-slot="conversation.composer"]')
    if (!composer) return
    const mount = document.createElement("span")
    mount.className = "dws-hero-action"
    let attached = false
    const sync = () => {
      const preset = composer.querySelector('[data-slot="conversation.hero.agentPreset"]')
      const row = preset?.parentElement
      if (!preset || !row || !row.querySelector('button[aria-haspopup="menu"]')) {
        if (attached) { mount.remove(); attached = false; setTarget(null) }
        return
      }
      if (mount.parentElement !== row || mount.nextSibling !== preset) row.insertBefore(mount, preset)
      if (!attached) { attached = true; setTarget(mount) }
    }
    const observer = new MutationObserver(sync)
    observer.observe(composer, { childList: true, subtree: true })
    sync()
    return () => { observer.disconnect(); mount.remove() }
  }, [])
  // react-dom's transitive typings resolve React 19 here; this portal contains
  // only this package's React 18 ReactNode and runs on the host's shared React.
  const portal = target ? createPortal(children, target) as ReactNode : null
  return <><span ref={marker} hidden data-dws-placement="" />{portal}</>
}

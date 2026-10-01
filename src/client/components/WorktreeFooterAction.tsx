import { BrandGlyph } from "./icons"
import { useT } from "../lib/i18n"

interface WorktreeFooterActionProps {
  /** Whether the sidebar is wide; false is the 56px rail, which shows icons only. */
  wide: boolean
  onOpen: () => void
}

/**
 * The Worktree Space entry in the sidebar's footer, beside Settings.
 *
 * It is the whole of this plugin's navigation: the management panel used to live
 * inside Settings, which buried a workspace tool among preferences. The rail shows
 * the icon alone, the wide sidebar adds the label, and the accessible name is
 * always present so the collapsed form is still announceable.
 */
export function WorktreeFooterAction({ wide, onOpen }: WorktreeFooterActionProps) {
  const t = useT()
  const label = t("worktrees")
  return (
    <button type="button" className="dws-footer-action" data-wide={wide ? "true" : "false"} title={label} aria-label={label} onClick={onOpen}>
      <span className="dws-footer-action-icon" aria-hidden="true"><BrandGlyph size={18} className="dws-brand-glyph" /></span>
      {wide ? <span className="dws-footer-action-label">{label}</span> : null}
    </button>
  )
}

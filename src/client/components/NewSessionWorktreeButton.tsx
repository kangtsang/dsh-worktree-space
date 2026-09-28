import { HoverHint } from "./HoverHint"
import { BrandGlyph } from "./icons"
import { Button } from "./ui"
import { useT } from "../lib/i18n"
import type { Workspace } from "../lib/types"
import type { SessionId } from "@deepseek-ai/dsh-session/types"

interface NewSessionWorktreeButtonProps {
  session: {
    sessionId: SessionId
    blank: boolean
  }
  useWorkspaces: <T>(selector: (state: { items: Workspace[] }) => T) => T
  onOpen: (workspace: Workspace) => void
  canCreate?: (workspace: Workspace) => boolean
}

export function NewSessionWorktreeButton({ session, useWorkspaces, onOpen, canCreate }: NewSessionWorktreeButtonProps) {
  const t = useT()
  const workspace = useWorkspaces((state) => state.items.find((item) => item.sessionIds?.includes(session.sessionId)))

  if (!session.blank || !workspace || (canCreate && !canCreate(workspace))) return null

  return (
    // The icon says nothing on its own: it wears the plugin's own mark, so the hint is
    // where the button names itself, on hover and on keyboard focus alike.
    <HoverHint label={t("newWorktreeSpace")} className="dws-new-session-action">
      <Button type="button" className="dws-new-session-button" aria-label={t("newWorktreeSpace")} onClick={() => onOpen(workspace)}>
        <BrandGlyph size={16} aria-hidden="true" />
      </Button>
    </HoverHint>
  )
}

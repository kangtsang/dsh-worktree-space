import { useT } from "../lib/i18n"
import type { Workspace, WorkspacesService, WorkspaceNavigation } from "../lib/types"
import { WorktreesSettings } from "./WorktreesSettings"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui"
import type { createWorktreeApi } from "../lib/api"
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client"

interface WorktreeManagePanelProps {
  api: ReturnType<typeof createWorktreeApi>
  workspaces: WorkspacesService
  uiWorkspace: WorkspaceNavigation
  sessions: ISessions
  /** Opens the create form; the panel steps aside for it. */
  onCreate: (target: Pick<Workspace, "path" | "title">) => void
  onClose: () => void
}

/**
 * The management panel, opened from the sidebar's footer entry.
 *
 * It is the settings page's own component in a wide dialog rather than a second
 * implementation of it, with the section's heading turned off because the dialog
 * supplies that heading — and the accessible title — itself.
 */
export function WorktreeManagePanel({ api, workspaces, uiWorkspace, sessions, onCreate, onClose }: WorktreeManagePanelProps) {
  const t = useT()
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="dws-manage-panel">
        <div className="dws-dialog-heading">
          <DialogTitle className="dws-dialog-title">{t("worktreesTitle")}</DialogTitle>
          <DialogDescription className="dws-form-note">{t("panelDescription")}</DialogDescription>
        </div>
        <div className="dws-dialog-body">
          <WorktreesSettings
            api={api}
            workspaces={workspaces}
            uiWorkspace={uiWorkspace}
            sessions={sessions}
            heading={false}
            onCreate={onCreate}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

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
 * The management page in a dialog, for the sidebar footer's shortcut.
 *
 * The panel row under New session opens the same page as a main panel; this is the
 * other way in, and it is a dialog on purpose: a shortcut at the foot of the sidebar
 * should not take the session you were reading off screen, and closing it puts you
 * back where you were. It is that page's own component rather than a second
 * implementation of it, with the heading turned off because the dialog supplies one
 * — and the accessible title — of its own.
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

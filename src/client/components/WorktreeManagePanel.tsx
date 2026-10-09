import { useT } from "../lib/i18n"
import type { Workspace, WorkspacesService, WorkspaceNavigation } from "../lib/types"
import { WorktreesPage } from "./WorktreePanel"
import type { ConfigFormLike } from "./PluginConfigCard"
import { PluginDescription } from "./PluginDescription"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui"
import type { createWorktreeApi } from "../lib/api"
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client"

interface WorktreeManagePanelProps {
  api: ReturnType<typeof createWorktreeApi>
  workspaces: WorkspacesService
  uiWorkspace: WorkspaceNavigation
  sessions: ISessions
  /** Opens the create form; the dialog steps aside for it. */
  onCreate: (target: Pick<Workspace, "path" | "title">) => void
  /** Shows the Host's Plugins page, from the navigation column's gear row. */
  onOpenSettings?: () => void
  onClose: () => void
  /** This plugin's configuration form, when the shell serves one; see {@link WorktreesPageProps}. */
  config?: ConfigFormLike
}

/**
 * The management page in a dialog, for the sidebar footer's shortcut.
 *
 * The panel row under New session opens the same page as a main panel; this is the
 * other way in, and it is a dialog on purpose: a shortcut at the foot of the sidebar
 * should not take the session you were reading off screen, and closing it puts you
 * back where you were. It draws the page the panel draws — the same navigation column,
 * the same lists — inside the dialog's own header and footer chrome, so the two ways
 * in are one page seen twice rather than two implementations of it.
 */
export function WorktreeManagePanel({ api, workspaces, uiWorkspace, sessions, onCreate, onOpenSettings, onClose, config }: WorktreeManagePanelProps) {
  const t = useT()
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="dws-manage-dialog">
        <header className="dws-manage-heading">
          <DialogTitle className="dws-dialog-title">{t("worktreesTitle")}</DialogTitle>
          <DialogDescription className="dws-form-note"><PluginDescription /></DialogDescription>
        </header>
        <WorktreesPage
          api={api}
          workspaces={workspaces}
          uiWorkspace={uiWorkspace}
          sessions={sessions}
          onCreate={onCreate}
          onOpenSettings={onOpenSettings}
          variant="dialog"
          onLeave={onClose}
          config={config}
        />
      </DialogContent>
    </Dialog>
  )
}

import { useT } from "../lib/i18n"
import type { Workspace, WorkspacesService, WorkspaceNavigation } from "../lib/types"
import { WorktreesPage } from "./WorktreePanel"
import type { ConfigFormLike } from "./PluginConfigCard"
import { PluginDescription } from "./PluginDescription"
import { UpdatePill } from "./UpdatePill"
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
  /** The host's directory chooser, when this deployment has one; see {@link WorktreesPageProps}. */
  pickDirectory?: () => Promise<string | null>
}

/**
 * The management page in a dialog, which is the only form it has.
 *
 * All three entries - the row in the sidebar's panel list, the shortcut in its footer,
 * and the compact icon beside the settings row - open this. A dialog rather than the
 * main column on purpose: a row in the sidebar should not take the session you were
 * reading off screen, and closing the dialog puts you back where you were. The panel
 * the row selects is a redirect to this, so there is one page rather than two frames
 * around one page.
 */
export function WorktreeManagePanel({ api, workspaces, uiWorkspace, sessions, onCreate, onOpenSettings, onClose, config, pickDirectory }: WorktreeManagePanelProps) {
  const t = useT()
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="dws-manage-dialog">
        <header className="dws-manage-heading">
          <div className="dws-title-row">
            <DialogTitle className="dws-dialog-title">{t("worktreesTitle")}</DialogTitle>
            <UpdatePill />
          </div>
          <DialogDescription className="dws-form-note"><PluginDescription /></DialogDescription>
        </header>
        <WorktreesPage
          api={api}
          workspaces={workspaces}
          uiWorkspace={uiWorkspace}
          sessions={sessions}
          onCreate={onCreate}
          onOpenSettings={onOpenSettings}
          onLeave={onClose}
          config={config}
          pickDirectory={pickDirectory}
        />
      </DialogContent>
    </Dialog>
  )
}

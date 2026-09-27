import { FolderGit2 } from "lucide-react"
import { useT } from "../lib/i18n"
import type { Workspace, WorkspacesService, WorkspaceNavigation } from "../lib/types"
import { WorktreesSettings } from "./WorktreesSettings"
import type { createWorktreeApi } from "../lib/api"
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client"

interface WorktreePanelPageProps {
  api: ReturnType<typeof createWorktreeApi>
  workspaces: WorkspacesService
  uiWorkspace: WorkspaceNavigation
  sessions: ISessions
  /** Opens the create form over this page; the page stays where it is. */
  onCreate: (target: Pick<Workspace, "path" | "title">) => void
}

/**
 * The management page as a main panel, beside the conversation.
 *
 * The main column is the shell's own seat for a plugin's own page — the sidebar row
 * in the panel list selects it by this panel's key — so the page gets the window
 * rather than the settings panel's column, which is what the Settings entry used to
 * confine it to.
 */
export function WorktreePanelPage({ api, workspaces, uiWorkspace, sessions, onCreate }: WorktreePanelPageProps) {
  const t = useT()
  return <section className="dws-panel" aria-label={t("worktreesTitle")}>
    <div className="dws-panel-scroll">
      <div className="dws-panel-content">
        <header className="dws-panel-heading">
          <h1>{t("worktreesTitle")}</h1>
          <p>{t("panelDescription")}</p>
        </header>
        <WorktreesSettings
          api={api}
          workspaces={workspaces}
          uiWorkspace={uiWorkspace}
          sessions={sessions}
          heading={false}
          onCreate={onCreate}
        />
      </div>
    </div>
  </section>
}

/**
 * The glyph on the sidebar's panel row.
 *
 * The row itself — label, order, selection, hover — belongs to the sidebar: a
 * registrant supplies the icon and nothing else, so this is the plugin's own mark
 * and no chrome of its own.
 */
export function WorktreePanelIcon({ size }: { size: number }) {
  return <FolderGit2 size={size} />
}

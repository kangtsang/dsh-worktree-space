import { ChevronLeft, FolderGit2 } from "lucide-react"
import { useState } from "react"
import { useT } from "../lib/i18n"
import type { Workspace, WorkspacesService, WorkspaceNavigation } from "../lib/types"
import { WORKTREE_VIEWS, WorktreesSettings, type WorktreeView } from "./WorktreesSettings"
import type { createWorktreeApi } from "../lib/api"
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client"

interface WorktreePanelPageProps {
  api: ReturnType<typeof createWorktreeApi>
  workspaces: WorkspacesService
  uiWorkspace: WorkspaceNavigation
  sessions: ISessions
  /** Opens the create form over this page; the page stays where it is. */
  onCreate: (target: Pick<Workspace, "path" | "title">) => void
  /** Shows the conversation again: this page took the column it was in. */
  onBack: () => void
}

/**
 * The management page as a main panel, beside the conversation.
 *
 * The main column is the shell's own seat for a plugin's own page — the sidebar row
 * in the panel list selects it by this panel's key — so the page gets the window
 * rather than the settings panel's column. It brings its own navigation for the same
 * reason the settings dialog has one: this page has three views, and a nav column
 * says which one you are in without squeezing the title line. The way back to the
 * conversation leads that column, because selecting this panel took its place.
 */
export function WorktreePanelPage({ api, workspaces, uiWorkspace, sessions, onCreate, onBack }: WorktreePanelPageProps) {
  const t = useT()
  // Tasks are the unit this page is about, so it opens on them; the other two views
  // are one click away in the column on the left.
  const [view, setView] = useState<WorktreeView>("tasks")
  return <section className="dws-panel" aria-label={t("worktreesTitle")}>
    <nav className="dws-panel-nav" aria-label={t("worktreesTitle")}>
      <button type="button" className="dws-panel-nav-back" onClick={onBack}>
        <ChevronLeft size={16} aria-hidden="true" />
        <span>{t("backToConversation")}</span>
      </button>
      <span className="dws-panel-nav-rule" aria-hidden="true" />
      {WORKTREE_VIEWS.map(([value, label]) => <button
        key={value}
        type="button"
        aria-current={view === value ? "true" : undefined}
        onClick={() => setView(value)}
      >{t(label)}</button>)}
    </nav>
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
          control={{ view, onView: setView }}
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

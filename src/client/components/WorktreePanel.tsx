import { useState } from "react"
import { useT } from "../lib/i18n"
import type { Workspace, WorkspacesService, WorkspaceNavigation } from "../lib/types"
import { worktreeNavItems, WorktreesSettings } from "./WorktreesSettings"
import type { WorktreeView } from "./WorktreesSettings"
import { BrandGlyph, Settings } from "./icons"
import type { createWorktreeApi } from "../lib/api"
import type { ConfigFormLike } from "./PluginConfigCard"
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client"

/** What every host of the management page supplies: its services and its frame. */
export interface WorktreesPageProps {
  api: ReturnType<typeof createWorktreeApi>
  workspaces: WorkspacesService
  uiWorkspace: WorkspaceNavigation
  sessions: ISessions
  /** Opens the create form; the dialog steps aside for it. */
  onCreate: (target: Pick<Workspace, "path" | "title">) => void
  /**
   * Shows this plugin's own configuration on the Host's Plugins panel. Left
   * out, the navigation column keeps only the three views: a host that cannot
   * reach that page must not offer a row that goes nowhere.
   */
  onOpenSettings?: () => void
  /**
   * The host's own way out of the page, for following a session out of the finish
   * dialog. The dialog passes its own close, so following a session there leaves the
   * page too rather than covering the conversation it just opened.
   */
  onLeave?: () => void
  /**
   * This plugin's configuration form, when the shell serves one, for the finish dialog's
   * switch: it is the one place that setting can be changed from the page rather than the
   * Plugins page, and it is handed down rather than read from a store so a host that has
   * no form simply does not offer the switch.
   */
  config?: ConfigFormLike
  /**
   * Opens the host's directory chooser, or undefined when this deployment has none.
   *
   * Handed down rather than read from a store: the page that adds a Workspace and the
   * page that adds a repository both name a directory, and the picker is the host's own
   * - so a shell that does not serve one keeps the text field rather than a button that
   * opens nothing.
   */
  pickDirectory?: () => Promise<string | null>
}

/**
 * The page's three views as a navigation column, the way the shell's sidebar draws a
 * list — the same radius, height, inset and fill its own rows use.
 *
 * Every host of the page reads this one column, so its views cannot drift apart: the
 * alignment is the shell sidebar's own right-aligned row, since a label reads from the
 * same edge wherever the column sits.
 *
 * The gear row is the one thing under the views, pinned to the foot of the column the
 * way the shell pins its own settings control to the foot of its sidebar: this is where
 * a reader who wants to change how the plugin behaves looks. It is offered only when
 * the host can actually reach the Plugins page — a row that goes nowhere is worse than
 * no row.
 */
export function WorktreesNav({ view, onView, onOpenSettings }: {
  view: WorktreeView
  onView: (view: WorktreeView) => void
  onOpenSettings?: () => void
}) {
  const t = useT()
  return <nav className="dws-nav" aria-label={t("worktreesTitle")}>
    {worktreeNavItems().map(({ value, label }) => <button
      key={value}
      type="button"
      className="dws-nav-item"
      aria-current={view === value ? "true" : undefined}
      onClick={() => onView(value)}
    ><span>{t(label)}</span></button>)}
    {onOpenSettings ? <button
      type="button"
      className="dws-nav-item dws-nav-settings"
      onClick={onOpenSettings}
    ><Settings size={16} aria-hidden="true" /><span>{t("pluginSettings")}</span></button> : null}
  </nav>
}

/**
 * The management views, in the frame the dialog gives them.
 *
 * The view lives here rather than in the dialog, so a switch means the same thing every
 * time the page opens, and only the rows the view lists scroll.
 */
export function WorktreesPage({ api, workspaces, uiWorkspace, sessions, onCreate, onOpenSettings, onLeave, config, pickDirectory }: WorktreesPageProps) {
  const t = useT()
  // A view is state, not a prop, so the dialog does not have to hold it: React unmounts
  // this component whenever the page closes, so every opening starts on the same view.
  const [view, setView] = useState<WorktreeView>("spaces")
  return <section className="dws-manage-page" aria-label={t("worktreesTitle")}>
    <WorktreesNav view={view} onView={setView} onOpenSettings={onOpenSettings} />
    <div className="dws-manage-page-content">
      <WorktreesSettings
        api={api}
        workspaces={workspaces}
        uiWorkspace={uiWorkspace}
        sessions={sessions}
        pickDirectory={pickDirectory}
        onCreate={onCreate}
        control={{ view, onView: setView }}
        onLeave={onLeave}
        config={config}
      />
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
  return <BrandGlyph size={size} className="dws-brand-glyph" />
}

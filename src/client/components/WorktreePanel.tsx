import { useState } from "react"
import { useT } from "../lib/i18n"
import type { Workspace, WorkspacesService, WorkspaceNavigation } from "../lib/types"
import { worktreeNavItems, WorktreesSettings } from "./WorktreesSettings"
import type { WorktreeView } from "./WorktreesSettings"
import { BrandGlyph, ChevronLeft } from "./icons"
import type { createWorktreeApi } from "../lib/api"
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client"

/** What every host of the management page supplies: its services and its frame. */
export interface WorktreesPageProps {
  api: ReturnType<typeof createWorktreeApi>
  workspaces: WorkspacesService
  uiWorkspace: WorkspaceNavigation
  sessions: ISessions
  /** Opens the create form; the host decides whether it covers the page or steps aside. */
  onCreate: (target: Pick<Workspace, "path" | "title">) => void
}

/**
 * The page's three views as a navigation column, the way the shell's sidebar draws a
 * list — the same radius, height, inset and fill its own rows use.
 *
 * Both hosts read this one column, so the panel's navigation and the dialog's cannot
 * drift apart: the alignment is the shell sidebar's own right-aligned row in both, since
 * a label reads from the same edge wherever the column sits. `onBack` leads it where the
 * host has somewhere to go back to — the panel replaced the conversation, so it does. A
 * dialog closes instead, with the shell's own button in the corner, so it passes nothing.
 */
export function WorktreesNav({ view, onView, onBack }: { view: WorktreeView; onView: (view: WorktreeView) => void; onBack?: () => void }) {
  const t = useT()
  return <nav className="dws-nav" aria-label={t("worktreesTitle")}>
    {onBack === undefined ? null : <>
      <button type="button" className="dws-nav-item" onClick={onBack}>
        <ChevronLeft size={16} aria-hidden="true" />
        <span>{t("backToConversation")}</span>
      </button>
      <span className="dws-nav-rule" aria-hidden="true" />
    </>}
    {worktreeNavItems().map(({ value, label }) => <button
      key={value}
      type="button"
      className="dws-nav-item"
      aria-current={view === value ? "true" : undefined}
      onClick={() => onView(value)}
    ><span>{t(label)}</span></button>)}
  </nav>
}

/**
 * The management views, in the frame their host asks for.
 *
 * The view lives here rather than in either host, so both open on the same one and a
 * switch means the same thing in both. The hosts differ only in their chrome: the panel
 * scrolls a page under a heading, the dialog scrolls a column beside its navigation.
 */
export function WorktreesPage({ api, workspaces, uiWorkspace, sessions, onCreate, variant, onBack }: WorktreesPageProps & {
  variant: "panel" | "dialog"
  /** Panel only: the way back to the conversation. */
  onBack?: () => void
}) {
  const t = useT()
  // A view is state, not a prop, so neither host has to hold it: React unmounts this
  // component whenever the page closes, so both hosts open on the same view anyway.
  const [view, setView] = useState<WorktreeView>("tasks")
  const settings = <WorktreesSettings
    api={api}
    workspaces={workspaces}
    uiWorkspace={uiWorkspace}
    sessions={sessions}
    heading={false}
    onCreate={onCreate}
    control={{ view, onView: setView }}
  />
  if (variant === "dialog") return <section className="dws-manage-page" aria-label={t("worktreesTitle")}>
    <WorktreesNav view={view} onView={setView} />
    <div className="dws-manage-page-content">{settings}</div>
  </section>
  return <section className="dws-panel" aria-label={t("worktreesTitle")}>
    <WorktreesNav view={view} onView={setView} onBack={onBack} />
    <div className="dws-panel-scroll">
      <div className="dws-panel-content">
        <header className="dws-panel-heading">
          <h1>{t("worktreesTitle")}</h1>
          <p>{t("panelDescription")}</p>
        </header>
        {settings}
      </div>
    </div>
  </section>
}

interface WorktreePanelPageProps extends WorktreesPageProps {
  /** Shows the conversation again: this page took the column it was in. */
  onBack: () => void
}

/**
 * The management page as a main panel, beside the conversation.
 *
 * The main column is the shell's own seat for a plugin's own page — the sidebar row
 * in the panel list selects it by this panel's key — so the page gets the window
 * rather than the settings panel's column. The way back to the conversation leads that
 * column, because selecting this panel took the column's place.
 */
export function WorktreePanelPage({ onBack, ...props }: WorktreePanelPageProps) {
  return <WorktreesPage {...props} variant="panel" onBack={onBack} />
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

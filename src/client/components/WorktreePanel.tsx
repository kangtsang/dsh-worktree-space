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
  /**
   * The host's own way out of the page, for following a session out of the finish
   * dialog. The panel leaves it out — its way back to the conversation says the same
   * thing, so that stands in — and the dialog passes its own close.
   */
  onLeave?: () => void
}

/**
 * The page's three views as a navigation column, the way the shell's sidebar draws a
 * list — the same radius, height, inset and fill its own rows use.
 *
 * Both hosts read this one column, so the panel's navigation and the dialog's cannot
 * drift apart: the alignment is the shell sidebar's own right-aligned row in both, since
 * a label reads from the same edge wherever the column sits. Only the views are in it:
 * the panel's way back to the conversation is the panel's own chrome, and it leads the
 * heading instead — see `WorktreeNavBack` — so that this column begins on the toolbar's
 * own line in both hosts.
 */
export function WorktreesNav({ view, onView }: { view: WorktreeView; onView: (view: WorktreeView) => void }) {
  const t = useT()
  return <nav className="dws-nav" aria-label={t("worktreesTitle")}>
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
 * The panel's way back to the conversation, in the shell's own row shape.
 *
 * It is not one of the three views, so it cannot sit in the view column without pushing
 * them off the toolbar's line; it leads the heading's band instead. The cell keeps the
 * column's width and its edge line whether or not there is somewhere to go back to, so
 * the two bands stay one column.
 */
function WorktreeNavBack({ onBack }: { onBack?: () => void }) {
  const t = useT()
  return <div className="dws-panel-lead-nav">
    {onBack === undefined ? null : <>
      <button type="button" className="dws-nav-item" onClick={onBack}>
        <ChevronLeft size={16} aria-hidden="true" />
        <span>{t("backToConversation")}</span>
      </button>
      <span className="dws-nav-rule" aria-hidden="true" />
    </>}
  </div>
}

/**
 * The management views, in the frame their host asks for.
 *
 * The view lives here rather than in either host, so both open on the same one and a
 * switch means the same thing in both. The hosts differ only in their chrome: the panel
 * keeps its heading and its way back above the two columns, the dialog puts the title in
 * the window's own header, and either way only the rows the view lists scroll.
 */
export function WorktreesPage({ api, workspaces, uiWorkspace, sessions, onCreate, variant, onBack, onLeave }: WorktreesPageProps & {
  variant: "panel" | "dialog"
  /** Panel only: the way back to the conversation. */
  onBack?: () => void
}) {
  const t = useT()
  // A view is state, not a prop, so neither host has to hold it: React unmounts this
  // component whenever the page closes, so both hosts open on the same view anyway.
  const [view, setView] = useState<WorktreeView>("spaces")
  const settings = <WorktreesSettings
    api={api}
    workspaces={workspaces}
    uiWorkspace={uiWorkspace}
    sessions={sessions}
    heading={false}
    onCreate={onCreate}
    control={{ view, onView: setView }}
    onLeave={onLeave ?? onBack}
  />
  if (variant === "dialog") return <section className="dws-manage-page" aria-label={t("worktreesTitle")}>
    <WorktreesNav view={view} onView={setView} />
    <div className="dws-manage-page-content">{settings}</div>
  </section>
  // The two bands of the panel's own chrome. The way back to the conversation and the
  // page's heading share the first one; the second one holds the view column and the
  // reading column, so the three tabs begin exactly where the toolbar above the rows
  // begins. That is the alignment the dialog has for free — it has no back row — and it
  // is why the back row cannot simply lead the view column.
  return <section className="dws-panel" aria-label={t("worktreesTitle")}>
    <div className="dws-panel-lead">
      <WorktreeNavBack onBack={onBack} />
      <header className="dws-panel-heading">
        <h1>{t("worktreesTitle")}</h1>
        <p>{t("panelDescription")}</p>
      </header>
    </div>
    <div className="dws-panel-body">
      <WorktreesNav view={view} onView={setView} />
      <div className="dws-panel-scroll">
        <div className="dws-panel-content">{settings}</div>
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

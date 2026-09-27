import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import type { Context } from "@deepseek-ai/cordis"
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client"
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots"
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client"
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client"
import type { ILayout } from "@deepseek-ai/dsh-client-ui-layout/client"
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client"
import type {} from "@deepseek-ai/dsh-client-ui-settings/client"
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client"
import type {} from "@deepseek-ai/dsh-api-workspace-controller/client"
import type {} from "@deepseek-ai/dsh-api-session-controller/client"
import css from "./styles.css"
import { ArchiveTaskDialog } from "./components/ArchiveTaskDialog"
import { CreateWorktreeDialog } from "./components/CreateWorktreeDialog"
import { NewSessionWorktreeButton } from "./components/NewSessionWorktreeButton"
import { PluginConfigCard } from "./components/PluginConfigCard"
import { WorkspaceMenuEntries } from "./components/WorkspaceMenuEntries"
import { WorkspaceActionPlacement } from "./components/WorkspaceActionPlacement"
import { WorktreeFooterAction } from "./components/WorktreeFooterAction"
import { WorktreeManagePanel } from "./components/WorktreeManagePanel"
import { WorktreePanelIcon, WorktreePanelPage } from "./components/WorktreePanel"
import { createWorktreeApi } from "./lib/api"
import { previewValue, subscribePreview } from "./lib/configPreview"
import { installLocale, NS, t } from "./lib/i18n"
import { cleanPath } from "./lib/paths"
import type { Workspace } from "./lib/types"

/** The client plugin context surface this plugin touches. */
export type WorktreeClientContext = Context & {
  connection: ConnectionHandle
  layout: ILayout
}

const STYLE_TAG = "data-dsh-worktree-space-style"

/**
 * Where this plugin's sidebar entry sits among the footer actions.
 *
 * sidebar.footer.action is a list slot: the sidebar sorts what every plugin
 * registers there by its own order, so placement is arranged rather than
 * claimed, and a plugin that wants to sit above this one only has to pick a
 * lower number. The default neighbours take 10.
 */
const SIDEBAR_FOOTER_ORDER = 5

/**
 * The management page's key, which is also its sidebar row's id.
 *
 * A keyed `main` slot and a `sidebar.panellist` list entry meet on this string: the
 * row is what selects the panel, and the page's own way back is `selectPanel(null)` —
 * the shell's reserved "show the Conversation" selection. The sidebar footer's
 * shortcut does not select it at all: it opens the same page as a dialog, so a
 * shortcut cannot move the session you were reading off screen.
 */
const PANEL_ID = "dsh-worktree-space"

/**
 * Where the row sits in the sidebar's panel list.
 *
 * The list sorts by `order`; the shipped rows take 10, so this sits after them and
 * before any plugin that asks for a larger number.
 */
const SIDEBAR_PANEL_ORDER = 20

function installStyles() {
  if (typeof document === "undefined" || document.querySelector(`style[${STYLE_TAG}]`)) return () => {}
  const style = document.createElement("style")
  style.setAttribute(STYLE_TAG, "")
  style.textContent = css
  document.head.appendChild(style)
  return () => style.remove()
}

export const WorktreePlugin = {
  name: "dsh-worktree-space",
  inject: ["slots", "connection", "locale", "workspaces", "uiWorkspace", "sessions", "layout"],
  apply(ctx: WorktreeClientContext) {
    ctx.effect(installStyles, "dsh-worktree-space styles")
    ctx.effect(() => installLocale(ctx), "dsh-worktree-space locale")
    const api = createWorktreeApi(ctx.connection)
    const workspaces = ctx.workspaces
    // Opening a Session belongs to the workspace navigation face: ISessions.open
    // was removed after 0.1.5, while openWorkspace reuses or creates the target
    // Workspace's blank Session and shows it in one action.
    const uiWorkspace = ctx.uiWorkspace
    // Archiving a task while a session in it is running would pull the directory
    // out from under that session, so the archive dialog reads their state.
    const sessions = ctx.sessions

    // Classification drives the "New task space" affordance in the
    // conversation composer: a workspace can hold a task when it is a repository
    // that is not a linked worktree, or a directory whose top-level children are
    // repositories — the multi-repository shape this plugin exists for.
    // Keep one stable snapshot until a current classification finishes. A
    // closure-only Set cannot tell the mounted dock that async data arrived.
    let classification = { sourceRootPaths: new Set<string>() }
    const classificationListeners = new Set<() => void>()
    const getClassification = () => classification
    const subscribeClassification = (listener: () => void) => {
      classificationListeners.add(listener)
      return () => { classificationListeners.delete(listener) }
    }
    let active = true
    let openCreate: (workspace: Pick<Workspace, "path" | "title">) => void = () => {}
    let openArchive: (path: string) => void = () => {}
    let openManage: () => void = () => {}
    let refreshGeneration = 0

    // Stable faces onto the handlers the overlay installs when it mounts. The menu
    // adapter lives outside React's tree and holds the props it was first given, so
    // handing it these wrappers - which read the current handler when a row is
    // clicked - keeps a click from landing on the placeholder that stood there
    // before the overlay mounted, without re-registering on every render.
    const requestCreate = (target: Pick<Workspace, "path" | "title">) => openCreate(target)
    const requestArchive = (path: string) => openArchive(path)

    const refreshClassification = async () => {
      if (!active) return
      const generation = ++refreshGeneration
      const items = workspaces.list.getSnapshot().items as Workspace[]
      const classified = await Promise.all(items.map(async (workspace) => {
        try {
          return await api.classifyRoot(workspace.path)
        } catch {
          return undefined
        }
      }))
      if (!active || generation !== refreshGeneration) return
      const sourceRootPaths = new Set<string>()
      for (const item of classified) {
        if (item?.isSourceRoot && item.path) sourceRootPaths.add(cleanPath(item.path))
      }
      classification = { sourceRootPaths }
      for (const listener of classificationListeners) listener()
    }

    ctx.effect(() => {
      active = true
      const dispose = workspaces.list.subscribe(() => { void refreshClassification() })
      void refreshClassification()
      return () => {
        active = false
        refreshGeneration += 1
        dispose()
        classificationListeners.clear()
      }
    }, "dsh-worktree-space workspace classification")

    function WorktreeOverlay() {
      // One overlay host for the dialogs this plugin floats over the shell: the
      // composer and the workspace list's menu open the create form, the menu also
      // opens the archive form, and the sidebar footer's shortcut opens the
      // management page here rather than switching the main column to it.
      const [request, setRequest] = useState<
        | { kind: "create"; target: Pick<Workspace, "path" | "title"> }
        | { kind: "archive"; path: string }
        | { kind: "manage" }
        | null
      >(null)
      // The menu offers a task space exactly where the composer's button does, so
      // both read the one classification rather than asking the Host again.
      const { sourceRootPaths } = useSyncExternalStore(subscribeClassification, getClassification, getClassification)
      const canCreate = useCallback((workspace: Workspace) => sourceRootPaths.has(cleanPath(workspace.path)), [sourceRootPaths])
      useEffect(() => {
        openCreate = (target) => setRequest({ kind: "create", target })
        openArchive = (path) => setRequest({ kind: "archive", path })
        openManage = () => setRequest({ kind: "manage" })
        return () => { openCreate = () => {}; openArchive = () => {}; openManage = () => {} }
      }, [])
      return <>
        <WorkspaceMenuEntries api={api} workspaces={workspaces} canCreate={canCreate} onCreate={requestCreate} onArchive={requestArchive} />
        {request?.kind === "create" ? (
          <CreateWorktreeDialog
            target={request.target}
            api={api}
            workspaces={workspaces}
            uiWorkspace={uiWorkspace}
            onCreated={() => {
              void refreshClassification()
            }}
            onClose={() => setRequest(null)}
          />
        ) : null}
        {request?.kind === "archive" ? (
          <ArchiveTaskDialog
            path={request.path}
            api={api}
            workspaces={workspaces}
            sessions={sessions}
            onArchived={() => {
              void refreshClassification()
            }}
            onClose={() => setRequest(null)}
          />
        ) : null}
        {request?.kind === "manage" ? (
          <WorktreeManagePanel
            api={api}
            workspaces={workspaces}
            uiWorkspace={uiWorkspace}
            sessions={sessions}
            onCreate={(target) => setRequest({ kind: "create", target })}
            onClose={() => setRequest(null)}
          />
        ) : null}
      </>
    }

    function WorktreeDock(props: PropsRuntime<"conversation.input.dock">) {
      const { sourceRootPaths } = useSyncExternalStore(
        subscribeClassification, getClassification, getClassification,
      )
      return (
        <WorkspaceActionPlacement><NewSessionWorktreeButton
          session={props.session}
          useWorkspaces={props.useWorkspaces}
          canCreate={(workspace) => sourceRootPaths.has(cleanPath(workspace.path))}
          onOpen={(workspace) => openCreate(workspace)}
        /></WorkspaceActionPlacement>
      )
    }

    ctx.slots.inject("conversation.input.dock", () => ctx.slots.register(
      { name: "conversation.input.dock", id: "dsh-worktree-space-new-session", order: -30, label: () => t("createTask") },
      (props: PropsRuntime<"conversation.input.dock">) => <WorktreeDock {...props} />,
    ))

    ctx.slots.inject("shell.overlay", () => ctx.slots.register(
      { name: "shell.overlay", id: "dsh-worktree-space-create", order: 30, label: () => t("createTask") },
      WorktreeOverlay,
    ))

    // The management page itself, registered once as the `main` panel its sidebar row
    // selects. It stays registered even when that row is hidden: the panel is what the
    // id means, and a hidden row is a preference, not an unbuilt page.
    ctx.slots.inject("main", () => ctx.slots.register(
      { name: "main", key: PANEL_ID },
      () => <WorktreePanelPage api={api} workspaces={workspaces} uiWorkspace={uiWorkspace} sessions={sessions} onCreate={(target) => openCreate(target)} onBack={() => ctx.layout.selectPanel(null)} />,
    ))

    // The plugin's two ways in, each shown or hidden by this plugin's own
    // configuration on the Plugins page — the same place, and the same shape, the
    // neighbouring plugins use. The values arrive through the `configForms` service
    // and are subscribed to, so the slots follow every change instead of waiting for a
    // reload. Without that service the defaults stand: both shown.
    //
    // The panel row is the front door — a row in the sidebar's panel list, under New
    // Session, where the native Plugins and Task board entries sit. The footer action
    // is a shortcut to the same page. Hiding one leaves the other, the workspace menu
    // and the composer's own button, so nothing becomes unreachable.
    // The panel row is asked for and the footer shortcut is assumed, which is what the
    // Host's defaults say: one way in is always there, a second one is a choice.
    let disposeEntries: Array<() => void> = []
    const showEntries = (value: { sidebarEntry?: string; panelEntry?: string } | undefined) => {
      for (const dispose of disposeEntries) dispose()
      disposeEntries = []
      if (value?.panelEntry === "show") {
        // A list slot: the sidebar owns the row and sorts by `order`, so placement is
        // arranged rather than claimed.
        disposeEntries.push(ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(
          { name: "sidebar.panellist", id: PANEL_ID, order: SIDEBAR_PANEL_ORDER, label: () => t("worktrees") },
          (props: PropsRuntime<"sidebar.panellist">) => <WorktreePanelIcon size={props.size} />,
        )))
      }
      if (value?.sidebarEntry !== "hide") {
        disposeEntries.push(ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
          { name: "sidebar.footer.action", id: "dsh-worktree-space", order: SIDEBAR_FOOTER_ORDER, label: () => t("worktrees") },
          (props: PropsRuntime<"sidebar.footer.action">) => <WorktreeFooterAction wide={props.wide} onOpen={() => openManage()} />,
        )))
      }
    }
    // DSH 0.1.7 addresses a settings form by the profile row's entry id, not by a
    // namespace the plugin registers: preferences live on the mount row. The locale
    // namespace below is a separate thing - it only carries this plugin's copy.
    const ENTRY_ID = "worktree-space"
    ctx.inject(["configForms"], (raw) => {
      const forms = raw.configForms
      if (forms === undefined || typeof forms.get !== "function") {
        showEntries(undefined)
        return
      }
      const form = forms.get(ENTRY_ID)
      // A pending choice counts here too: the entry appears or disappears with the
      // click rather than a round trip later.
      const read = () => {
        const served = form.getSnapshot().value as { sidebarEntry?: string; panelEntry?: string } | undefined
        showEntries({
          sidebarEntry: previewValue("sidebarEntry") ?? served?.sidebarEntry,
          panelEntry: previewValue("panelEntry") ?? served?.panelEntry,
        })
      }
      read()
      ctx.effect(() => form.subscribe(read), "dsh-worktree-space entry configuration")
      ctx.effect(() => subscribePreview(read), "dsh-worktree-space entry preview")
      // The Plugins page draws a configuration section for a bundle that fills this
      // slot: a declared Host schema is served but never shown on its own, and of
      // that schema the page serves the volatile preference fields. The registration
      // sits inside whileServed because that is what the page reads to decide a
      // bundle has configuration, and it is keyed by the settings namespace the Host
      // serves — the shape the neighbouring plugin uses for the same seat. The slot
      // name is asserted rather than typed: its declaration lives in the
      // plugin-manager package, part of the shell rather than a dependency of this
      // plugin. The card renders nothing without a form.
      if (typeof forms.whileServed !== "function") return
      ctx.effect(() => forms.whileServed([ENTRY_ID], () => ctx.slots.inject("plugins.bundle.config" as never, () => ctx.slots.register(
        { name: "plugins.bundle.config", key: NS, locale: NS } as never,
        () => <PluginConfigCard form={form as never} />,
      ))), "dsh-worktree-space plugin configuration card")
    })
  },
}

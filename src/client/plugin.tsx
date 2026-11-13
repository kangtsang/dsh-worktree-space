import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react"
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
import { PLUGIN_NAME } from "./lib/meta"
import { PluginConfigCard } from "./components/PluginConfigCard"
import type { ConfigFormLike } from "./components/PluginConfigCard"
import { WorkspaceMenuEntries } from "./components/WorkspaceMenuEntries"
import { WorkspaceActionPlacement } from "./components/WorkspaceActionPlacement"
import { WorktreeFooterAction } from "./components/WorktreeFooterAction"
import { WorktreeManagePanel } from "./components/WorktreeManagePanel"
import { WorktreePanelIcon } from "./components/WorktreePanel"
import { WorktreeCompactEntry } from "./components/WorktreeCompactEntry"
import { createWorktreeApi } from "./lib/api"
import { previewValue, subscribePreview } from "./lib/config-preview"
import { ENTRY_STYLE_FALLBACK, ENTRY_STYLE_FIELD, entryStyleOf, type EntryStyle, type LegacyEntrySwitches } from "./lib/entry-style"
import { installLocale, NS, t } from "./lib/i18n"
import { alertIconSvg, closeIconSvg } from "./lib/menu-icons"
import { type OpenCapability, openDirectoryWith, probeOpening } from "./lib/open-in-app"
import { canPickDirectory, pickDirectory } from "./lib/directory-picker"
import { cleanPath } from "./lib/paths"
import type { SourceRootClassification, Workspace } from "./lib/types"

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
 * sidebar's row addresses the panel by the id it registered, so the two have to agree.
 *
 * The page itself is a dialog now, opened by all three entries alike, so the panel this
 * key selects renders nothing but the redirect below. The registration stays because
 * the shell's own row handler is `selectPanel(id)` and that call throws for a key no
 * panel registered - and it throws from the sidebar's click handler, where a reader
 * cannot see why the row stopped working.
 */
const PANEL_ID = "dsh-worktree-space"

/**
 * Where the gear row takes the reader: this bundle's own detail page on the
 * shell's Plugins panel.
 *
 * The Plugins panel provides a `pluginNavigation` service whose `openBundle`
 * selects the panel and moves straight to one package's detail — the contract
 * the voice bundle uses for its own settings button. The package name is the
 * one the inventory lists this bundle under, which is `package.json`'s name,
 * the same string the loader registers this plugin's own card by.
 */
const BUNDLE_NAME = "dsh-worktree-space"

/**
 * This plugin's configuration form, once the shell has served one.
 *
 * Held at module scope because the form arrives inside an inject callback while the
 * dialog that needs it is rendered from a later closure: it is read for the
 * configured default branch prefix and written to when the user ticks the box that
 * remembers a new one. Undefined simply means no form is served, in which case the
 * dialog starts from the Host's own default and offers no checkbox.
 */
let pluginConfigForm: ConfigFormLike | undefined

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
  // `remote` is what carries the host's open-in-app and directory-picker namespaces, and
  // a nested namespace is declared separately - `remote` alone does not make
  // `remote.directoryPicker` readable. Declared rather than read opportunistically:
  // cordis throws on a service that is not injected, and the guarded read that swallowed
  // that throw made every host capability answer "unavailable" - which is how the
  // workspace menu came out with no "open in application" row on a machine that has one.
  inject: ["slots", "connection", "locale", "workspaces", "uiWorkspace", "sessions", "layout", "remote", "remote.session", "remote.directoryPicker"],
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
    // The host's own directory chooser, or nothing when this deployment has none. Both
    // hosts of the management page use it, so it is built once here rather than in
    // either of them.
    const picker = canPickDirectory(ctx) ? () => pickDirectory(ctx) : undefined

    // Stable faces onto the handlers the overlay installs when it mounts. The menu
    // adapter lives outside React's tree and holds the props it was first given, so
    // handing it these wrappers - which read the current handler when a row is
    // clicked - keeps a click from landing on the placeholder that stood there
    // before the overlay mounted, without re-registering on every render.
    const requestCreate = (target: Pick<Workspace, "path" | "title">) => openCreate(target)
    const requestArchive = (path: string) => openArchive(path)
    const requestManage = () => openManage()
    /**
     * The panel the reader was on, as of the last selection that was not this plugin's.
     *
     * Tracked by subscription rather than read when the row is clicked, because by then it
     * is too late: the shell's own row handler calls `selectPanel(id)` first, so a read at
     * that moment returns this plugin's key - every time - and the column could only ever
     * be put back to the conversation. Watching the selection instead means the value is
     * already correct when the click arrives.
     *
     * `null` is a real selection - the shell's "show the Conversation" - so the remembered
     * value is stored as `{ id }` and "nothing remembered" is a separate state. Reading a
     * remembered `null` as "nothing" would put the reader back on the conversation, which
     * is the bug this exists to avoid.
     */
    let panelBefore: { id: string | null } | null = null
    const rememberPanel = () => {
      const id = ctx.layout.panelInfo.getSnapshot().activePanelId as string | null
      // This plugin's own key is the one selection that says nothing about where the reader
      // was: it is the click, not the place they clicked from.
      if (id === PANEL_ID) return
      panelBefore = { id }
    }
    rememberPanel()
    ctx.effect(
      () => ctx.layout.panelInfo.subscribe(rememberPanel),
      "dsh-worktree-space last panel",
    )
    /**
     * Put the main column back where it was, then forget the memory.
     *
     * Both callbacks are hoisted out of the registration because the layout effect that
     * calls them lists them as dependencies: a fresh arrow per render would re-run the
     * redirect on every render, which would reopen the dialog each time.
     */
    const enterPanel = () => { openManage() }
    const restorePanel = () => {
      const previous = panelBefore
      panelBefore = null
      // Selecting a panel that has since been unregistered throws, and that check is the
      // shell's own. A failed restore falls back to the conversation, the one selection the
      // shell always has.
      try {
        ctx.layout.selectPanel((previous?.id ?? null) as never)
      } catch {
        ctx.layout.selectPanel(null)
      }
    }
    // The gear row's destination: this plugin's own configuration, which lives on
    // the shell's Plugins panel under this bundle's detail page. `pluginNavigation`
    // is the panel's published way in — it selects the panel and opens the bundle
    // in one step, without touching the current Session. Where the service is not
    // served (a shell without the Plugins panel), the row does nothing rather than
    // taking the management page down with a throw.
    const requestSettings = () => {
      try {
        const navigation = ctx.get("pluginNavigation") as { openBundle?: (name: string) => void } | undefined
        navigation?.openBundle?.(BUNDLE_NAME)
      } catch {
        // Nothing to open; the configuration stays reachable through the shell's own
        // navigation.
      }
    }

    const refreshClassification = async () => {
      if (!active) return
      const generation = ++refreshGeneration
      const items = workspaces.list.getSnapshot().items as Workspace[]
      const paths = items.map(workspace => workspace.path)
      if (paths.length === 0) {
        classification = { sourceRootPaths: new Set<string>() }
        for (const listener of classificationListeners) listener()
        return
      }
      // One request for the whole list. It walks every path now and answers now,
      // which is what decides whether a row offers to create a task space here -
      // so it is exactly the answer that must not be reused from last time. What
      // the single form cost was the round trip, one per Workspace, every time
      // the list changed at all.
      let classified: SourceRootClassification[]
      try {
        classified = await api.classifyRoots(paths)
      } catch {
        classified = []
      }
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

    /**
     * The `main` panel the sidebar row selects: opens the management dialog and puts the
     * main column back the way it found it.
     *
     * It renders nothing at all. The effect runs in the commit phase, which is before the
     * browser paints, so the column is restored in the same frame the row was clicked: what
     * a reader sees is the dialog opening over whatever they were looking at.
     *
     * **The column goes back to the panel that was selected before, not to the conversation.**
     * The first version always selected `null`, which is the shell's "show the Conversation"
     * selection - so opening this dialog from the Plugins page, a plugin detail page or the
     * task board quietly replaced that page with the conversation behind the dialog. The
     * reader closed the dialog and their page was gone. What the button promises is a dialog
     * over the screen they were on, so the panel that was selected is remembered on the way
     * in and selected again on the way out.
     *
     * `onOpen` is the dialog, `restore` puts the column back; both run once, and the effect's
     * dependencies are the two stable callbacks handed in below.
     */
    function WorktreePanelRedirect({ onOpen, restore }: { onOpen: () => void; restore: () => void }) {
      useLayoutEffect(() => {
        onOpen()
        restore()
      }, [onOpen, restore])
      return null
    }

    function WorktreeOverlay() {
      // One overlay host for the dialogs this plugin floats over the shell: the
      // composer and the workspace list's menu open the create form, the menu also
      // opens the archive form, and all three sidebar entries open the management
      // page here rather than switching the main column to it.
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
      // The entry in force, for the one form the overlay draws rather than registers.
      const entryStyleNow = useSyncExternalStore(subscribeEntryStyle, getEntryStyle, getEntryStyle)
      // What this deployment can open a directory with, asked once at mount. `null` until
      // the probe returns; the menu simply offers fewer rows until then rather than dead
      // ones, and a host with no desktop at all keeps the answer `available: false`.
      const [capability, setCapability] = useState<OpenCapability | null>(null)
      useEffect(() => {
        let live = true
        void probeOpening(ctx).then((answer) => { if (live) setCapability(answer) })
        return () => { live = false }
      }, [])
      // A failure notice about one press on a menu that has already closed. The action
      // goes through the host's own open-in-app capability, so a failure here means the
      // host declined rather than that this side built the wrong command - which is the
      // whole reason the command-building code is gone.
      const [revealFailure, setRevealFailure] = useState<{ message: string; detail?: string } | null>(null)
      const openIn = useCallback((path: string, application: string) => {
        void (async () => {
          if (await openDirectoryWith(ctx, path, application)) {
            setRevealFailure(null)
            return
          }
          setRevealFailure({ message: t("workspaceRevealFailed"), detail: t("workspaceRevealUnavailable") })
        })()
      }, [t])
      // Escape closes it, from anywhere. The card is a dead end without that: it has no
      // backdrop to click and sits in a corner a reader may be looking away from, so the
      // only obvious exit is the button - which is a small target for a message that is
      // covering part of what they were reading.
      useEffect(() => {
        if (revealFailure === null) return undefined
        const onKey = (event: KeyboardEvent) => {
          if (event.key === "Escape") setRevealFailure(null)
        }
        document.addEventListener("keydown", onKey, true)
        return () => document.removeEventListener("keydown", onKey, true)
      }, [revealFailure])
      useEffect(() => {
        openCreate = (target) => setRequest({ kind: "create", target })
        openArchive = (path) => setRequest({ kind: "archive", path })
        openManage = () => setRequest({ kind: "manage" })
        return () => { openCreate = () => {}; openArchive = () => {}; openManage = () => {} }
      }, [])
      return <>
        <WorkspaceMenuEntries api={api} workspaces={workspaces} canCreate={canCreate} onCreate={requestCreate} onArchive={requestArchive} onOpenIn={openIn} capability={capability} />
        {/* The compact entry lives here because it is not a slot registration: its button
            is portalled into the host's settings row, which is not a slot at all. The
            overlay is the one place this plugin always has mounted, and it is where the
            button falls back to when the row cannot be found. */}
        {entryStyleNow === "compact" ? <WorktreeCompactEntry onOpen={requestManage} /> : null}
        {revealFailure === null ? null : (
          // A card rather than a toast: the host exposes no general notice surface - its
          // own `RowToast` is a closed union of sidebar events - so this one carries the
          // shell's own card styling and stays until dismissed. An error that vanished on
          // its own would be one a reader can miss while looking at the window it is about.
          <div className="dws-error-card" role="alert">
            {/* `menu-icons` returns svg *markup*, which the imperatively built row menu
                inserts by assignment. React escapes a string child instead, so the first
                version printed the whole `<svg xmlns=…>` on screen and that run of text
                set the card's height. The markup is this plugin's own constant - nothing
                from a caller reaches it - which is what makes setting it as html safe. */}
            <span className="dws-error-card-mark" aria-hidden="true" dangerouslySetInnerHTML={{ __html: alertIconSvg }} />
            <div className="dws-error-card-body">
              <p className="dws-error-card-title">{revealFailure.message}</p>
              {revealFailure.detail === undefined ? null : (
                <p className="dws-error-card-detail">{revealFailure.detail}</p>
              )}
            </div>
            <button type="button" className="dws-error-card-close" aria-label={t("close")} onClick={() => setRevealFailure(null)}>
              <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: closeIconSvg }} />
            </button>
          </div>
        )}
        {request?.kind === "create" ? (
          <CreateWorktreeDialog
            target={request.target}
            api={api}
            workspaces={workspaces}
            uiWorkspace={uiWorkspace}
            config={pluginConfigForm ?? undefined}
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
            uiWorkspace={uiWorkspace}
            config={pluginConfigForm ?? undefined}
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
            config={pluginConfigForm ?? undefined}
            pickDirectory={picker}
            onCreate={(target) => setRequest({ kind: "create", target })}
            onOpenSettings={() => {
              // Close first: the dialog covers the main column, and the page it is
              // jumping to lives in that column — leaving it open would put the
              // Plugins page behind a window over it.
              setRequest(null)
              requestSettings()
            }}
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

    // The panel the sidebar row addresses, and the whole of it: selecting it opens the
    // management dialog and hands the main column straight back to the conversation.
    //
    // A redirect rather than the page, because there is one management page now. The
    // page used to be drawn here, in the main column, while the footer's shortcut drew
    // the same page in a dialog - two frames, two sets of rules about where the heading
    // and the way back sit, and two answers to "where does this open". The dialog is
    // what survived: a row in the sidebar should not take the session being read off
    // screen, and closing a dialog puts the reader back where they were.
    //
    // It stays registered whether or not the row is shown: the key is what the row means,
    // and a hidden row is a preference rather than an unbuilt page.
    ctx.slots.inject("main", () => ctx.slots.register(
      { name: "main", key: PANEL_ID },
      () => <WorktreePanelRedirect onOpen={enterPanel} restore={restorePanel} />,
    ))

    // The plugin's one way in, in whichever of its three forms the configuration asks
    // for. The value arrives through the `configForms` service and is subscribed to, so
    // the entry moves with the click instead of waiting for a reload. Without that
    // service the fallback stands: the footer shortcut.
    //
    // Exactly one form is registered at a time, which is the whole point of asking once
    // rather than twice: the two switches this replaced described two facts and offered
    // four arrangements, one of which put the plugin nowhere in the sidebar at all.
    // The entry in force, for the one host that is not a slot registration: the compact
    // button is portalled into the host's settings row, so the overlay draws it and needs
    // to hear about a change the way it hears about the classification. A stable snapshot
    // plus listeners, for the same reason that one has them - a closure alone cannot tell
    // a mounted component that the answer arrived.
    let entryStyle: EntryStyle = ENTRY_STYLE_FALLBACK
    const entryStyleListeners = new Set<() => void>()
    const getEntryStyle = () => entryStyle
    const subscribeEntryStyle = (listener: () => void) => {
      entryStyleListeners.add(listener)
      return () => { entryStyleListeners.delete(listener) }
    }
    let disposeEntries: Array<() => void> = []
    /** Whether {@link showEntries} has run at least once, for the early return below. */
    let entriesApplied = false
    /**
     * Register the entry the configuration asks for, once per actual change.
     *
     * The early return matters more than it looks: the form notifies on every write to
     * *any* field in this plugin's configuration, so re-registering unconditionally tore
     * the sidebar entry down and rebuilt it every time an unrelated setting was saved -
     * a visible flicker on a row nobody asked to move, and a fresh registration for the
     * sidebar to re-sort. The guard is on the style, which is the only thing this
     * function reads.
     */
    const showEntries = (style: EntryStyle = ENTRY_STYLE_FALLBACK) => {
      if (entriesApplied && style === entryStyle) return
      entriesApplied = true
      for (const dispose of disposeEntries) dispose()
      disposeEntries = []
      entryStyle = style
      for (const listener of entryStyleListeners) listener()
      if (style === "standard") {
        // A list slot: the sidebar owns the row and sorts by `order`, so placement is
        // arranged rather than claimed. Its click selects `main`, which redirects to the
        // dialog - see the panel registration above.
        disposeEntries.push(ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(
          { name: "sidebar.panellist", id: PANEL_ID, order: SIDEBAR_PANEL_ORDER, label: () => t("worktrees") },
          (props: PropsRuntime<"sidebar.panellist">) => <WorktreePanelIcon size={props.size} />,
        )))
      }
      if (style === "quick") {
        disposeEntries.push(ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
          { name: "sidebar.footer.action", id: "dsh-worktree-space", order: SIDEBAR_FOOTER_ORDER, label: () => t("worktrees") },
          (props: PropsRuntime<"sidebar.footer.action">) => <WorktreeFooterAction wide={props.wide} onOpen={requestManage} />,
        )))
      }
      // The third form has no slot to register into: the host's settings row is not a
      // slot, so the button is portalled into it and the overlay renders the host node.
      // It is mounted from the overlay rather than registered here for that reason.
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
      // The same form the Plugins page edits, published for the dialogs: the create
      // dialog reads the configured default branch prefix from it and writes a new
      // one back through it, rather than keeping a second copy of the setting.
      pluginConfigForm = form
      // A pending choice counts here too: the entry appears or disappears with the
      // click rather than a round trip later.
      const read = () => {
        const served = form.getSnapshot().value as ({ entryStyle?: string } & LegacyEntrySwitches) | undefined
        // The pending choice first, so the entry moves with the click rather than a round
        // trip later; then the served field, and only then the two switches it replaced.
        showEntries(entryStyleOf({
          entryStyle: previewValue(ENTRY_STYLE_FIELD) ?? served?.entryStyle,
          panelEntry: served?.panelEntry,
          sidebarEntry: served?.sidebarEntry,
        }))
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
      /**
       * One stable identity for the catalog read, for the life of this registration.
       *
       * Written as a hoisted constant rather than inline in the JSX below, and that is a
       * fix rather than tidiness: `loadModels={() => api.models()}` made a new function on
       * every render, the card's loading effect lists `loadModels` among its dependencies,
       * and so every render looked like a new request. The effect re-ran, which set
       * "loading", whose state change caused another render, which produced another
       * function - a loop that asked the Host for the catalog over and over and made the
       * row and everything under it flicker until the round trip finally settled.
       *
       * `api` is itself stable for this closure, so the function can be too.
       */
      const loadModels = () => api.models()
      ctx.effect(() => forms.whileServed([ENTRY_ID], () => ctx.slots.inject("plugins.bundle.config" as never, () => ctx.slots.register(
        { name: "plugins.bundle.config", key: NS, locale: NS } as never,
        () => <PluginConfigCard form={form as never} loadModels={loadModels} />,
      ))), "dsh-worktree-space plugin configuration card")
      // No capsule on the Plugins detail page. The update pill lives in this plugin's
      // own surfaces - the management dialog and the sidebar panel - where the reader
      // is working; the detail page is the Host's, and its uninstall row is not this
      // plugin's place to add to.
    })
  },
}

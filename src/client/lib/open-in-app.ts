/**
 * Opening a directory through DSH's own open-in-app capability.
 *
 * This plugin used to do it itself - probe for a launcher, spawn it detached, and hope
 * the window survived. That was wrong in a way worth recording: the Host runs plugin
 * subprocesses inside a confinement boundary, and a file manager does not keep its own
 * window - it hands the request to the running shell and exits. Every spelling of the
 * command failed the same way, and no amount of argv work could fix it, because the
 * defect was asking the Host to start something the Host was going to tear down.
 *
 * The Host already has the right answer, and it is a much larger one than "start a
 * file manager": `ctx.remote.session.openWorkspacePath` hands a path to the desktop
 * that owns it, `workspacePathApplications` reports the applications the OS has
 * registered for it, and `GET /open-in-app/apps` lists the catalog a directory can be
 * opened with. All three are the Host's to call: it knows the platform, it runs on the
 * machine with the desktop, and it is the only side that can reach a launcher the
 * confinement boundary is designed to stop.
 *
 * Everything here degrades to "no entry" rather than to a dead row. A deployment with
 * no desktop - a container, a remote headless host - answers `false` from the probe,
 * and the menu simply does not offer what cannot work.
 */

/**
 * The slice of `ctx.remote.session` this plugin calls, structurally typed.
 *
 * Deliberately not imported from the Host: the client bundle must not depend on the
 * Host package, and a structural type is what lets an older composition (which lacks
 * the namespace entirely) degrade instead of failing to load.
 */
interface SessionRemote {
  canOpenWorkspacePath(): Promise<{ ok: boolean; value?: boolean }>
  workspacePathApplications(request: { path: string }): Promise<{ ok: boolean; value?: readonly RawApplication[] }>
  openWorkspacePath(request: { path: string; action?: 'reveal'; application?: string }): Promise<{ ok: boolean }>
}

/** One application the Host reports as able to open a path. */
interface RawApplication {
  id: string
  name: string
  default: boolean
  icon: string | null
}

/** An application the menu can offer. */
export interface OpenTarget {
  id: string
  name: string
  /** A data URL the Host produced, or the Host's icon route; absent when it has none. */
  icon?: string
}

/** What this deployment can do, asked once and remembered. */
export interface OpenCapability {
  /** Whether the Host can hand a path to a desktop at all. */
  available: boolean
  /** The catalog: applications a *directory* can be opened with, in the Host's order. */
  applications: readonly OpenTarget[]
}

/**
 * The host routes for the catalog, in the form the browser addresses them.
 *
 * No leading slash, deliberately. The Host registers an absolute pathname and the
 * browser addresses a *document-relative* form of it - `"/open-in-app/apps".slice(1)` -
 * because the web UI is served from a subpath. A leading slash here resolves against
 * the document root instead and answers 404, which the caller reads as "the host has no
 * catalog" and turns into an empty submenu.
 */
const APPS_PATH = "open-in-app/apps"
const ICON_PATH = "open-in-app/icon"
const OPEN_PATH = "open-in-app/open"

/** A ctx that can resolve client services (the cordis client root). */
interface CtxLike {
  get(name: string): unknown
}

/**
 * The remote namespace, or undefined when this composition lacks it.
 *
 * Cordis throws when a service is read without a matching `inject` entry, so the read
 * is guarded: a page that mounts this plugin without the Host Remote assembly must
 * lose the feature, not fail to render.
 * @param ctx - the client root.
 * @returns the session remote, or undefined when it is not there.
 */
function remoteOf(ctx: CtxLike): SessionRemote | undefined {
  try {
    const remote = ctx.get("remote") as { session?: SessionRemote } | undefined | null
    const session = remote?.session
    return session !== undefined && typeof session.openWorkspacePath === "function" ? session : undefined
  } catch {
    return undefined
  }
}

/** Whether this deployment can open paths on a desktop, and with what. */
export async function probeOpening(ctx: CtxLike): Promise<OpenCapability> {
  const remote = remoteOf(ctx)
  if (remote === undefined) return { available: false, applications: [] }
  let available = false
  try {
    const answer = await remote.canOpenWorkspacePath()
    available = answer.ok && answer.value === true
  } catch {
    available = false
  }
  if (!available) return { available: false, applications: [] }
  return { available: true, applications: await catalog() }
}

/**
 * The applications a directory can be opened with, in the Host's menu order.
 *
 * A route rather than a remote call: this is the *catalog* of installed applications,
 * while the remote's `workspacePathApplications` answers a different question - which
 * handlers the OS registered for one file. Opening a folder is the catalog's job.
 * @returns the catalog, or an empty list when the route is unavailable.
 */
async function catalog(): Promise<readonly OpenTarget[]> {
  try {
    const response = await fetch(APPS_PATH)
    if (!response.ok) return []
    const payload = (await response.json()) as { apps?: unknown }
    const ids = Array.isArray(payload.apps) ? payload.apps.filter((id): id is string => typeof id === "string") : []
    return ids.map((id) => ({
      id,
      // The Host localizes these through its own `open-in-app` namespace, which this
      // plugin reads through its locale bridge in `plugin.tsx`; the id is the fallback.
      name: id,
      icon: `${ICON_PATH}/${encodeURIComponent(id)}`,
    }))
  } catch {
    return []
  }
}

/**
 * Reveal a directory in the machine's file manager.
 *
 * `action: 'reveal'` is the Host's file-manager navigation; without it the same call
 * would hand the path to the default application instead, which for a directory is not
 * what the menu entry means.
 * @param ctx - the client root.
 * @param path - the directory, absolute.
 * @returns whether the Host accepted it.
 */
export async function revealDirectory(ctx: CtxLike, path: string): Promise<boolean> {
  const remote = remoteOf(ctx)
  if (remote === undefined) return false
  try {
    const result = await remote.openWorkspacePath({ path, action: "reveal" })
    return result.ok
  } catch {
    return false
  }
}

/**
 * Open a directory with one application from the catalog.
 *
 * The remote is tried first because a registered application id is what it takes; a
 * catalog id is not a file-handler id, so the Host's own directory route is the
 * fallback - and that route is the one that launches "VS Code on this folder".
 * @param ctx - the client root.
 * @param path - the directory, absolute.
 * @param application - a catalog id from {@link probeOpening}.
 * @returns whether either route accepted it.
 */
export async function openDirectoryWith(ctx: CtxLike, path: string, application: string): Promise<boolean> {
  const remote = remoteOf(ctx)
  if (remote !== undefined) {
    try {
      const result = await remote.openWorkspacePath({ path, application })
      if (result.ok) return true
    } catch {
      // Falls through to the catalog route: a failure here says the id was not a
      // registered handler, which is exactly the case the other route exists for.
    }
  }
  try {
    const response = await fetch(OPEN_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app: application, path }),
    })
    return response.ok
  } catch {
    return false
  }
}

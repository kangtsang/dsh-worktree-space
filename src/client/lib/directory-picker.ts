/**
 * Choosing a directory through the host's own picker.
 *
 * Every path this plugin asks for - a Workspace, a repository root - is a directory on
 * the Host, and typing one by hand is both error-prone and unnecessary: DSH already
 * mounts a directory picker (`ctx.remote.directoryPicker`) and its own Workspace flow
 * uses it. This is the same call, so the dialog a user sees here is the one they see
 * everywhere else, including on deployments where the Host serves a browser instead of
 * an OS dialog.
 *
 * Two backends can be behind that namespace, and the caller does not care which:
 * `native` opens an OS chooser on the Host's screen, `browse` answers with directory
 * listings for a remote browser. Both come back the same way - an absolute path, or
 * `null` when the operator cancelled - so nothing here branches on the capability.
 */

/**
 * The slice of `ctx.remote.directoryPicker` this module calls.
 *
 * Structurally typed rather than imported: the client bundle must not depend on a Host
 * package, and a composition without the namespace has to degrade to "no picker"
 * instead of failing to load.
 */
interface DirectoryPickerRemote {
  pick(signal?: AbortSignal): Promise<{ ok: boolean; value?: string | null; error?: { message?: string } }>
}

/** A ctx that can resolve client services (the cordis client root). */
interface CtxLike {
  get(name: string): unknown
}

/**
 * The desktop bridge, when this page runs inside the DSH desktop shell.
 *
 * The shell exposes a native chooser over IPC before the Remote namespace is involved
 * (`__DSH_DIRECTORY_PICKER__`). It is checked first because a window owned by the
 * desktop can present a dialog that is modal to it, which is the interaction a user in
 * the app expects; the Remote route remains for the web client.
 */
interface DesktopBridge {
  pick(): Promise<string | null>
}

/**
 * Read one property without letting cordis' inject guard take the caller down.
 * @param ctx - the client root.
 * @param name - the service name.
 * @returns the value, or undefined when it is absent or guarded.
 */
function safeGet(ctx: CtxLike, name: string): unknown {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/**
 * Whether this deployment can open a directory chooser at all.
 *
 * Asked before an entry is offered: a Host with neither the Remote namespace nor the
 * desktop bridge cannot pick, and a button that opens nothing is worse than no button.
 * @param ctx - the client root.
 * @returns whether picking is possible.
 */
export function canPickDirectory(ctx: CtxLike): boolean {
  const bridge = (globalThis as { __DSH_DIRECTORY_PICKER__?: DesktopBridge }).__DSH_DIRECTORY_PICKER__
  if (bridge !== undefined && typeof bridge.pick === "function") return true
  const remote = safeGet(ctx, "remote") as { directoryPicker?: DirectoryPickerRemote } | undefined
  return remote?.directoryPicker !== undefined && typeof remote.directoryPicker.pick === "function"
}

/**
 * Open the chooser and answer with what the operator chose.
 *
 * `null` is a cancel, and it is not an error: the dialog closes and the field keeps
 * whatever it held. A failure - no backend, a chooser that would not start - throws, so
 * the caller can say so rather than leaving the button looking dead.
 * @param ctx - the client root.
 * @param signal - aborts the chooser, when the caller has a signal.
 * @returns the chosen absolute path, or null when the operator cancelled.
 * @throws Error when this deployment has no picker, or the picker failed.
 */
export async function pickDirectory(ctx: CtxLike, signal?: AbortSignal): Promise<string | null> {
  const bridge = (globalThis as { __DSH_DIRECTORY_PICKER__?: DesktopBridge }).__DSH_DIRECTORY_PICKER__
  if (bridge !== undefined && typeof bridge.pick === "function") {
    return await bridge.pick()
  }
  const remote = safeGet(ctx, "remote") as { directoryPicker?: DirectoryPickerRemote } | undefined
  const picker = remote?.directoryPicker
  if (picker === undefined || typeof picker.pick !== "function") {
    throw new Error("no directory picker is available on this deployment")
  }
  const result = await picker.pick(signal)
  if (!result.ok) {
    throw new Error(result.error?.message ?? "the directory picker failed")
  }
  return result.value ?? null
}

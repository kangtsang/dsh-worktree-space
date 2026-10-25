import { afterEach, describe, expect, it, vi } from "vitest"
import { canPickDirectory, pickDirectory } from "../src/client/lib/directory-picker.js"

/**
 * A ctx double that resolves one service, and throws for anything else - which is what
 * cordis does when a service is read without a matching `inject` entry. The module has
 * to survive that: a page mounting this plugin without the Remote assembly must lose
 * the button, not fail to render.
 */
function ctxWith(services) {
  return {
    get(name) {
      if (name in services) return services[name]
      throw new Error(`service ${name} is not injected`)
    },
  }
}

const remoteWith = (picker) => ({ remote: { directoryPicker: picker } })

afterEach(() => {
  delete globalThis.__DSH_DIRECTORY_PICKER__
})

describe("canPickDirectory", () => {
  it("says yes when the host serves the Remote picker", () => {
    expect(canPickDirectory(ctxWith(remoteWith({ pick: async () => ({ ok: true, value: "/a" }) })))).toBe(true)
  })

  it("says yes when the desktop bridge is present, even without the Remote", () => {
    // The shell exposes an IPC chooser before the Remote namespace is involved.
    globalThis.__DSH_DIRECTORY_PICKER__ = { pick: async () => "/b" }
    expect(canPickDirectory(ctxWith({}))).toBe(true)
  })

  it("says no when neither is there, and does not throw over the guarded read", () => {
    // cordis throws for an un-injected service; asking must not take the page down.
    expect(canPickDirectory(ctxWith({}))).toBe(false)
    expect(canPickDirectory(ctxWith({ remote: {} }))).toBe(false)
  })
})

describe("pickDirectory", () => {
  it("answers with the chosen path", async () => {
    const pick = vi.fn(async () => ({ ok: true, value: "/chosen/dir" }))
    expect(await pickDirectory(ctxWith(remoteWith({ pick })))).toBe("/chosen/dir")
    expect(pick).toHaveBeenCalledTimes(1)
  })

  it("treats a cancel as null rather than as a failure", async () => {
    // A user who backs out of the chooser has not hit an error: the field keeps what it
    // held and nothing is reported.
    const pick = vi.fn(async () => ({ ok: true, value: null }))
    expect(await pickDirectory(ctxWith(remoteWith({ pick })))).toBeNull()
  })

  it("prefers the desktop bridge when the page runs inside the shell", async () => {
    // A dialog modal to the window is the interaction a user in the app expects, so the
    // bridge wins over the Remote even when both are available.
    const bridge = vi.fn(async () => "/from/bridge")
    globalThis.__DSH_DIRECTORY_PICKER__ = { pick: bridge }
    const remote = vi.fn(async () => ({ ok: true, value: "/from/remote" }))
    expect(await pickDirectory(ctxWith(remoteWith({ pick: remote })))).toBe("/from/bridge")
    expect(remote).not.toHaveBeenCalled()
  })

  it("throws when the deployment has no picker at all", async () => {
    // The caller hides the button when `canPickDirectory` is false, so this is the
    // belt-and-braces path: a direct call says why rather than answering a silent null.
    await expect(pickDirectory(ctxWith({}))).rejects.toThrow(/no directory picker/)
  })

  it("throws with the host's own message when the chooser fails", async () => {
    // A chooser that would not start is not a cancel, and must not be reported as one.
    const pick = vi.fn(async () => ({ ok: false, error: { message: "zenity is not installed" } }))
    await expect(pickDirectory(ctxWith(remoteWith({ pick })))).rejects.toThrow(/zenity is not installed/)
  })

  it("passes the caller's signal through to the host", async () => {
    const signal = new AbortController().signal
    const pick = vi.fn(async () => ({ ok: true, value: "/x" }))
    await pickDirectory(ctxWith(remoteWith({ pick })), signal)
    expect(pick).toHaveBeenCalledWith(signal)
  })
})

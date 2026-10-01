// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import type { ComponentType } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorktreePlugin } from "../src/client/plugin"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

type Classification = {
  path: string
  isRepository: boolean
  isSourceRoot: boolean
  repositoryCount: number
  repositories: Array<{ name: string; path: string }>
}

/** A workspace holding repositories — the multi-repository shape. */
function container(path: string, count: number): Classification {
  return {
    path,
    isRepository: false,
    isSourceRoot: count > 0,
    repositoryCount: count,
    repositories: Array.from({ length: count }, (_, index) => ({ name: `repo-${index}`, path: `${path}repo-${index}` })),
  }
}

/** A workspace that is itself a repository, which takes the same path. */
function repository(path: string): Classification {
  return { path, isRepository: true, isSourceRoot: true, repositoryCount: 1, repositories: [{ name: "repo", path }] }
}

/** A workspace a task cannot start in: a linked worktree, or no repositories. */
function unusable(path: string): Classification {
  return { path, isRepository: false, isSourceRoot: false, repositoryCount: 0, repositories: [] }
}

const disposers: Array<() => void> = []
afterEach(() => {
  cleanup()
  for (const dispose of disposers.splice(0)) dispose()
})

function setup() {
  const workspace = { workspaceId: "ws-main", path: "/repo/", title: "repo", sessionIds: ["session-new"] }
  // Both workspace and locale snapshots stay identical while classification resolves.
  const snapshot = { items: [workspace] }
  const workspaceListeners = new Set<() => void>()
  const effects: Array<() => void> = []
  const requests: Array<ReturnType<typeof deferred<{ ok: true; value: Classification }>>> = []
  let Dock!: ComponentType<any>
  const useWorkspaces = vi.fn((selector: (state: typeof snapshot) => unknown) => selector(snapshot))
  const locale = {
    register: () => () => {},
    bind: () => (key: string) => key === "createTask" ? "New task space" : key === "newWorktreeSpace" ? "New Worktree Space" : key,
    getSnapshot: () => "en",
    subscribe: vi.fn(() => () => {}),
  }
  const call = vi.fn(() => {
    const request = deferred<{ ok: true; value: Classification }>()
    requests.push(request)
    return request.promise
  })
  WorktreePlugin.apply({
    connection: { rpc: { call } },
    get: (name: string) => name === "locale" ? locale : undefined,
    // The plugin reads its own configuration through this service; without it the
    // default entries stand, which is what these tests exercise.
    inject: (_names: string[], run: (ctx: unknown) => void) => { run({}) },
    workspaces: { list: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        workspaceListeners.add(listener)
        return () => { workspaceListeners.delete(listener) }
      },
    } },
    uiWorkspace: {},
    effect: (effect: () => (() => void)) => { effects.push(effect()) },
    slots: {
      inject: (_name: string, register: () => void) => register(),
      register: (slot: { name: string }, callback: ComponentType<any>) => {
        if (slot.name === "conversation.input.dock") Dock = callback
      },
    },
  } as any)
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const effect of effects.reverse()) effect()
  }
  disposers.push(dispose)
  const element = <div data-slot="conversation.composer"><div><button aria-haspopup="menu">Workspace</button><div data-slot="conversation.hero.agentPreset" /></div><Dock session={{ sessionId: "session-new", blank: true }} useWorkspaces={useWorkspaces} /></div>
  return {
    element, useWorkspaces, call, workspaceListeners, dispose,
    refresh: () => { for (const listener of workspaceListeners) listener() },
    resolve: async (index: number, classification: Classification) => {
      await act(async () => {
        requests[index].resolve({ ok: true, value: classification })
        await requests[index].promise
      })
    },
  }
}

const button = () => screen.queryByRole("button", { name: "New Worktree Space" })

describe("registered task dock classification reactivity", () => {
  it("shows the entry for a workspace holding repositories, after deferred classification", async () => {
    const host = setup()
    render(host.element)
    expect(button()).toBeNull()
    expect(host.call).toHaveBeenCalledTimes(1)
    expect(host.call.mock.calls[0].slice(0, 3)).toEqual(["/api", "dsh-worktree-space/task.classify-root", { sourceRoot: "/repo/" }])
    await host.resolve(0, container("/repo/", 2))
    expect(button()).not.toBeNull()
    expect(host.call).toHaveBeenCalledTimes(1)
  })

  it("shows the entry for a workspace that is itself a repository", async () => {
    const host = setup()
    render(host.element)
    await host.resolve(0, repository("/repo/"))
    expect(button()).not.toBeNull()
  })

  it.each([
    ["a linked worktree", unusable("/repo/")],
    ["a directory holding no repositories", unusable("/repo/")],
  ] as const)("keeps the entry hidden for %s", async (_label, classification) => {
    const host = setup()
    render(host.element)
    await host.resolve(0, classification)
    expect(button()).toBeNull()
  })

  it.each([false, true])("ignores an obsolete classification when the latest isSourceRoot is %s", async (latestIsSourceRoot) => {
    const host = setup()
    render(host.element)
    act(() => host.refresh())
    await host.resolve(1, latestIsSourceRoot ? container("/repo/", 1) : unusable("/repo/"))
    expect(Boolean(button())).toBe(latestIsSourceRoot)
    const renders = host.useWorkspaces.mock.calls.length
    await host.resolve(0, latestIsSourceRoot ? unusable("/repo/") : container("/repo/", 1))
    expect(Boolean(button())).toBe(latestIsSourceRoot)
    expect(host.useWorkspaces).toHaveBeenCalledTimes(renders)
  })

  it("does not publish a late result after plugin disposal", async () => {
    const host = setup()
    render(host.element)
    act(() => host.dispose())
    expect(host.workspaceListeners.size).toBe(0)
    const renders = host.useWorkspaces.mock.calls.length
    await host.resolve(0, container("/repo/", 1))
    expect(button()).toBeNull()
    expect(host.useWorkspaces).toHaveBeenCalledTimes(renders)
    host.refresh()
    expect(host.call).toHaveBeenCalledTimes(1)
  })

  it("unsubscribes an unmounted dock and gives a new mount the completed snapshot", async () => {
    const host = setup()
    const view = render(host.element)
    view.unmount()
    const renders = host.useWorkspaces.mock.calls.length
    await host.resolve(0, container("/repo/", 1))
    expect(host.useWorkspaces).toHaveBeenCalledTimes(renders)
    render(host.element)
    expect(button()).not.toBeNull()
  })
})

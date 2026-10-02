import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { apply, branchTargets, configuredTasksRoot, DEFAULT_SCAN_DEPTH, discoverGitRoots, fail, MAX_SCAN_DEPTH, MAX_SCAN_DIRECTORIES, MIN_SCAN_DEPTH, parseWorktrees, resolveScanDepth } from "../src/host/index.js"
import { setAuditEnabled } from "../src/host/task/audit-log.js"
import { clearScanCache, SCAN_CACHE_LIMIT } from "../src/host/task/scan-cache.js"

// `handleFor` runs `apply`, which pushes the audit-log switch into a module-level
// cell. A handler built with `auditLog: "off"` would otherwise leave the log off
// for every test that runs after it, and the symptom would land somewhere
// unrelated - a record missing, or a rotation that did not happen. Restored in
// one place, because the switch is global state and so is its reset.
afterEach(() => setAuditEnabled(true))

function handleFor(outputs = {}, config) {
  const routes = new Map()
  const subprocess = {
    spawn({ argv }) {
      const key = argv.slice(3).join(" ")
      const result = outputs[key] ?? ""
      const stdout = typeof result === "string" ? result : result.stdout ?? ""
      const stderr = typeof result === "string" ? "" : result.stderr ?? ""
      const exitCode = typeof result === "string" ? 0 : result.exitCode ?? 0
      return {
        done: Promise.resolve({ exitCode, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: stdout }) },
          stderr: { readFrom: () => ({ text: stderr }) },
        },
      }
    },
  }
  const ctx = {
    subprocess,
    connection: { fetch: { register(route) {
      expect(routes.has(route.path)).toBe(false)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    } } },
    effect(effect) { return effect() },
  }
  apply(ctx, config)
  const handler = async (endpoint, payload = {}, signal, method = `dsh-worktree-space/${endpoint}`) => {
    const path = `/api/dsh-worktree-space/${endpoint}`
    const route = routes.get(path)
    expect(route, `missing exact route: ${path}`).toBeDefined()
    expect(route.methods).toEqual(["POST"])
    expect(route.requestBody).toBe("buffered")
    const controller = new AbortController()
    if (signal?.aborted) controller.abort()
    const request = new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "test", method, payload }),
      signal: controller.signal,
    })
    const response = await route.fetch(request)
    expect(response).toBeInstanceOf(Response)
    expect(response.status).toBe(200)
    const message = await response.json()
    expect(message).toEqual({ type: "server-response", rpcId: "test", result: expect.any(Object) })
    return message.result
  }
  return Object.assign(handler, { routes })
}

describe("worktree porcelain parser", () => {
  it("discovers nested Git roots while skipping noisy directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-worktree-space-"))
    try {
      await mkdir(join(root, "projects", "one", ".git"), { recursive: true })
      await mkdir(join(root, "node_modules", "ignored", ".git"), { recursive: true })
      await mkdir(join(root, "projects", "two"), { recursive: true })
      await writeFile(join(root, "projects", "two", ".git"), "gitdir: ../one/.git\n")
      expect((await discoverGitRoots(root)).sort()).toEqual([
        join(root, "projects", "one"),
        join(root, "projects", "two"),
      ].sort())
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("inspects two levels by default and only descends further when asked", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-worktree-space-depth-"))
    const depthTwo = join(root, "a", "two")
    const depthThree = join(root, "a", "b", "three")
    const depthFive = join(root, "a", "b", "c", "d", "five")
    try {
      for (const path of [depthTwo, depthThree, depthFive]) await mkdir(join(path, ".git"), { recursive: true })
      expect(await discoverGitRoots(root)).toEqual([depthTwo])
      expect((await discoverGitRoots(root, { maxDepth: 5 })).sort()).toEqual([depthTwo, depthThree, depthFive].sort())
      expect(await discoverGitRoots(root, { maxDepth: 1 })).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("clamps a requested scan depth into the supported range", () => {
    expect(DEFAULT_SCAN_DEPTH).toBe(2)
    expect(MIN_SCAN_DEPTH).toBe(1)
    expect(MAX_SCAN_DEPTH).toBe(5)
    expect(MAX_SCAN_DIRECTORIES).toBe(1000)

    // No depth, or one that is not a number at all, keeps the default.
    expect(resolveScanDepth(undefined)).toBe(DEFAULT_SCAN_DEPTH)
    expect(resolveScanDepth(null)).toBe(DEFAULT_SCAN_DEPTH)
    expect(resolveScanDepth("deep")).toBe(DEFAULT_SCAN_DEPTH)
    // A usable depth is read, rounded down, and held inside the bounds.
    expect(resolveScanDepth("4")).toBe(4)
    expect(resolveScanDepth(4.7)).toBe(4)
    expect(resolveScanDepth(0)).toBe(MIN_SCAN_DEPTH)
    expect(resolveScanDepth(-3)).toBe(MIN_SCAN_DEPTH)
    expect(resolveScanDepth(99)).toBe(MAX_SCAN_DEPTH)
  })

  it("skips hidden and noisy descendants but permits .worktrees and explicit hidden roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-worktree-space-hidden-"))
    const ignored = [".cache", ".config", ".hidden", "node_modules", "Library", "dist", "build", "vendor"]
    try {
      for (const directory of [...ignored, ".worktrees", "projects"]) {
        await mkdir(join(root, directory, "repo", ".git"), { recursive: true })
      }
      expect((await discoverGitRoots(root)).sort()).toEqual([
        join(root, ".worktrees", "repo"), join(root, "projects", "repo"),
      ].sort())
      expect(await discoverGitRoots(join(root, ".hidden"))).toEqual([join(root, ".hidden", "repo")])
      expect(await discoverGitRoots(join(root, ".hidden", "repo"), { maxDepth: 0 })).toEqual([join(root, ".hidden", "repo")])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("throws instead of returning a partial scan when the directory budget is exceeded", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-worktree-space-budget-"))
    try {
      await mkdir(join(root, "repo", ".git"), { recursive: true })
      await expect(discoverGitRoots(root, { maxDirectories: 1 })).rejects.toThrow(/scan limit reached.*more specific Workspace/)
      expect(await discoverGitRoots(root, { maxDirectories: 2 })).toEqual([join(root, "repo")])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects an already cancelled scan with the AbortSignal reason", async () => {
    const controller = new AbortController()
    const reason = new Error("scan cancelled by caller")
    controller.abort(reason)
    await expect(discoverGitRoots(tmpdir(), { signal: controller.signal })).rejects.toBe(reason)
  })

  it("honors cancellation while a directory read is in flight", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-worktree-space-abort-"))
    try {
      await mkdir(join(root, "nested", "repo", ".git"), { recursive: true })
      const controller = new AbortController()
      const reason = new Error("scope changed")
      const scan = discoverGitRoots(root, { signal: controller.signal })
      controller.abort(reason)
      await expect(scan).rejects.toBe(reason)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("parses main, branches and worktree state flags", () => {
    const rows = parseWorktrees([
      "worktree /repo",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /repo.worktrees/feature",
      "HEAD def",
      "branch refs/heads/feature",
      "locked reason",
      "",
      "worktree /repo.worktrees/detached",
      "HEAD ghi",
      "detached",
    ].join("\n"))
    expect(rows).toEqual([
      expect.objectContaining({ path: "/repo", branch: "main", isMain: true }),
      expect.objectContaining({ path: "/repo.worktrees/feature", branch: "feature", locked: true, isMain: false }),
      expect.objectContaining({ path: "/repo.worktrees/detached", detached: true, isMain: false }),
    ])
  })
})

describe("worktree RPC contract", () => {
  it("registers only exact shared API routes for every endpoint", () => {
    expect([...handleFor().routes.keys()].sort()).toEqual([
      "worktree.scan", "worktree.cached", "worktree.status",
      "task.classify-root", "task.suggest-root", "task.create", "task.add-repositories", "task.list", "task.inspect", "task.plan", "task.done", "task.preference",
    ].map((endpoint) => `/api/dsh-worktree-space/${endpoint}`).sort())
  })

  const porcelain = [
    "worktree /repo",
    "HEAD abc",
    "branch refs/heads/main",
    "",
    "worktree /repo.worktrees/feature",
    "HEAD def",
    "branch refs/heads/feature",
  ].join("\n")

  /** A scan walks the disk before it asks git, so the root has to exist. */
  async function scanFixture() {
    const root = await mkdtemp(join(tmpdir(), "dsh-worktree-space-scan-"))
    await mkdir(join(root, "repo", ".git"), { recursive: true })
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
  }

  it("scans a repository, resolving its default branch from origin/HEAD", async () => {
    const fixture = await scanFixture()
    try {
      const handler = handleFor({
        "worktree list --porcelain": porcelain,
        "rev-parse --show-toplevel": join(fixture.root, "repo"),
        "rev-parse --git-common-dir": ".git",
        "symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main",
      })
      const scanned = (await handler("worktree.scan", { paths: [join(fixture.root, "repo")] })).value
      expect(scanned).toHaveLength(1)
      expect(scanned[0]).toMatchObject({ repoPath: "/repo", defaultBranch: "main", defaultRef: "origin/main" })
    } finally {
      await fixture.cleanup()
    }
  })

  it("prefers a local default branch when both local and remote refs exist", async () => {
    const fixture = await scanFixture()
    try {
      const handler = handleFor({
        "worktree list --porcelain": porcelain,
        "rev-parse --show-toplevel": join(fixture.root, "repo"),
        "rev-parse --git-common-dir": ".git",
        "symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main",
        "for-each-ref --format=%(refname:short) refs/heads refs/remotes/origin": "main\norigin/main",
      })
      const scanned = (await handler("worktree.scan", { paths: [join(fixture.root, "repo")] })).value
      expect(scanned[0]).toMatchObject({ defaultBranch: "main", defaultRef: "main" })
    } finally {
      await fixture.cleanup()
    }
  })

  it("keeps a public code and flattens one that is not public", () => {
    // A code the caller may act on survives; anything else becomes E9001 rather
    // than reaching a caller that would have to handle a distinction the host
    // does not maintain. This is the filter that makes the codes greppable.
    expect(fail("E3004", "fatal: not a git repository")).toMatchObject({
      ok: false,
      error: { code: "E3004", message: "fatal: not a git repository" },
    })
    expect(fail("some-internal-code", "internal detail")).toMatchObject({
      ok: false,
      error: { code: "E9001", message: "internal detail" },
    })
  })

  it("answers the configured default branch prefix, and follows it without a reload", async () => {
    // The entry keeps the volatile accessor itself, so a prefix written while the
    // Host is running is the one the next request answers with.
    let prefix = "task/"
    const handler = handleFor({}, { defaultBranchPrefix: { get: () => prefix } })
    expect((await handler("task.preference")).value).toMatchObject({ defaultBranchPrefix: "task/" })
    prefix = "wt/"
    expect((await handler("task.preference")).value).toMatchObject({ defaultBranchPrefix: "wt/" })
    // An emptied setting falls back to the built-in default rather than to no prefix.
    prefix = "  "
    expect((await handler("task.preference")).value).toMatchObject({ defaultBranchPrefix: "task/" })
  })

  it("answers the configured archive destination, and treats empty as not set", async () => {
    // The same live-accessor shape as the prefix above: a destination written from
    // the settings card is what the next archive dialog reads.
    let directory = ""
    const handler = handleFor({}, { archiveDocumentsDirectory: { get: () => directory } })
    // Unset is an answer, not a missing key: the dialog reads the key and keeps the root
    // the strategy names when it is empty.
    expect((await handler("task.preference")).value).toMatchObject({ archiveDocumentsDirectory: "" })
    directory = "E:\\archived-docs"
    expect((await handler("task.preference")).value).toMatchObject({ archiveDocumentsDirectory: "E:\\archived-docs" })
    // Whitespace is emptiness, so a cleared field cannot become a destination named "  ".
    directory = "   "
    expect((await handler("task.preference")).value).toMatchObject({ archiveDocumentsDirectory: "" })
  })

  it("answers the configured archive strategy, and stays in the container by default", async () => {
    // The strategy names the root and the directory above only narrows it, so the dialog
    // reads both before it computes anything: one without the other says nothing.
    let strategy
    const handler = handleFor({}, { archiveDocumentsStrategy: { get: () => strategy } })
    // A Host nobody has configured answers with the shipped default, and so does one
    // serving a word the schema does not offer - the dialog would have to guess at it,
    // and the guess belongs in one place.
    expect((await handler("task.preference")).value).toMatchObject({ archiveDocumentsStrategy: "container" })
    strategy = "custom"
    expect((await handler("task.preference")).value).toMatchObject({ archiveDocumentsStrategy: "custom" })
    strategy = "somewhere"
    expect((await handler("task.preference")).value).toMatchObject({ archiveDocumentsStrategy: "container" })
  })

  it("reads the configured task space location, and only under the custom strategy", async () => {
    // Two settings rather than one: the strategy says whether a directory is read at
    // all, so a directory left over from an earlier custom run has to go inert the
    // moment the strategy is back on the derived default.
    let strategy
    let directory = "E:\\worktree-space"
    const handler = handleFor({}, {
      tasksRootStrategy: { get: () => strategy },
      tasksRootDirectory: { get: () => directory },
    })
    // Nobody configured anything: the answer is "no configured root", so a create
    // derives the location it always did rather than taking a directory nobody chose.
    expect(configuredTasksRoot()).toBe("")
    strategy = "default"
    expect(configuredTasksRoot()).toBe("")
    strategy = "custom"
    expect(configuredTasksRoot()).toBe("E:\\worktree-space")
    // A word the schema does not offer is not the custom strategy, so it reads as the
    // default rather than as a licence to use the directory.
    strategy = "somewhere"
    expect(configuredTasksRoot()).toBe("")
    // Whitespace is emptiness, so a cleared field cannot become a root named "  ".
    strategy = "custom"
    directory = "   "
    expect(configuredTasksRoot()).toBe("")
    // Unset at all is the same as empty, and reads the same way.
    directory = undefined
    expect(configuredTasksRoot()).toBe("")
    // And the endpoint asks through this same accessor, so the dialog opens on the
    // root a create would use.
    const fixture = await scanFixture()
    try {
      directory = join(fixture.root, "worktree-space")
      const answered = await handler("task.suggest-root", { sourceRoot: join(fixture.root, "repo"), tasksRoot: "" })
      expect(answered.value.suggested).toBe(join(fixture.root, "worktree-space"))
    } finally {
      await fixture.cleanup()
    }
  })

  it("answers whether the agent entries are offered, and offers them by default", async () => {
    // Shown is what anything but an explicit hide means, so a profile that never touches
    // the setting keeps the finish it has been getting.
    let entry
    const handler = handleFor({}, { handoffEntry: { get: () => entry } })
    expect((await handler("task.preference")).value).toMatchObject({ handoffEntry: "show" })
    entry = "hide"
    expect((await handler("task.preference")).value).toMatchObject({ handoffEntry: "hide" })
    entry = "show"
    expect((await handler("task.preference")).value).toMatchObject({ handoffEntry: "show" })
  })

  it("writes the audit log unless the configuration says otherwise", async () => {
    // The answer is read from the running state rather than the configured value,
    // so `task.preference` cannot report `on` while the module is writing
    // nothing - which is the disagreement a dialog reading this would act on.
    const off = handleFor({}, { auditLog: { get: () => "off" } })
    expect((await off("task.preference")).value).toMatchObject({ auditLog: "off" })

    const on = handleFor({}, { auditLog: { get: () => "on" } })
    expect((await on("task.preference")).value).toMatchObject({ auditLog: "on" })

    // Anything but an explicit `off` writes. A profile row that has never been
    // touched has no value at all, and it has to behave like one that says `on`
    // or the log would be off everywhere until somebody went looking for it.
    for (const unset of [{}, { auditLog: {} }, { auditLog: { get: () => undefined } }]) {
      const handler = handleFor({}, unset)
      expect((await handler("task.preference")).value).toMatchObject({ auditLog: "on" })
    }

    // And the string form, which is what `apply` receives when a profile row
    // carries a plain value rather than a live reference. Reading the reference
    // instead is the bug this pair pins down: `config.auditLog !== "off"` is
    // never true for a `{ get }`, so the setting could not turn anything off.
    expect((await handleFor({}, { auditLog: "off" })("task.preference")).value).toMatchObject({ auditLog: "off" })
    expect((await handleFor({}, { auditLog: "on" })("task.preference")).value).toMatchObject({ auditLog: "on" })
  })

  it("counts the commits a worktree carries back when a target is named", async () => {
    const handler = handleFor({
      "status --short --branch": "## feat/antest",
      "rev-list --count develop..HEAD": "4",
    })

    expect((await handler("worktree.status", { path: "/repo", target: "develop" })).value)
      .toMatchObject({ changedFiles: 0, commits: 4 })
    // No target, or one git cannot resolve, leaves the count out rather than
    // claiming a clean branch: the page shows nothing instead of a wrong zero.
    expect((await handler("worktree.status", { path: "/repo" })).value).not.toHaveProperty("commits")
    expect((await handler("worktree.status", { path: "/repo", target: "ghost" })).value).not.toHaveProperty("commits")
  })

  it("returns the stable error envelope for bad requests and cancellation", async () => {
    const handler = handleFor()
    // A request with no path names its own failure rather than falling back to
    // the catch-all, so the caller and the log can both say which argument was
    // missing rather than that something was.
    expect(await handler("worktree.status", {})).toMatchObject({ ok: false, error: { code: "E4005", details: { issues: [] } } })
    expect(await handler("worktree.status", {}, undefined, "dsh-worktree-space/worktree.unknown")).toMatchObject({
      ok: false, error: { code: "E9001", message: "RPC method does not match endpoint.", details: { issues: [] } },
    })
    expect(await handler("worktree.status", {}, { aborted: true })).toMatchObject({ ok: false, error: { code: "cancelled" } })
  })
})

describe("the branch each repository merges into", () => {
  it("reads a per-repository choice, and nothing usable out of a malformed one", () => {
    expect(branchTargets({ alpha: " develop ", beta: "main" })).toEqual({ alpha: "develop", beta: "main" })
    // An entry that names nothing usable is dropped, and an empty result is "no
    // choice at all" rather than a target named "".
    expect(branchTargets({ alpha: "" })).toBeUndefined()
    expect(branchTargets({ "  ": "develop" })).toBeUndefined()
    expect(branchTargets({ alpha: 7 })).toBeUndefined()
    expect(branchTargets(undefined)).toBeUndefined()
    expect(branchTargets(null)).toBeUndefined()
    expect(branchTargets(["develop"])).toBeUndefined()
  })
})

/**
 * What a reopened panel is handed before its own scan answers. The cache's
 * lifetime is the process, so every case here starts from an empty one.
 */
describe("the Host's memory of the last scan", () => {
  beforeEach(() => clearScanCache())

  const porcelain = [
    "worktree /repo",
    "HEAD abc",
    "branch refs/heads/main",
    "",
    "worktree /repo.worktrees/feature",
    "HEAD def",
    "branch refs/heads/feature",
  ].join("\n")

  /** A scan walks the disk before it asks git, so the root has to exist. */
  async function scanFixture() {
    const root = await mkdtemp(join(tmpdir(), "dsh-worktree-space-memory-"))
    await mkdir(join(root, "repo", ".git"), { recursive: true })
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
  }

  /** A Host whose git answers describe the one repository the fixture holds. */
  const scannerFor = (root) => handleFor({
    "worktree list --porcelain": porcelain,
    "rev-parse --show-toplevel": join(root, "repo"),
    "rev-parse --git-common-dir": ".git",
    "symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main",
    "status --short --branch": "## feature\n M a.txt\n?? b.txt",
  })

  it("serves what the last scan of those Workspaces found, and nothing before it", async () => {
    const fixture = await scanFixture()
    try {
      const handler = scannerFor(fixture.root)
      const paths = [join(fixture.root, "repo")]
      expect((await handler("worktree.cached", { paths })).value).toBeNull()

      await handler("worktree.scan", { paths })
      const remembered = (await handler("worktree.cached", { paths })).value
      expect(remembered.repositories).toHaveLength(1)
      expect(remembered.repositories[0]).toMatchObject({ repoPath: "/repo", defaultBranch: "main" })
      // No worktree status has been asked about yet, so none is claimed.
      expect(remembered.statuses).toEqual({})
    } finally {
      await fixture.cleanup()
    }
  })

  it("keeps each worktree status alongside the scan that lists it", async () => {
    const fixture = await scanFixture()
    try {
      const handler = scannerFor(fixture.root)
      const paths = [join(fixture.root, "repo")]
      await handler("worktree.scan", { paths })
      await handler("worktree.status", { path: "/repo.worktrees/feature" })

      const remembered = (await handler("worktree.cached", { paths })).value
      expect(remembered.statuses).toEqual({
        "/repo.worktrees/feature": { branchLine: "## feature", changedFiles: 2, output: "## feature\n M a.txt\n?? b.txt" },
      })
    } finally {
      await fixture.cleanup()
    }
  })

  it("answers nothing for Workspaces it has never scanned", async () => {
    const fixture = await scanFixture()
    try {
      const handler = scannerFor(fixture.root)
      await handler("worktree.scan", { paths: [join(fixture.root, "repo")] })
      expect((await handler("worktree.cached", { paths: [join(fixture.root, "other")] })).value).toBeNull()
    } finally {
      await fixture.cleanup()
    }
  })

  it("replaces the remembered answer on the next scan, empty result included", async () => {
    const fixture = await scanFixture()
    try {
      const handler = scannerFor(fixture.root)
      const paths = [join(fixture.root, "repo")]
      await handler("worktree.scan", { paths })
      expect((await handler("worktree.cached", { paths })).value.repositories).toHaveLength(1)

      // The repository is gone by the next scan, and that is an answer too: the
      // panel must not be handed the older list back.
      await rm(join(fixture.root, "repo"), { recursive: true, force: true })
      await handler("worktree.scan", { paths })
      expect((await handler("worktree.cached", { paths })).value).toEqual({ repositories: [], statuses: {} })
    } finally {
      await fixture.cleanup()
    }
  })

  it("forgets the Workspace set that has gone longest without a scan", async () => {
    const fixture = await scanFixture()
    try {
      const handler = scannerFor(fixture.root)
      const sets = []
      for (let index = 0; index <= SCAN_CACHE_LIMIT; index += 1) {
        const path = join(fixture.root, `set-${index}`)
        await mkdir(path, { recursive: true })
        sets.push(path)
      }
      for (const path of sets) await handler("worktree.scan", { paths: [path] })

      expect((await handler("worktree.cached", { paths: [sets[0]] })).value).toBeNull()
      const last = sets[sets.length - 1]
      expect((await handler("worktree.cached", { paths: [last] })).value).toEqual({ repositories: [], statuses: {} })
    } finally {
      await fixture.cleanup()
    }
  })

  it("identifies a scan by its Workspace paths, not by how they are spelled or ordered", async () => {
    const fixture = await scanFixture()
    try {
      const handler = scannerFor(fixture.root)
      const repo = join(fixture.root, "repo")
      const other = join(fixture.root, "other")
      await mkdir(other, { recursive: true })
      await handler("worktree.scan", { paths: [repo, other] })

      // Reversed, and with a trailing separator: still the same two Workspaces.
      const separator = process.platform === "win32" ? "\\" : "/"
      const remembered = (await handler("worktree.cached", { paths: [other, `${repo}${separator}`] })).value
      expect(remembered.repositories).toHaveLength(1)
      // A set that only overlaps is a set this Host has never scanned.
      expect((await handler("worktree.cached", { paths: [repo] })).value).toBeNull()
    } finally {
      await fixture.cleanup()
    }
  })
})

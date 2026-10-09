import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { apply, branchTargets, configuredTasksRoot, DEFAULT_SCAN_DEPTH, discoverGitRoots, fail, ignoredScanDirectorySet, MAX_SCAN_DEPTH, MAX_SCAN_DIRECTORIES, MIN_SCAN_DEPTH, parseWorktrees, resolveScanDepth, topLevelRequestedPaths } from "../src/host/index.js"
import { setAuditEnabled } from "../src/host/task/audit-log.js"
import { clearScanCache, SCAN_CACHE_LIMIT } from "../src/host/task/scan-cache.js"

// `handleFor` runs `apply`, which pushes the audit-log switch into a module-level
// cell. A handler built with `auditLog: "off"` would otherwise leave the log off
// for every test that runs after it, and the symptom would land somewhere
// unrelated - a record missing, or a rotation that did not happen. Restored in
// one place, because the switch is global state and so is its reset.
afterEach(() => setAuditEnabled(true))

function handleFor(outputs = {}, config, asked, services) {
  const routes = new Map()
  const subprocess = {
    spawn({ argv }) {
      const key = argv.slice(3).join(" ")
      // Opt-in, because "what did this scan ask git" is the question a scan test
      // should be able to ask and nothing else needs to record anything.
      if (asked !== undefined) asked.push(key)
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
    // Only when a test asks for peer services, and off unless it does: the handlers reach
    // for those through `ctx.get` and are written to carry on when there is none, so a
    // fixture that always answered one would be a different context from the one every
    // other test here runs against.
    ...(services === undefined ? {} : { get: (name) => services[name] }),
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
      // A linked worktree, not a repository: `projects/two` carries `.git` as a file
      // and is a checkout of `projects/one`. See the test below for why that is not a
      // root of its own.
      await writeFile(join(root, "projects", "two", ".git"), "gitdir: ../one/.git\n")
      expect((await discoverGitRoots(root)).sort()).toEqual([
        join(root, "projects", "one"),
      ].sort())
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("does not list a linked worktree as a repository of its own", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-worktree-space-worktree-"))
    try {
      // The shape a task space makes: a container of linked worktrees, one per
      // repository. Registering a container root as a Workspace used to answer with
      // every one of them, and each row named the repository they are checkouts of -
      // the same repository, once per task space, under a path that is not its own.
      await mkdir(join(root, "alpha"), { recursive: true })
      await writeFile(join(root, "alpha", ".git"), "gitdir: ../../elsewhere/.git/worktrees/alpha\n")
      // A real repository beside them, so a walk that finds nothing at all is not
      // what this is looking at.
      await mkdir(join(root, "repo", ".git"), { recursive: true })

      expect(await discoverGitRoots(root)).toEqual([join(root, "repo")])
      // Pointed straight at one, the answer is the same: this is the directory a
      // create refuses as a source root, and a scan must not offer what a create
      // would then refuse.
      expect(await discoverGitRoots(join(root, "alpha"))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("inspects three levels by default and only descends further when asked", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-worktree-space-depth-"))
    const depthTwo = join(root, "a", "two")
    const depthThree = join(root, "a", "b", "three")
    const depthFour = join(root, "a", "b", "c", "four")
    const depthFive = join(root, "a", "b", "c", "d", "five")
    try {
      for (const path of [depthTwo, depthThree, depthFour, depthFive]) await mkdir(join(path, ".git"), { recursive: true })
      // The default reaches the third level and stops there. It was two, on a
      // measurement - against a real Workspace the extra level found two repositories
      // out of ninety-six - which is a cost worth naming but not a cost worth
      // refusing reachability for. A repository is a leaf of this walk, so depth only
      // buys the directories that hold none between the source root and the
      // repositories: on a source root whose repositories all sit within two levels
      // the third level found nothing and walked nothing extra, because there was
      // nothing at level two left to descend into. What bounds a walk is the
      // directory budget, not the depth. The order is the sorted one the walk
      // settles on.
      expect((await discoverGitRoots(root)).sort()).toEqual([depthTwo, depthThree].sort())
      // Still one level short of the deepest, so three is a default and not a
      // ceiling: a deeper layout is a setting, not a rewrite.
      expect(await discoverGitRoots(root, { maxDepth: 2 })).toEqual([depthTwo])
      expect((await discoverGitRoots(root, { maxDepth: 5 })).sort()).toEqual([depthTwo, depthThree, depthFour, depthFive].sort())
      expect(await discoverGitRoots(root, { maxDepth: 1 })).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("clamps a requested scan depth into the supported range", () => {
    expect(DEFAULT_SCAN_DEPTH).toBe(3)
    expect(MIN_SCAN_DEPTH).toBe(1)
    expect(MAX_SCAN_DEPTH).toBe(5)
    expect(MAX_SCAN_DIRECTORIES).toBe(2000)

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

  it("skips the build output of the languages the built-in list covers", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-worktree-space-builds-"))
    try {
      // One from each ecosystem in the list, all of them containing a repository
      // so that finding it is the only evidence the directory was walked into.
      for (const directory of ["__pycache__", "target", "obj", "DerivedData", "Pods", "_build", "zig-out", "Intermediate", "site-packages", "elm-stuff", "blib", "dist-newstyle", "Binaries", "DerivedDataCache", "deps", "packages", "coverage", "storybook-static"]) {
        await mkdir(join(root, directory, "repo", ".git"), { recursive: true })
      }
      await mkdir(join(root, "src", "repo", ".git"), { recursive: true })
      expect(await discoverGitRoots(root)).toEqual([join(root, "src", "repo")])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("skips a configured name and matches it without regard to case", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-worktree-space-extra-"))
    try {
      // Typed in the case a user would type it, against a filesystem that spells it
      // the other way. The walk compares lower-cased names, and this is the function
      // that puts a configured name in that shape, so the two halves have to agree
      // or a configured name would silently never match.
      await mkdir(join(root, "DerivedDataCache", "repo", ".git"), { recursive: true })
      await mkdir(join(root, "output", "repo", ".git"), { recursive: true })
      expect(await discoverGitRoots(root, { ignored: ignoredScanDirectorySet(["DERIVEDDATACACHE"]) })).toEqual([join(root, "output", "repo")])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps the built-in names in force under a configuration that adds others", async () => {
    // Adding a name must not be a way to lose the ones already there: a user who
    // typed `output` has not asked for `node_modules` to start being walked.
    const set = ignoredScanDirectorySet(["Output"])
    expect(set.has("node_modules")).toBe(true)
    expect(set.has("__pycache__")).toBe(true)
    // Lower case, because that is what the walk asks for: it lower-cases the
    // directory name before it looks, so the set has to be in that shape too.
    expect(set.has("output")).toBe(true)
    // A name that is not a usable one is dropped rather than matched against
    // everything: an empty entry would otherwise ignore every directory.
    expect(ignoredScanDirectorySet(["", "   "]).has("")).toBe(false)
  })

  it("names a directory it could not read, because silence is indistinguishable from empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-worktree-space-unreadable-"))
    try {
      // A real repository, so a walk that works at all has something to return and
      // the failure cannot be mistaken for "there was nothing here".
      await mkdir(join(root, "repo", ".git"), { recursive: true })
      const said = []
      // A path that cannot be read stands in for a denied one: both reach the same
      // catch, and both used to produce "no repositories" with nothing said. On
      // Windows the real thing is a sandboxed token without access to the path the
      // user pointed a Workspace at, which is how this was found.
      expect(await discoverGitRoots(join(root, "missing"), { onIssue: (why) => said.push(why) })).toEqual([])
      expect(said.join("\n")).toMatch(/Could not read .*missing/)
      // And the sibling that does answer is untouched.
      said.length = 0
      expect(await discoverGitRoots(root, { onIssue: (why) => said.push(why) })).toEqual([join(root, "repo")])
      expect(said).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("says it stopped at the directory budget instead of throwing the whole scan away", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-worktree-space-budget-"))
    try {
      await mkdir(join(root, "repo", ".git"), { recursive: true })
      // Throwing here used to cost the caller every other path's repositories too,
      // because the handler walked all paths in one `Promise.all`: a Workspace with
      // three roots reported nothing because a fourth was too deep. The ceiling is a
      // statement about how much was looked at, not about whether what was looked
      // at exists, so it is reported and the walk keeps what it has.
      const said = []
      expect(await discoverGitRoots(root, { maxDirectories: 1, onIssue: (why) => said.push(why) })).toEqual([])
      expect(said.join("\n")).toMatch(/Stopped after 1 directories/)
      expect(await discoverGitRoots(root, { maxDirectories: 2, onIssue: () => {} })).toEqual([join(root, "repo")])
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
      "task.classify-root", "task.classify-roots", "task.suggest-root", "task.create", "task.add-repositories", "task.list", "task.inspect", "task.plan", "task.done", "task.deploy-status", "task.deploy-destroy", "task.deploy-accept", "task.deploy-up", "task.deploy-smoke", "task.preference", "task.handoff-access",
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

  it("asks git exactly one question per repository", async () => {
    const fixture = await scanFixture()
    try {
      // The count is the whole assertion. Five processes per repository on Windows
      // is ~95% process creation, and the scan of a ninety-four repository
      // Workspace is what timed out; it now runs one `git worktree list --porcelain`
      // and derives everything else from that one answer. A call added back here
      // is a call the panel pays for on every refresh of every Workspace.
      const asked = []
      const handler = handleFor({ "worktree list --porcelain": porcelain }, undefined, asked)
      const scanned = (await handler("worktree.scan", { paths: [join(fixture.root, "repo")] })).value
      expect(scanned.lists).toHaveLength(1)
      // The main working tree is the porcelain's first entry, so the repository
      // path comes from there rather than from a `rev-parse` of its own.
      expect(scanned.lists[0]).toMatchObject({ repoPath: "/repo" })
      expect(asked).toEqual(["worktree list --porcelain"])
    } finally {
      await fixture.cleanup()
    }
  })

  it("carries no field the panel does not read", async () => {
    const fixture = await scanFixture()
    try {
      const handler = handleFor({ "worktree list --porcelain": porcelain })
      const scanned = (await handler("worktree.scan", { paths: [join(fixture.root, "repo")] })).value
      // `commonDir`, `defaultBranch` and `defaultRef` each cost a `git` process and
      // were read by nothing - the branch the panel shows is derived on the client
      // from the main worktree's row. Leaving them declared but always undefined
      // would be worse than absent: the next reader trusts the field and wonders
      // why it is empty.
      expect(Object.keys(scanned.lists[0]).sort()).toEqual(["repoPath", "worktrees"])
    } finally {
      await fixture.cleanup()
    }
  })

  it("reports a complete scan", async () => {
    const fixture = await scanFixture()
    try {
      const handler = handleFor({ "worktree list --porcelain": porcelain })
      const scanned = (await handler("worktree.scan", { paths: [join(fixture.root, "repo")] })).value
      expect(scanned).toMatchObject({ complete: true, reason: "" })
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

  it("answers which arrangement the next handoff uses, and off is the default", async () => {
    // Off is what the plugin has always done, so a profile that never touches the setting
    // keeps the boundary that reaches the git metadata - and a Host that predates the
    // setting answers without it, which the dialog reads as the same thing.
    let access
    const handler = handleFor({}, { handoffFullAccess: { get: () => access } })
    expect((await handler("task.preference")).value).toMatchObject({ handoffFullAccess: "off" })
    access = "on"
    expect((await handler("task.preference")).value).toMatchObject({ handoffFullAccess: "on" })
    access = "off"
    expect((await handler("task.preference")).value).toMatchObject({ handoffFullAccess: "off" })

    // The plain string, which is what `apply` receives when a profile row carries a value
    // rather than a live reference. Reading only the reference is the pair of bugs these two
    // pin down: `{ get }.get()` is fine but `"on".get()` is undefined, so a plain `on` would
    // read as off - a setting that could be switched on and never take effect.
    expect((await handleFor({}, { handoffFullAccess: "on" })("task.preference")).value).toMatchObject({ handoffFullAccess: "on" })
    expect((await handleFor({}, { handoffFullAccess: "off" })("task.preference")).value).toMatchObject({ handoffFullAccess: "off" })
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
      // A miss is empty rows, not `null`. The bounds are a separate fact about the
      // Host's configuration and are answered either way - a panel that has never
      // scanned anything still needs to name the depth of its first scan.
      const miss = (await handler("worktree.cached", { paths })).value
      expect(miss.repositories).toEqual([])
      expect(miss.current).toMatchObject({ depth: expect.any(Number), directories: expect.any(Number) })

      await handler("worktree.scan", { paths })
      const remembered = (await handler("worktree.cached", { paths })).value
      expect(remembered.repositories).toHaveLength(1)
      expect(remembered.repositories[0]).toMatchObject({ repoPath: "/repo", worktrees: expect.any(Array) })
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

  it("answers no rows for Workspaces it has never scanned, and still says what depth a scan would use", async () => {
    const fixture = await scanFixture()
    try {
      const handler = scannerFor(fixture.root)
      await handler("worktree.scan", { paths: [join(fixture.root, "repo")] })
      const answer = (await handler("worktree.cached", { paths: [join(fixture.root, "other")] })).value
      expect(answer.repositories).toEqual([])
      expect(answer.current).toMatchObject({ depth: expect.any(Number), directories: expect.any(Number) })
    } finally {
      await fixture.cleanup()
    }
  })

  it("answers with the paths that worked and a reason for the one that did not", async () => {
    const fixture = await scanFixture()
    try {
      const handler = scannerFor(fixture.root)
      // Two Workspaces in one scan, one of them a directory that is not there. The
      // panel has to get the repository it can reach AND be told about the one it
      // cannot: losing the row is how a workspace silently empties, and hiding the
      // reason is what made that happen in the first place.
      const good = join(fixture.root, "repo")
      const answer = await handler("worktree.scan", { paths: [good, join(fixture.root, "gone")] })
      expect(answer.value.complete).toBe(false)
      // The repository that answered is still here; the path the mock reports is
      // its own, which is why this asserts the count and not the joined path.
      expect(answer.value.lists).toHaveLength(1)
      expect(answer.value.reason).toMatch(/gone/)
    } finally {
      await fixture.cleanup()
    }
  })

  it("counts a Workspace's nested repositories the way the scan does, through the endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-worktree-space-classify-"))
    try {
      // The shape that reported "0 repositories" about a directory full of them: a
      // top level of containers with the repositories one level below, which is
      // what `E:\workspace` looks like.
      await mkdir(join(root, "group", "nested", ".git"), { recursive: true })
      const handler = handleFor({}, { scanDepth: 2 })
      const answer = await handler("task.classify-roots", { paths: [root] })
      // Asserted through the endpoint rather than against `discoverSourceRepos`,
      // because the bug this guards was never in that function: it was in the names
      // the handler hands the bounds under. Spreading `scanBounds` passed `depth`
      // and `directories` where `maxDepth` and `maxDirectories` were read, so both
      // fell back to one and the count stayed one level deep while the setting read
      // as if it had been applied. Every test of the function passed.
      expect(answer.value[0].repositoryCount).toBe(1)
      expect(answer.value[0].repositories.map((entry) => entry.name)).toEqual(["nested"])

      // And the setting is what decides it. A depth that cannot change the answer
      // is a setting that does nothing: at depth 1 the only thing below this root is
      // the container, and a container is not a repository, so the count must be 0.
      // Pinning both ends is what makes "94 at every depth" a failure rather than
      // something nobody notices until someone re-reads the setting and believes it.
      const shallow = handleFor({}, { scanDepth: 1 })
      expect((await shallow("task.classify-roots", { paths: [root] })).value[0].repositoryCount).toBe(0)
      const deeper = handleFor({}, { scanDepth: 3 })
      expect((await deeper("task.classify-roots", { paths: [root] })).value[0].repositoryCount).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
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
      const emptied = (await handler("worktree.cached", { paths })).value
      expect(emptied.repositories).toEqual([])
      expect(emptied.statuses).toEqual({})
      // Unchanged by a scan that found nothing: the depth is read off the
      // configuration on every call, never out of the remembered rows.
      expect(emptied.current).toMatchObject({ depth: expect.any(Number), directories: expect.any(Number) })
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

      expect((await handler("worktree.cached", { paths: [sets[0]] })).value.repositories).toEqual([])
      const last = sets[sets.length - 1]
      const held = (await handler("worktree.cached", { paths: [last] })).value
      expect(held.repositories).toEqual([])
      expect(held.statuses).toEqual({})
      // The remembered rows were dropped, but the bounds still come back: they
      // come off the configuration, which no amount of forgetting reaches.
      expect(held.current).toMatchObject({ depth: expect.any(Number), directories: expect.any(Number) })
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
      expect((await handler("worktree.cached", { paths: [repo] })).value.repositories).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })
})

// A Workspace registered inside another one - `E:\workspace\public` under
// `E:\workspace` - is walked by name and again as part of its parent. Both walks
// that the panel depends on have to make the same decision about it, because the
// badge on a Workspace and the list its row expands to are two walks over one path
// list; pruning one and not the other leaves a count beside a list it no longer
// describes.
describe("a Workspace registered inside another Workspace", () => {
  const parent = "/work"
  const inner = "/work/public"

  it("drops the nested path from the paths a request carries", () => {
    expect(topLevelRequestedPaths([parent, inner])).toEqual([parent])
    // Order in, order out: the caller's order is theirs to have chosen, and the
    // nested path goes whichever way round they were named.
    expect(topLevelRequestedPaths([inner, parent])).toEqual([parent])
    // Only the nested one goes: the outer is walked whatever else was asked for.
    expect(topLevelRequestedPaths([parent])).toEqual([parent])
    expect(topLevelRequestedPaths([inner])).toEqual([inner])
    expect(topLevelRequestedPaths([])).toEqual([])
  })

  it("does not mistake a shared name prefix for containment", () => {
    // `workspaces` starts with `work`, and a string test says it is inside it.
    // Walking it as part of `work` would attribute its repositories to the parent
    // and hide them from the Workspace that actually holds them.
    expect(topLevelRequestedPaths(["/work", "/workspaces"])).toEqual(["/work", "/workspaces"])
  })

  it("keeps siblings that only share a parent", () => {
    expect(topLevelRequestedPaths(["/work/a", "/work/b"])).toEqual(["/work/a", "/work/b"])
  })

  it("treats a trailing separator as the same directory", () => {
    expect(topLevelRequestedPaths([parent, `${inner}/`])).toEqual([parent])
  })

  // Every case above is written with forward slashes, which is also what the Host
  // answers with when a scan reports a path. The Workspace registration it has to
  // prune arrives in the platform's own spelling, and on Windows that is
  // backslashes - so the pruning ran against paths whose separator no `startsWith`
  // could match, and dropped nothing at all. Every other case in this block passed
  // while the one shape a Windows user actually registers did not.
  it("prunes a nested Workspace registered in the platform's own separator", () => {
    const winParent = "E:\\workspace"
    const winInner = "E:\\workspace\\public"
    expect(topLevelRequestedPaths([winParent, winInner])).toEqual([winParent])
    expect(topLevelRequestedPaths([winInner, winParent])).toEqual([winParent])
  })

  it("prunes a nested Workspace whose path differs only in case", () => {
    // Windows has one directory named once; `WORKSPACE` and `workspace` are one
    // spelling of it, not two, so the nested one goes.
    //
    // Linux has two directories, and it has to keep them: a Workspace registered at
    // `/Workspace/public` is a different Workspace from `/workspace`, and dropping it
    // because the two merely look alike would lose real work with nothing to notice
    // it was lost. That is the whole reason `canonicalPath` lowercases on win32 and
    // nowhere else, and this case is what pins that down. Asserting the Windows answer
    // on every platform would have been describing a bug on half of them.
    const nested = "E:\\WORKSPACE\\public"
    const parent = "e:\\workspace"
    expect(topLevelRequestedPaths([nested, parent]))
      .toEqual(process.platform === "win32" ? [parent] : [nested, parent])
  })

  it("prunes a nested Workspace whose ancestor is spelled the same either way", () => {
    // The case above must not have been "fixed" by dropping case handling outright.
    // With the shared prefix spelled identically this is a plain descendant on every
    // platform, so it goes on every platform - which is what separates the two
    // answers above from a function that never looks at case at all.
    const nested = "E:\\workspace\\PUBLIC"
    const parent = "E:\\workspace"
    expect(topLevelRequestedPaths([nested, parent])).toEqual([parent])
    expect(topLevelRequestedPaths([parent, nested])).toEqual([parent])
  })

  it("does not prune a sibling that only shares a name prefix, in either separator", () => {
    expect(topLevelRequestedPaths(["E:\\work", "E:\\workspaces"])).toEqual(["E:\\work", "E:\\workspaces"])
  })

  it("still classifies a nested Workspace on its own account", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "dsh-ws-nested-"))
    try {
      const nested = join(fixture, "work", "public")
      await mkdir(join(nested, "inner-repo", ".git"), { recursive: true })
      await mkdir(join(fixture, "work", "outer-repo", ".git"), { recursive: true })

      const handler = handleFor({}, {})
      const classified = (await handler("task.classify-roots", { paths: [join(fixture, "work"), nested] })).value
      const byPath = Object.fromEntries(classified.map(row => [row.path, row]))
      // The nested Workspace is dropped from the parent's pass so it is not walked
      // twice, and it is still walked as itself - pruning removes the duplicate, not
      // the Workspace.
      expect(byPath[nested].repositoryCount).toBe(1)
      // The nested Workspace is a Workspace like any other, and `isSourceRoot` is
      // what decides whether a task space can be started from it. Dropping it from
      // the request - which is what pruning the request does - took that away.
      expect(byPath[nested].isSourceRoot).toBe(true)
      // The parent's walk steps over the nested Workspace, so its count is the
      // repositories the parent itself holds. That is also what its row shows: the
      // panel gives each repository to the most specific Workspace holding it, so
      // inner-repo belongs to the nested row and never appeared under this one.
      // Counting it here would put a number beside a list that does not contain it.
      expect(byPath[join(fixture, "work")].repositoryCount).toBe(1)
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
})
// running, and what the Loader hands `apply` is a live reference rather than the
// value. Reading that reference without unwrapping it is what pinned the depth to
// the default: `Number({ get })` is NaN, and every helper here answers NaN with the
// default rather than with a number. So a depth of 3 scanned as 2, and reported
// itself as 2, no matter what was written - which reads exactly like a setting that
// is simply ignored, and is why this is pinned from both directions.
describe("the scan limits the running entry is held to", () => {
  beforeEach(() => clearScanCache())

  const live = (read) => ({ get: read })

  /** A scan walks the disk before it asks git, so the root has to exist. */
  async function scanFixture(prefix) {
    const root = await mkdtemp(join(tmpdir(), `dsh-ws-${prefix}-`))
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
  }

  const porcelainFor = (path) => [
    `worktree ${path}`,
    "HEAD abc",
    "branch refs/heads/main",
    "",
  ].join("\n")

  it("reads a depth held as a reference, and not as the default it fell back to", async () => {
    const handler = handleFor({}, { scanDepth: live(() => 3) })
    const answer = (await handler("worktree.cached", { paths: [] })).value
    expect(answer.current.depth).toBe(3)
  })

  it("follows a depth written after the entry loaded, without apply running again", async () => {
    let depth = 2
    const handler = handleFor({}, { scanDepth: live(() => depth) })
    expect((await handler("worktree.cached", { paths: [] })).value.current.depth).toBe(2)

    // The Plugins page writes this while the entry is running. Nothing re-runs
    // `apply`, because a volatile field is not a restart - so a value read once
    // at load would still answer with the old depth, which is the whole bug.
    depth = 5
    expect((await handler("worktree.cached", { paths: [] })).value.current.depth).toBe(5)
  })

  it("honours a directory cap held as a reference", async () => {
    const handler = handleFor({}, { maxScanDirectories: live(() => 250) })
    expect((await handler("worktree.cached", { paths: [] })).value.current.directories).toBe(250)
  })

  it("scans at the requested depth rather than the configured one", async () => {
    const fixture = await scanFixture("depth")
    try {
      const deep = join(fixture.root, "one", "two")
      await mkdir(join(deep, ".git"), { recursive: true })
      const handler = handleFor({ "worktree list --porcelain": porcelainFor(deep) }, { scanDepth: live(() => 5) })

      // The payload wins over the configuration, which is what lets the panel name
      // the depth it is waiting on before the setting has been written down.
      // `one/two` sits two levels under the root, so one is the depth that stops
      // short of it and five is the one that reaches it.
      await handler("worktree.scan", { paths: [fixture.root], depth: 1 })
      expect((await handler("worktree.cached", { paths: [fixture.root] })).value.repositories).toEqual([])

      await handler("worktree.scan", { paths: [fixture.root] })
      expect((await handler("worktree.cached", { paths: [fixture.root] })).value.repositories).toHaveLength(1)
    } finally {
      await fixture.cleanup()
    }
  })

  it("honours names added to the ignore list through a reference", async () => {
    const fixture = await scanFixture("ignored")
    try {
      const hidden = join(fixture.root, "skipped")
      await mkdir(join(hidden, ".git"), { recursive: true })
      const handler = handleFor({ "worktree list --porcelain": porcelainFor(hidden) }, {
        ignoredScanDirectories: live(() => ["skipped"]),
        removedScanDirectories: live(() => []),
      })
      // `Array.isArray` on the reference is false, so a guard written against the
      // reference itself skipped the whole block and left the built-in names in
      // force. The directory walked into is the evidence that it did.
      await handler("worktree.scan", { paths: [fixture.root] })
      expect((await handler("worktree.cached", { paths: [fixture.root] })).value.repositories).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })
})

describe("the request that widens a handed-on session", () => {
  /** A session service that records what is appended to the session it is asked for. */
  function sessionsWith(known) {
    const appended = []
    return {
      appended,
      sessions: {
        get: (id) => (known && id === "session-1"
          ? { append: (type, data) => appended.push({ type, data }) }
          : undefined),
      },
    }
  }

  it("appends the whole full-access preset, and says the session was widened", async () => {
    // The events are the session's whole permission state, so they are what is asserted
    // rather than a flag kept somewhere else. `danger-full-access` is what a session needs to
    // write a source repository's git metadata from a working directory that does not hold
    // it - and DSH's own table bundles it with `never`, "full file access without approval
    // prompts", which is written with it so the session is the same one the panel's own
    // switch produces rather than a pair that matches no preset.
    const { sessions, appended } = sessionsWith(true)
    const handler = handleFor({}, { handoffFullAccess: "on" }, undefined, { sessions })

    expect(await handler("task.handoff-access", { sessionId: "session-1" }))
      .toEqual({ ok: true, value: { widened: true, mode: "danger-full-access" } })
    expect(appended).toEqual([
      { type: "sandbox/mode", data: { mode: "danger-full-access", source: "delegation" } },
      { type: "approval/policy", data: { policy: "never", source: "delegation" } },
    ])
  })

  it("refuses while the setting is off, and appends nothing", async () => {
    // The setting is the authorisation for this write, so it is checked here rather than
    // taken from the client that asked: a stale dialog, or anything else that finds this
    // route, must not be able to widen a session by itself.
    const { sessions, appended } = sessionsWith(true)
    const off = handleFor({}, { handoffFullAccess: "off" }, undefined, { sessions })
    expect(await off("task.handoff-access", { sessionId: "session-1" }))
      .toMatchObject({ ok: false, error: { code: "E4012" } })
    expect(appended).toEqual([])

    // And unset is off too: a profile that never touched the setting has not agreed to it.
    const unset = handleFor({}, {}, undefined, { sessions })
    expect(await unset("task.handoff-access", { sessionId: "session-1" }))
      .toMatchObject({ ok: false, error: { code: "E4012" } })
    expect(appended).toEqual([])
  })

  it("says it did not widen when there is no session to widen", async () => {
    // Not a failure: the handoff has already happened, and the panel then says which
    // access the session actually got rather than claiming the setting took effect.
    const gone = handleFor({}, { handoffFullAccess: "on" }, undefined, { sessions: { get: () => undefined } })
    expect(await gone("task.handoff-access", { sessionId: "gone" }))
      .toEqual({ ok: true, value: { widened: false, reason: "no-session" } })

    // A deployment that composes no session service at all.
    const none = handleFor({}, { handoffFullAccess: "on" })
    expect(await none("task.handoff-access", { sessionId: "session-1" }))
      .toEqual({ ok: true, value: { widened: false, reason: "no-sessions-service" } })
  })

  it("refuses a request that names no session", async () => {
    const handler = handleFor({}, { handoffFullAccess: "on" })
    expect(await handler("task.handoff-access", {}))
      .toMatchObject({ ok: false, error: { code: "E4011" } })
  })
})

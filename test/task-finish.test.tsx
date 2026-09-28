// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorktreesSettings } from "../src/client/components/WorktreesSettings"
import { clearFinishScenes } from "../src/client/lib/finishScene"
import { format, t } from "../src/client/lib/i18n"
import type { FinishTaskResult, Worktree, WorktreeList } from "../src/client/lib/types"

const root = "E:\\worktree-space"
const container = `${root}\\antest`
const branch = "feat/antest"

function worktree(path: string, on: string | undefined, extra: Partial<Worktree> = {}): Worktree {
  return { path, branch: on, isMain: false, detached: false, locked: false, prunable: false, ...extra }
}
function repository(name: string, rows: Worktree[]): WorktreeList {
  const repoPath = `E:\\workspace\\public\\kratos-admin\\${name}`
  return {
    repoPath,
    commonDir: `${repoPath}\\.git`,
    currentBranch: "main",
    worktrees: [{ ...worktree(repoPath, "main"), isMain: true }, ...rows],
  }
}
/** Two repositories holding `feat/antest`, plus a hand-made worktree that is not a task. */
function scanned(): WorktreeList[] {
  return [
    repository("kratos-vue-admin", [worktree(`${container}\\kratos-vue-admin`, branch), worktree("/projects/api.worktrees/spike", "spike")]),
    repository("kratos-vue-admin-web", [worktree(`${container}\\kratos-vue-admin-web`, branch)]),
  ]
}
function finishResult(overrides: Partial<FinishTaskResult> = {}): FinishTaskResult {
  return {
    task: "antest",
    path: container,
    mergeTarget: "main",
    repositories: [
      { name: "kratos-vue-admin", path: `${container}\\kratos-vue-admin`, branch, target: "main", merged: true, removed: true, branchDeleted: false },
      { name: "kratos-vue-admin-web", path: `${container}\\kratos-vue-admin-web`, branch, target: "main", merged: true, removed: true, branchDeleted: false },
    ],
    strays: ["notes.md"],
    archivedStrays: [],
    removedStrays: [],
    containerRemoved: false,
    failed: false,
    warnings: [],
    ...overrides,
  }
}

function setup({ repos = scanned(), result = finishResult(), changedFiles = 0, strays = [], items = [] as any[], archiveDirectory = "" }: { repos?: WorktreeList[]; result?: FinishTaskResult; changedFiles?: number | ((path: string) => number); strays?: { name: string; directory: boolean; documents: number; kind: "build" | "editor" | "content" }[]; items?: any[]; archiveDirectory?: string } = {}) {
  const statusFor = typeof changedFiles === "function" ? changedFiles : () => changedFiles
  const api = {
    scan: vi.fn().mockResolvedValue(repos),
    cachedScan: vi.fn().mockResolvedValue(null),
    // What the Host has configured: the archive destination is empty unless a test
    // sets one, which is the same "not set" the real entry answers with.
    preferences: vi.fn().mockResolvedValue({ defaultBranchPrefix: "task/", archiveDocumentsDirectory: archiveDirectory }),
    // The page merges this status over the scanned row, so a dirty repository has
    // to report it here rather than in the scan fixture.
    status: vi.fn().mockImplementation(async (path: string) => ({ branchLine: "", output: "", changedFiles: statusFor(path) })),
    remove: vi.fn().mockResolvedValue({}),
    prune: vi.fn().mockResolvedValue({}),
    doneTask: vi.fn().mockResolvedValue(result),
    // The archive dialog asks the host what archiving would do, and shows the
    // answer: branch, merge target, the branches it could merge into instead,
    // commits and uncommitted files per repository. A chosen target comes back
    // with the commits that belong to it, exactly as the Host answers.
    planTask: vi.fn().mockImplementation(async ({ task, tasksRoot, targets }: { task: string; tasksRoot: string; targets?: Record<string, string> }) => {
      const repositories = ["kratos-vue-admin", "kratos-vue-admin-web"].map((name) => {
        const repoPath = tasksRoot + "\\" + task + "\\" + name
        const target = targets?.[name] ?? "main"
        return {
          name,
          path: repoPath,
          branch: "feat/" + task,
          target,
          checkedOut: "main",
          branches: ["main", "develop"],
          commits: target === "main" ? 0 : 4,
          changedFiles: statusFor(repoPath),
        }
      })
      return {
        task,
        tasksRoot,
        path: tasksRoot + "\\" + task,
        mergeTarget: repositories[0].target,
        changedFiles: repositories.reduce((total, repository) => total + repository.changedFiles, 0),
        commits: repositories.reduce((total, repository) => total + repository.commits, 0),
        repositories,
        strays,
      }
    }),
  }
  const workspaces = { list: { getSnapshot: () => ({ items }), subscribe: () => () => {} }, create: vi.fn(), rename: vi.fn(), delete: vi.fn() }
  const uiWorkspace = { openWorkspace: vi.fn(), openSession: vi.fn() }
  // The dialog opens one session per conflicting repository and sends it the work as
  // its first message, so the double records both halves of that: what each session
  // was opened with, and what it was told. The list is the Host's own; it is mutable
  // here because `running` is how the dialog learns a handoff is still working.
  const created: { cwd?: string }[] = []
  const prompts: { sessionId: string; text: string }[] = []
  const snapshots: Record<string, { running: boolean }> = {}
  const sessionListeners: (() => void)[] = []
  const sessions = {
    list: {
      getSnapshot: () => ({ byId: snapshots }),
      subscribe: (listener: () => void) => { sessionListeners.push(listener); return () => {} },
    },
    create: vi.fn(async (options: { cwd?: string }) => { created.push(options); return `session-${created.length}` }),
    using: vi.fn(async (sessionId: string, _options: unknown, operation: (reference: any) => unknown) => operation({
      binding: { session: { prompt: async (parts: { text?: string }[]) => { prompts.push({ sessionId, text: parts[0]?.text ?? "" }) } } },
    })),
  }
  render(<WorktreesSettings api={api as any} workspaces={workspaces as any} uiWorkspace={uiWorkspace as any} sessions={sessions as any} />)
  return { api, workspaces, sessions, created, prompts, snapshots, sessionListeners, uiWorkspace }
}

// An option's accessible name is its label followed by its hint, and one hint
// repeats another option's words, so anchor on the label.
const option = (label: string) => screen.getByRole("checkbox", { name: new RegExp(`^${label}`) })
const taskArticles = () => document.querySelectorAll(".dws-task")

// The reports a finish leaves behind outlive the dialog, so a case that made one has to
// clear it: otherwise the next case opens on the previous one's conflict.
afterEach(() => { cleanup(); clearFinishScenes() })

/** The page opens on tasks, so this only waits for the first scan to settle. */
async function ready() {
  await waitFor(() => expect(screen.getByRole("button", { name: t("refresh") })).toHaveProperty("disabled", false))
}

describe("task view", () => {
  it("opens on the tasks, which no other view groups this way", async () => {
    const user = userEvent.setup()
    setup()
    await ready()

    expect(screen.getByRole("heading", { name: "antest" })).toBeTruthy()
    // The panel shows every path with forward slashes, whichever separator the host reported.
    expect(screen.getByText(container.replace(/\\/g, "/"))).toBeTruthy()
    expect(screen.getByText(branch)).toBeTruthy()
    expect(screen.getByText("kratos-vue-admin")).toBeTruthy()
    expect(screen.getByText("kratos-vue-admin-web")).toBeTruthy()
    // Tasks lead the switch, since they are what the page opens on. The filters and
    // the fold button follow it in one run, the order the panel reads them in too.
    const viewSwitch = screen.getByRole("group", { name: t("viewSwitch") })
    expect([...viewSwitch.querySelectorAll("button")].map((button) => button.textContent)).toEqual([t("viewTasks"), t("viewWorkspaces"), t("viewRepositories")])
    const foldRun = screen.getByRole("group", { name: t("filters") })
    expect([...foldRun.querySelectorAll("button")].map((button) => button.textContent)).toEqual([t("filterAll"), t("filterAttention"), t("collapseAll")])
    // The hand-made `spike` worktree shares no container with a matching branch.
    expect(taskArticles()).toHaveLength(1)
    expect(document.querySelector(".dws-summary")?.textContent).toContain(t("taskCount"))

    // The repository view keeps showing it, unchanged.
    await user.click(screen.getByRole("button", { name: t("viewRepositories") }))
    expect(screen.getByRole("heading", { name: "kratos-vue-admin" })).toBeTruthy()
    expect(taskArticles()).toHaveLength(0)

    await user.click(screen.getByRole("button", { name: t("viewTasks") }))
    expect(taskArticles()).toHaveLength(1)
  })

  it("offers the attention filter here too, and applies it to whole tasks", async () => {
    const user = userEvent.setup()
    // Two tasks side by side: only `dirty` has uncommitted work in either repository.
    const rows = (task: string) => [worktree(`${root}\\${task}\\kratos-vue-admin`, `feat/${task}`), worktree(`${root}\\${task}\\kratos-vue-admin-web`, `feat/${task}`)]
    setup({
      repos: [
        repository("kratos-vue-admin", [rows("antest")[0]!, rows("dirty")[0]!]),
        repository("kratos-vue-admin-web", [rows("antest")[1]!, rows("dirty")[1]!]),
      ],
      changedFiles: (path) => (path.includes("dirty") ? 3 : 0),
    })
    await ready()

    const filters = screen.getByRole("group", { name: t("filters") })
    // Every task holds worktrees, so that filter has nothing to say here; the fold
    // button shares the run, as it does in the panel.
    expect([...filters.querySelectorAll("button")].map((button) => button.textContent)).toEqual([t("filterAll"), t("filterAttention"), t("collapseAll")])
    expect(screen.getByRole("heading", { name: "antest" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "dirty" })).toBeTruthy()

    await user.click(within(filters).getByRole("button", { name: t("filterAttention") }))
    expect(screen.getByRole("heading", { name: "dirty" })).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "antest" })).toBeNull()
    expect(document.querySelector(".dws-summary")?.textContent).toContain("1 / 2")
  })

  it("says what a bare count counts, in both views that show one", async () => {
    const user = userEvent.setup()
    setup()
    await ready()

    // A number with no noun beside it means nothing until it is hovered, and the two
    // views ask the same question — how many worktrees hang under this row — so both
    // carry the same hint. The repository rows had it and the task rows did not.
    const taskCount = document.querySelector(".dws-task .dws-count")
    expect(taskCount?.textContent).toBe("2")
    expect(taskCount?.getAttribute("title")).toBe(format(t("worktreeCountHint"), { count: "2" }))

    await user.click(screen.getByRole("button", { name: t("viewRepositories") }))
    const repoCounts = [...document.querySelectorAll(".dws-repo .dws-count")]
    expect(repoCounts.map((node) => node.textContent)).toEqual(["2", "1"])
    expect(repoCounts.map((node) => node.getAttribute("title"))).toEqual([
      format(t("worktreeCountHint"), { count: "2" }),
      format(t("worktreeCountHint"), { count: "1" }),
    ])
  })
})

describe("finishing a task", () => {
  it("merges and deletes branches only as chosen, then reports every repository", async () => {
    const user = userEvent.setup()
    const next = setup()
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))

    expect(screen.getByRole("dialog", { name: format(t("finishTitle"), { task: "antest" }) })).toBeTruthy()
    // Merging is what the task was for, so it is on already; deleting the branch
    // is not, and stays both unticked and unavailable until a merge is wanted.
    expect(option(t("finishMerge"))).toHaveProperty("checked", true)
    expect(option(t("finishDeleteBranch"))).toHaveProperty("disabled", false)
    expect(option(t("finishDeleteBranch"))).toHaveProperty("checked", false)
    expect(option(t("finishForce"))).toHaveProperty("checked", false)
    await user.click(option(t("finishDeleteBranch")))
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))

    await waitFor(() => expect(next.api.doneTask).toHaveBeenCalledTimes(1))
    expect(next.api.doneTask).toHaveBeenCalledWith({ task: "antest", tasksRoot: root, merge: true, deleteBranch: true, force: false, cleanStray: true })
    await waitFor(() => expect(screen.getByText(t("finishDone"))).toBeTruthy())
    expect(screen.getAllByText(new RegExp(t("finishMerged").replace("{target}", "main")))).toHaveLength(2)
    expect(screen.getAllByText(new RegExp(t("finishRemoved"))).length).toBeGreaterThan(0)
    expect(screen.getByText(format(t("finishStrays"), { names: "notes.md" }))).toBeTruthy()
    expect(screen.getByText(format(t("finishContainerKept"), { path: container.replace(/\\/g, "/") }))).toBeTruthy()
    // The report replaces the options: nothing left to confirm twice.
    expect(screen.queryByRole("button", { name: t("finishConfirmAction") })).toBeNull()
    expect(next.api.doneTask).toHaveBeenCalledTimes(1)
  })

  it("hands a standing conflict to an agent in its own worktree, then finishes again when asked", async () => {
    const user = userEvent.setup()
    const site = `${container}\\kratos-vue-admin`
    const next = setup({
      result: finishResult({
        failed: true,
        repositories: [
          { name: "kratos-vue-admin", path: site, branch, target: "main", merged: false, removed: false, branchDeleted: false, conflict: true, mergeInProgress: true, mergeSite: site, conflictedFiles: ["src/a.ts"], error: "CONFLICT (content): merge conflict in src/a.ts" },
          { name: "kratos-vue-admin-web", path: `${container}\\kratos-vue-admin-web`, branch, target: "main", merged: true, removed: true, branchDeleted: true },
        ],
        strays: [],
        containerRemoved: false,
      }),
    })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))

    // The conflict is the step that is left, so it says where it stands and offers to
    // spend a session on it — rather than spending one before being asked.
    await waitFor(() => expect(screen.getByText(t("finishHandoffTitle"))).toBeTruthy())
    expect(next.sessions.create).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: t("finishHandoffAuthorize") }))
    // One session, opened in the worktree the merge is standing in, in the repository
    // that could not reconcile — and told the files and the one thing not to do.
    await waitFor(() => expect(next.sessions.create).toHaveBeenCalledWith({ cwd: site }))
    await waitFor(() => expect(next.created).toHaveLength(1))
    expect(next.prompts[0].text).toContain(site.replace(/\\/g, "/"))
    expect(next.prompts[0].text).toContain("src/a.ts")
    // Opened on the worktree itself, the session cannot be told that the repository's
    // git metadata is writable: it may be somewhere this boundary does not reach.
    expect(next.prompts[0].text).toContain(t("finishHandoffScopeTight"))
    expect(next.prompts[0].text).not.toContain(t("finishHandoffScopeWide"))
    expect(screen.getByText(format(t("finishHandoffAuthorized"), { count: "1", sessions: "kratos-vue-admin" }))).toBeTruthy()

    // The dialog cannot see an approval and cannot do the agent's work, so it does the
    // two things it can: report where the session state comes from, and take the user
    // to the session itself.
    expect(screen.getByText(t("finishHandoffApprove"))).toBeTruthy()
    await user.click(screen.getByRole("button", { name: t("finishHandoffOpen") }))
    expect(next.uiWorkspace.openSession).toHaveBeenCalledWith("session-1")

    // A session still working owns the next step: finishing now would try to merge a
    // branch whose merge is not committed yet, so the button waits for the Host to
    // report it stopped.
    act(() => {
      next.snapshots["session-1"] = { running: true }
      next.sessionListeners.forEach((listener) => listener())
    })
    expect((screen.getByRole("button", { name: t("finishContinueWaiting") }) as HTMLButtonElement).disabled).toBe(true)
    expect(next.api.doneTask).toHaveBeenCalledTimes(1)
    act(() => {
      next.snapshots["session-1"] = { running: false }
      next.sessionListeners.forEach((listener) => listener())
    })

    // Nothing finishes twice behind the user's back: the second finish is asked for,
    // because only the user knows whether what came back is what they wanted.
    await user.click(screen.getByRole("button", { name: t("finishContinue") }))
    await waitFor(() => expect(next.api.doneTask).toHaveBeenCalledTimes(2))
  })

  it("opens the handoff session on the ancestor of the worktree and the repository the Host named", async () => {
    const user = userEvent.setup()
    // A task space beside its repositories, as the demo lays them out: the session's
    // working directory is its write boundary, so one opened on the worktree alone
    // could edit the conflicted file but never commit it - a linked worktree keeps
    // its git metadata under the main repository. The Host names that repository with
    // the conflict, and the two have nothing in common past the container, so the
    // container is the narrowest boundary that reaches both.
    const site = "E:\\wt-demo\\spaces\\demo\\alpha"
    const next = setup({
      result: finishResult({
        failed: true,
        repositories: [
          { name: "alpha", path: site, mainRepo: "E:\\wt-demo\\repos\\alpha", branch: "task/demo", target: "main", merged: false, removed: false, branchDeleted: false, conflict: true, mergeInProgress: true, mergeSite: site, conflictedFiles: ["src/app.ts"], error: "CONFLICT (content): Merge conflict in src/app.ts" },
        ],
      }),
    })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))
    await waitFor(() => expect(screen.getByText(t("finishHandoffTitle"))).toBeTruthy())

    // The page scans the Workspaces for its own view; what must not happen is the
    // dialog scanning them again for an answer the Host already gave.
    const scans = next.api.scan.mock.calls.length + next.api.cachedScan.mock.calls.length
    await user.click(screen.getByRole("button", { name: t("finishHandoffAuthorize") }))
    await waitFor(() => expect(next.sessions.create).toHaveBeenCalledWith({ cwd: "E:/wt-demo" }))
    expect(next.api.scan.mock.calls.length + next.api.cachedScan.mock.calls.length).toBe(scans)
    // The message says which directory the session is in, since that is no longer the
    // directory the work is in, and the panel names the boundary it bought.
    expect(next.prompts[0].text).toContain("E:/wt-demo")
    // A boundary that reaches the repository is what the agent is told it has, since
    // that is what saves it from asking for a wider sandbox.
    expect(next.prompts[0].text).toContain(t("finishHandoffScopeWide"))
    expect(screen.getByText(format(t("finishHandoffBoundary"), { path: "E:/wt-demo" }))).toBeTruthy()
  })

  it("opens the handoff session on a scanned repository when the Host named none", async () => {
    const user = userEvent.setup()
    // A Host that named no repository still has one: the scan pairs the worktree with
    // the repository behind it, and their common ancestor is the narrowest boundary
    // that reaches the metadata. The comparison has to read both spellings of a
    // Windows path - the Host joins with backslashes, git prints forward slashes.
    const repo = "E:\\worktree-space\\repos\\alpha"
    const site = `${container}\\alpha`
    const next = setup({
      repos: [
        ...scanned(),
        {
          repoPath: repo,
          commonDir: `${repo}\\.git`,
          currentBranch: "main",
          worktrees: [{ ...worktree(repo, "main"), isMain: true }, worktree(site, "task/demo")],
        },
      ],
      result: finishResult({
        failed: true,
        repositories: [
          { name: "alpha", path: site, branch: "task/demo", target: "main", merged: false, removed: false, branchDeleted: false, conflict: true, mergeInProgress: true, mergeSite: site, conflictedFiles: ["src/app.ts"], error: "CONFLICT (content): Merge conflict in src/app.ts" },
        ],
      }),
    })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))
    await waitFor(() => expect(screen.getByText(t("finishHandoffTitle"))).toBeTruthy())

    await user.click(screen.getByRole("button", { name: t("finishHandoffAuthorize") }))
    await waitFor(() => expect(next.sessions.create).toHaveBeenCalledWith({ cwd: "E:/worktree-space" }))
    await waitFor(() => expect(next.created).toHaveLength(1))
    // The task's own directory is one of the places the pairing is looked for, since a
    // task space is a worktree of the repository whose metadata the session needs.
    expect(next.api.scan).toHaveBeenCalledWith(expect.arrayContaining([container]))
    // The message says which directory the session is in, since that is no longer the
    // directory the work is in.
    expect(next.prompts[0].text).toContain("E:/worktree-space")
    // The boundary is wider than the worktree, and that width is what saves the
    // approval, so the panel names it rather than leaving it to be discovered.
    expect(screen.getByText(format(t("finishHandoffBoundary"), { path: "E:/worktree-space" }))).toBeTruthy()
    expect(screen.getByText(site.replace(/\\/g, "/"))).toBeTruthy()
  })

  it("puts a standing conflict back when the dialog is reopened after approving a session", async () => {
    const user = userEvent.setup()
    const site = `${container}\\kratos-vue-admin`
    const result = finishResult({
      failed: true,
      repositories: [
        { name: "kratos-vue-admin", path: site, branch, target: "main", merged: false, removed: false, branchDeleted: false, conflict: true, mergeInProgress: true, mergeSite: site, conflictedFiles: ["src/a.ts"], error: "CONFLICT (content): merge conflict in src/a.ts" },
      ],
      strays: [],
      containerRemoved: false,
    })
    const first = setup({ result })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))
    await waitFor(() => expect(screen.getByText(t("finishHandoffTitle"))).toBeTruthy())
    await user.click(screen.getByRole("button", { name: t("finishHandoffAuthorize") }))
    await waitFor(() => expect(first.created).toHaveLength(1))

    // Approving an approval happens in the session's own view, which replaces the view
    // this dialog is drawn in. So the page comes back, and what it has to show is the
    // report - not an empty dialog, and not a second session for the same worktree.
    cleanup()
    const second = setup({ result })
    // The report is on screen from the start here: the dialog holds the page's view, so
    // the page's own controls are behind it and the report is what to wait for.
    await waitFor(() => expect(screen.getByText(t("finishHandoffTitle"))).toBeTruthy())
    expect(second.sessions.create).not.toHaveBeenCalled()
    expect(screen.getByText(format(t("finishHandoffAuthorized"), { count: "1", sessions: "kratos-vue-admin" }))).toBeTruthy()
    // And the step it was left on is still the one on offer.
    expect((screen.getByRole("button", { name: t("finishContinue") }) as HTMLButtonElement).disabled).toBe(false)

    // A finish that has nothing left to do clears its report, so reopening the page
    // does not bring back a conflict that has already been dealt with.
    second.api.doneTask.mockResolvedValue(finishResult())
    await user.click(screen.getByRole("button", { name: t("finishContinue") }))
    await waitFor(() => expect(second.api.doneTask).toHaveBeenCalledTimes(1))
    cleanup()
    setup({ result: finishResult() })
    await ready()
    expect(screen.queryByText(t("finishHandoffTitle"))).toBeNull()
  })

  it("shows where a handed-on merge is standing, and the files it could not reconcile", async () => {
    const user = userEvent.setup()
    const site = `${root}\\kratos-vue-admin`
    const next = setup({
      // The Host left the merge in place instead of aborting it, which is what the
      // agent that resolves it needs to be told: the checkout, and the files.
      result: finishResult({
        failed: true,
        repositories: [
          {
            name: "kratos-vue-admin",
            path: `${container}\\kratos-vue-admin`,
            branch,
            target: "main",
            merged: false,
            removed: false,
            branchDeleted: false,
            conflict: true,
            mergeInProgress: true,
            mergeSite: site,
            conflictedFiles: ["src/a.ts", "src/b.ts"],
            error: "CONFLICT (content): merge conflict in src/a.ts",
          },
        ],
      }),
    })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))

    await waitFor(() => expect(screen.getByText(format(t("finishConflictHandoff"), { site: site.replace(/\\/g, "/") }))).toBeTruthy())
    expect(screen.getByText(format(t("finishConflictFiles"), { files: "src/a.ts, src/b.ts" }))).toBeTruthy()
    // Still standing, not aborted: the report says which of the two it is.
    expect(screen.getAllByText(t("finishConflictKept")).length).toBeGreaterThan(0)
    expect(screen.queryByText(t("finishConflicted"))).toBeNull()
  })

  it("names the task space by its directory, not by one repository's merge target", async () => {
    const user = userEvent.setup()
    const next = setup()
    // Two repositories pointed at different branches: there is no single target a
    // headline could name, which is why the per-repository rows are the only place
    // the target is stated.
    next.api.planTask.mockImplementation(async ({ task, tasksRoot }: { task: string; tasksRoot: string }) => ({
      task,
      tasksRoot,
      path: `${tasksRoot}\\${task}`,
      changedFiles: 0,
      commits: 2,
      strays: [],
      repositories: [
        { name: "kratos-vue-admin", path: `${tasksRoot}\\${task}\\kratos-vue-admin`, branch: "feat/antest", target: "main", checkedOut: "main", branches: ["main", "develop"], commits: 1, changedFiles: 0 },
        { name: "kratos-vue-admin-web", path: `${tasksRoot}\\${task}\\kratos-vue-admin-web`, branch: "feat/antest", target: "develop", checkedOut: "develop", branches: ["main", "develop"], commits: 1, changedFiles: 0 },
      ],
    }))
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))

    await waitFor(() => expect(screen.getByText(format(t("planCommits"), { count: "2" }))).toBeTruthy())
    // The space is named by its directory, and each row carries its own target.
    expect(screen.getByText(t("taskDirectoryLabel")).parentElement?.textContent).toContain(container.replace(/\\/g, "/"))
    expect([...document.querySelectorAll(".dws-plan-target")].map((select) => (select as HTMLSelectElement).value)).toEqual(["main", "develop"])
    expect(document.querySelector(".dws-remove-target")).toBeNull()
  })

  it("points one repository at another branch, previews it, and merges there", async () => {
    const user = userEvent.setup()
    const next = setup()
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))
    await waitFor(() => expect(next.api.planTask).toHaveBeenCalledTimes(1))

    // Each repository offers the branch it is on first, then the alternatives the
    // Host listed — the task branch itself is never among them.
    const picker = screen.getByRole("combobox", { name: `${t("planTargetLabel")} · kratos-vue-admin` })
    expect([...picker.querySelectorAll("option")].map((choice) => choice.textContent)).toEqual(["main", "develop"])

    await user.selectOptions(picker, "develop")
    await waitFor(() => expect(next.api.planTask).toHaveBeenCalledWith(expect.objectContaining({ targets: { "kratos-vue-admin": "develop" } })))
    // The preview follows the choice: the commits that branch would bring, and the
    // note that it is not the branch the source repository is on.
    const plan = () => document.querySelector(".dws-finish-repos")!.textContent ?? ""
    await waitFor(() => expect(plan()).toContain(format(t("planCommits"), { count: "4" })))
    expect(screen.getAllByText(t("planTemporaryWorktree"))).toHaveLength(1)
    // The repository left alone keeps its own default, counted on its own branch.
    expect(plan()).toContain(format(t("planCommits"), { count: "0" }))

    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))
    await waitFor(() => expect(next.api.doneTask).toHaveBeenCalledTimes(1))
    expect(next.api.doneTask).toHaveBeenCalledWith(expect.objectContaining({ merge: true, targets: { "kratos-vue-admin": "develop" } }))
    // The plan stays on screen as the record of what was done, so its choice is
    // read-only rather than pointing at a task space that no longer exists.
    await waitFor(() => expect(screen.getByRole("combobox", { name: `${t("planTargetLabel")} · kratos-vue-admin` })).toHaveProperty("disabled", true))
  })

  it("lists the user's own leftovers before the choice, and only summarises build noise", async () => {
    const user = userEvent.setup()
    const next = setup({
      strays: [
        { name: "dist", directory: true, documents: 0, kind: "build" },
        { name: ".idea", directory: true, documents: 0, kind: "editor" },
        { name: "notes.md", directory: false, documents: 1, kind: "content" },
        { name: "docs", directory: true, documents: 2, kind: "content" },
      ],
    })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))
    await waitFor(() => expect(document.querySelector(".dws-plan-strays")).toBeTruthy())

    const plan = document.querySelector(".dws-plan-strays")!
    // The user's own content is named one by one, with its documents called out…
    expect([...plan.querySelectorAll("li")].map((row) => row.querySelector("code")?.textContent)).toEqual(["notes.md", "docs/"])
    expect(plan.textContent).toContain(format(t("planDocuments"), { count: "2" }))
    expect(plan.textContent).toContain(t("planBreadcrumb"))
    // …build output and editor state are one line, not entries of their own…
    const noise = document.querySelector(".dws-plan-noise")!
    expect(noise.textContent).toContain(format(t("planNoise"), { count: "2", names: "dist/、.idea/" }))
    // …and nothing is warned about while the documents are being kept, which is
    // the default: only unticking loses anything.
    expect(document.querySelector(".dws-notice-danger")).toBeNull()
    expect(next.api.doneTask).not.toHaveBeenCalled()
  })

  it("files the container's documents out of the way by default", async () => {
    const user = userEvent.setup()
    const next = setup({ strays: [{ name: "notes.md", directory: false, documents: 1, kind: "content" }] })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))

    await waitFor(() => expect(option(t("archiveDocuments"))).toBeTruthy())
    // On by default, and the folder it names is the one the call will use.
    expect(option(t("archiveDocuments"))).toHaveProperty("checked", true)
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))

    await waitFor(() => expect(next.api.doneTask).toHaveBeenCalledTimes(1))
    const payload = next.api.doneTask.mock.calls[0]![0] as { documentsDirectory?: string; discardDocuments?: boolean }
    // The folder is named after the workspace and the moment: the exact second is
    // the dialog's, so it is matched by shape rather than recomputed here.
    expect(payload.documentsDirectory).toMatch(new RegExp(`^${root.replace(/\\/g, "\\\\")}\\\\archived-docs\\\\antest-\\d{8}-\\d{6}$`))
    expect(payload.discardDocuments).toBeUndefined()
  })

  it("deletes the documents outright when the box is unticked", async () => {
    const user = userEvent.setup()
    const next = setup({ strays: [{ name: "notes.md", directory: false, documents: 1, kind: "content" }] })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))

    const box = await waitFor(() => option(t("archiveDocuments")))
    await user.click(box)
    expect(box).toHaveProperty("checked", false)
    // Unticking is the only thing that loses writing, so it is the only thing
    // that warns — and it names exactly what would go.
    const warning = document.querySelector(".dws-notice-danger")!
    expect(warning.textContent).toContain(format(t("archiveDocumentsWarning"), { names: "notes.md", count: "1" }))
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))

    await waitFor(() => expect(next.api.doneTask).toHaveBeenCalledTimes(1))
    const payload = next.api.doneTask.mock.calls[0]![0] as { documentsDirectory?: string; discardDocuments?: boolean }
    expect(payload.discardDocuments).toBe(true)
    expect(payload.documentsDirectory).toBeUndefined()
  })

  it("files into the configured destination when the Host has one set", async () => {
    const user = userEvent.setup()
    // The setting is read rather than assumed: this Host has one configured, so it is
    // the folder the dialog proposes and the one the call carries.
    const configured = "E:\\archived-docs"
    const next = setup({ strays: [{ name: "notes.md", directory: false, documents: 1, kind: "content" }], archiveDirectory: configured })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))

    const box = await waitFor(() => option(t("archiveDocuments")))
    // The row names the configured folder, not a folder computed for this task.
    expect(box.closest(".dws-check-option")?.textContent).toContain(configured.replace(/\\/g, "/"))
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))

    await waitFor(() => expect(next.api.doneTask).toHaveBeenCalledTimes(1))
    const payload = next.api.doneTask.mock.calls[0]![0] as { documentsDirectory?: string }
    // Exactly the configured directory: no title, no moment added to it, so repeated
    // archives land in one place rather than in a folder each.
    expect(payload.documentsDirectory).toBe(configured)
  })

  it("keeps the computed folder when the setting is empty", async () => {
    const user = userEvent.setup()
    // Empty is the setting's "not set", which is also the answer from a Host that has
    // never had it written: the per-workspace folder has to come back.
    const next = setup({ strays: [{ name: "notes.md", directory: false, documents: 1, kind: "content" }], archiveDirectory: "" })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))

    await waitFor(() => expect(option(t("archiveDocuments"))).toBeTruthy())
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))

    await waitFor(() => expect(next.api.doneTask).toHaveBeenCalledTimes(1))
    const payload = next.api.doneTask.mock.calls[0]![0] as { documentsDirectory?: string }
    expect(payload.documentsDirectory).toMatch(new RegExp(`^${root.replace(/\\/g, "\\\\")}\\\\archived-docs\\\\antest-\\d{8}-\\d{6}$`))
  })

  it("warns about uncommitted work and only forces discarding it deliberately", async () => {
    const user = userEvent.setup()
    const next = setup({ changedFiles: 2 })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))

    expect(screen.getByText(format(t("finishDirtyNotice"), { count: "4" }))).toBeTruthy()
    expect(screen.queryByText(t("finishForceWarning"))).toBeNull()
    await user.click(option(t("finishForce")))
    expect(screen.getByText(t("finishForceWarning"))).toBeTruthy()
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))

    await waitFor(() => expect(next.api.doneTask).toHaveBeenCalledWith(expect.objectContaining({ force: true, merge: true, deleteBranch: false })))
  })

  it("keeps the branches when merging is unticked", async () => {
    const user = userEvent.setup()
    const kept = finishResult({
      mergeTarget: undefined,
      repositories: finishResult().repositories.map((entry) => ({ ...entry, merged: false, target: undefined })),
    })
    const next = setup({ result: kept })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))
    // Merging is on by default, so a task kept unmerged is one the user opted out
    // of: untick it and the branches stay where they are.
    await user.click(option(t("finishMerge")))
    expect(option(t("finishMerge"))).toHaveProperty("checked", false)
    expect(option(t("finishDeleteBranch"))).toHaveProperty("disabled", true)
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))

    await waitFor(() => expect(screen.getByText(t("finishDoneKept"))).toBeTruthy())
    expect(next.api.doneTask).toHaveBeenCalledWith(expect.objectContaining({ merge: false, deleteBranch: false }))
  })

  it("abandons a task space without merging once the branch deletion is forced", async () => {
    const user = userEvent.setup()
    const next = setup({ result: finishResult({
      mergeTarget: undefined,
      repositories: finishResult().repositories.map((entry) => ({ ...entry, merged: false, removed: true, branchDeleted: true, target: undefined })),
    }) })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))

    // Merging is on by default, so deleting a branch is available at once.
    await user.click(option(t("finishDeleteBranch")))
    expect(option(t("finishDeleteBranch"))).toHaveProperty("checked", true)

    // Unticking the merge takes that away again - and drops the tick with it, since
    // nothing on screen may still ask for something the flow will refuse.
    await user.click(option(t("finishMerge")))
    expect(option(t("finishDeleteBranch"))).toHaveProperty("disabled", true)
    expect(option(t("finishDeleteBranch"))).toHaveProperty("checked", false)

    // Forcing is what makes an unmerged branch deletable: abandoning the task space.
    await user.click(option(t("finishForce")))
    expect(option(t("finishDeleteBranch"))).toHaveProperty("disabled", false)
    // What force costs is said before it is done, and it costs more with the branch.
    expect(screen.getByText(t("finishForceWarning"))).toBeTruthy()
    await user.click(option(t("finishDeleteBranch")))
    expect(screen.getByText(t("finishForceWarningBranch"))).toBeTruthy()

    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))
    await waitFor(() => expect(next.api.doneTask).toHaveBeenCalledWith(expect.objectContaining({ merge: false, deleteBranch: true, force: true })))
    // The headline has to agree with the row: nothing was merged, and the branch did
    // not survive, so this was an abandonment rather than a task kept for later.
    await waitFor(() => expect(screen.getByText(t("finishDoneDiscarded"))).toBeTruthy())
    expect(screen.queryByText(t("finishDoneKept"))).toBeNull()
  })

  it("warns while finishing is routine, and turns red once Force would discard uncommitted files", async () => {
    const user = userEvent.setup()
    // Two uncommitted files and three commits waiting: the plan the dialog reads.
    const next = setup()
    next.api.planTask.mockImplementation(async ({ task, tasksRoot }: { task: string; tasksRoot: string }) => ({
      task, tasksRoot, path: `${tasksRoot}\\${task}`, changedFiles: 2, commits: 3, strays: [],
      repositories: [{ name: "kratos-vue-admin", path: `${tasksRoot}\\${task}\\kratos-vue-admin`, branch: "feat/antest", target: "main", checkedOut: "main", branches: ["main"], commits: 3, changedFiles: 2 }],
    }))
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))
    const confirm = () => screen.getByRole("button", { name: t("finishConfirmAction") })

    // Merging with the branches kept is routine: the merge can be reverted and
    // nothing is discarded, so the button warns instead of shouting.
    expect(confirm().className).toContain("dws-button-warn-solid")
    // Force discards those two files, which is not reversible.
    await user.click(option(t("finishForce")))
    expect(confirm().className).toContain("dws-button-danger-solid")
    // Deleting a branch that was merged loses nothing, so with the files gone this
    // is a warning again.
    await user.click(option(t("finishForce")))
    await user.click(option(t("finishDeleteBranch")))
    expect(confirm().className).toContain("dws-button-warn-solid")
    expect(next.api.doneTask).not.toHaveBeenCalled()
  })

  it("turns red when abandoning a branch that still has commits", async () => {
    const user = userEvent.setup()
    const next = setup()
    next.api.planTask.mockImplementation(async ({ task, tasksRoot }: { task: string; tasksRoot: string }) => ({
      task, tasksRoot, path: `${tasksRoot}\\${task}`, changedFiles: 0, commits: 3, strays: [],
      repositories: [{ name: "kratos-vue-admin", path: `${tasksRoot}\\${task}\\kratos-vue-admin`, branch: "feat/antest", target: "main", checkedOut: "main", branches: ["main"], commits: 3, changedFiles: 0 }],
    }))
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))
    const confirm = () => screen.getByRole("button", { name: t("finishConfirmAction") })

    // A clean worktree and no branch deletion: still routine.
    expect(confirm().className).toContain("dws-button-warn-solid")
    // No merge, forced branch deletion, and three commits that live only there.
    await user.click(option(t("finishMerge")))
    await user.click(option(t("finishForce")))
    await user.click(option(t("finishDeleteBranch")))
    expect(confirm().className).toContain("dws-button-danger-solid")
    expect(next.api.doneTask).not.toHaveBeenCalled()
  })

  it("reports a repository left untouched instead of hiding it behind the others", async () => {
    const user = userEvent.setup()
    const conflicted = finishResult({
      failed: true,
      repositories: [
        { name: "kratos-vue-admin", path: `${container}\\kratos-vue-admin`, branch, target: "main", merged: true, removed: true, branchDeleted: false },
        { name: "kratos-vue-admin-web", path: `${container}\\kratos-vue-admin-web`, branch, merged: false, removed: false, branchDeleted: false, conflict: true, error: "CONFLICT (content): merge conflict in src/main.ts" },
      ],
      strays: [],
      containerRemoved: false,
    })
    const next = setup({ result: conflicted })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))

    await waitFor(() => expect(screen.getByText(t("finishPartial"))).toBeTruthy())
    // The conflict is explained in the user's language; git's own words are the
    // detail behind the disclosure rather than the sentence itself.
    expect(screen.getByText(t("finishConflict"))).toBeTruthy()
    expect(screen.getByText(t("finishConflicted"))).toBeTruthy()
    expect(screen.getByText(t("finishGitOutput")).parentElement?.textContent).toContain("merge conflict in src/main.ts")
    expect(next.api.doneTask).toHaveBeenCalledTimes(1)
  })

  it("says nothing was finished when every repository kept its own", async () => {
    const user = userEvent.setup()
    const next = setup({ result: finishResult({
      failed: true,
      repositories: finishResult().repositories.map((entry) => ({ ...entry, merged: false, removed: false, error: "cannot locate the source repository" })),
      containerRemoved: false,
    }) })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))

    await waitFor(() => expect(screen.getByText(t("finishNone"))).toBeTruthy())
    expect(screen.queryByText(t("finishPartial"))).toBeNull()
  })

  it("keeps the workspace registration while the task space is still there", async () => {
    const user = userEvent.setup()
    const next = setup({
      items: [{ workspaceId: "ws-antest", path: container, title: "worktree-space/antest" }],
      result: finishResult({
        failed: true,
        repositories: [{ name: "kratos-vue-admin-web", path: `${container}\\kratos-vue-admin-web`, branch, merged: false, removed: false, branchDeleted: false, conflict: true, error: "CONFLICT (content): merge conflict" }],
        strays: [],
        containerRemoved: false,
      }),
    })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))

    // The container is still on disk with the conflict inside it: dropping the
    // registration here would hide the task space and strand its sessions.
    await waitFor(() => expect(screen.getByText(t("archiveWorkspaceKeptIntact"))).toBeTruthy())
    expect(next.workspaces.delete).not.toHaveBeenCalled()
  })

  it("removes the workspace registration once the container is really gone", async () => {
    const user = userEvent.setup()
    const next = setup({
      items: [{ workspaceId: "ws-antest", path: container, title: "worktree-space/antest" }],
      result: finishResult({ containerRemoved: true }),
    })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))

    await waitFor(() => expect(next.workspaces.delete).toHaveBeenCalledWith("ws-antest"))
    expect(screen.getByText(t("archiveWorkspaceRemoved"))).toBeTruthy()
  })

  it("surfaces a failed finish without closing the dialog or losing the choice", async () => {
    const user = userEvent.setup()
    const next = setup()
    next.api.doneTask.mockRejectedValueOnce(new Error("no such task space: E:\\worktree-space\\antest"))
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("no such task space"))
    expect(option(t("finishMerge"))).toHaveProperty("checked", true)
    expect(screen.getByRole("button", { name: t("finishConfirmAction") })).toBeTruthy()
    expect(next.api.scan).toHaveBeenCalledTimes(1)
  })
})

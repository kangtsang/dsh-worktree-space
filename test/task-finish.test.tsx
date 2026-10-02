// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorktreesSettings } from "../src/client/components/WorktreesSettings"
import { clearFinishScenes, readFinishScene, saveFinishScene, type FinishSceneSession } from "../src/client/lib/finish-scene"
import { format, t } from "../src/client/lib/i18n"
import type { FinishTaskResult, Worktree, WorktreeList } from "../src/client/lib/types"

const root = "E:\\worktree-space"
// A task space is `<container root>/<project>/<task>`, the project being the source
// root's own directory name.
const project = "kratos-admin"
const container = `${root}\\${project}\\antest`
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
    project,
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

function setup({ repos = scanned(), result = finishResult(), changedFiles = 0, strays = [], items = [] as any[], archiveDirectory = "", archiveStrategy = "container", handoffEntry = "show", plan }: { repos?: WorktreeList[]; result?: FinishTaskResult; changedFiles?: number | ((path: string) => number); strays?: { name: string; directory: boolean; documents: number; kind: "build" | "editor" | "content" }[]; items?: any[]; archiveDirectory?: string; archiveStrategy?: string; handoffEntry?: string; plan?: (built: any) => any } = {}) {
  const statusFor = typeof changedFiles === "function" ? changedFiles : () => changedFiles
  const api = {
    scan: vi.fn().mockResolvedValue(repos),
    cachedScan: vi.fn().mockResolvedValue(null),
    // What the Host has configured: the archive reads the shipped strategy unless a test
    // asks for another one, its directory is empty unless a test sets one, and the agent
    // entries are offered unless a test hides them, which is what a case about the
    // standard flow does.
    preferences: vi.fn().mockResolvedValue({ defaultBranchPrefix: "task/", archiveDocumentsStrategy: archiveStrategy, archiveDocumentsDirectory: archiveDirectory, handoffEntry }),
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
    planTask: vi.fn().mockImplementation(async ({ task, project: layer, tasksRoot, targets }: { task: string; project: string; tasksRoot: string; targets?: Record<string, string> }) => {
      const repositories = ["kratos-vue-admin", "kratos-vue-admin-web"].map((name) => {
        const repoPath = tasksRoot + "\\" + layer + "\\" + task + "\\" + name
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
      const built = {
        task,
        project: layer,
        tasksRoot,
        path: tasksRoot + "\\" + layer + "\\" + task,
        mergeTarget: repositories[0].target,
        changedFiles: repositories.reduce((total, repository) => total + repository.changedFiles, 0),
        commits: repositories.reduce((total, repository) => total + repository.commits, 0),
        repositories,
        strays,
      }
      // A case that needs a plan the Host would not answer - two repositories on volumes
      // that share no directory, say - rewrites it here instead of the Host's own shape.
      return plan === undefined ? built : plan(built)
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
  // The surface the dialog was drawn in. Following a session has to leave that too, or
  // it stands in front of the conversation the click just asked to see.
  const onLeave = vi.fn()
  render(<WorktreesSettings api={api as any} workspaces={workspaces as any} uiWorkspace={uiWorkspace as any} sessions={sessions as any} onLeave={onLeave} />)
  return { api, workspaces, sessions, created, prompts, snapshots, sessionListeners, uiWorkspace, onLeave }
}

// An option's accessible name is its label followed by its hint, and one hint
// repeats another option's words, so anchor on the label.
const option = (label: string) => screen.getByRole("checkbox", { name: new RegExp(`^${label}`) })
const taskArticles = () => document.querySelectorAll(".dws-task")

// The reports a finish leaves behind outlive the dialog, so a case that made one has to
// clear it: otherwise the next case opens on the previous one's conflict.
afterEach(() => { cleanup(); clearFinishScenes() })

/** The first scan has answered and the page is still on the view it opened on. */
async function settled() {
  await waitFor(() => expect(screen.getByRole("button", { name: t("refresh") })).toHaveProperty("disabled", false))
}

/** The page opens on the Workspaces, and this file is about tasks: a case that wants
 *  them asks for them, which is one click on the view that holds them. */
async function ready() {
  await settled()
  fireEvent.click(screen.getByRole("button", { name: t("viewTasks") }))
}

describe("task view", () => {
  it("opens on the Workspaces, and the tasks view groups tasks this way no other view does", async () => {
    const user = userEvent.setup()
    setup()
    await settled()

    // A task space starts from a Workspace, so the page opens on the registered ones —
    // and this fixture registers none.
    expect(screen.getByText(t("workspaceEmpty"))).toBeTruthy()

    await user.click(screen.getByRole("button", { name: t("viewTasks") }))
    expect(screen.getByRole("heading", { name: "antest" })).toBeTruthy()
    // The panel shows every path with forward slashes, whichever separator the host reported.
    expect(screen.getByText(container.replace(/\\/g, "/"))).toBeTruthy()
    expect(screen.getByText(branch)).toBeTruthy()
    expect(screen.getByText("kratos-vue-admin")).toBeTruthy()
    expect(screen.getByText("kratos-vue-admin-web")).toBeTruthy()
    // The views read in the order they are offered: a Workspace a task starts from, a
    // repository one is opened across, and the task space itself last. The filters and
    // the fold button follow the switch in one run, the order the panel reads them in too.
    const viewSwitch = screen.getByRole("group", { name: t("viewSwitch") })
    expect([...viewSwitch.querySelectorAll("button")].map((button) => button.textContent)).toEqual([t("viewWorkspaces"), t("viewRepositories"), t("viewTasks")])
    const foldRun = screen.getByRole("group", { name: t("filters") })
    expect([...foldRun.querySelectorAll("button")].map((button) => button.textContent)).toEqual([t("filterAll"), t("filterAttention"), t("collapseAll")])
    // The hand-made `spike` worktree shares no container with a matching branch.
    expect(taskArticles()).toHaveLength(1)
    expect(document.querySelector(".dws-summary")?.textContent).toContain(t("taskCount"))

    // The repository view keeps showing it, unchanged.
    await user.click(screen.getByRole("button", { name: t("viewRepositories") }))
    expect(screen.getByRole("heading", { name: "kratos-vue-admin" })).toBeTruthy()
    expect(taskArticles()).toHaveLength(0)
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
    expect(next.api.doneTask).toHaveBeenCalledWith({ task: "antest", project, tasksRoot: root, merge: true, deleteBranch: true, force: false, cleanStray: true })
    await waitFor(() => expect(screen.getByText(t("finishDone"))).toBeTruthy())
    expect(screen.getAllByText(new RegExp(t("finishMerged").replace("{target}", "main")))).toHaveLength(2)
    expect(screen.getAllByText(new RegExp(t("finishRemoved"))).length).toBeGreaterThan(0)
    expect(screen.getByText(format(t("finishStrays"), { names: "notes.md" }))).toBeTruthy()
    expect(screen.getByText(format(t("finishContainerKept"), { path: container.replace(/\\/g, "/") }))).toBeTruthy()
    // The report replaces the options: nothing left to confirm twice.
    expect(screen.queryByRole("button", { name: t("finishConfirmAction") })).toBeNull()
    expect(next.api.doneTask).toHaveBeenCalledTimes(1)
  })

  it("hands a standing conflict to an agent when asked, and leaves the merging to the button", async () => {
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

    // Nothing here had to be committed first, so the merge is the finish's own first move
    // and the conflict it stops on is the answer. Reconciling one is not this side's to do,
    // so the finish stops and asks: no session exists until the user says so.
    await waitFor(() => expect(screen.getByText(t("finishHandoffTitle"))).toBeTruthy())
    expect(screen.getByText(t("finishHandoffExplain"))).toBeTruthy()
    expect(screen.getByText(t("finishHandoffHint"))).toBeTruthy()
    expect(next.sessions.create).not.toHaveBeenCalled()
    // The note about leaving the dialog belongs to the button that does it, so with no
    // session row there is no button and no note either.
    expect(document.querySelector(".dws-finish-handoff-note")).toBeNull()
    // Handing it over is that one button, and what it opens is the worktree the merge is
    // standing in - the repository that could not reconcile - with the conflicted files
    // named in the message and the one thing not to do.
    await user.click(screen.getByRole("button", { name: t("finishAuthorizeConflict") }))
    await waitFor(() => expect(next.sessions.create).toHaveBeenCalledWith({ cwd: site }))
    await waitFor(() => expect(next.created).toHaveLength(1))
    expect(next.prompts[0].text).toContain(site.replace(/\\/g, "/"))
    expect(next.prompts[0].text).toContain("src/a.ts")
    // Opened on the worktree itself, the session has everything resolving needs - the
    // conflicted files are under its working directory. Every placeholder is filled, and
    // the prompt no longer carries a boundary or a scope sentence at all.
    expect(next.prompts[0].text).not.toMatch(/\{[a-z]+\}/)
    expect(screen.getByText(format(t("finishHandoffAuthorized"), { count: "1", job: t("finishHandoffJobConflict") }))).toBeTruthy()

    // The dialog cannot do the agent's work, so it does the two things it can: report
    // what the session was opened for, and offer the way to the session itself. The job is
    // named once in that sentence, so the row under it is just the repository and its
    // worktree - naming the job on every row said the same thing once per repository.
    expect(document.querySelector(".dws-finish-handoff-sessions li")?.textContent).toBe(`kratos-vue-admin${site.replace(/\\/g, "/")}`)
    expect(screen.getByRole("button", { name: t("finishHandoffOpen") })).toBeTruthy()
    // That row's button is the way out of this dialog, so the note saying what leaving costs
    // stands under the row rather than down by the notice. It wears the same glyph as the
    // consequence by the options, in the grey this line is set in - not the notice's amber.
    const note = document.querySelector(".dws-finish-handoff-note")
    expect(note?.querySelector("svg")).toBeTruthy()
    expect(screen.getByRole("button", { name: t("finishHandoffOpen") }).compareDocumentPosition(note as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

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

    // The agent has stopped and said its part is done, and the finish is not carried on
    // from here: what comes next is a merge into the user's own checkout, so it waits for
    // the button rather than starting by itself.
    expect((screen.getByRole("button", { name: t("finishContinue") }) as HTMLButtonElement).disabled).toBe(false)
    expect(next.api.doneTask).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole("button", { name: t("finishContinue") }))
    await waitFor(() => expect(next.api.doneTask).toHaveBeenCalledTimes(2))
  })

  it("keeps the conflict on screen without the entries a Host does not offer", async () => {
    const user = userEvent.setup()
    const site = `${container}\\kratos-vue-admin`
    const next = setup({
      handoffEntry: "hide",
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

    // What the finish stopped on is still the panel's subject: why the conflict is there,
    // and the press that carries the finish on once it is committed by hand. The setting
    // governs the offer to put an agent on it, not the situation itself.
    await waitFor(() => expect(screen.getByText(t("finishHandoffTitle"))).toBeTruthy())
    expect(screen.getByText(t("finishHandoffExplain"))).toBeTruthy()
    expect(screen.getByText(t("finishHandoffHint"))).toBeTruthy()
    // Both entries are gone, and so is the notice that explains them - and nothing opened
    // a session on its own.
    await waitFor(() => expect(screen.queryByRole("button", { name: t("finishAuthorizeConflict") })).toBeNull())
    expect(screen.queryByRole("button", { name: t("finishAuthorizeCommit") })).toBeNull()
    expect(document.querySelector(".dws-beta-notice")).toBeNull()
    expect(next.sessions.create).not.toHaveBeenCalled()
  })

  it("says how to commit work nobody committed when the agent entry is hidden", async () => {
    const user = userEvent.setup()
    const next = setup({
      handoffEntry: "hide",
      changedFiles: 1,
      result: finishResult({
        failed: true,
        repositories: [
          { name: "kratos-vue-admin", path: `${container}\\kratos-vue-admin`, branch, target: "main", merged: false, removed: false, branchDeleted: false, error: "uncommitted changes" },
          { name: "kratos-vue-admin-web", path: `${container}\\kratos-vue-admin-web`, branch, target: "main", merged: false, removed: false, branchDeleted: false, error: "uncommitted changes" },
        ],
      }),
    })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))
    await waitFor(() => expect(screen.getByText(t("finishCommitTitle"))).toBeTruthy())

    // The finish stops on that work either way, so the line under the title says what is
    // left to do about it - the standard flow's own sentence rather than the escalation
    // an agent's commit needs - and confirming stays out of reach until it is done.
    expect(screen.getByText(t("finishCommitManual"))).toBeTruthy()
    expect(screen.queryByText(t("finishCommitEscalation"))).toBeNull()
    await waitFor(() => expect(screen.queryByRole("button", { name: t("finishAuthorizeCommit") })).toBeNull())
    expect((screen.getByRole("button", { name: t("finishConfirmAction") }) as HTMLButtonElement).disabled).toBe(true)
    expect(next.sessions.create).not.toHaveBeenCalled()
  })

  it("keeps a session it already opened on screen when the entries are hidden", async () => {
    // The setting governs the offer, not the work: a repository handed to an agent stays
    // that agent's until its merge is committed, so the way back to that conversation
    // cannot disappear because a profile changed its mind about the entries.
    const site = `${container}\\kratos-vue-admin`
    saveFinishScene(container, {
      result: finishResult({
        failed: true,
        repositories: [
          { name: "kratos-vue-admin", path: site, branch, target: "main", merged: false, removed: false, branchDeleted: false, conflict: true, mergeInProgress: true, mergeSite: site, conflictedFiles: ["src/a.ts"], error: "CONFLICT (content): merge conflict in src/a.ts" },
          { name: "kratos-vue-admin-web", path: `${container}\\kratos-vue-admin-web`, branch, target: "main", merged: true, removed: true, branchDeleted: true },
        ],
        strays: [],
        containerRemoved: false,
      }),
      handoff: [{ name: "kratos-vue-admin", site, boundary: site, wide: false, kind: "conflict", sessionId: "session-1" as FinishSceneSession["sessionId"] }],
    })
    setup({ handoffEntry: "hide" })
    // A task with a report left behind reopens its dialog with the page, so the panel is
    // what to wait for rather than the page's own controls: the report is on screen from
    // the start here.
    await waitFor(() => expect(screen.getByText(t("finishHandoffTitle"))).toBeTruthy())

    // The session that is already on the work stays reported, with the way back to it:
    // hiding the entries cannot strand a conversation the panel itself opened.
    expect(document.querySelector(".dws-finish-handoff-sessions li")?.textContent).toBe(`kratos-vue-admin${site.replace(/\\/g, "/")}`)
    expect(screen.getByRole("button", { name: t("finishHandoffOpen") })).toBeTruthy()
    expect(screen.getByText(format(t("finishHandoffAuthorized"), { count: "1", job: t("finishHandoffJobConflict") }))).toBeTruthy()
    // What the switch does govern is the notice that explains the entries, and the
    // entries themselves.
    await waitFor(() => expect(document.querySelector(".dws-beta-notice")).toBeNull())
    expect(screen.queryByRole("button", { name: t("finishAuthorizeConflict") })).toBeNull()
  })

  it("closes the dialog when the user follows the session the finish handed work to", async () => {
    const user = userEvent.setup()
    const site = `${container}\\kratos-vue-admin`
    const next = setup({
      result: finishResult({
        failed: true,
        repositories: [
          { name: "kratos-vue-admin", path: site, branch, target: "main", merged: false, removed: false, branchDeleted: false, conflict: true, mergeInProgress: true, mergeSite: site, conflictedFiles: ["src/a.ts"], error: "CONFLICT (content): merge conflict in src/a.ts" },
        ],
        strays: [],
        containerRemoved: false,
      }),
    })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))
    await waitFor(() => expect(screen.getByText(t("finishHandoffTitle"))).toBeTruthy())
    await user.click(screen.getByRole("button", { name: t("finishAuthorizeConflict") }))
    await waitFor(() => expect(next.created).toHaveLength(1))

    // Following the agent is one click rather than two: the session takes over the view
    // this dialog was drawn in, so the dialog leaves with it instead of covering it.
    expect(next.onLeave).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: t("finishHandoffOpen") }))
    expect(next.uiWorkspace.openSession).toHaveBeenCalledWith("session-1")
    // The surface the dialog was drawn in leaves as well: closing only the dialog would
    // have left the management page standing in front of the conversation just opened.
    expect(next.onLeave).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("dialog")).toBeNull()
    // What it left behind is the report, so the task is still finishable: opening the
    // dialog again puts the same panel back rather than starting the finish over.
    expect(readFinishScene(container)?.handoff).toHaveLength(1)
  })

  it("opens the handoff session wide enough to reach the repository a commit has to write", async () => {
    const user = userEvent.setup()
    // A task space beside its repositories, as the demo lays them out. A commit writes into
    // the repository's own git directory - a linked worktree only points at it - so the
    // session's working directory has to cover both, and the narrowest one that does is
    // their common ancestor. The conflicted files are inside the worktree, which is under
    // it, so the whole of the agent's job is still within the session's reach.
    const site = "E:\\wt-demo\\spaces\\demo\\alpha"
    const repo = "E:\\wt-demo\\repos\\alpha"
    const next = setup({
      result: finishResult({
        failed: true,
        repositories: [
          { name: "alpha", path: site, mainRepo: repo, branch: "task/demo", target: "main", merged: false, removed: false, branchDeleted: false, conflict: true, mergeInProgress: true, mergeSite: site, conflictedFiles: ["src/app.ts"], error: "CONFLICT (content): Merge conflict in src/app.ts" },
        ],
      }),
    })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))

    // The page scans the Workspaces for its own view; what must not happen is the dialog
    // scanning them again for an answer the finish's own report already carries.
    const scans = next.api.scan.mock.calls.length + next.api.cachedScan.mock.calls.length
    await waitFor(() => expect(screen.getByText(t("finishHandoffTitle"))).toBeTruthy())
    await user.click(screen.getByRole("button", { name: t("finishAuthorizeConflict") }))
    await waitFor(() => expect(next.sessions.create).toHaveBeenCalledWith({ cwd: "E:/wt-demo" }))
    expect(next.api.scan.mock.calls.length + next.api.cachedScan.mock.calls.length).toBe(scans)
    // The message names both directories: the worktree the conflict is standing in, and
    // the boundary the session is opened on, so the agent knows where to edit and where
    // its git commands are allowed to write.
    expect(next.prompts[0].text).toContain("E:/wt-demo/spaces/demo/alpha")
    expect(next.prompts[0].text).toContain("E:/wt-demo")
    expect(next.prompts[0].text).not.toMatch(/\{[a-z]+\}/)
  })

  it("hands every repository with uncommitted work to one session, opened on their common ancestor", async () => {
    const user = userEvent.setup()
    // Two repositories holding work nobody committed, under one task space: their common
    // ancestor reaches both worktrees and both main repositories, so a single conversation
    // can commit them both - one session, handed the whole list in one turn.
    const next = setup({
      changedFiles: 1,
      // The merge that follows is the plugin's own next step, and it still has work to do,
      // so the panel keeps reporting the sessions rather than being replaced by a report.
      result: finishResult({
        failed: true,
        repositories: [
          { name: "kratos-vue-admin", path: `${container}\\kratos-vue-admin`, branch, target: "main", merged: false, removed: false, branchDeleted: false, error: "uncommitted changes" },
          { name: "kratos-vue-admin-web", path: `${container}\\kratos-vue-admin-web`, branch, target: "main", merged: false, removed: false, branchDeleted: false, error: "uncommitted changes" },
        ],
      }),
    })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))
    await waitFor(() => expect(screen.getByText(t("finishCommitTitle"))).toBeTruthy())
    // Work nobody committed is not this side's to write, so confirming is out of reach
    // until the user hands it over - and handing it over is that one button.
    expect((screen.getByRole("button", { name: t("finishConfirmAction") }) as HTMLButtonElement).disabled).toBe(true)
    expect(next.sessions.create).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: t("finishAuthorizeCommit") }))

    await waitFor(() => expect(next.sessions.create).toHaveBeenCalledTimes(1))
    expect(next.created[0].cwd).toBe("E:/worktree-space/kratos-admin/antest")
    await waitFor(() => expect(next.prompts).toHaveLength(1))
    // One turn carries the whole batch, to that one session: the agent is handed the list of
    // repositories with their worktrees at once, rather than being queued a message per
    // repository - and the shared directory its git commands are allowed to write inside is
    // named in the same message.
    expect(next.prompts[0].sessionId).toBe("session-1")
    expect(next.prompts[0].text).toContain("E:/worktree-space/kratos-admin/antest/kratos-vue-admin")
    expect(next.prompts[0].text).toContain("E:/worktree-space/kratos-admin/antest/kratos-vue-admin-web")
    expect(next.prompts[0].text).toContain("E:/worktree-space/kratos-admin/antest")
    expect(next.prompts[0].text).not.toMatch(/\{[a-z]+\}/)
    // The panel counts sessions and names the repositories they cover: two rows, one
    // session - and the boundary reaches every git directory it needs, which the line
    // under the rows says in its own words.
    expect(screen.getByText(format(t("finishHandoffAuthorized"), { count: "1", job: t("finishHandoffJobCommit") }))).toBeTruthy()
    // One line for the session, not one per repository: opening it is the same trip either
    // way, and the boundary is the session's rather than a repository's.
    expect(screen.getAllByRole("button", { name: t("finishHandoffOpen") })).toHaveLength(1)
    // Its boundary is the shared one, which reaches both worktrees and both git directories.
    expect(screen.getAllByTitle(t("finishHandoffScopeWide"))).toHaveLength(1)
    // Authorizing by hand is said once, where the button was: the escalation a commit
    // may need is not one this dialog can give.
    expect(screen.getByText(t("finishCommitEscalation"))).toBeTruthy()
  })

  it("stops reporting the commits once the finish is on the conflict that came after them", async () => {
    const user = userEvent.setup()
    // The two jobs come one after the other: repositories handed over for the commits nobody
    // made, an agent that makes them, and then a merge that stops on a conflict. By the time
    // that question is asked the commits are behind the finish, so the rows reporting them
    // are not shown beside it - the session that made them still is, because the conflict
    // goes to that same conversation rather than to a new one.
    // The worktrees hold uncommitted files until the agent has made the commits, which is
    // what the second read of the plan - the one taken once its session stops - finds.
    let dirty = true
    const next = setup({
      changedFiles: () => (dirty ? 1 : 0),
      result: finishResult({
        failed: true,
        repositories: [
          { name: "kratos-vue-admin", path: `${container}\\kratos-vue-admin`, branch, target: "main", merged: false, removed: false, branchDeleted: false, error: "uncommitted changes" },
          { name: "kratos-vue-admin-web", path: `${container}\\kratos-vue-admin-web`, branch, target: "main", merged: false, removed: false, branchDeleted: false, error: "uncommitted changes" },
        ],
      }),
    })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))
    await waitFor(() => expect(screen.getByText(t("finishCommitTitle"))).toBeTruthy())
    await user.click(screen.getByRole("button", { name: t("finishAuthorizeCommit") }))
    await waitFor(() => expect(next.sessions.create).toHaveBeenCalledTimes(1))
    expect(screen.getByText(format(t("finishHandoffAuthorized"), { count: "1", job: t("finishHandoffJobCommit") }))).toBeTruthy()

    // The agent writes the commits and stops. Nothing starts by itself any more: the plan is
    // read again, the panel says the commits are in, and the step that conflicts is the user's
    // own press of the footer's button.
    dirty = false
    next.api.doneTask.mockResolvedValue(finishResult({
      failed: true,
      repositories: [
        { name: "kratos-vue-admin", path: `${container}\\kratos-vue-admin`, branch, target: "main", merged: false, removed: false, branchDeleted: false, conflict: true, mergeInProgress: true, mergeSite: `${container}\\kratos-vue-admin`, conflictedFiles: ["src/a.ts"], error: "CONFLICT (content): merge conflict in src/a.ts" },
        { name: "kratos-vue-admin-web", path: `${container}\\kratos-vue-admin-web`, branch, target: "main", merged: true, removed: true, branchDeleted: false },
      ],
    }))
    act(() => { next.snapshots["session-1"] = { running: true }; next.sessionListeners.forEach((listener) => listener()) })
    act(() => { next.snapshots["session-1"] = { running: false }; next.sessionListeners.forEach((listener) => listener()) })
    // The commits are in, so the panel waits on the user rather than stepping itself.
    await waitFor(() => expect(screen.getByText(t("finishCommitDone"))).toBeTruthy())
    // The merge that press starts leaves a conflict standing in the worktree, which is what
    // the plan read for that phase says: an uncommitted file.
    dirty = true
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))
    await waitFor(() => expect(screen.getByText(t("finishHandoffTitle"))).toBeTruthy())
    // What is on offer is the conflict, and nothing about the commits: no sentence about
    // them, no row naming them, and no way to open a session on work that is done.
    expect(screen.getByRole("button", { name: t("finishAuthorizeConflict") })).toBeTruthy()
    expect(screen.queryByText(format(t("finishHandoffAuthorized"), { count: "1", job: t("finishHandoffJobCommit") }))).toBeNull()
    expect(screen.queryByText(format(t("finishHandoffAuthorized"), { count: "2", job: t("finishHandoffJobCommit") }))).toBeNull()
    expect(screen.queryByRole("button", { name: t("finishHandoffOpen") })).toBeNull()

    // Handing the conflict over reuses that session - one was never opened for it - and the
    // panel now reports the one repository the conflict is in, under the job it is on.
    await user.click(screen.getByRole("button", { name: t("finishAuthorizeConflict") }))
    await waitFor(() => expect(next.prompts).toHaveLength(2))
    expect(next.sessions.create).toHaveBeenCalledTimes(1)
    expect(next.prompts[1].sessionId).toBe("session-1")
    expect(screen.getByText(format(t("finishHandoffAuthorized"), { count: "1", job: t("finishHandoffJobConflict") }))).toBeTruthy()
    expect([...document.querySelectorAll(".dws-finish-handoff-sessions li")].map((row) => row.querySelector("strong")?.textContent)).toEqual(["kratos-vue-admin"])

    // That session was handed the conflict while it stood idle, so the row reads as stopped
    // before the prompt has been picked up - and that first read still finds the conflict in
    // the worktree. Nothing is called resolved on the strength of it.
    await waitFor(() => expect(next.api.planTask).toHaveBeenCalledTimes(3))
    expect(screen.getByText(t("finishHandoffTitle"))).toBeTruthy()
    expect(screen.queryByText(t("finishConflictDone"))).toBeNull()

    // The agent resolves the conflict and commits it, then stops. That stop is a new one, so
    // the plan is read again, and this time it reports the worktree clean: the conflict is
    // done, under the same green light - and the press that carries on is still the user's.
    dirty = false
    act(() => { next.snapshots["session-1"] = { running: true }; next.sessionListeners.forEach((listener) => listener()) })
    expect(screen.queryByText(t("finishConflictDone"))).toBeNull()
    act(() => { next.snapshots["session-1"] = { running: false }; next.sessionListeners.forEach((listener) => listener()) })
    await waitFor(() => expect(next.api.planTask).toHaveBeenCalledTimes(4))
    await waitFor(() => expect(screen.getByText(t("finishConflictDone"))).toBeTruthy())
    expect(screen.queryByText(t("finishHandoffTitle"))).toBeNull()
    expect(document.querySelector(".dws-finish-handoff-title.is-done .dws-status-dot")).toBeTruthy()
    expect(next.api.doneTask).toHaveBeenCalledTimes(1)

    // The way on is the footer's own button, and pressing it is what reads the state again.
    await waitFor(() => expect((screen.getByRole("button", { name: t("finishContinue") }) as HTMLButtonElement).disabled).toBe(false))
    await user.click(screen.getByRole("button", { name: t("finishContinue") }))
    await waitFor(() => expect(next.api.doneTask).toHaveBeenCalledTimes(2))
  })

  it("says the commits are in and leaves the last press to the user", async () => {
    const user = userEvent.setup()
    // An agent that has made the commits and stopped is not the same thing as a user who has
    // decided to go on: the merge that comes next reaches their own checkout, and the options
    // beside it are still whatever they were left on. So the panel reads the plan again, says
    // the commits are done under the green light the page uses for a clean worktree, and waits.
    let dirty = true
    const next = setup({ changedFiles: () => (dirty ? 1 : 0) })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))
    await waitFor(() => expect(screen.getByText(t("finishCommitTitle"))).toBeTruthy())
    expect((screen.getByRole("button", { name: t("finishConfirmAction") }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole("button", { name: t("finishAuthorizeCommit") }))
    await waitFor(() => expect(next.prompts).toHaveLength(1))

    // The commit lands and the session stops. What the panel shows is the state, not a step it
    // took: nothing was archived, and the light is on the sentence itself.
    dirty = false
    act(() => { next.snapshots["session-1"] = { running: true }; next.sessionListeners.forEach((listener) => listener()) })
    act(() => { next.snapshots["session-1"] = { running: false }; next.sessionListeners.forEach((listener) => listener()) })
    await waitFor(() => expect(screen.getByText(t("finishCommitDone"))).toBeTruthy())
    expect(next.api.doneTask).not.toHaveBeenCalled()
    expect(screen.queryByText(t("finishCommitTitle"))).toBeNull()
    expect(document.querySelector(".dws-finish-handoff-title.is-done .dws-status-dot")).toBeTruthy()

    // And the press is the user's: the button that was out of reach while the work was
    // uncommitted is what carries the finish on now.
    await waitFor(() => expect((screen.getByRole("button", { name: t("finishConfirmAction") }) as HTMLButtonElement).disabled).toBe(false))
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))
    await waitFor(() => expect(next.api.doneTask).toHaveBeenCalledTimes(1))
  })

  it("opens one session on the task space when the repositories share nothing but a volume root", async () => {
    const user = userEvent.setup()
    // A repository on another volume shares no directory with its neighbour, so no directory
    // of theirs covers both, and the volume root is too wide to open a session on: the task
    // space stands in for it, and one conversation still does the whole job. What that
    // directory cannot do is reach the git metadata the commits write, which the panel says
    // out loud and the user approves in the session.
    const next = setup({
      changedFiles: 1,
      plan: (built) => ({
        ...built,
        repositories: built.repositories.map((entry: any, index: number) => ({
          ...entry,
          path: index === 0 ? `${container}\\kratos-vue-admin` : "D:\\elsewhere\\kratos-vue-admin-web",
        })),
      }),
      result: finishResult({
        failed: true,
        repositories: [
          { name: "kratos-vue-admin", path: `${container}\\kratos-vue-admin`, branch, target: "main", merged: false, removed: false, branchDeleted: false, error: "uncommitted changes" },
          { name: "kratos-vue-admin-web", path: `${container}\\kratos-vue-admin-web`, branch, target: "main", merged: false, removed: false, branchDeleted: false, error: "uncommitted changes" },
        ],
      }),
    })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))
    await waitFor(() => expect(screen.getByText(t("finishCommitTitle"))).toBeTruthy())
    await user.click(screen.getByRole("button", { name: t("finishAuthorizeCommit") }))

    // One session for both repositories, opened on the task space rather than on either
    // worktree: the batch is still one conversation, told about both in one turn.
    await waitFor(() => expect(next.sessions.create).toHaveBeenCalledTimes(1))
    expect(next.created[0].cwd?.replace(/\\/g, "/")).toBe("E:/worktree-space/kratos-admin/antest")
    await waitFor(() => expect(next.prompts).toHaveLength(1))
    expect(next.prompts[0].sessionId).toBe("session-1")
    expect(next.prompts[0].text).toContain("E:/worktree-space/kratos-admin/antest/kratos-vue-admin")
    expect(next.prompts[0].text).toContain("D:/elsewhere/kratos-vue-admin-web")
    // The directory it works in is named, and so is what that directory does not reach: the
    // message asks for the elevation rather than claiming the git commands will go through.
    expect(next.prompts[0].text).toContain(format(t("finishPromptScopeTight"), { boundary: "E:/worktree-space/kratos-admin/antest" }))
    expect(next.prompts[0].text).not.toMatch(/\{[a-z]+\}/)
    // The panel says the same thing in its own words: one line, one session, and the scope
    // it stops short of.
    expect(screen.getByText(format(t("finishHandoffBoundary"), { path: "E:/worktree-space/kratos-admin/antest" }))).toBeTruthy()
    expect(screen.getAllByTitle(t("finishHandoffScopeTight"))).toHaveLength(1)
    expect(screen.queryAllByTitle(t("finishHandoffScopeWide"))).toHaveLength(0)
  })

  it("opens the handoff session in the worktree when the Host named no repository", async () => {
    const user = userEvent.setup()
    // A Host that names no repository is no reason to walk every Workspace: the session's
    // working directory is the worktree either way, and the merge is the plugin's to
    // conclude. The fixture still holds the repository and its main worktree, so a scan
    // would find them - and must not be asked to.
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
    await user.click(screen.getByRole("button", { name: t("finishAuthorizeConflict") }))

    await waitFor(() => expect(next.sessions.create).toHaveBeenCalledWith({ cwd: site }))
    await waitFor(() => expect(next.created).toHaveLength(1))
    // The message names the worktree, which is both where the work is and where the
    // session is.
    expect(next.prompts[0].text).toContain(site.replace(/\\/g, "/"))
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
    await user.click(screen.getByRole("button", { name: t("finishAuthorizeConflict") }))
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
    expect(screen.getByText(format(t("finishHandoffAuthorized"), { count: "1", job: t("finishHandoffJobConflict") }))).toBeTruthy()
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
    // The folder is named after the project and the task with the moment: the exact
    // second is the dialog's, so it is matched by shape rather than recomputed here.
    expect(payload.documentsDirectory).toMatch(new RegExp(`^${root.replace(/\\/g, "\\\\")}\\\\archived-docs\\\\${project}\\\\antest-\\d{8}-\\d{6}$`))
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

  it("files into the directory the Host names under the custom strategy", async () => {
    const user = userEvent.setup()
    // The setting is read rather than assumed: this Host roots its archive at a directory
    // of its own, so that is the folder the dialog proposes and the one the call carries.
    const configured = "E:\\archived-docs"
    const next = setup({ strays: [{ name: "notes.md", directory: false, documents: 1, kind: "content" }], archiveStrategy: "custom", archiveDirectory: configured })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))

    const box = await waitFor(() => option(t("archiveDocuments")))
    // The row names the configured folder, not an anchor computed for this task.
    expect(box.closest(".dws-check-option")?.textContent).toContain(configured.replace(/\\/g, "/"))
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))

    await waitFor(() => expect(next.api.doneTask).toHaveBeenCalledTimes(1))
    const payload = next.api.doneTask.mock.calls[0]![0] as { documentsDirectory?: string }
    // Under the configured root, and still in a project and task folder of this task's
    // own: one root holds every archive, so those two names are what keep them apart.
    expect(payload.documentsDirectory).toMatch(new RegExp(`^${configured.replace(/\\/g, "\\\\")}\\\\${project}\\\\antest-\\d{8}-\\d{6}$`))
  })

  it("files under the container root when no directory is set", async () => {
    const user = userEvent.setup()
    // A Host nobody has configured answers with the shipped strategy and no directory at
    // all, which is what a Host that has never had either setting written answers with.
    const next = setup({ strays: [{ name: "notes.md", directory: false, documents: 1, kind: "content" }], archiveDirectory: "" })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))

    await waitFor(() => expect(option(t("archiveDocuments"))).toBeTruthy())
    await user.click(screen.getByRole("button", { name: t("finishConfirmAction") }))

    await waitFor(() => expect(next.api.doneTask).toHaveBeenCalledTimes(1))
    const payload = next.api.doneTask.mock.calls[0]![0] as { documentsDirectory?: string }
    // The container root's own archived-docs, which is the shipped default: nothing
    // outside `root` is written, whatever volume the container happened to be made on.
    // `documents.test.ts` is where the two roots are told apart.
    expect(payload.documentsDirectory).toMatch(new RegExp(`^${root.replace(/\\/g, "\\\\")}\\\\archived-docs\\\\${project}\\\\antest-\\d{8}-\\d{6}$`))
  })

  it("warns about uncommitted work and only forces discarding it deliberately", async () => {
    const user = userEvent.setup()
    const next = setup({ changedFiles: 2 })
    await ready()
    await user.click(screen.getByRole("button", { name: t("finishTask") }))

    expect(screen.getByText(format(t("finishDirtyNotice"), { count: "4" }))).toBeTruthy()
    // The finish cannot start on work nobody committed: the worktree would refuse to go,
    // and the commit is the agent's. Force is the other way past it, and it says so.
    expect((screen.getByRole("button", { name: t("finishConfirmAction") }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText(t("finishForceWarning"))).toBeNull()
    await user.click(option(t("finishForce")))
    expect(screen.getByText(t("finishForceWarning"))).toBeTruthy()
    expect((screen.getByRole("button", { name: t("finishConfirmAction") }) as HTMLButtonElement).disabled).toBe(false)
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
    expect(confirm().className).toContain("dws-button-warn-outline")
    // Force discards those two files, which is not reversible.
    await user.click(option(t("finishForce")))
    expect(confirm().className).toContain("dws-button-danger-outline")
    // Deleting a branch that was merged loses nothing, so with the files gone this
    // is a warning again.
    await user.click(option(t("finishForce")))
    await user.click(option(t("finishDeleteBranch")))
    expect(confirm().className).toContain("dws-button-warn-outline")
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
    expect(confirm().className).toContain("dws-button-warn-outline")
    // No merge, forced branch deletion, and three commits that live only there.
    await user.click(option(t("finishMerge")))
    await user.click(option(t("finishForce")))
    await user.click(option(t("finishDeleteBranch")))
    expect(confirm().className).toContain("dws-button-danger-outline")
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

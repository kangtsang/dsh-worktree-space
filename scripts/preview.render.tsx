/**
 * Renders the plugin's surfaces into standalone HTML, for looking at them in a browser
 * without the GUI.
 *
 * The GUI needs an authenticated server and a real Workspace list, which is not
 * something a stylesheet or a layout change can be checked against; this renders the
 * same components with the same stylesheet and stubs for the Host's answers instead.
 * It is a development tool and is not part of the published package: run it with
 * `node scripts/preview.mjs`, which points Vitest at `scripts/preview.render.tsx`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { CreateWorktreeDialog } from "../src/client/components/CreateWorktreeDialog"
import { PluginConfigCard } from "../src/client/components/PluginConfigCard"
import { WorktreeManagePanel } from "../src/client/components/WorktreeManagePanel"
import { WorktreePanelPage } from "../src/client/components/WorktreePanel"
import { NewSessionWorktreeButton } from "../src/client/components/NewSessionWorktreeButton"
import * as icons from "../src/client/components/icons"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = resolve(root, "_preview")

const suggestion = {
  sourceRoot: "/repo",
  suggested: "/tasks",
  explicit: false,
  branchPrefix: "task/",
  repositories: [
    { name: "kratos-vue-admin", path: "/repo/kratos-vue-admin", branch: "main" },
    { name: "kratos-vue-admin-web", path: "/repo/kratos-vue-admin-web", branch: "main" },
  ],
}

const repos = [
  {
    repoPath: "/repo/kratos-vue-admin",
    currentBranch: "main",
    worktrees: [
      { path: "/repo/kratos-vue-admin", branch: "main", isMain: true, locked: false, prunable: false },
      { path: "E:/worktree-space/hotfix/kratos-vue-admin", branch: "feat/hotfix", isMain: false, locked: false, prunable: false, commits: 2 },
      { path: "E:/worktree-space/test-c/kratos-vue-admin", branch: "feat/test-c", isMain: false, locked: false, prunable: false, changedFiles: 3 },
    ],
  },
  {
    repoPath: "/repo/kratos-vue-admin-web",
    currentBranch: "main",
    worktrees: [
      { path: "/repo/kratos-vue-admin-web", branch: "main", isMain: true, locked: false, prunable: false },
      { path: "E:/worktree-space/hotfix/kratos-vue-admin-web", branch: "feat/hotfix", isMain: false, locked: false, prunable: false, commits: 2 },
    ],
  },
]

/** The services both pages read, with the answers the previews need. */
function services(workspaces: Array<{ workspaceId: string; path: string; title: string }> = [], empty = false) {
  const api: any = {
    suggestRoot: vi.fn().mockResolvedValue(suggestion),
    createTask: vi.fn(),
    doneTask: vi.fn(),
    scan: vi.fn().mockResolvedValue(empty ? [] : repos),
    cachedScan: vi.fn().mockResolvedValue(null),
    status: vi.fn().mockResolvedValue({ changedFiles: 0, branchLine: "", output: "" }),
    classifyRoot: vi.fn().mockImplementation(async (path: string) => ({
      path,
      isRepository: path.includes("kratos"),
      isSourceRoot: path.includes("kratos"),
      repositoryCount: path.includes("kratos") ? 1 : 0,
      repositories: [],
    })),
  }
  const service: any = {
    list: { getSnapshot: () => ({ items: workspaces }), subscribe: () => () => {} },
    create: vi.fn(), rename: vi.fn(), delete: vi.fn(),
  }
  return { api, workspaces: service, uiWorkspace: { openWorkspace: vi.fn() } as any, sessions: { list: { getSnapshot: () => ({ byId: {} }) } } as any }
}

/** The configuration form the create dialog reads its default prefix from. */
function configForm(defaultBranchPrefix = "task/") {
  const value = { panelEntry: "show", sidebarEntry: "show", handoffEntry: "hide", scanDepth: 3, maxScanDirectories: 3000, defaultBranchPrefix }
  return { getSnapshot: () => ({ status: "ready", value }), subscribe: () => () => {}, set: vi.fn(async () => true) }
}

async function settle() {
  await waitFor(() => expect(document.body.textContent).not.toBe(""))
  // Two macrotasks: one for the mocked reads, one for the status pass they trigger.
  await new Promise((done) => setTimeout(done, 0))
  await new Promise((done) => setTimeout(done, 0))
}

function write(name: string, markup: string) {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(resolve(OUT, `${name}.html`), page(markup))
}

describe("preview build", () => {
  it("writes the create dialog", async () => {
    const next = services()
    render(<CreateWorktreeDialog target={{ path: "/repo", title: "kratos-vue-admin" }} api={next.api} workspaces={next.workspaces} uiWorkspace={next.uiWorkspace} config={configForm()} onCreated={vi.fn()} onClose={vi.fn()} />)
    await settle()
    fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "hotfix-placeorder" } })
    write("create", document.body.innerHTML)
    cleanup()
  })

  it("writes the plugin configuration card", () => {
    write("config", renderToStaticMarkup(<PluginConfigCard form={configForm() as any} />))
  })

  it("writes the management page as a panel and as a dialog", async () => {
    for (const [name, node] of [
      ["panel", <WorktreePanelPage {...services()} onCreate={vi.fn()} onBack={vi.fn()} />],
      ["manage", <WorktreeManagePanel {...services()} onCreate={vi.fn()} onClose={vi.fn()} />],
    ] as const) {
      render(node)
      await settle()
      write(name, document.body.innerHTML)
      cleanup()
    }
  })

  it("writes the repository view", async () => {
    render(<WorktreePanelPage {...services()} onCreate={vi.fn()} onBack={vi.fn()} />)
    await settle()
    fireEvent.click(screen.getByRole("button", { name: "Git 仓库视图" }))
    await new Promise((done) => setTimeout(done, 0))
    write("repos", document.body.innerHTML)
    cleanup()
  })

  it("writes the workspace view", async () => {
    const items = [
      { workspaceId: "a", path: "/repo/kratos-vue-admin", title: "kratos-vue-admin" },
      { workspaceId: "b", path: "/repo/kratos-vue-admin-web", title: "kratos-vue-admin-web" },
      { workspaceId: "c", path: "/notes", title: "notes" },
    ]
    render(<WorktreePanelPage {...services(items)} onCreate={vi.fn()} onBack={vi.fn()} />)
    await settle()
    fireEvent.click(screen.getByRole("button", { name: "工作区视图" }))
    await new Promise((done) => setTimeout(done, 0))
    write("spaces", document.body.innerHTML)
    cleanup()
  })

  it("writes the icon sheet", () => {
    write("icons", renderToStaticMarkup(<IconSheet />))
  })

  it("writes the composer entry's hover hint", async () => {
    // The composer is the shell's, so the preview draws the entry on a bare stage: what
    // is being looked at is the bubble, which is portalled to the body of the page.
    const useWorkspaces = ((selector: (state: { items: Array<Record<string, unknown>> }) => unknown) =>
      selector({ items: [{ workspaceId: "a", path: "/repo/kratos-vue-admin", title: "kratos-vue-admin", sessionIds: ["session-new"] }] })) as any
    render(<NewSessionWorktreeButton session={{ sessionId: "session-new" as any, blank: true }} useWorkspaces={useWorkspaces} onOpen={vi.fn()} />)

    fireEvent.mouseOver(screen.getByRole("button", { name: "新建 Worktree Space" }))
    await new Promise((done) => setTimeout(done, 200))
    // jsdom lays nothing out, so the fixed coordinates the hint reads from its anchor are
    // all zero here — which also makes it pick the below-fallback. The page is given the
    // place a browser puts it, centred just above the entry, because the picture is of the
    // bubble and not of jsdom's empty geometry.
    const hint = screen.getByRole("tooltip")
    hint.className = "dws-hint"
    hint.setAttribute("style", "left: 50%; top: 202px")
    write("hint", `<div class="dws-hint-stage">${document.body.innerHTML}</div>`)
    cleanup()
  })

  it("writes the empty task and repository lists", async () => {
    for (const [name, label] of [["empty-tasks", "任务空间视图"], ["empty-repos", "Git 仓库视图"]] as const) {
      render(<WorktreePanelPage {...services([], true)} onCreate={vi.fn()} onBack={vi.fn()} />)
      await settle()
      fireEvent.click(screen.getByRole("button", { name: label }))
      await new Promise((done) => setTimeout(done, 0))
      write(name, document.body.innerHTML)
      cleanup()
    }
  })
})

/**
 * Every glyph the plugin draws, at every size a call site asks for, on one page.
 *
 * The row labels are the hugeicons names, which is how a change is ordered ("use
 * FolderRootIcon there"); the sheet is what says whether the drawing at 16 or 18 pixels
 * still reads as that glyph.
 */
function IconSheet() {
  const sizes = [12, 14, 15, 16, 18, 26]
  return <div className="dws-icon-sheet">
    {Object.entries(icons).map(([name, Icon]) => <div className="dws-icon-row" key={name}>
      <code>{name}</code>
      <div className="dws-icon-sizes">{sizes.map(size => <span key={size}><Icon size={size} /><em>{size}</em></span>)}</div>
    </div>)}
  </div>
}

/**
 * One document around the plugin's own markup.
 *
 * Only the shell's design tokens are supplied here: the aliases DSH defines at runtime
 * are not on disk, so the values below are the shell's own boot fallbacks. Everything
 * else — every rule the plugin applies — is the stylesheet the bundle ships, copied in
 * as it is.
 */
function page(markup: string) {
  const tokens = `
    --dsw-alias-label-primary: #0f1115;
    --dsw-alias-label-secondary: #61666b;
    --dsw-alias-label-tertiary: #81858c;
    --dsw-alias-label-primary-foreground: #ffffff;
    --dsw-alias-border-l2: rgb(0 0 0 / 10%);
    --dsw-alias-bg-base: #f7f8fa;
    --dsw-alias-bg-layer-1: #ffffff;
    --dsw-alias-bg-module-platform: #f2f3f5;
    --dsw-alias-interactive-bg-hover: rgb(0 0 0 / 5%);
    --dsw-alias-interactive-bg-hover-danger: rgb(220 38 38 / 8%);
    --dsw-alias-brand-primary: #0f1115;
    --dsw-alias-button-primary-fill: #0f1115;
    --dsw-alias-button-primary-hover: #2a2d33;
    --dsw-alias-state-success-primary: #16a34a;
    --dsw-alias-state-error-primary: #dc2626;
    --dsw-static-amber-600: #d97706;
    --dsw-static-neutral-00: #ffffff;
    --dsw-radius-md: 12px;
    --dsw-focus-ring-width: 2px;
    --dsw-focus-ring-color: #0f1115;
    --dsw-alias-bg-mask-1: rgb(0 0 0 / 32%);
    --dsw-mask-blur: blur(2px);
    --dsw-alias-tooltip-bg: #2c2c2e;
    --dsw-static-neutral-bluish-00: #ffffff;
    --dsw-shadow-lv3: 0 12px 32px rgb(0 0 0 / 18%);`
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>preview</title>
<style>
  :root {${tokens}
  }
  html, body { margin: 0; height: 100%; background: #e9eaee; }
  body { font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
  /* The GUI's document belongs to the shell: the overlay and the dialog are fixed to
     it and the panel is a column of it, so the preview gives them the same box. */
  .dws-dialog-overlay { position: fixed; }
  .dws-panel { height: 100%; }
  /* The icon sheet is a development-only page: it borrows nothing from the plugin and is
     never shipped, so its rules live here rather than in the plugin's stylesheet. */
  .dws-icon-sheet { padding: 24px; display: grid; gap: 6px; background: #ffffff; }
  /* The hint page stands the composer entry in the open, at the height where the shell
     puts it, so the bubble above it is visible in a screenshot. */
  .dws-hint-stage { display: flex; justify-content: center; align-items: center; min-height: 420px; background: #ffffff; }
  .dws-icon-row { display: grid; grid-template-columns: 150px 1fr; align-items: center; gap: 16px; padding: 6px 0; border-bottom: 1px solid rgb(0 0 0 / 8%); }
  .dws-icon-row code { font-size: 13px; color: #0f1115; }
  .dws-icon-sizes { display: flex; align-items: flex-end; gap: 22px; color: #0f1115; }
  .dws-icon-sizes span { display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .dws-icon-sizes em { font-size: 10px; font-style: normal; color: #81858c; }
</style>
<style>${readFileSync(resolve(root, "src/client/styles.css"), "utf8")}</style>
</head><body>${markup}</body></html>
`
}

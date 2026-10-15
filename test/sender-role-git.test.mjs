/**
 * The sender role against real git, not a hand-built `.git`.
 *
 * Two things a fixture cannot produce are worth guarding here. `git worktree add` writes a
 * `gitdir` file *inside* the main repository's own `.git/worktrees/`, so a rule that read
 * the repository's children without first asking whether the directory is itself a
 * repository would call every checkout on the machine a member. And the worktree it creates
 * is the shape this plugin's own layout uses, so the member answer has to be read off one
 * real `git worktree add` makes. Only real git puts either on disk, so this runs it — in
 * the `git` layer, beside the other tests that need a process.
 */
import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerSessionTools } from "../src/host/session-tools.js"

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

/**
 * A task space on disk: the record is what makes a directory one, and the role test reads
 * it before it reads any `.git`.
 */
async function taskSpaceAt(dir) {
  await mkdir(join(dir, ".worktree-space"), { recursive: true })
  await writeFile(join(dir, ".worktree-space", "worktree-space.json"), JSON.stringify({
    version: 1, task: "login", project: "kratos-admin", branch: "task/login",
    sourceRoot: "/src/kratos-admin", repositories: [], createdAt: "2026-01-01T00:00:00.000Z",
  }), "utf8")
  return dir
}

/**
 * The role one sender's working directory answers with, through the real send path.
 *
 * The header is the only honest reading of `senderRole`: it is built by the tool, from the
 * caller's own directory as the host recorded it, and nothing else on the way is consulted.
 */
async function roleFor(cwd, targetCwd) {
  const calls = []
  const target = {
    id: "s-target",
    status: "idle",
    session: { header: { id: "s-target", cwd: targetCwd, createdAt: 1 }, snapshotEvents: () => [] },
    inbox: {},
    followup: (message) => calls.push(message),
    steer: (message) => calls.push(message),
    cancel: () => {},
  }
  const agents = { "s-target": target }
  const services = {
    agents: { get: (id) => agents[id], list: () => Object.values(agents) },
    sessionPersistence: { list: async () => [], inspect: async () => { throw new Error("none") } },
    workspaceRegistry: { list: () => [] },
  }
  const captured = []
  const ctx = { get: (name) => (name === "tools" ? { register: (d) => captured.push(d) } : services[name]) }
  registerSessionTools(ctx)
  const send = captured.find((tool) => tool.name === "wts_session_tool_send")
  const sender = {
    id: "s-sender",
    status: "idle",
    session: { header: { id: "s-sender", cwd, createdAt: 1 }, snapshotEvents: () => [] },
    inbox: {},
    followup: () => {},
    steer: () => {},
    cancel: () => {},
  }
  await send.execute({ sessionId: "s-target", message: "hello" }, { agent: sender })
  const text = calls[0]?.content?.[0]?.text ?? ""
  return { text, role: /^Role: (\S+)$/m.exec(text)?.[1] }
}

describe("the sender role against real git", () => {
  it("reads a real worktree as a member, and the repository holding it as neither end", async () => {
    // The case the guard exists for: a real `git worktree add` leaves a `gitdir` file under
    // the main repository's `.git/worktrees/`, and a repository that read its own children
    // without first asking what it is would answer `member` from that file - calling the
    // dispatcher's own checkout a member of every task it dispatches.
    if (!gitAvailable) return
    const root = await mkdtemp(join(tmpdir(), "wts-role-git-"))
    try {
      const repo = join(root, "repo")
      await mkdir(repo, { recursive: true })
      const git = (args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" })
      git(["init", "-b", "main", "."])
      git(["config", "user.email", "test@example.invalid"])
      git(["config", "user.name", "Test"])
      await writeFile(join(repo, "a.txt"), "one\n", "utf8")
      git(["add", "a.txt"])
      git(["commit", "-m", "one"])
      // The worktree lives OUTSIDE the repository, which is also this plugin's own rule about
      // a container root: nothing it makes sits inside a checkout.
      const linked = join(root, "linked-wt")
      git(["worktree", "add", "-b", "wt", linked])
      // The guard's own precondition: git really wrote the marker inside the repository.
      expect(existsSync(join(repo, ".git", "worktrees"))).toBe(true)

      // A second worktree nested one level BELOW the repository. This is the shape the rule
      // exists for: the repository's own children include a worktree, so a rule that asked
      // about the children without first asking whether the directory is itself a repository
      // would answer `member` here. Without this, the test passes for the wrong reason - the
      // worktree above sits outside the repository, where no child check would ever see it.
      const nested = join(repo, "nested-wt")
      git(["worktree", "add", "-b", "wt-nested", nested])

      const target = await taskSpaceAt(join(root, "space"))

      // The repository is a repository: not a member, and it does not claim leadership
      // either - that is a fact about the conversation, not about the path. Asserted with a
      // worktree of its own sitting directly inside it, which is what makes the assertion
      // mean something.
      expect((await roleFor(repo, target)).role).toBe("unknown")
      // The worktree git made is the member shape, read off a real one.
      expect((await roleFor(linked, target)).role).toBe("member")
      expect((await roleFor(nested, target)).role).toBe("member")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

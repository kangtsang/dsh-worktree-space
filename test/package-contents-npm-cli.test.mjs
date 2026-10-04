import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/**
 * The package-contents check must not guess an npm it cannot run.
 *
 * It runs npm by executing npm's own `npm-cli.js` with the current Node, because
 * the obvious alternative - the `npm` on PATH - is a `.cmd` shim on Windows and
 * Node has refused to start a batch file without a shell since the
 * CVE-2024-27980 fix (EINVAL), while routing arguments through a shell is itself
 * deprecated. The comment above the code said all of that and then fell back to
 * the forbidden spawn anyway, so the one branch that could not work was the only
 * one that was automatic.
 *
 * Measured on this machine, Node 24: the bare name resolves to nothing (ENOENT)
 * and naming the shim is rejected outright (EINVAL). The fallback was not a
 * slower answer, it was no answer.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const SCRIPT = pathToFileURL(join(ROOT, "scripts", "check-package-contents.mjs")).href

/** Run a snippet of ESM in its own node, and collect what it said. */
function runModule(source, cwd) {
  return new Promise((settle) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("close", (code) => settle({ code, stdout, stderr }))
  })
}

describe("scripts/check-package-contents.mjs", () => {
  it("reports a Node layout without npm's CLI instead of trying to run a batch shim", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "dsh-npm-cli-"))
    try {
      // An empty directory standing in for a Node installation. This is what a
      // relocated, stripped or bundled Node looks like to the script, and it is
      // the only situation the fallback branch was ever reached from.
      const nodeDir = join(workdir, "node")
      await mkdir(nodeDir, { recursive: true })

      // `process.execPath` is the one thing the script reads to locate npm, so
      // pointing it at that installation is enough to take the branch - no copy
      // of the repository and no modified file needed.
      const source = [
        `process.execPath = ${JSON.stringify(join(nodeDir, "node.exe"))}`,
        `await import(${JSON.stringify(SCRIPT)})`,
      ].join("\n")

      const { code, stderr } = await runModule(source, workdir)

      expect(code).not.toBe(0)
      expect(stderr).toContain("npm-cli.js")
      // It has to say why, or the next person meets this as "the check broke".
      expect(stderr).toContain("CVE-2024-27980")
      // The line that matters: no attempt to start a command that cannot start.
      expect(stderr).not.toMatch(/spawn npm\b/i)
      // And it stops before doing anything, rather than leaving a cache
      // directory behind on the way to failing.
      expect(existsSync(join(workdir, ".npm-cache"))).toBe(false)
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  }, 20_000)
})

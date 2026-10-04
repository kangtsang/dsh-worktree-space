import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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

  it("finds npm under lib/, which is where the Linux and macOS archives install it", async () => {
    // The check above is satisfied by a machine shaped like Windows, where npm sits
    // beside the node executable. Nothing here said what happens on the other layout,
    // so the path was assumed rather than looked for, and the assumption held until
    // the first run on a Linux runner - where the whole gate refused to open on a
    // path that does not exist, and printed "install a Node that ships npm" about a
    // Node that shipped npm one directory over.
    //
    // A Node installation does not agree with itself about where npm lives: the
    // Windows installer puts it at <prefix>/node_modules/npm, and the official Linux
    // and macOS archives put it at <prefix>/lib/node_modules/npm. The candidate list
    // is what covers both, so this builds the second shape and asks for the same
    // answer the Windows-shaped test above already gets.
    const workdir = await mkdtemp(join(tmpdir(), "dsh-npm-cli-posix-"))
    try {
      const binDir = join(workdir, "node", "22.23.3", "x64", "bin")
      const libDir = join(workdir, "node", "22.23.3", "x64", "lib")
      await mkdir(binDir, { recursive: true })
      // Only one thing is installed here, and it is npm, in the POSIX spot. The
      // Windows spot is deliberately left empty so this cannot pass by accident on
      // the candidate that Windows already covers.
      const npmCli = join(libDir, "node_modules", "npm", "bin", "npm-cli.js")
      await mkdir(dirname(npmCli), { recursive: true })
      await writeFile(join(binDir, "node"), "")
      await writeFile(npmCli, "console.log('pretend npm')\n")

      const { code, stderr } = await runModule(
        [
          `process.execPath = ${JSON.stringify(join(binDir, "node"))}`,
          `await import(${JSON.stringify(SCRIPT)})`,
        ].join("\n"),
        workdir,
      )

      // It got past locating npm - so it did not print the "not where a Node
      // installation puts it" report. It fails later, on the dry-run pack of a
      // directory that is not a package, and that is the point: the gate opened.
      expect(stderr).not.toContain("CVE-2024-27980")
      expect(stderr).not.toContain("is not where this Node installation puts it")
      expect(existsSync(join(workdir, ".npm-cache"))).toBe(true)
      expect(code).not.toBe(0)
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  }, 20_000)
})

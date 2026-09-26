import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
// Windows resolves the npm CLI to a .cmd shim. Naming it explicitly is not
// enough: since the CVE-2024-27980 fix Node refuses to spawn a batch file
// without a shell (EINVAL), and passing arguments through a shell is
// deprecated (DEP0190). Running npm's own JS entry point with the current Node
// executable avoids both, and behaves the same on every platform.
const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
const [npmCommand, npmArgs] = existsSync(npmCli) ? [process.execPath, [npmCli]] : ["npm", []]
const npmCache = join(process.cwd(), ".npm-cache")
await mkdir(npmCache, { recursive: true })
const { stdout } = await execFileAsync(npmCommand, [...npmArgs, "pack", "--dry-run", "--json"], {
  encoding: "utf8",
  env: { ...process.env, npm_config_cache: npmCache },
})
const result = JSON.parse(stdout)
assert.equal(result.length, 1, "npm pack must produce one package manifest")

const files = result[0].files.map(({ path }) => path).sort()
const expected = [
  "LICENSE",
  "README.md",
  "README.zh.md",
  "assets/skill/task-worktree-space/SKILL.md",
  "client/client.js",
  "cordis.patch.yml",
  "docs/finish-task.png",
  "docs/manage-worktree-space.png",
  "docs/new-session.png",
  "docs/new-worktree-space.png",
  "icon.svg",
  "lib/index.js",
  "locale/en.json",
  "locale/zh.json",
  "package.json",
].sort()
assert.deepEqual(files, expected, "npm package contents changed; update the allowlist deliberately")
assert.equal(result[0].entryCount, expected.length, "npm package entry count must match the allowlist")
assert.ok(result[0].size > 0, "npm package must contain bytes")

console.log(`npm package contents are valid (${files.length} files, ${result[0].size} bytes)`)

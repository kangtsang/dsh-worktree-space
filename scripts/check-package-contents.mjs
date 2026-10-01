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
  "CHANGELOG.en.md",
  "CHANGELOG.md",
  "LICENSE",
  "PERMISSIONS.en.md",
  "PERMISSIONS.md",
  "README.en.md",
  "README.md",
  "assets/skill/task-worktree-space/SKILL.md",
  "client/client.js",
  "cordis.patch.yml",
  "docs/img/finish-task.png",
  "docs/img/manage-worktree-space.png",
  "docs/img/user-story-flow.png",
  "docs/img/new-worktree-space.png",
  "docs/store-evidence.md",
  "docs/store-evidence.json",
  "icon.svg",
  "lib/index.js",
  "locale/en.json",
  "locale/zh.json",
  "package.json",
].sort()

// A bare assert.deepEqual over 21 paths prints a wall of quoted strings and says
// nothing about why any of them matter. Name each file that moved and say what it
// is, so the fix is obvious without opening package.json.
function describe(path) {
  if (path.startsWith("docs/img/")) {
    return "a README illustration. It ships so the store page and docs render; keep the file name and path stable or the links that point at it break. Note that gzip barely shrinks PNG, so each of these costs close to its raw size."
  }
  if (path.startsWith("docs/")) return "the evidence document. It ships because the store contract asks for it to be readable from the package."
  if (path.startsWith("scripts/") || path.startsWith("test/") || path.startsWith("src/")) {
    return "development-only. It never runs on a user's machine and should not be here."
  }
  if (path.startsWith("client/") || path.startsWith("lib/")) return "a runtime artifact. If its name changed, the build or the manifest probably has to change with it."
  return "check whether this belongs in the package at all"
}

const unexpected = files.filter((path) => !expected.includes(path))
const vanished = expected.filter((path) => !files.includes(path))

if (unexpected.length > 0 || vanished.length > 0) {
  console.error("npm package contents changed. Update the allowlist above AND the files field in package.json together, then confirm the change was intended.\n")
  for (const path of unexpected) console.error(`  in the package but not in the allowlist: ${path}\n      -> ${describe(path)}`)
  for (const path of vanished) console.error(`  in the allowlist but not in the package: ${path}\n      -> it stopped being packaged. Was it removed, renamed, or did a files pattern stop matching it?`)
  console.error("")
  process.exit(1)
}

assert.equal(result[0].entryCount, expected.length, "npm package entry count must match the allowlist")
assert.ok(result[0].size > 0, "npm package must contain bytes")

console.log(`npm package contents are valid (${files.length} files, ${result[0].size} bytes packed, ${result[0].unpackedSize} bytes unpacked)`)
import { execFileSync } from "node:child_process"

try {
  execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" })
} catch {
  console.warn("tracked bundle check skipped outside a Git worktree")
  process.exit(0)
}

try {
  execFileSync("git", ["diff", "--exit-code", "--", "client/client.js", "lib/index.js"], { stdio: "inherit" })
  console.log("tracked client and host bundles match the latest build")
} catch {
  console.error("generated bundles are stale; run pnpm build and commit client/client.js plus lib/index.js")
  process.exit(1)
}

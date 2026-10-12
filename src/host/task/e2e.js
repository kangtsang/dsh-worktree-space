/**
 * The acceptance stack a repository's own end-to-end configuration points at.
 *
 * A repository that ships an e2e suite usually ships the address that suite runs
 * against, and that address is written for whoever develops the repository - it
 * names the stack already running on their machine, or it tells the runner to
 * reuse whatever it finds. Neither is wrong in the repository. Both are wrong
 * inside a task space, where the whole point is that the work is verified against
 * an instance of this task's own: a suite pointed at the host's stack reports
 * green for code the task never built, and the report is indistinguishable from a
 * real one.
 *
 * Nothing here runs a test or refuses a request. It reads the configuration a
 * repository already carries and says what it found, because the finding is a
 * hazard the reader has to weigh - a suite may be pointed at a fixed port quite
 * deliberately, and a create is not the place to overrule that. What it must not
 * be is invisible until someone trusts a green run that meant nothing.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

/**
 * The configuration file names an end-to-end suite is started from.
 * Matched by stem so every extension a runner accepts is covered without listing
 * them: `playwright.config.ts` and `playwright.config.mjs` are the same file to
 * the runner and to this probe.
 */
const E2E_CONFIG_STEMS = ['playwright.config', 'cypress.config']

/**
 * Directories never descended into: dependency trees and build output hold
 * copies of other people's configuration, and none of it runs this repository's
 * suite.
 */
const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  'target', 'vendor', '__pycache__', '.venv', 'venv',
])

/** How many levels below a worktree to look for a suite's configuration. */
const E2E_CONFIG_DEPTH = 2

/** How many configs a report names before it says how many more there are. */
export const E2E_NAMES_SHOWN = 3

/**
 * Whether a file name is one of the runners' configuration files.
 * @param name - the file name.
 * @returns whether it is a config this probe reads.
 */
function isE2eConfig(name) {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return E2E_CONFIG_STEMS.includes(name.slice(0, dot))
}

/**
 * Every e2e configuration below a worktree, as paths relative to it.
 *
 * Bounded in both directions - depth and the directories skipped - because this
 * runs while a person waits on a create, and a suite's configuration lives at a
 * repository's root or one level in. A file that cannot be read is skipped rather
 * than raised over: the caller is asking what it can see, and a config it cannot
 * open is not one it can judge.
 * @param worktreePath - the repository's checkout.
 * @returns the relative paths, in the order they were found.
 */
export async function findE2eConfigs(worktreePath) {
  const found = []
  const queue = [{ path: worktreePath, depth: 0 }]
  while (queue.length > 0) {
    const { path, depth } = queue.shift()
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isFile() && isE2eConfig(entry.name)) found.push(relative(worktreePath, join(path, entry.name)))
      else if (entry.isDirectory() && depth < E2E_CONFIG_DEPTH && !SKIP_DIRECTORIES.has(entry.name)) {
        queue.push({ path: join(path, entry.name), depth: depth + 1 })
      }
    }
  }
  return found
}

/**
 * What a configuration says about the stack it runs against.
 *
 * Two findings, and they are separate because they fail differently. A reused
 * server means the suite never starts anything: it exercises whatever is already
 * listening, which in a task space is the host's stack rather than this task's. A
 * fixed local address means the suite does start something, but reports against
 * the address written in the file - right only if this task happened to deploy
 * there, and silent when it did not.
 *
 * An address built from an environment variable is not a finding: that is a suite
 * written to be pointed somewhere, which is exactly what a task space needs.
 * @param text - the configuration's own text.
 * @returns the findings: whether a server is reused, and the fixed local addresses named.
 */
export async function inspectE2eConfigs(worktreePath) {
  const findings = []
  for (const rel of await findE2eConfigs(worktreePath)) {
    let text
    try {
      text = await readFile(join(worktreePath, rel), 'utf8')
    } catch {
      continue
    }
    const { reusesExistingServer, fixedUrls } = inspectE2eConfig(text)
    if (!reusesExistingServer && fixedUrls.length === 0) continue
    findings.push({ path: rel, reusesExistingServer, fixedUrls })
  }
  return findings
}

/**
 * What a configuration says about the stack it runs against.
 *
 * Two findings, and they are separate because they fail differently. A reused
 * server means the suite never starts anything: it exercises whatever is already
 * listening, which in a task space is the host's stack rather than this task's. A
 * fixed local address means the suite does start something, but reports against
 * the address written in the file - right only if this task happened to deploy
 * there, and silent when it did not.
 *
 * An address built from an environment variable is not a finding: that is a suite
 * written to be pointed somewhere, which is exactly what a task space needs.
 * @param text - the configuration's own text.
 * @returns the findings: whether a server is reused, and the fixed local addresses named.
 */
export function inspectE2eConfig(text) {
  const source = String(text ?? '')
  // `reuseExistingServer` is a boolean in the runners that have it; only the true
  // form is a finding, and whitespace and a trailing comment may sit between.
  const reuses = /reuseExistingServer\s*:\s*true\b/.test(source)
  const urls = new Set()
  for (const match of source.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?/g)) {
    urls.add(match[0])
  }
  return { reusesExistingServer: reuses, fixedUrls: [...urls] }
}

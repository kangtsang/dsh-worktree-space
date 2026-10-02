/**
 * The bundled skill.
 *
 * The workflow guidance ships inside this package so it stays in step with the
 * operations it describes. The body is guidance only — the work itself happens
 * through the `task_worktree_space` tool — so the skill directory carries no scripts,
 * which also keeps it usable on a platform where the plugin's shell seam is not.
 */
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coded } from './codes.js'

/** Provider name in the `ctx.skills` registry. */
export const PROVIDER_NAME = 'dsh-worktree-space'

/** Kebab-case skill name; the asset directory carries the same name. */
export const SKILL_NAME = 'task-worktree-space'

/** Package this module belongs to, used to locate its own assets. */
const PACKAGE_NAME = 'dsh-worktree-space'

/**
 * Rank of a skill that ships inside a package. Spelled out rather than imported
 * from `@deepseek-ai/dsh-skill` so the plugin carries no dependency for one
 * number; that package defines the same value as `BUNDLED_SKILL_RANK`.
 */
const BUNDLED_SKILL_RANK = 600

/** Instruction file inside the skill directory. */
const SKILL_FILE = 'SKILL.md'

/**
 * Resolve this package's root by walking up to the manifest that names it.
 *
 * A relative hop cannot do this job: this module sits at `src/host/task/` in the
 * source tree, is inlined into the entry at `src/host/` or `lib/` when bundled,
 * and lives inside its own directory once installed. All three are inside the
 * package, so walking up to the manifest answers for every layout.
 * @returns the package directory.
 * @throws Error when no manifest above this module names the package.
 */
function packageRoot() {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).name === PACKAGE_NAME) return directory
      } catch {
        // A manifest that cannot be read is not this package's; keep walking.
      }
    }
    const parent = dirname(directory)
    if (parent === directory) {
      throw coded('E7001', `${PACKAGE_NAME}: cannot locate the package root for the bundled skill`)
    }
    directory = parent
  }
}

/**
 * Split a skill file into its declared description and its body.
 *
 * The frontmatter is read with two line-anchored patterns rather than a YAML
 * parser: this package needs one `name` and one single-line `description`, and a
 * dependency for that would be the only reason to carry one.
 * @param raw - the file contents.
 * @param path - the file path, for diagnostics.
 * @returns the declared description and the body without frontmatter.
 * @throws Error when frontmatter, a description, or a matching name is missing.
 */
export function parseSkillFile(raw, path) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw coded('E7002', `${PACKAGE_NAME}: ${path} has no YAML frontmatter`)
  const description = /^description:[ \t]*(.+?)[ \t]*$/mu.exec(frontmatter[1])?.[1]
  const declared = /^name:[ \t]*(.+?)[ \t]*$/mu.exec(frontmatter[1])?.[1]
  if (description === undefined || description === '') throw coded('E7003', `${PACKAGE_NAME}: ${path} has no description`)
  if (declared !== SKILL_NAME) {
    throw coded('E7004', `${PACKAGE_NAME}: ${path} declares name '${declared}' where '${SKILL_NAME}' is served`)
  }
  return { description, content: raw.slice(frontmatter[0].length).trim() }
}

/**
 * Register the bundled skill when the deployment serves a skill registry.
 *
 * Both guards matter, as for the tool: a deployment without a skill registry
 * keeps its endpoints, and a bare context double has no service lookup at all.
 * A missing or malformed asset throws here rather than degrading into a skill
 * that silently never appears.
 * @param ctx - the host plugin context.
 * @returns the registration disposer, or undefined when skills are unavailable.
 * @throws Error when the bundled instruction file is missing or malformed.
 */
export function registerTaskSkill(ctx) {
  if (typeof ctx.get !== 'function') return undefined
  const skills = ctx.get('skills')
  if (skills === undefined || skills === null || typeof skills.registerProvider !== 'function') return undefined

  const directory = join(packageRoot(), 'assets', 'skill', SKILL_NAME)
  const skillPath = join(directory, SKILL_FILE)
  const { description } = parseSkillFile(readFileSync(skillPath, 'utf8'), skillPath)

  const candidate = {
    name: SKILL_NAME,
    description,
    path: skillPath,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER_NAME,
    source: 'bundled',
    rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: directory },
    locator: skillPath,
  }

  const provider = {
    name: PROVIDER_NAME,
    list: () => Promise.resolve([candidate]),
    async get(requested, options) {
      const path = typeof requested?.locator === 'string' ? requested.locator : skillPath
      const raw = await readFile(path, { encoding: 'utf8', signal: options?.signal })
      const loaded = parseSkillFile(raw, path)
      const { rank: _rank, locator: _locator, ...summary } = candidate
      return { ...summary, description: loaded.description, content: loaded.content }
    },
  }

  return skills.registerProvider(() => provider)
}

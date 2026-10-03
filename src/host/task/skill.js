/**
 * The bundled skill.
 *
 * The workflow guidance ships inside this package so it stays in step with the
 * operations it describes. The body is guidance only — the work itself happens
 * through the `task_worktree_space` tool — so the skill directory carries no scripts,
 * which also keeps it usable on a platform where the plugin's shell seam is not.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
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
 * How many bytes of instruction file are read.
 *
 * A skill is prose, not a payload: the bundled one is a few kilobytes, and a
 * file past this is not one whatever it opens with. The cap is on the read
 * rather than on the parse, because the read is the part that can be asked for
 * an arbitrary file and the part that answers in memory.
 */
const SKILL_MAX_BYTES = 256 * 1024

/**
 * Read an instruction file, refusing to read more than it should ever hold.
 *
 * `readFile` sizes the buffer from the file and there is no way to bound it, so
 * the read is opened and asked for a fixed window instead; a file that would
 * fill it is refused rather than truncated, because a half-read skill is
 * neither a skill nor an error the caller can act on.
 * @param path - the file to read.
 * @param signal - an abort signal, when the caller has one.
 * @returns the file's contents.
 * @throws Error carrying E7005 when the file is larger than {@link SKILL_MAX_BYTES}.
 */
async function readBounded(path, signal) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(SKILL_MAX_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > SKILL_MAX_BYTES) {
      throw coded('E7005', `${PACKAGE_NAME}: ${basename(path)} is larger than the ${SKILL_MAX_BYTES} bytes a skill may hold`)
    }
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * {@link readBounded}, for the one read that has to have happened by the time
 * registration returns.
 *
 * Registration is synchronous - the caller installs the provider with whatever
 * it gets back - so the description cannot be awaited into existence. The bound
 * is the same one, for the same reason.
 * @param path - the file to read.
 * @returns the file's contents.
 * @throws Error carrying E7005 when the file is larger than {@link SKILL_MAX_BYTES}.
 */
function readBoundedSync(path) {
  const handle = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(SKILL_MAX_BYTES + 1)
    const bytesRead = readSync(handle, buffer, 0, buffer.length, 0)
    if (bytesRead > SKILL_MAX_BYTES) {
      throw coded('E7005', `${PACKAGE_NAME}: ${basename(path)} is larger than the ${SKILL_MAX_BYTES} bytes a skill may hold`)
    }
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    closeSync(handle)
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
  const { description } = parseSkillFile(readBoundedSync(skillPath), skillPath)

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
      // A locator arriving in the request is a name to check, not a path to
      // follow. This provider serves exactly one file, and it publishes that
      // file's own locator - so a request naming anything else is asking this
      // plugin to open a file it never offered, on the say-so of whoever made
      // the request. The refusal names the basename rather than the path it
      // was handed, so answering it does not report back what was probed.
      const asked = typeof requested?.locator === 'string' ? requested.locator : ''
      if (asked !== '' && resolve(asked) !== resolve(skillPath)) {
        throw coded('E7005', `${PACKAGE_NAME}: not a skill this provider serves: ${basename(asked)}`)
      }
      const raw = await readBounded(skillPath, options?.signal)
      const loaded = parseSkillFile(raw, skillPath)
      const { rank: _rank, locator: _locator, ...summary } = candidate
      return { ...summary, description: loaded.description, content: loaded.content }
    },
  }

  return skills.registerProvider(() => provider)
}

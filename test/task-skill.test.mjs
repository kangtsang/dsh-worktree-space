import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseSkillFile, PROVIDER_NAME, registerTaskSkill, SKILL_NAME } from "../src/host/task/skill.js"

/**
 * A context whose skill registry captures the provider the plugin registers.
 * @returns the context and the registered providers.
 */
function skillContext() {
  const providers = []
  const ctx = {
    get: (name) => (name === "skills"
      ? {
        registerProvider: (create) => {
          providers.push(create({ signal: new AbortController().signal, invalidate: () => {} }))
          return () => {}
        },
      }
      : undefined),
  }
  return { ctx, providers }
}

/** The bundled instruction file, as it is authored. */
const skillFile = join(process.cwd(), "assets", "skill", SKILL_NAME, "SKILL.md")

describe("registerTaskSkill", () => {
  it("registers one bundled provider and returns its disposer", () => {
    const { ctx, providers } = skillContext()
    const dispose = registerTaskSkill(ctx)
    expect(providers).toHaveLength(1)
    expect(providers[0].name).toBe(PROVIDER_NAME)
    expect(typeof dispose).toBe("function")
  })

  it("offers the skill to both the model and the user", async () => {
    const { ctx, providers } = skillContext()
    registerTaskSkill(ctx)
    const candidates = await providers[0].list({})
    expect(candidates).toHaveLength(1)
    const [candidate] = candidates
    expect(candidate.name).toBe(SKILL_NAME)
    expect(candidate.source).toBe("bundled")
    expect(candidate.provider).toBe(PROVIDER_NAME)
    // 600 is dsh-skill's BUNDLED_SKILL_RANK; a package-shipped skill outranks a
    // user directory, which is what a bundled body must do.
    expect(candidate.rank).toBe(600)
    expect(candidate.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    // The catalog description is capped at 500 characters by the skill tool.
    expect(candidate.description.length).toBeGreaterThan(20)
    expect(candidate.description.length).toBeLessThan(500)
    expect(existsSync(candidate.resourceBase.path)).toBe(true)
  })

  it("loads the body without frontmatter and points at the tool", async () => {
    const { ctx, providers } = skillContext()
    registerTaskSkill(ctx)
    const [candidate] = await providers[0].list({})
    const loaded = await providers[0].get(candidate, {})
    expect(loaded.name).toBe(SKILL_NAME)
    expect(loaded.content.startsWith("---")).toBe(false)
    expect(loaded.content).toContain("# Task Worktree Space")
    expect(loaded.content).toContain("task_worktree_space")
    // The workflow rules the model must apply live in the body.
    expect(loaded.content).toContain("Never create a workspace with a guessed location")
    expect(loaded.content).toContain("Never merge into main or master")
  })

  it("reads the file on every load, so an edited asset is served", async () => {
    const { ctx, providers } = skillContext()
    registerTaskSkill(ctx)
    const [candidate] = await providers[0].list({})
    const first = await providers[0].get(candidate, {})
    const second = await providers[0].get(candidate, {})
    expect(second.content).toBe(first.content)
    expect(second.content).toBe(parseSkillFile(readFileSync(skillFile, "utf8"), skillFile).content)
  })

  it("stays out of the way when the deployment serves no skill registry", () => {
    expect(registerTaskSkill({ get: () => undefined })).toBeUndefined()
  })

  it("survives a bare context double with no service lookup", () => {
    expect(() => registerTaskSkill({})).not.toThrow()
    expect(registerTaskSkill({})).toBeUndefined()
  })
})

describe("parseSkillFile", () => {
  it("accepts the bundled file", () => {
    const parsed = parseSkillFile(readFileSync(skillFile, "utf8"), skillFile)
    expect(parsed.description.length).toBeGreaterThan(20)
    expect(parsed.content.startsWith("# Task Worktree Space")).toBe(true)
  })

  it("refuses a file without frontmatter", () => {
    expect(() => parseSkillFile("# Task Worktree Space\n", "x.md")).toThrow(/no YAML frontmatter/)
  })

  it("refuses a file without a description", () => {
    expect(() => parseSkillFile(`---\nname: ${SKILL_NAME}\n---\nbody\n`, "x.md")).toThrow(/no description/)
  })

  it("refuses a file that declares another skill name", () => {
    expect(() => parseSkillFile("---\nname: other-skill\ndescription: x\n---\nbody\n", "x.md"))
      .toThrow(/declares name 'other-skill'/)
  })
})

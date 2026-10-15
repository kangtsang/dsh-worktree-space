import { describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
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
    expect(loaded.content).toContain("wts_worktree_space")
    // The workflow rules the model must apply live in the body.
    expect(loaded.content).toContain("Never create a workspace with a guessed location")
    // Hand-merging in a source checkout stays forbidden; finishing through `done` is the
    // user's decision between two supported flows, and the body has to say both.
    expect(loaded.content).toContain("never hand-merge there")
    expect(loaded.content).toContain("Who finishes is the user's decision")
    expect(loaded.content).toContain("both flows are supported")
    expect(loaded.content).toContain("DEPLOY_ENV_ID")
    // The acceptance fence is the one delivery decision a create makes, and it cannot be
    // added afterwards - so the body has to make asking for it a step of its own rather
    // than something to do when the user happens to volunteer the answer, and it has to
    // say what a deploying task's finish line is.
    expect(loaded.content).toContain("Ask about the acceptance fence")
    expect(loaded.content).toContain("Do not answer it for the user")
    expect(loaded.content).toContain("not finished until its fence has passed")
    // The two roles the body is written in. It addresses its reader as the leader, and
    // names the session it dispatches the member; the member session and the task
    // session are one session under two names, chosen by context. Dropping either
    // definition would leave the body describing a flow it never introduces, so both
    // are pinned here.
    expect(loaded.content).toContain("You are the leader agent")
    expect(loaded.content).toContain("the member agent")
    expect(loaded.content).toContain("member session")
    expect(loaded.content).toContain("task session")
    // The superseded wording is gone: one name per idea, so a reader does not have to
    // work out that the dispatcher and the leader are the same party. Each of these
    // fails against the version before the rename, which is what makes it a guard
    // rather than a restatement of the current text.
    expect(loaded.content).not.toContain("dispatching agent")
    expect(loaded.content).not.toContain("dispatched session")
    expect(loaded.content).not.toContain("dispatcher")
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

  it("serves only the file it registered, and does not report what was probed", async () => {
    const { ctx, providers } = skillContext()
    registerTaskSkill(ctx)
    const [candidate] = await providers[0].list({})

    // A locator arriving in the request is a name to check, not a path to follow.
    // This provider serves exactly one file and publishes its own locator, so
    // anything else is a request to open a file it never offered.
    const elsewhere = mkdtempSync(join(tmpdir(), "dsh-skill-probe-"))
    const decoy = join(elsewhere, "SKILL.md")
    writeFileSync(decoy, "---\nname: worktree-space\ndescription: secret\n---\nleaked\n")
    try {
      await expect(providers[0].get({ locator: decoy }, {})).rejects.toMatchObject({ code: "E7005" })
      // The refusal names the basename only: answering with the path it was
      // handed would report back what was probed, which is the half of the
      // oracle that matters.
      const refusal = await providers[0].get({ locator: decoy }, {}).catch((error) => error)
      expect(refusal.message).toContain("SKILL.md")
      expect(refusal.message).not.toContain(elsewhere)
      // The one locator that is genuinely this provider's still resolves.
      const served = await providers[0].get({ locator: candidate.locator }, {})
      expect(served.content).toContain("# Task Worktree Space")
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
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

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
    // Asking the user before anything is made is a creating-stage rule now, so it is
    // pinned in `creating.md` rather than here - see the reference block below.
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
    // What the body delegates, and the rule each file has to keep. The body is only the
    // map now: a stage's rules live in the file for that stage, read when the stage is
    // reached rather than on every start - and a section that moved is still a rule this
    // skill owes, which is why each is pinned in the file that carries it now.
    const reference = (name) => readFileSync(join(candidate.resourceBase.path, "references", name), "utf8")
    const creating = reference("creating.md")
    const working = reference("working.md")
    const finishing = reference("finishing.md")
    const conflicts = reference("conflicts.md")
    const deploying = reference("deploying.md")
    // Creating is where the user is asked before anything is made: no guessed location,
    // and the acceptance fence as a question put to them rather than answered for them.
    expect(creating).toContain("Never create a workspace with a guessed location")
    expect(creating).toContain("Ask about the acceptance fence")
    expect(creating).toContain("Do not answer it for the user")
    // Hand-merging in a source checkout stays forbidden, and finishing through `done`
    // is the user's decision between two flows.
    expect(working).toContain("never hand-merge there")
    expect(working).toContain("Who finishes is the user's decision")
    expect(finishing).toContain("both flows are supported")
    // A deploying task's finish line is its own smoke, not the fact that the code is
    // written, and it is the fence the body sends the reader here for.
    expect(finishing).toContain("not finished until its fence has passed")
    expect(deploying).toContain("DEPLOY_ENV_ID")
    // The conflict layer is the one branch of a finish that is not routine, so it sits
    // one level below `finishing.md` rather than in it.
    expect(conflicts).toContain("mergeInProgress")
    expect(conflicts).toContain("dirtyCheckout")
    // The body has to point at every file it hands the reader over to: an index that
    // leaves one out would strand the rule it carries.
    for (const name of ["creating.md", "working.md", "finishing.md", "conflicts.md", "deploying.md", "failures.md"]) {
      expect(loaded.content, name).toContain(`references/${name}`)
      expect(existsSync(join(candidate.resourceBase.path, "references", name)), name).toBe(true)
    }
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

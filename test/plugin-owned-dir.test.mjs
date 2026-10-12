/**
 * The plugin's own files live in one directory, and nothing is read from where they used
 * to live.
 *
 * Every version before this one wrote the record, the note rendered from it and the
 * deploy root at the task space's TOP LEVEL, beside the worktrees; this one writes them
 * inside `.worktree-space/`. The maintainer chose a clean switch rather than a fallback,
 * so the old locations are not searched at all - and that is a decision worth a test,
 * because the failure it prevents is silent: a half-migrated space would keep working
 * while its deploy scripts went on writing a state file this plugin never reads, and the
 * finish gate would answer "no passing smoke" about a smoke that had passed.
 *
 * Each negative below sits beside the positive that proves the check can succeed, so a
 * test that passes because nothing was written at all cannot hide here.
 */
import { describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertDeliveryGate,
  deployEnvironment,
  deliveryGatePreview,
  deliveryStateSummary,
  deploymentStatus,
} from "../src/host/task/deploy.js"
import { finishTask } from "../src/host/task/operations.js"
import { PLUGIN_ROOT, readTaskMetadata } from "../src/host/task/shared.js"

/** A deploy state that passes the finish gate, for the fixtures that need one. */
const STATE = { url: "http://localhost:51666", lastSmoke: { result: "pass", at: "2026-01-01T00:00:00Z" } }

/** The record a create leaves, as this version writes it. */
const RECORD = {
  version: 1,
  task: "login",
  project: "kratos-admin",
  branch: "task/login",
  sourceRoot: "/source",
  deploymentEnvId: "dsh-kratos-admin-login",
  delivery: { version: 1, deploy: { target: "docker" } },
  repositories: [{ name: "alpha", sourcePath: "/source/alpha", branch: "task/login" }],
}

/**
 * Where a task space's own files go.
 * @param taskPath - the task space directory.
 * @param layout - `"plugin"` for the directory this version writes, `"top"` for the top
 *   level every version before it wrote.
 * @returns the directory that layout puts the files in.
 */
function home(taskPath, layout) {
  return layout === "top" ? taskPath : join(taskPath, PLUGIN_ROOT)
}

/**
 * A task space with its record - and optionally its deploy root - where a test says.
 * @param options - `record`, `state` and `entry` each name a layout (`"plugin"` or
 *   `"top"`), or are absent to write nothing.
 * @returns the container root, the task space, and a cleanup.
 */
async function taskSpace({ record = "plugin", state, entry } = {}) {
  const root = await mkdtemp(join(tmpdir(), "dsh-plugin-dir-"))
  const taskPath = join(root, "kratos-admin", "login")
  await mkdir(home(taskPath, record), { recursive: true })
  await writeFile(join(home(taskPath, record), "worktree-space.json"), `${JSON.stringify(RECORD, null, 2)}\n`, "utf8")
  if (state !== undefined) {
    await mkdir(join(home(taskPath, state), "deploy"), { recursive: true })
    await writeFile(join(home(taskPath, state), "deploy", ".state.json"), `${JSON.stringify(STATE, null, 2)}\n`, "utf8")
  }
  if (entry !== undefined) {
    await mkdir(join(home(taskPath, entry), "deploy"), { recursive: true })
    await writeFile(join(home(taskPath, entry), "deploy", "deploy.sh"), "#!/bin/sh\necho up\n", "utf8")
  }
  return { root, taskPath, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/**
 * A subprocess double that answers nothing: docker is absent, which every reader here
 * answers as "no containers" rather than as a failure.
 */
const noDocker = {
  spawn: () => ({
    done: Promise.resolve({ exitCode: 1, signal: null }),
    collected: {
      stdout: { readFrom: () => ({ text: "" }) },
      stderr: { readFrom: () => ({ text: "" }) },
    },
  }),
}

/** A subprocess double that records the argv and env it was handed and succeeds. */
function spawnRecorder() {
  const envs = []
  return {
    envs,
    subprocess: {
      spawn({ argv, env }) {
        envs.push({ argv, env })
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: { stdout: { readFrom: () => ({ text: "" }) }, stderr: { readFrom: () => ({ text: "" }) } },
        }
      },
    },
  }
}

describe("the record is read from the plugin's own directory, and nowhere else", () => {
  it("reads it where this version writes it", async () => {
    const space = await taskSpace()
    try {
      expect(existsSync(join(space.taskPath, PLUGIN_ROOT, "worktree-space.json"))).toBe(true)
      expect((await readTaskMetadata(space.taskPath))?.task).toBe("login")
    } finally {
      await space.cleanup()
    }
  })

  it("does not read a record left at the task space's top level", async () => {
    const space = await taskSpace({ record: "top" })
    try {
      // It is there, and it is not read: the answer is "no record", not a record read
      // from the old place.
      expect(existsSync(join(space.taskPath, "worktree-space.json"))).toBe(true)
      expect(await readTaskMetadata(space.taskPath)).toBeUndefined()
    } finally {
      await space.cleanup()
    }
  })

  it("falls through an old top-level record to the legacy note beside it", async () => {
    // The sharpest form of the same question: with both files in the old place, the
    // answer must come from the note alone. A reply naming the note's task rather than
    // the record's is what proves the JSON at the top level was never opened.
    const space = await taskSpace({ record: "top" })
    try {
      await writeFile(join(space.taskPath, "README.en.md"), "# Task: from-note\n- Branch: `task/from-note`\n", "utf8")
      expect(await readTaskMetadata(space.taskPath)).toEqual({ version: 0, task: "from-note", branch: "task/from-note" })
    } finally {
      await space.cleanup()
    }
  })

  it("refuses to finish a space whose only record is the old one", async () => {
    // The consequence, at the entry point that matters: `done` claims the directory has
    // no record of this plugin's making, so nothing in it is deleted.
    const space = await taskSpace({ record: "top" })
    try {
      await expect(finishTask(noDocker, { task: "login", project: "kratos-admin", tasksRoot: space.root, merge: false }))
        .rejects.toMatchObject({ code: "E2005" })
      // Refused, and nothing was touched on the way there.
      expect(existsSync(join(space.taskPath, "worktree-space.json"))).toBe(true)
    } finally {
      await space.cleanup()
    }
  })
})

describe("the delivery state is read from the plugin's own deploy root, and nowhere else", () => {
  it("reads it where the plugin hands the path to the script", async () => {
    const space = await taskSpace({ state: "plugin" })
    try {
      const summary = await deliveryStateSummary(space.taskPath)
      expect(summary.url).toBe(STATE.url)
      expect(summary.lastSmoke).toEqual({ result: "pass", at: STATE.lastSmoke.at })
      const status = await deploymentStatus(noDocker, space.taskPath)
      expect(status.stateFound).toBe(true)
      expect(status.statePath).toBe(join(space.taskPath, PLUGIN_ROOT, "deploy", ".state.json"))
      // And the gate a merge meets is open, which is the fact all of this is for.
      await expect(assertDeliveryGate(RECORD, space.taskPath, { merge: true })).resolves.toBeUndefined()
    } finally {
      await space.cleanup()
    }
  })

  it("reports no state at all when the only state file is in a top-level deploy/", async () => {
    const space = await taskSpace({ state: "top" })
    try {
      // The file exists where every earlier version put it, and reads as absent.
      expect(existsSync(join(space.taskPath, "deploy", ".state.json"))).toBe(true)
      const summary = await deliveryStateSummary(space.taskPath)
      expect(summary).toEqual({ url: null, lastSmoke: null, statePath: null })

      const status = await deploymentStatus(noDocker, space.taskPath)
      expect(status.stateFound).toBe(false)
      expect(status.statePath).toBe(null)
      expect(status.url).toBe(null)

      // A passing smoke that this plugin cannot see is a passing smoke it will not
      // accept, which is the whole reason the old location is not read.
      await expect(assertDeliveryGate(RECORD, space.taskPath, { merge: true })).rejects.toMatchObject({ code: "E5006" })
      expect(await deliveryGatePreview(RECORD, space.taskPath)).toMatchObject({ applies: true, missing: ["deployment", "smoke"] })
    } finally {
      await space.cleanup()
    }
  })

  it("finds an entry in the plugin's own deploy root, and not one in a top-level deploy/", async () => {
    const moved = await taskSpace({ entry: "plugin" })
    const left = await taskSpace({ entry: "top" })
    try {
      const { subprocess, envs } = spawnRecorder()
      await deployEnvironment(subprocess, moved.taskPath)
      expect(envs[0].argv[1]).toBe(join(moved.taskPath, PLUGIN_ROOT, "deploy", "deploy.sh"))

      // A root-level `deploy/` is not a repository and not the plugin's directory, so
      // the space it sits in deploys nothing rather than running a stale script.
      await expect(deployEnvironment(noDocker, left.taskPath)).rejects.toMatchObject({ code: 'E5008' })
    } finally {
      await moved.cleanup()
      await left.cleanup()
    }
  })
})

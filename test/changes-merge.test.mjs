/**
 * The changes list's two answers, merged.
 *
 * `--name-status` and `--numstat` are asked as two commands, and `--ignore-cr-at-eol`
 * does not move them together on every git: one can still carry a file whose only
 * difference is a carriage return while the other reports no lines for it. Which of
 * the two answers arrives that way is git's business; what the list draws is this
 * plugin's, so the merge is pinned here against both answers instead of against a
 * version's behaviour.
 */
import { describe, expect, it } from "vitest"
import { parseGitArgv } from "../src/host/index.js"
import { carriesLines, changesList } from "../src/host/task/changes.js"

const MERGE_BASE = "a".repeat(40)

/** A subprocess that answers by the git command line, the way the seam is asked. */
function fakeGit(outputs) {
  const asked = []
  return {
    asked,
    subprocess: {
      spawn({ argv }) {
        const key = parseGitArgv(argv).args.join(" ")
        asked.push(key)
        const answer = outputs[key] ?? ""
        const stdout = typeof answer === "string" ? answer : answer.stdout ?? ""
        const exitCode = typeof answer === "string" ? 0 : answer.exitCode ?? 0
        return {
          done: Promise.resolve({ exitCode, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: stdout }) },
            stderr: { readFrom: () => ({ text: "" }) },
          },
        }
      },
    },
  }
}

/** Everything `changesList` asks before the two listings, answered the same way each time. */
function baseAnswers({ statuses, numbered }) {
  return {
    "rev-parse --abbrev-ref HEAD": "main",
    "rev-parse --short HEAD": "abc1234",
    // One call resolves the base: `merge-base` alone both proves the ref resolves and
    // answers the commit the comparison starts at.
    [`merge-base origin/main HEAD`]: MERGE_BASE,
    [`diff --ignore-cr-at-eol --name-status -z ${MERGE_BASE}`]: statuses,
    [`diff --ignore-cr-at-eol --numstat -z ${MERGE_BASE}`]: numbered,
    "ls-files --others --exclude-standard -z": "",
  }
}

describe("the changes list", () => {
  it("draws no row for a file the counts call unchanged", async () => {
    // Git 2.56 with the flag: neither listing names the file.
    const { subprocess } = fakeGit(baseAnswers({
      statuses: "M\0service/a.go\0M\0service/b.go\0",
      numbered: "",
    }))
    const answer = await changesList(subprocess, "/repo", "origin/main")
    expect(answer.files).toEqual([])
    expect(answer.totals).toEqual({ files: 0, insertions: 0, deletions: 0 })
  })

  it("draws no row for a file the counts report as zero lines", async () => {
    // Git 2.28 with the same flag: `--name-status` still carries the file (the flag is a
    // patch option there) and `--numstat` reports `0 0`, so both lists name it and the row
    // read "modified +0 −0" over an empty diff. This is the shape the sidebar showed on a
    // checkout whose only difference was the carriage return.
    const { subprocess } = fakeGit(baseAnswers({
      statuses: "M\0service/a.go\0M\0service/b.go\0",
      numbered: "0\t0\tservice/a.go\0" + "0\t0\tservice/b.go\0",
    }))
    const answer = await changesList(subprocess, "/repo", "origin/main")
    expect(answer.files).toEqual([])
    expect(answer.totals).toEqual({ files: 0, insertions: 0, deletions: 0 })
  })

  it("keeps a binary change, which has a difference and no lines", async () => {
    const { subprocess } = fakeGit(baseAnswers({
      statuses: "M\0assets/logo.png\0",
      numbered: "-\t-\tassets/logo.png\0",
    }))
    const answer = await changesList(subprocess, "/repo", "origin/main")
    expect(answer.files).toHaveLength(1)
    expect(answer.files[0]).toMatchObject({ path: "assets/logo.png", binary: true, insertions: 0, deletions: 0 })
  })

  it("keeps a row for an answer that is not a modification", async () => {
    // A rename is not a line change either, and dropping it would hide the one thing the
    // row says: the file moved. Only `modified` means "git could not show what differs".
    const { subprocess } = fakeGit(baseAnswers({
      statuses: "R100\0old/name.go\0new/name.go\0",
      numbered: "",
    }))
    const answer = await changesList(subprocess, "/repo", "origin/main")
    expect(answer.files).toHaveLength(1)
    expect(answer.files[0]).toMatchObject({ path: "new/name.go", oldPath: "old/name.go", status: "renamed" })
  })

  it("keeps the counts when both commands answered, and the status from the name list", async () => {
    // The ordinary case, asserted so the filter above cannot be widened into "a file the
    // counts did not mention" without this failing: here the counts did mention it.
    const { subprocess } = fakeGit(baseAnswers({
      statuses: "M\0a.go\0A\0b.go\0",
      numbered: "3\t1\ta.go\0" + "5\t0\tb.go\0",
    }))
    const answer = await changesList(subprocess, "/repo", "origin/main")
    expect(answer.files).toHaveLength(2)
    expect(answer.files.find((file) => file.path === "a.go")).toMatchObject({ status: "modified", insertions: 3, deletions: 1 })
    expect(answer.files.find((file) => file.path === "b.go")).toMatchObject({ status: "added", insertions: 5, deletions: 0 })
    expect(answer.totals).toEqual({ files: 2, insertions: 8, deletions: 1 })
  })
})

describe("what counts as a change", () => {
  it("is every entry but a text difference with no lines in it", () => {
    expect(carriesLines({ insertions: 0, deletions: 0 })).toBe(false)
    // One direction is still a change: a deletion has no insertions and is not nothing.
    expect(carriesLines({ insertions: 0, deletions: 2 })).toBe(true)
    expect(carriesLines({ insertions: 3, deletions: 0 })).toBe(true)
    // A binary change reports no counts either, and is a difference all the same.
    expect(carriesLines({ insertions: 0, deletions: 0, binary: true })).toBe(true)
  })
})

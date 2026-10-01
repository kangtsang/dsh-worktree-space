import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"

/**
 * Every tracked text file has to be valid UTF-8.
 *
 * This is not hypothetical: a file rewritten through a shell round-trip lost its em
 * dashes to a `?` each and stayed invalid until someone read it. Git, the package
 * checks and the test suite all pass such a file through, so the only thing that
 * catches it is a decoder that is asked to be strict.
 */
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|css|md|yml|yaml|txt|svg)$/

function trackedTextFiles() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name !== "" && TEXT.test(name))
}

describe("tracked text files", () => {
  it("are valid UTF-8", () => {
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const broken = trackedTextFiles().filter((name) => {
      try {
        decoder.decode(readFileSync(name))
        return false
      } catch {
        return true
      }
    })

    expect(broken, `not valid UTF-8: ${broken.join(", ")}`).toEqual([])
  })
})

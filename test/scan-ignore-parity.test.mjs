import { describe, expect, it } from "vitest"
import { DEFAULT_IGNORED_SCAN_DIRECTORY_SET, ignoredScanDirectorySet } from "../src/host/index.js"
import { DEFAULT_IGNORED_SCAN_DIRECTORIES } from "../src/client/lib/scan-ignore"

/**
 * The Plugins page shows the names the Host ships, so it keeps a copy of the list
 * rather than asking: the dialog has to open on the click, and a round trip first
 * would mean a button that sometimes does nothing.
 *
 * Nothing in the build would catch the two drifting apart. The Host would go on
 * skipping exactly the right directories and the dialog would go on listing the
 * wrong ones, and the page would answer a different question from the one it is
 * there to answer. This is the check that keeps the copy a copy.
 */
describe("the two copies of the built-in directory list", () => {
  it("hold the same names", () => {
    expect(new Set(DEFAULT_IGNORED_SCAN_DIRECTORIES)).toEqual(DEFAULT_IGNORED_SCAN_DIRECTORY_SET)
  })

  it("hold no name twice, in either copy", () => {
    expect(new Set(DEFAULT_IGNORED_SCAN_DIRECTORIES).size).toBe(DEFAULT_IGNORED_SCAN_DIRECTORIES.length)
    expect(DEFAULT_IGNORED_SCAN_DIRECTORY_SET.size).toBe(DEFAULT_IGNORED_SCAN_DIRECTORY_SET.size)
  })

  it("skip nothing that is a dot-directory, which the walk already covers", () => {
    // A name beginning with `.` is dead weight: `discoverGitRoots` skips every one
    // of them except `.worktrees`, so listing it would promise something the
    // behaviour does not depend on. Worth a test, because a future build-output
    // name like `.build` is exactly the sort of thing that gets added by habit.
    for (const name of DEFAULT_IGNORED_SCAN_DIRECTORIES) {
      expect(name.startsWith("."), `${name} is already skipped by the dot rule`).toBe(false)
    }
  })

  it("are what a configuration with nothing in it falls back to", () => {
    // The dialog saves an empty list to mean "nothing beyond the built-ins", and
    // that has to be the same set rather than an empty one, or clearing the
    // setting would switch the built-ins off.
    expect(ignoredScanDirectorySet([])).toEqual(DEFAULT_IGNORED_SCAN_DIRECTORY_SET)
  })
})

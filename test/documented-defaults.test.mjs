import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_SCAN_DEPTH, MAX_SCAN_DIRECTORIES } from "../src/host/index.js"
import { DEFAULT_IGNORED_SCAN_DIRECTORIES } from "../src/client/lib/scan-ignore"

/**
 * The documented defaults must be the defaults the code ships.
 *
 * A default is a promise in prose. `scanDepth` being two levels was true once, and
 * the code moved to three on a measurement - the CHANGELOG says so, under "The
 * default scan depth is three, not two" - and every document kept saying two. The
 * skip list lost an entry somewhere and the README kept counting 24 when there were
 * 23. Nothing about that is checkable by reading either side: the code is right,
 * the prose is wrong, and both are internally consistent.
 *
 * So the count is compared, not trusted. Each document is read and the number it
 * states is extracted by pattern, then checked against the constant the plugin
 * actually runs with. Changing a default without updating the four documents is now
 * a red test naming the files, rather than a wrong README that nobody finds until a
 * user reports that the plugin does not do what its page says.
 *
 * The patterns are per-document on purpose. They are what say "this is the default
 * and not something else nearby", and a document that is reworded until its pattern
 * stops matching fails loudly - which is the outcome to prefer over a pattern that
 * quietly matched nothing and compared `undefined` to a number.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const read = (name) => readFileSync(join(ROOT, name), "utf8")

/**
 * The English half of a merged document.
 *
 * 1.3.6 merged each Chinese/English pair into one file - Chinese first, English after
 * `<a id="english">` - so the English statements no longer live in a file of their own.
 * Every entry below names one file and, when its prose is the English half, the anchor
 * its statements sit after; `read` returns that half and the same patterns apply.
 */
const readPart = (file, after) => {
  const whole = read(file)
  if (after === undefined) return whole
  const marker = `<a id="${after}"></a>`
  const at = whole.indexOf(marker)
  if (at < 0) throw new Error(`${file} no longer carries ${marker}, so its English half cannot be located`)
  return whole.slice(at)
}

/**
 * Every place a default is stated in prose, and how to pull the stated number out.
 *
 * `directories` and `ignored` are optional because not every document states them:
 * `docs/PERMISSIONS.md` does not quote the skip list, and neither document counts the
 * built-in names in its default column. Where a document is silent, this stays
 * silent with it - a check that demands a sentence the document has no reason to
 * contain is a check that gets deleted.
 */
const STATED = [
  {
    file: "README.md",
    depth: /\| 扫描深度 \|[^|]*\|\s*(\d+)\s*层\s*\|/,
    directories: /\| 最大遍历目录数 \|[^|]*\|\s*(\d+)\s*\|/,
    ignored: /\| 工作区仓库扫描忽略目录 \|[^|]*\|\s*内置 (\d+) 个\s*\|/,
  },
  {
    // The English half of the same file, after the merge anchor.
    file: "README.md",
    after: "english",
    label: "README.md (English)",
    depth: /\| Scan depth \|[^|]*\|\s*(\d+)\s*levels\s*\|/,
    directories: /\| Scan directory limit \|[^|]*\|\s*(\d+)\s*\|/,
    ignored: /\| Directories the scan skips \|[^|]*\|\s*the plugin's (\d+)\s*\|/,
  },
  {
    file: "docs/PERMISSIONS.md",
    depth: /最多 `scanDepth` 层（1–5，默认 (\d+)）/,
    directories: /最多 `maxScanDirectories` 个目录（默认 (\d+)）/,
  },
  {
    file: "docs/PERMISSIONS.md",
    after: "english",
    label: "docs/PERMISSIONS.md (English)",
    // Wrapped across a line break in the source, so the gap is `[\s\S]` and the
    // bound is what stops it reaching the next setting's number.
    depth: /`scanDepth` levels[\s\S]{0,20}?default (\d+)/,
    directories: /`maxScanDirectories` directories \(default (\d+)\)/,
  },
]

describe("the defaults the documents state", () => {
  it.each(STATED)("$label states the scan depth the plugin ships", ({ file, after, label, depth }) => {
    const named = label ?? file
    const stated = readPart(file, after).match(depth)
    // Not "expect(match).not.toBeNull()": a pattern that stopped matching would
    // otherwise fail on a Number(undefined) that reads like the wrong number.
    expect(stated, `${named} no longer states a scan depth where this test can read it`).not.toBeNull()
    expect(Number(stated[1]), `${named} states a scan depth the plugin does not ship`).toBe(DEFAULT_SCAN_DEPTH)
  })

  it.each(STATED.filter((entry) => entry.directories))(
    "$label states the directory limit the plugin ships",
    ({ file, after, label, directories }) => {
      const named = label ?? file
      const stated = readPart(file, after).match(directories)
      expect(stated, `${named} no longer states a directory limit where this test can read it`).not.toBeNull()
      expect(Number(stated[1]), `${named} states a directory limit the plugin does not ship`).toBe(MAX_SCAN_DIRECTORIES)
    },
  )

  it.each(STATED.filter((entry) => entry.ignored))(
    "$label counts the built-in skip names correctly",
    ({ file, after, label, ignored }) => {
      const named = label ?? file
      const stated = readPart(file, after).match(ignored)
      expect(stated, `${named} no longer counts the built-in names where this test can read it`).not.toBeNull()
      expect(Number(stated[1]), `${named} counts a different number of built-in skip names than are shipped`).toBe(
        DEFAULT_IGNORED_SCAN_DIRECTORIES.length,
      )
    },
  )

  it("keeps the built-in skip names the two copies agree on, so the count means one thing", () => {
    // The README count is only a claim about something if the Host and the dialog
    // ship the same list. `scan-ignore-parity.test.mjs` proves the two lists match;
    // this says so here too, because a mismatch would make the corrected count wrong
    // in a different way and a reader would have no way to tell which number to trust.
    expect(DEFAULT_IGNORED_SCAN_DIRECTORIES.length).toBeGreaterThan(0)
    expect(new Set(DEFAULT_IGNORED_SCAN_DIRECTORIES).size).toBe(DEFAULT_IGNORED_SCAN_DIRECTORIES.length)
  })

})
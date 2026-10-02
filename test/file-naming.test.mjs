import { describe, expect, it } from "vitest"
import { readdir } from "node:fs/promises"
import { basename, extname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Filenames are kebab-case, and nothing enforces that except whoever remembers.
 *
 * The repository had both: `test/` was kebab throughout while `src/` mixed
 * `scanCache.js` and `configPreview.ts` into it. Both are now kebab, and this is
 * what keeps them there - a rename that fixes one file and leaves five behind is
 * not a rule being followed, it is a rule being noticed once.
 *
 * The one exception is `src/client/components/`, whose PascalCase names are not
 * in scope here. They say what a component is and are read as a type at the
 * import site, which a dash would break.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url))

/** Directories that hold no first-party source and are not worth naming rules. */
const SKIP = new Set([
  "node_modules", "dist", "coverage", ".git", ".idea", ".npm-cache", "_preview", "target",
])

/**
 * Every file under `src` and `test`, as paths relative to the repository root.
 * @returns {Promise<string[]>} relative paths.
 */
async function sourceFiles() {
  const found = []

  async function walk(directory) {
    const entries = await readdir(join(ROOT, directory), { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else found.push(relative(ROOT, path))
    }
  }

  await walk("src")
  await walk("test")
  return found.sort()
}

/** Whether a path is a component file, the one place PascalCase is allowed. */
const isComponent = (path) =>
  path.replace(/\\/g, "/").startsWith("src/client/components/") && extname(path) !== ".ts"

/** The part of a filename between its first and last dot. */
const stem = (name) => {
  const extension = extname(name)
  return extension === "" ? name : name.slice(0, name.length - extension.length)
}

describe("filenames", () => {
  it("never uses camelCase for a multi-word name", async () => {
    // Lowercase start plus an uppercase anywhere is camelCase by definition, and
    // a stem that also contains a dash has been spelled both ways at once.
    const offenders = (await sourceFiles()).filter((path) => {
      if (isComponent(path)) return false
      const name = stem(basename(path))
      return /[A-Z]/.test(name) && !/^[A-Z]/.test(name)
    })

    expect(offenders).toEqual([])
  })

  it("spells a separator once, and not at either end", async () => {
    // `--` reads as one separator, and a leading or trailing one is a typo that
    // sorts oddly and greps badly.
    const offenders = (await sourceFiles()).filter((path) => {
      const name = stem(basename(path))
      return name.startsWith("-") || name.endsWith("-") || name.includes("--")
    })

    expect(offenders).toEqual([])
  })

  it("keeps an underscore out of the name", async () => {
    const offenders = (await sourceFiles()).filter((path) => basename(path).includes("_"))

    expect(offenders).toEqual([])
  })

  it("names every test after the thing it tests, in kebab-case", async () => {
    // `api.test.ts` is the shape: the module under test, kebab-cased, plus the
    // test suffix. A file called `tests.test.mjs` tells a reader nothing.
    const offenders = (await sourceFiles())
      .filter((path) => path.replace(/\\/g, "/").startsWith("test/"))
      .map((path) => basename(path))
      .filter((name) => !/^[a-z0-9]+(?:-[a-z0-9]+)*\.test\.(mjs|ts|tsx)$/.test(name))

    expect(offenders).toEqual([])
  })
})

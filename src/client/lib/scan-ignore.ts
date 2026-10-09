/**
 * The directory names a scan walks past, as the Plugins page shows them.
 *
 * This is a copy of what the Host ships, and it is a copy because the dialog has
 * to open on the click: a round trip to the Host first would mean a button that
 * sometimes does nothing, and the names are twenty-odd entries.
 *
 * A copy is only honest while someone checks it, so `scan-ignore-parity.test.mjs`
 * compares this against the Host's own list. Nothing in the build would notice a
 * drift: the Host would keep skipping the right directories and the dialog would
 * list the wrong ones, which is a page that answers a different question from the
 * one the user asked.
 *
 * They are lower case here, because that is the shape the Host compares in. The
 * Host keeps the spellings, which differ per ecosystem - `Pods`, `Intermediate` -
 * and this shows the same names rather than a tidied-up version of them.
 */
export const DEFAULT_IGNORED_SCAN_DIRECTORIES = [
  "node_modules", "dist", "build", "coverage", "storybook-static",
  "__pycache__", "site-packages",
  "target",
  "obj", "packages",
  "library", "deriveddata", "pods",
  "vendor", "deps", "elm-stuff",
  "dist-newstyle", "_build", "blib", "zig-out",
  "binaries", "intermediate", "deriveddatacache",
  // This plugin's own task container, under both of the names it takes. The container
  // root is registered as a Workspace - that is how the sessions a finish hands an
  // agent end up under one group - so a scan walks it, and what is in it holds no
  // repository of its own.
  "worktree-space", "dsh-worktree-space",
]

/**
 * How many names the dialog will hold.
 *
 * A ceiling, because the list is free text and nothing else would stop a paste of
 * ten thousand lines from becoming a configuration the Plugins page struggles to
 * draw. It is generous rather than tight: two hundred names covers every build
 * system in common use several times over, so anyone who reaches it has a reason
 * to be there rather than a habit.
 *
 * The Host's own backstop is a good deal higher, and deliberately so. This number
 * is about the dialog; that one is about refusing a file so broken that the
 * plugin should not start. A configuration written by hand sits between the two
 * and is honoured, because a name the user wrote down is a name they meant.
 */
export const MAX_IGNORED_SCAN_DIRECTORIES = 200

/**
 * The names a scan is actually skipping, given the two settings that hold the choices.
 *
 * One function, because there are two places that have to answer this and a
 * disagreement between them is visible: the row counting the names, and the dialog
 * opening on them. The Plugins page would say twenty-two and the dialog would show
 * twenty-four, with nothing on screen that would explain the gap.
 *
 * `added` and `removed` can both mention the same name - that is what putting a
 * built-in name back looks like when it is written down - and here it resolves to
 * skipped, the same as it does in the Host, because `removed` is subtracted after
 * `added` is unioned in. The order is the whole of the answer; swapping the two
 * lines would make the same configuration mean two different things.
 *
 * @param builtIn - the names the Host ships.
 * @param added - the names the configuration adds.
 * @param removed - the built-in names the configuration switches back on.
 * @returns each distinct name once, in force, in the order it is met.
 */
export function forcedIgnoreNames(builtIn: string[], added: string[], removed: string[]): string[] {
  const off = new Set(removed.map((name) => name.toLowerCase()))
  const kept = new Set<string>()
  const names: string[] = []
  for (const name of [...builtIn, ...added]) {
    const key = name.toLowerCase()
    if (off.has(key) || kept.has(key)) continue
    kept.add(key)
    names.push(name)
  }
  return names
}

/**
 * Whether two name lists are the same list.
 *
 * `forcedIgnoreNames` builds a fresh array on every call, so two calls that agree
 * answer with two different references. Dropping the result of one into state
 * re-renders even when nothing about the answer changed - and an effect that
 * stores it after every render, which is exactly what a missing dependency array
 * is, then renders again, builds two more arrays, and runs again. That is not a
 * slow render. It is the Plugins page stopping responding while a worker eats its
 * way through a gigabyte of heap, which is how this helper came to exist: the
 * card it serves had that missing array, and the only symptom was the test suite
 * hanging with no output.
 *
 * Order is compared, not set membership: `forcedIgnoreNames` produces an order
 * and it is the whole of the answer, so two lists in a different order mean
 * different things and must not be treated as one.
 *
 * @param left - the names in hand.
 * @param right - the names to compare them against.
 * @returns true when both lists hold the same names in the same order.
 */
export function sameIgnoreNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index])
}

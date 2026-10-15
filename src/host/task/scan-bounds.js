/**
 * The bounds a repository walk obeys when its caller names none.
 *
 * These live here rather than in the entry module for the reason
 * {@link ./concurrency.js} gives about its own number: the entry imports the task
 * side, so a constant the entry owned could not be read back from the task side
 * without a cycle. This file is a leaf - it imports nothing - which is what makes
 * it the one place both walks read their ceiling and their skip list from.
 *
 * The entry re-exports both, so its public surface is unchanged, and the two
 * walks are now guaranteed to agree about the two facts they used to state
 * separately: how many directories a walk may look at, and which names it steps
 * over. When those were written twice they drifted, and the drift is invisible -
 * a caller that passes its bounds explicitly never reads these at all, so the
 * disagreement only shows up in the one call path that forgot to.
 */

/**
 * How many directories a walk may inspect before it stops and keeps what it has.
 *
 * The same number the configuration is clamped to, because it *is* that number:
 * a configured value is clamped to this ceiling and handed to the walk as its
 * `maxDirectories`, so a walk falling back to anything else would either exceed
 * a bound the user's own setting cannot reach or silently truncate a scan the
 * configuration said was allowed.
 */
export const MAX_SCAN_DIRECTORIES = 2000

/**
 * The ceiling the configured value is clamped to, which is a different fact from
 * the default above and happens to hold the same number today.
 *
 * Kept separate on purpose. Raising the default says "a walk with no configured
 * bound may look at more"; raising the ceiling says "a user may ask for more".
 * Collapsing them would make each of those changes silently perform the other.
 */
export const MAX_SCAN_DIRECTORIES_CEILING = 10000

/**
 * The lowest depth a scan may be configured to walk, and the highest.
 *
 * One is the historical contract for a caller that passes no bounds, and the
 * ceiling is where a deeper walk stops finding repositories and starts finding
 * build output. Both are read by the schema that bounds the setting and by the
 * resolver that clamps a stored value that predates it - which is why they live
 * beside the default rather than in the entry module alone: a clamp using a
 * different number from the schema would let a stored value through that the
 * schema refuses, or refuse one it allows.
 */
export const MIN_SCAN_DEPTH = 1
export const MAX_SCAN_DEPTH = 5

/**
 * The default depth: how far below a Workspace a walk looks without being told.
 *
 * Three, because the shape that motivated it is `E:\workspace`, whose top level
 * holds containers (`aqumon`, `public`) rather than repositories - so a one-level
 * walk reported nothing about a root full of them.
 */
export const DEFAULT_SCAN_DEPTH = 3

/**
 * Directory names a walk steps over without being told to.
 *
 * A build output directory holds no repository the user wants, but it holds a
 * great many directories - `node_modules` alone is tens of thousands - and each
 * one spends a share of {@link MAX_SCAN_DIRECTORIES}. So these are not a
 * nicety; on a Workspace that holds real projects, the difference between
 * skipping them and not is the difference between a scan that answers and one
 * that gives up against its ceiling.
 *
 * Dot-directories need no entry: both walks already skip anything beginning with
 * `.`, which covers `.venv`, `.gradle`, `.tox`, `.next`, `.dart_tool`,
 * `.stack-work` and the rest of that family. What is here is the half that does
 * not start with a dot.
 *
 * The list is a starting point rather than a rule - the user edits it on the
 * Plugins page - so nothing in it has to be defensible as permanent, only as a
 * good default. Names were left out where the same word is a place people keep
 * source: `bin` holds scripts in too many projects, `env` is a Django
 * `settings` directory as often as a virtual environment, and `out` means
 * whatever the build in front of you says it means.
 */
export const DEFAULT_IGNORED_SCAN_DIRECTORIES = [
  // JavaScript and the web
  'node_modules', 'dist', 'build', 'coverage', 'storybook-static',
  // Python
  '__pycache__', 'site-packages',
  // The JVM, Rust, Scala, Clojure: Cargo and Maven agree on the name
  'target',
  // .NET
  'obj', 'packages',
  // Apple
  'Library', 'DerivedData', 'Pods',
  // PHP, and the dependency trees other ecosystems fetch into the project
  'vendor', 'deps', 'elm-stuff',
  // Haskell, Elixir, OCaml, Perl, Zig
  'dist-newstyle', '_build', 'blib', 'zig-out',
  // Unreal, which capitalises its generated directories
  'Binaries', 'Intermediate', 'DerivedDataCache',
  // This plugin's own task container, under both of the names it takes.
  //
  // Registering the container root as a Workspace is how the sessions a finish hands
  // an agent end up under one group rather than in Ungrouped, and that puts the
  // container in the set of roots a scan walks. What is in it is task spaces, which
  // are linked worktrees of repositories the scan has already found elsewhere, and
  // archived documents - so walking it spends budget on directories that hold no
  // repository of their own. Named rather than skipped by path because a scan is
  // handed Workspace roots and walks them: the name is the only thing left to compare.
  // A user whose own directory is called this and does hold repositories can take the
  // name back off this list on the Plugins page, which is what that setting is for.
  'worktree-space', 'dsh-worktree-space',
]

/**
 * The names above, as the walk compares them.
 *
 * Case-insensitively, because the comparison is against directory names as the
 * filesystem reports them and those differ by platform: `Pods` and `pods` are
 * different directories on a case-sensitive volume and the same one on macOS.
 * Matching one way would make this list mean different things depending on where
 * DSH runs, and a user who typed `deriveddata` expecting Xcode's folder to be
 * skipped would be right on Windows and wrong on Linux.
 */
export const DEFAULT_IGNORED_SCAN_DIRECTORY_SET = new Set(
  DEFAULT_IGNORED_SCAN_DIRECTORIES.map((name) => name.toLowerCase()),
)

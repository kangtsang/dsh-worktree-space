/**
 * Error codes: `E` and four digits. The first digit is the category, the last
 * three are the position within it.
 *
 * They exist to answer one question faster than a message can: where in this
 * source tree did this failure come from? A log line and a screen can disagree
 * about wording - the log says what the operation meant, the screen says what
 * the user is told - and the code is the part both carry unchanged, so a code
 * read off either one is the code to grep for.
 *
 *   E1xxx  container and isolation      where task spaces may and may not live
 *   E2xxx  task space lifecycle         creating, finding, taking one down
 *   E3xxx  git and branches             the repository underneath any of it
 *   E4xxx  arguments and validation     a request that does not add up
 *   E5xxx  finishing and merging        the work that has to be settled first
 *   E6xxx  scanning and discovery       finding workspaces in the first place
 *   E7xxx  the package itself           packaging and wiring, not user input
 *
 * Numbers are assigned in reading order within a category and are never reused:
 * a code that once meant something keeps meaning it, so an old log line and a
 * new one that share a code are about the same thing. E1-E6 are what a user can
 * cause; E7 means the plugin is broken and should be reported.
 *
 * Each entry says where it is thrown, because that is the other half of the
 * promise. The codes are written literally at the throw site rather than looked
 * up here, so `grep -n E2003` finds the line itself.
 */

/** Every code, with the place that raises it. The shape is checked by a test. */
export const ERROR_CODES = {
  // --- E1xxx container and isolation --------------------------------------
  E1001: 'paths.js - the tasks root is the repositories directory itself',
  E1002: 'paths.js, add.js - the container, or the task space, is inside a repository',
  E1003: 'paths.js, add.js - the container, or the task space, holds a repository',
  E1004: 'paths.js, container.js, archive.js, inspect.js, add.js - the tasks root is missing or empty',
  E1005: 'container.js - the tasks root was refused on creation',

  // --- E2xxx task space lifecycle -----------------------------------------
  E2001: 'create.js - the task name is taken by a different task space',
  E2002: 'create.js - the task space is this task own, left before its Workspace was registered',
  E2003: 'archive.js, add.js - no task space at that path',
  E2004: 'archive.js, add.js - the task space holds no git worktrees',
  E2005: 'create.js, add.js - creating or extending failed and everything was rolled back',
  E2006: 'create.js, add.js - creating or extending failed and the rollback left something behind',

  // --- E3xxx git and branches ---------------------------------------------
  E3001: 'create.js, add.js - the branch to cut the worktree from is already in use',
  E3002: 'create.js, add.js - the requested base ref does not exist in that repository',
  E3003: 'git.js - a git command failed, for any reason not covered below',
  E3004: 'git.js - the directory is not a git repository',
  E3005: 'git.js - the worktree checkout has gone',

  // --- E4xxx arguments and validation -------------------------------------
  E4001: 'create.js, add.js - no repository was selected',
  E4002: 'create.js, add.js - two repositories in one task share a name',
  E4003: 'index.js - the task name is missing',
  E4004: 'index.js - the source root is missing',
  E4005: 'index.js, add.js - a path is required, either a worktree, a task space or a repository',
  E4006: 'index.js - the workspace scan hit its directory limit',
  E4007: 'archive.js - deleting an unmerged branch was not forced',
  E4008: 'archive.js - the merge target is unusable',
  E4009: 'naming.js - the task name or branch prefix is not usable',

  // --- E5xxx finishing and merging ----------------------------------------
  E5001: 'archive.js - a merge is still standing, so nothing was finished',
  E5002: 'archive.js - finishing did not complete for every repository',
  E5003: 'archive.js - one repository could not be finished and needs another attempt',

  // --- E6xxx scanning and discovery ---------------------------------------
  E6001: 'discover.js, add.js - a candidate directory is not a source repository',
  E6002: 'index.js - a workspace was not selected',

  // --- E7xxx the package itself -------------------------------------------
  E7001: 'skill.js - the package root for the bundled skill cannot be located',
  E7002: 'skill.js - a bundled skill file has no YAML frontmatter',
  E7003: 'skill.js - a bundled skill file declares no description',
  E7004: 'skill.js - a bundled skill file declares a name that is not the one served',
  E7005: 'tool.js - an unknown action was asked for',
  E7006: 'tool.js - a required argument for an action is missing',
}

/** The code reported when a failure has no code of its own. */
export const UNKNOWN = 'E9001'

/**
 * An error carrying one of these codes.
 *
 * The code is written as a literal at every call site rather than referenced
 * through a name here, so that searching the tree for a code finds the line that
 * raises it. This is only the constructor.
 * @param code - one of {@link ERROR_CODES}.
 * @param message - the message, which stays free of the code.
 * @returns the error, with `code` set.
 */
export function coded(code, message) {
  const error = new Error(message)
  error.code = code
  // The sentence the operation would tell a person, which the message alone
  // cannot: "task space already exists" says what collided, not what it means
  // for the create that was refused, or which of two ways to resolve it applies.
  // `recover` reads it; nothing else does.
  error.withMsg = (sentence) => {
    error.msg = sentence
    return error
  }
  return error
}
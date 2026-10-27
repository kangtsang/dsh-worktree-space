/**
 * Where the task space above a directory is.
 *
 * Two callers need this answer for different reasons, and they must agree: the
 * session tools ask it to decide what a message header should say, and the tool
 * gate asks it to decide which tools a session starts with. A second copy would
 * be a second definition of "is this session in a task space", and the two would
 * drift exactly where the answer matters - a session that one of them placed and
 * the other did not.
 *
 * Two spellings of the same walk exist, and the split is deliberate. The async one
 * serves a tool call, where the read is already inside an async body. The sync one
 * serves the tool gate, which runs while a session's first prompt is being
 * assembled: registering a step later than that means the model's first request
 * carries no Worktree Space tool at all, so the gate cannot wait on a promise. Both
 * read the same files through the same helpers, so they answer identically.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BREADCRUMB, readTaskMetadata, taskMetadataPath } from './shared.js'

/**
 * How far up from a session's directory a task space is looked for.
 *
 * The plugin's own layout is `<container root>/<project>/<task>`, and a session is
 * opened either on the task space itself or on a worktree one level inside it, so the
 * record is a level or two up. The walk stops at the drive root anyway; this bound
 * only keeps a pathologically deep directory from turning one tool call into a long
 * chain of reads that cannot succeed.
 */
export const TASK_SPACE_WALK_LIMIT = 8

/**
 * The task space a directory sits in, and the record it holds.
 *
 * Walked upward rather than read at one exact level, because a session may be opened
 * on a worktree rather than on the task space, and the record sits at the task space's
 * own level. `dirname` rather than a split-and-rejoin: rejoining loses a Windows drive
 * prefix, so `C:\space\proj\task` would come back as a relative path that names
 * nothing, and `dirname` also stops cleanly at the root.
 * @param directory - a session's working directory, possibly absent.
 * @returns the task space's directory and its record, or undefined.
 */
export async function taskSpaceAbove(directory) {
  if (typeof directory !== 'string' || directory === '') return undefined
  let current = directory
  for (let level = 0; level < TASK_SPACE_WALK_LIMIT; level += 1) {
    const metadata = await readTaskMetadata(current).catch(() => undefined)
    if (metadata !== undefined && metadata !== null && typeof metadata === 'object') {
      return { path: current, metadata }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/**
 * The same answer, read synchronously.
 *
 * For the callers that cannot await: the tool gate runs inside the session's
 * creation announcement, and a registration that lands after the first prompt is
 * assembled is a tool the model is not offered until its second step. Reading at
 * most eight small files synchronously is the price of the tools being there at
 * step one.
 *
 * It applies the same rule as {@link readTaskMetadata}, because a container old
 * enough to hold only the Markdown note is still a task space: the JSON record is
 * tried first, then the note. Skipping the note would hand a session in an older
 * space the loader instead of the tools it needs.
 * @param directory - a session's working directory, possibly absent.
 * @returns the task space's directory and its record, or undefined.
 */
export function taskSpaceAboveSync(directory) {
  if (typeof directory !== 'string' || directory === '') return undefined
  let current = directory
  for (let level = 0; level < TASK_SPACE_WALK_LIMIT; level += 1) {
    const metadata = readMetadataSync(current)
    if (metadata !== undefined) return { path: current, metadata }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/**
 * One directory's record, synchronously: the JSON file, or the legacy note.
 * @param taskPath - a directory to test.
 * @returns the metadata, or undefined when this directory is not a task space.
 */
function readMetadataSync(taskPath) {
  const text = readTextSync(taskMetadataPath(taskPath))
  if (text !== undefined && text.trim() !== '') {
    try {
      const parsed = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.task === 'string' && parsed.task !== '') {
        return parsed
      }
    } catch {
      // A half-written or hand-edited file falls through to the note below,
      // exactly as the async reader does.
    }
  }
  const note = readTextSync(join(taskPath, BREADCRUMB))
  if (note === undefined || note.trim() === '') return undefined
  const task = /^#\s*Task:\s*(.+)$/m.exec(note)?.[1]?.trim()
  if (task === undefined || task === '') return undefined
  const branch = /^-\s*Branch:\s*`([^`]+)`/m.exec(note)?.[1]?.trim()
  const sourceRoot = /^-\s*Source root:\s*`([^`]+)`/m.exec(note)?.[1]?.trim()
  return {
    version: 0,
    task,
    ...(branch === undefined || branch === '' ? {} : { branch }),
    ...(sourceRoot === undefined || sourceRoot === '' ? {} : { sourceRoot }),
  }
}

/**
 * Read a small text file, or undefined when it is absent or unreadable.
 * @param path - the file to read.
 * @returns its contents.
 */
function readTextSync(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

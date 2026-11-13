import type { LineChanges } from "./types"

/**
 * Pairs of changes added into one.
 *
 * A collapsed row answers "how much is this carrying" once rather than twice, and the
 * total has to be the sum of what the rows below it draw - file count included, or the
 * one number on the page would be answering a different question from the rest.
 *
 * A pair that was never measured contributes nothing, and a group whose pairs all lack
 * a file count keeps lacking one: "nobody counted the files" is not "zero files", and
 * the row draws nothing rather than a zero it made up.
 * @param parts - the pairs to add, in any order. Absent pairs are skipped.
 * @returns the summed pair.
 */
export function sumLines(...parts: (LineChanges | undefined)[]): LineChanges {
  let files: number | undefined
  let insertions = 0
  let deletions = 0
  for (const part of parts) {
    if (part === undefined) continue
    insertions += part.insertions
    deletions += part.deletions
    if (part.files !== undefined) files = (files ?? 0) + part.files
  }
  return files === undefined ? { insertions, deletions } : { files, insertions, deletions }
}

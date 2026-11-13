import { format, useT } from "../lib/i18n"
import type { LineChanges } from "../lib/types"

/**
 * One pair of change counts: the two coloured line counts, then how many files.
 *
 * The line counts come first because they are what a reader compares down a column of
 * rows - green against green, red against red - and the file count is the qualifier
 * that follows them ("+326 −223, across 19 files"). Put in front, it broke that column
 * of numbers with a word in a different colour.
 *
 * A row git could not measure is a dash, not a zero pair: "nothing changed" and "this
 * could not be read" are different answers, and the page says which.
 */
export function LineCounts({ changes, hint, className }: {
  changes?: LineChanges
  /** The tooltip, with `{files}`, `{insertions}` and `{deletions}` filled in. */
  hint: string
  /** Extra classes for the wrapper, when a row sizes its own counts differently. */
  className?: string
}) {
  const t = useT()
  if (changes === undefined) return <span className="dws-line-none">—</span>
  const files = changes.files
  const title = format(hint, {
    // A Host that predates the field answers without it; the drawn count is left out
    // below, so the tooltip is the only place a placeholder has to be filled at all.
    files: String(files ?? 0),
    insertions: String(changes.insertions),
    deletions: String(changes.deletions),
  })
  return (
    <span className={className === undefined ? "dws-lines" : `dws-lines ${className}`} title={title}>
      <span className="dws-line-add">+{changes.insertions}</span>
      <span className="dws-line-del">−{changes.deletions}</span>
      {files === undefined ? null : <span className="dws-line-files">{format(t("filesCount"), { files: String(files) })}</span>}
    </span>
  )
}

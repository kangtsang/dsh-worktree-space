/**
 * One file of a repository's change view.
 *
 * The header is what a reader reads while the file is closed: the status, the
 * path, and the line counts. Opening it asks for the file's hunks, which is the
 * only read that happens here; a binary change and a change too large to draw
 * stop at the header with the reason written under it.
 */
import { Fragment, useMemo, useState, type ReactNode } from "react"
import { format, useT } from "../../lib/i18n"
import type { ChangeFile, ChangeFileAnswer, ChangeHunk } from "../../lib/types"
import { ChevronDown, ChevronRight, Loader2 } from "../icons"
import { diffRows, widenedContext } from "./diff-rows"
import { statusLetter } from "./FileTree"
import { languageOfPath, spansForHunks, useSourceHighlighter, type CodeHighlighter, type HighlightSpan } from "./source-highlight"
import { commentRange, hunkAt, hunkText, targetForRow, type CommentSide, type CommentTarget } from "./review-quote"
import type { ReviewComment } from "./review-buffer"

/** What the review buffer offers a file card: the comments to draw and the edits to make. */
export interface CommentContext {
  comments: readonly ReviewComment[]
  add: (target: CommentTarget, hunk: string, body: string) => void
  edit: (id: string, body: string) => void
  remove: (id: string) => void
}

/** What the view knows about one file's lines. */
export type ChangeFileState =
  | { status: "loading" }
  | { status: "ready"; answer: ChangeFileAnswer }
  | { status: "error"; message: string }

interface ChangeFileCardProps {
  file: ChangeFile
  expanded: boolean
  state: ChangeFileState | undefined
  wrap: boolean
  reviewed: boolean
  /** Marked once, on a change that is no longer the one on screen. */
  stale: boolean
  register: (path: string, element: HTMLElement | null) => void
  onToggle: (file: ChangeFile) => void
  onWiden: (file: ChangeFile, context: number) => void
  onReviewed: (file: ChangeFile) => void
  /** The review buffer: comments to draw under their lines, and the edits made on them. */
  review: CommentContext
}

/**
 * Draw one file's card.
 * @param props - the file, whether it is open, what its read answered, and the
 *   actions that change those.
 * @returns the card.
 */
export function ChangeFileCard({ file, expanded, state, wrap, reviewed, stale, register, onToggle, onWiden, onReviewed, review }: ChangeFileCardProps): ReactNode {
  const t = useT()
  // The shell's highlighter, bound to the grammar this path selects. It is asked
  // for even while the card is closed, because hooks cannot be called later; a
  // grammar it has not loaded yet answers undefined and the lines stay plain.
  const highlighter = useSourceHighlighter(languageOfPath(file.path))
  const directory = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""
  const name = file.path.slice(file.path.lastIndexOf("/") + 1)
  return (
    <section className={`dws-change-file${expanded ? " is-open" : ""}${wrap ? " is-wrap" : ""}${reviewed ? " is-reviewed" : ""}`} ref={(element) => register(file.path, element)}>
      <div className="dws-change-file-head">
        <button type="button" className="dws-change-file-toggle" onClick={() => onToggle(file)} aria-expanded={expanded}>
          <span className={`dws-change-status dws-change-status-${file.status}`} aria-hidden="true">{statusLetter(file)}</span>
          <span className="dws-change-file-path">
            <span className="dws-change-file-name">{name}</span>
            {directory === "" ? null : <span className="dws-change-file-dir" title={directory}>{directory}</span>}
          </span>
          <span className="dws-change-file-flags">
            {file.status === "added" ? <span className="dws-change-flag">{t("changesNewFile")}</span> : null}
            {file.status === "renamed" && file.oldPath !== undefined ? <span className="dws-change-flag" title={file.oldPath}>{t("changesRenamed")}</span> : null}
            {file.untracked === true ? <span className="dws-change-flag">{t("changesUntracked")}</span> : null}
            {file.oldPath !== undefined && file.status !== "renamed" ? <span className="dws-change-flag" title={file.oldPath}>{t("changesCopied")}</span> : null}
          </span>
          <span className="dws-change-file-counts">
            {file.binary === true ? <span className="dws-change-count-label">{t("changesBinary")}</span>
              : file.tooLarge === true ? <span className="dws-change-count-label">{t("changesTooLarge")}</span>
                : <><span className="dws-line-add">+{file.insertions}</span><span className="dws-line-del">−{file.deletions}</span></>}
          </span>
          <span className="dws-change-file-chevron" aria-hidden="true">{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
        </button>
        {stale ? <span className="dws-change-flag dws-change-flag-stale" title={t("changesNewChangesHint")}>{t("changesNewChanges")}</span> : null}
        <label className="dws-change-reviewed">
          <input type="checkbox" className="dws-checkbox" checked={reviewed} onChange={() => onReviewed(file)} />
          <span>{t("changesReviewed")}</span>
        </label>
      </div>
      {expanded ? <div className="dws-change-file-body">
        {file.binary === true ? <p className="dws-change-file-note">{t("changesBinaryHint")}</p>
          : file.tooLarge === true ? <p className="dws-change-file-note">{format(t("changesTooLargeHint"), { lines: "0" })}</p>
            : state === undefined || state.status === "loading" ? <p className="dws-change-file-note" role="status"><Loader2 size={14} className="dws-spin" />{t("changesLoadingFile")}</p>
              : state.status === "error" ? <p className="dws-change-file-note is-error" role="alert">{state.message}</p>
                : state.answer.kind === "binary" ? <p className="dws-change-file-note">{t("changesBinaryHint")}</p>
                  : state.answer.kind === "tooLarge" ? <p className="dws-change-file-note">{format(t("changesTooLargeHint"), { lines: String(state.answer.lines ?? 0) })}</p>
                    : <Hunks hunks={state.answer.hunks ?? []} highlighter={highlighter} path={file.path} review={review} onWiden={(context) => onWiden(file, context)} />}
      </div> : null}
    </section>
  )
}

/** Which line a composer is open for, and the hunk the quote will carry. */
interface Composer {
  side: CommentSide
  line: number
  hunk: ChangeHunk
}

/** The hunks of one file, with the unchanged gaps as the only other interactive rows. */
function Hunks({ hunks, highlighter, path, review, onWiden }: { hunks: readonly ChangeHunk[]; highlighter: CodeHighlighter; path: string; review: CommentContext; onWiden: (context: number) => void }): ReactNode {
  const t = useT()
  const rows = useMemo(() => diffRows(hunks), [hunks])
  const spans = useMemo(() => spansForHunks(hunks, highlighter), [hunks, highlighter])
  const [composer, setComposer] = useState<Composer | null>(null)
  const [body, setBody] = useState("")
  const [editing, setEditing] = useState<string | null>(null)
  const [editBody, setEditBody] = useState("")

  const open = (side: CommentSide, line: number) => {
    const hunk = hunkAt(hunks, { path, side, line })
    if (hunk === undefined) return
    setComposer({ side, line, hunk })
    setBody("")
  }
  const cancel = () => { setComposer(null); setBody("") }
  const submit = () => {
    if (composer === null || body.trim() === "") return
    const target: CommentTarget = { path, side: composer.side, line: composer.line }
    review.add(target, hunkText(composer.hunk), body.trim())
    cancel()
  }

  if (rows.length === 0) return <p className="dws-change-file-note">{t("changesNoTextChange")}</p>
  const width = widenedContext(hunks)
  return (
    <div className="dws-diff" role="table" aria-label={t("changesDiff")}>
      {rows.map((row, index) => {
        if (row.kind === "gap") {
          return <button key={`gap-${index}`} type="button" className="dws-diff-gap" onClick={() => onWiden(width)} title={t("changesExpandGap")}>
            {format(t("changesUnchangedLines"), { count: String(row.gap ?? 0) })}
          </button>
        }
        const lineSpans: readonly HighlightSpan[] | undefined = row.kind === "del"
          ? spans.old.get(row.oldLine ?? -1)
          : spans.next.get(row.newLine ?? -1) ?? spans.old.get(row.oldLine ?? -1)
        const active = composer !== null
          && (composer.side === "L" ? row.oldLine === composer.line : row.newLine === composer.line)
        const target = targetForRow(row, path)
        const label = target === undefined ? undefined : format(t("changesCommentOn"), { range: commentRange(target) })
        const rowComments = target === undefined ? [] : review.comments.filter((comment) =>
          comment.path === path && comment.side === target.side && comment.line === target.line)
        return <Fragment key={`${row.kind}-${index}`}>
          <div className={`dws-diff-row dws-diff-${row.kind}`} role="row">
            {target === undefined ? null : (
              <button type="button" className="dws-diff-plus" title={label} aria-label={label} onClick={() => open(target.side, target.line)}>+</button>
            )}
            {target === undefined
              ? <span className="dws-diff-lines is-plain"><span className="dws-diff-num">{row.oldLine ?? ""}</span><span className="dws-diff-num">{row.newLine ?? ""}</span></span>
              : <button type="button" className="dws-diff-lines" title={label} aria-label={label} onClick={() => open(target.side, target.line)}>
                <span className="dws-diff-num">{row.oldLine ?? ""}</span>
                <span className="dws-diff-num">{row.newLine ?? ""}</span>
              </button>}
            <span className="dws-diff-sign" aria-hidden="true">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</span>
            <code className="dws-diff-text">{lineSpans === undefined
              ? (row.text === "" ? " " : row.text)
              : lineSpans.length === 0 ? " " : lineSpans.map((span, spanIndex) => <span key={spanIndex} style={span.style}>{span.text}</span>)}</code>
          </div>
          {rowComments.map((comment) => <div className="dws-review-comment" key={comment.id}>
            <div className="dws-review-comment-head">
              <span>{format(t("changesCommentOn"), { range: commentRange({ path: comment.path, side: comment.side, line: comment.line }) })}</span>
              <span className="dws-review-comment-actions">
                <button type="button" onClick={() => { setEditing(comment.id); setEditBody(comment.body) }}>{t("changesEditComment")}</button>
                <button type="button" onClick={() => review.remove(comment.id)}>{t("changesDeleteComment")}</button>
              </span>
            </div>
            {editing === comment.id ? <div className="dws-review-comment-edit">
              <textarea className="dws-comment-input" rows={3} value={editBody} autoFocus onChange={(event) => setEditBody(event.target.value)} />
              <div className="dws-comment-actions">
                <button type="button" className="dws-comment-cancel" onClick={() => setEditing(null)}>{t("cancel")}</button>
                <button type="button" className="dws-comment-add" disabled={editBody.trim() === ""} onClick={() => { review.edit(comment.id, editBody); setEditing(null) }}>{t("changesSaveComment")}</button>
              </div>
            </div> : <p className="dws-review-comment-body">{comment.body}</p>}
          </div>)}
          {composer !== null && active ? <div className="dws-comment-composer">
            <div className="dws-comment-head">{format(t("changesCommentOn"), { range: commentRange({ path, side: composer.side, line: composer.line }) })}</div>
            <textarea className="dws-comment-input" value={body} rows={3} autoFocus placeholder={t("changesCommentPlaceholder")}
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") { event.preventDefault(); cancel() }
                else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit() }
              }} />
            <div className="dws-comment-actions">
              <button type="button" className="dws-comment-cancel" onClick={cancel}>{t("cancel")}</button>
              <button type="button" className="dws-comment-add" disabled={body.trim() === ""} onClick={submit}>{t("changesAddToInput")}</button>
            </div>
          </div> : null}
        </Fragment>
      })}
    </div>
  )
}

/**
 * 变更查看 — one repository's changed files and their lines.
 *
 * The list is read once; a file's hunks are read when that file is opened, so a
 * repository with hundreds of changed files paints its headers without carrying
 * every line. The tree on the left is a second way into the same cards.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"
import { parseChangesViewAddress, entryName } from "../../lib/change-address"
import type { ChangesTabProps } from "../../lib/changes-tab"
import { errorText } from "../../lib/error-text"
import { format, useT } from "../../lib/i18n"
import type { ChangeFile, ChangesListAnswer } from "../../lib/types"
import { ChangeFileCard, type ChangeFileState, type CommentContext } from "./ChangeFileCard"
import { FileTree } from "./FileTree"
import { hasNewChanges, isReviewed, useReviewedMarks } from "./reviewed"
import { addReviewComment, commentsBlock, removeReviewComment, updateReviewComment, useReviewComments } from "./review-buffer"
import { formatCommentQuote } from "./review-quote"
import { Loader2, RefreshCw } from "../icons"

/** The file tree's starting width, and the range a drag may take it to. */
const TREE_WIDTH_DEFAULT = 208
const TREE_WIDTH_MIN = 150
const TREE_WIDTH_MAX = 460
const TREE_WIDTH_KEY = "dsh-worktree-space.changes.treeWidth.v1"

/** A comment id that is unique within this browser; the crypto API may be absent on old pages. */
function newCommentId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `comment-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

/** How many files one batch reads at a time; each read is a `git` process on the Host. */
const LOAD_CONCURRENCY = 4

/** The width the reader last left the tree at, kept in this browser. */
function readTreeWidth(): number {
  try {
    const stored = Number(localStorage.getItem(TREE_WIDTH_KEY))
    return Number.isFinite(stored) && stored > 0 ? Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, stored)) : TREE_WIDTH_DEFAULT
  } catch {
    return TREE_WIDTH_DEFAULT
  }
}

function writeTreeWidth(width: number): void {
  try { localStorage.setItem(TREE_WIDTH_KEY, String(width)) } catch { /* the width is cosmetic; no storage is fine */ }
}

/**
 * Draw the view.
 * @param props - the tab's runtime hooks and the injected Host face.
 * @returns the files of one repository.
 */
export function ChangesViewTab({ useTabInfo, api, sessionId, syncComments }: ChangesTabProps): ReactNode {
  const t = useT()
  const { tab } = useTabInfo()
  const target = useMemo(() => parseChangesViewAddress(tab.contentId), [tab.contentId])
  const [list, setList] = useState<ChangesListAnswer | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [generation, setGeneration] = useState(0)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [contents, setContents] = useState<Record<string, ChangeFileState>>({})
  const [showTree, setShowTree] = useState(true)
  // Wrapped by default: a sidebar column is narrower than the code it shows, and
  // the reader who opened the view wants to read the lines, not to scroll them
  // sideways first. The toolbar keeps the switch for the opposite.
  const [wrap, setWrap] = useState(true)
  const [treeWidth, setTreeWidth] = useState(readTreeWidth)
  // Reviewed marks belong to this tab's address and to this browser; see reviewed.ts.
  const { marks: reviewed, toggle: toggleReviewed } = useReviewedMarks(tab.contentId)
  const comments = useReviewComments(sessionId)
  /**
   * Rewrite the session's whole comment block in the input.
   *
   * Every comment lives in the buffer first; the input only ever holds the block
   * this buffer renders. Adding, editing and removing all take this one path, so
   * an edit cannot leave the old text behind.
   */
  const flush = useCallback(() => {
    const block = commentsBlock(sessionId, (comment, index) => formatCommentQuote(
      { path: comment.path, side: comment.side, line: comment.line },
      comment.hunk,
      { repoPath: comment.repoPath, base: comment.base, branch: "" },
      comment.body,
      index,
    ))
    syncComments(sessionId, block)
  }, [sessionId, syncComments])
  const cards = useRef(new Map<string, HTMLElement>())
  const generationRef = useRef(0)
  // Reads are queued instead of all fired at once: "expand all" on a repository
  // with dozens of files would otherwise spawn one `git` per file together, and
  // the machine (and the page) stalls behind them.
  const queue = useRef<{ file: ChangeFile; context?: number; seq: number }[]>([])
  const inflight = useRef(new Set<string>())
  const running = useRef(0)
  const requestSeq = useRef(new Map<string, number>())
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => { generationRef.current = generation }, [generation])
  useEffect(() => { writeTreeWidth(treeWidth) }, [treeWidth])

  useEffect(() => {
    if (target === undefined) return
    const controller = new AbortController()
    setLoading(true)
    setError("")
    setContents({})
    queue.current = []
    inflight.current.clear()
    api.changesList(target.path, target.base, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setList(value) })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorText(t, reason)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [api, target?.path, target?.base, generation, t])

  const register = useCallback((path: string, element: HTMLElement | null) => {
    if (element === null) cards.current.delete(path)
    else cards.current.set(path, element)
  }, [])

  /** One queued read, with the sequence that lets a newer read of the same file win. */
  const fetchFile = useCallback(async (file: ChangeFile, context: number | undefined, seq: number) => {
    if (target === undefined) return
    const started = generationRef.current
    try {
      const answer = await api.changesFile(target.path, target.base, file.path, {
        ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
        ...(file.untracked === true ? { untracked: true } : {}),
        ...(context === undefined ? {} : { context }),
        ...(list?.baseCommit === undefined || list.baseCommit === "" ? {} : { baseCommit: list.baseCommit }),
      })
      if (generationRef.current !== started || requestSeq.current.get(file.path) !== seq) return
      setContents((previous) => ({ ...previous, [file.path]: { status: "ready", answer } }))
    } catch (reason: unknown) {
      if (generationRef.current !== started || requestSeq.current.get(file.path) !== seq) return
      setContents((previous) => ({ ...previous, [file.path]: { status: "error", message: errorText(t, reason) } }))
    }
  }, [api, target?.path, target?.base, list?.baseCommit, t])

  const pump = useCallback(() => {
    while (running.current < LOAD_CONCURRENCY && queue.current.length > 0) {
      const job = queue.current.shift()
      if (job === undefined) break
      running.current += 1
      void fetchFile(job.file, job.context, job.seq).finally(() => {
        running.current -= 1
        inflight.current.delete(job.file.path)
        pump()
      })
    }
  }, [fetchFile])

  const loadFile = useCallback((file: ChangeFile, context?: number, replace = false) => {
    if (target === undefined) return
    if (inflight.current.has(file.path) && !replace) return
    const seq = (requestSeq.current.get(file.path) ?? 0) + 1
    requestSeq.current.set(file.path, seq)
    inflight.current.add(file.path)
    setContents((previous) => ({ ...previous, [file.path]: { status: "loading" } }))
    queue.current.push({ file, context, seq })
    pump()
  }, [pump, target?.path])

  const toggle = useCallback((file: ChangeFile) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(file.path)) next.delete(file.path)
      else next.add(file.path)
      return next
    })
  }, [])

  // An open file with no read yet asks for one; a read already in flight or
  // finished is not asked again. Binary and oversized changes never ask.
  useEffect(() => {
    if (list === null) return
    for (const file of list.files) {
      if (!expanded.has(file.path)) continue
      if (contents[file.path] !== undefined) continue
      if (file.binary === true || file.tooLarge === true) continue
      loadFile(file)
    }
  }, [list, expanded, contents, loadFile])

  const reveal = useCallback((path: string) => {
    setExpanded((previous) => previous.has(path) ? previous : new Set([...previous, path]))
    const element = cards.current.get(path)
    if (element !== undefined) element.scrollIntoView({ block: "start" })
  }, [])

  /**
   * Drag the divider between the tree and the cards. The width is held here
   * rather than in the tree: both sides of the split have to agree while the
   * pointer moves, and a double-click returns the starting width.
   */
  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    drag.current = { startX: event.clientX, startWidth: treeWidth }
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    const move = (moving: globalThis.PointerEvent) => {
      const started = drag.current
      if (started === null) return
      setTreeWidth(Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, started.startWidth + moving.clientX - started.startX)))
    }
    const end = () => {
      drag.current = null
      document.removeEventListener("pointermove", move)
      document.removeEventListener("pointerup", end)
      document.removeEventListener("pointercancel", end)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }
    document.addEventListener("pointermove", move)
    document.addEventListener("pointerup", end)
    document.addEventListener("pointercancel", end)
  }
  const resizeBy = (delta: number) => setTreeWidth((width) => Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, width + delta)))
  const resizeKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); resizeBy(-16) }
    else if (event.key === "ArrowRight") { event.preventDefault(); resizeBy(16) }
  }

  /**
   * Flip one file's reviewed mark, and close a file that just became reviewed:
   * the reader said they were done reading it, so the card folds away and the
   * next one moves up, the way the shell's own view does it.
   */
  const markReviewed = useCallback((file: ChangeFile) => {
    const wasReviewed = isReviewed(reviewed, file)
    toggleReviewed(file)
    if (wasReviewed) return
    setExpanded((previous) => {
      const next = new Set(previous)
      next.delete(file.path)
      return next
    })
  }, [reviewed, toggleReviewed])

  const allChanged = list?.files ?? []
  const expandAll = useCallback(() => {
    setExpanded(new Set(allChanged.filter((file) => file.binary !== true && file.tooLarge !== true).map((file) => file.path)))
  }, [list])
  const collapseAll = useCallback(() => { setExpanded(new Set()) }, [])

  if (target === undefined) return <div className="dws-changes-notice" role="alert">{t("changesBadAddress")}</div>
  const files = list?.files ?? []
  const totals = list?.totals
  const reviewedCount = files.reduce((count, file) => count + (isReviewed(reviewed, file) ? 1 : 0), 0)
  const loadingCount = Object.values(contents).reduce((count, state) => count + (state.status === "loading" ? 1 : 0), 0)
  // What a line comment will name: this repository, the branch it is on, and the
  // base the view compares against. The repository is in the quote because one
  // worktree-space session sits above several checkouts.
  const address = tab.contentId
  const visibleComments = comments.filter((entry) => entry.address === address)
  const review: CommentContext = {
    comments: visibleComments,
    add: (entry, hunk, body) => {
      addReviewComment(sessionId, {
        id: newCommentId(),
        address,
        repoPath: list?.path ?? entry.path,
        base: list?.base ?? target.base,
        path: entry.path,
        side: entry.side,
        line: entry.line,
        hunk,
        body,
        createdAt: Date.now(),
      })
      flush()
    },
    edit: (id, body) => { updateReviewComment(sessionId, id, body); flush() },
    remove: (id) => { removeReviewComment(sessionId, id); flush() },
  }
  return (
    <div className="dws-changes-view">
      <header className="dws-changes-view-head">
        {/* The repository first, and in bold: one view per repository, and the tab's own
            chip says only "变更查看" - without this the two branches to its right name a
            comparison whose repository the reader has to infer from the file paths. */}
        <span className="dws-changes-repo" title={target.path}>{entryName(target.path)}</span>
        <span className="dws-changes-scope">{t("changesScopeBranch")}：</span>
        <span className="dws-changes-view-refs">
          <span className="dws-changes-current" title={list?.head}>{list?.branch ?? entryName(target.path)}</span>
          <span className="dws-changes-arrow" aria-hidden="true">→</span>
          <span className="dws-changes-base" title={list?.baseCommit ?? ""}>{list?.base ?? target.base ?? t("noRemoteBranch")}</span>
        </span>
        <span className="dws-changes-note">{t("changesIncludeUncommitted")}</span>
      </header>
      <div className="dws-changes-toolbar">
        <select
          className="dws-select dws-changes-jump"
          aria-label={t("changesJumpFile")}
          value=""
          onChange={(event) => { if (event.target.value !== "") reveal(event.target.value) }}
          disabled={files.length === 0}
        >
          <option value="">{format(t("changesAllFiles"), { count: String(files.length) })}</option>
          {files.map((file) => <option key={file.path} value={file.path}>{file.path}</option>)}
        </select>
        <span className="dws-changes-toolbar-spacer" />
        {loadingCount === 0 ? null : <span className="dws-changes-loading-badge" role="status">{format(t("changesLoadingProgress"), { count: String(loadingCount) })}</span>}
        <span className="dws-changes-reviewed-progress">{format(t("changesReviewedProgress"), { done: String(reviewedCount), total: String(files.length) })}</span>
        {totals === undefined ? null : <span className="dws-changes-totals"><span className="dws-line-add">+{totals.insertions}</span><span className="dws-line-del">−{totals.deletions}</span></span>}
        <span className="dws-changes-tools">
          <button type="button" className="dws-changes-tool is-text" aria-pressed={showTree} onClick={() => setShowTree((value) => !value)}>{t("changesFileTree")}</button>
          <button type="button" className="dws-changes-tool is-text" onClick={expandAll} disabled={files.length === 0}>{t("changesExpandAll")}</button>
          <button type="button" className="dws-changes-tool is-text" onClick={collapseAll} disabled={expanded.size === 0}>{t("changesCollapseAll")}</button>
          <button type="button" className="dws-changes-tool is-text" aria-pressed={wrap} onClick={() => setWrap((value) => !value)}>{t("changesWrap")}</button>
          <button type="button" className="dws-changes-tool" aria-label={t("changesRefresh")} title={t("changesRefresh")} onClick={() => setGeneration((value) => value + 1)} disabled={loading}>
            {loading ? <Loader2 size={14} className="dws-spin" /> : <RefreshCw size={14} />}
          </button>
        </span>
      </div>
      <div className={`dws-changes-body${showTree && files.length > 0 ? " has-tree" : ""}`}>
        {showTree && files.length > 0 ? <FileTree files={files} onPick={reveal} style={{ flexBasis: treeWidth, width: treeWidth }} /> : null}
        {showTree && files.length > 0 ? <div className="dws-change-splitter" role="separator" aria-orientation="vertical" aria-label={t("changesResizeTree")} tabIndex={0} onPointerDown={beginResize} onKeyDown={resizeKeys} onDoubleClick={() => setTreeWidth(TREE_WIDTH_DEFAULT)} /> : null}
        <div className="dws-changes-files">
          {error !== "" ? <p className="dws-changes-error" role="alert">{error}</p> : null}
          {loading && list === null ? <p className="dws-changes-loading" role="status"><Loader2 size={14} className="dws-spin" />{t("changesLoading")}</p> : null}
          {list !== null && files.length === 0 && error === "" ? <p className="dws-changes-empty">{t("changesClean")}</p> : null}
          {files.map((file) => (
            <ChangeFileCard
              key={file.path}
              file={file}
              expanded={expanded.has(file.path)}
              state={contents[file.path]}
              wrap={wrap}
              reviewed={isReviewed(reviewed, file)}
              stale={hasNewChanges(reviewed, file)}
              register={register}
              onToggle={toggle}
              onWiden={(file, context) => loadFile(file, context, true)}
              onReviewed={markReviewed}
              review={review}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

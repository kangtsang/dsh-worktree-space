/**
 * Syntax highlighting for the changes view, borrowed from the shell.
 *
 * DSH's own changed-files view highlights through `@deepseek-ai/dsh-client-ui-primitives`
 * — a shiki highlighter with a CSS-variables theme, so the colours follow the
 * light and dark themes without this plugin owning any of them. That package is
 * one of the browser's shared modules; it is optional here because the shared
 * table belongs to the shell, and a deployment without it must still draw the
 * diff as plain text rather than fail to load the plugin.
 *
 * A line is highlighted as one fragment per side of its hunk, so a token that
 * spans lines (a block comment, a template string) keeps its state exactly as
 * the shell's own view does. When the grammar is unknown or still loading, the
 * highlighter answers `undefined` and the row falls back to plain text.
 */
import type { CSSProperties } from "react"
import type { ChangeHunk } from "../../lib/types"

/** One run of characters sharing a token colour. */
export interface HighlightSpan {
  text: string
  style?: CSSProperties
}

/** One fragment turned into one token list per line, or `undefined` for plain text. */
export type CodeHighlighter = (code: string) => HighlightSpan[][] | undefined

/** The part of the shell's primitive face this plugin uses. */
interface PrimitivesHighlight {
  useCodeHighlighter(language: string | undefined): CodeHighlighter
  languageForPath(path: string): string | undefined
}

declare const require: ((specifier: string) => unknown) | undefined

/**
 * The shell's highlighter, when this deployment shares one.
 *
 * Resolved once, at module materialization: the module table is frozen before
 * any plugin runs, so the answer cannot change between renders, and a missing
 * module simply means every row is drawn as plain text.
 */
const primitives: PrimitivesHighlight | undefined = (() => {
  try {
    return typeof require === "function" ? require("@deepseek-ai/dsh-client-ui-primitives") as PrimitivesHighlight : undefined
  } catch {
    return undefined
  }
})()

const plain: CodeHighlighter = () => undefined
const upstreamHook = primitives?.useCodeHighlighter

/**
 * The grammar a path's extension selects, when the shell knows it.
 * @param path - the changed file's path.
 * @returns the language id, or undefined for plain text.
 */
export function languageOfPath(path: string): string | undefined {
  try {
    return primitives?.languageForPath(path)
  } catch {
    return undefined
  }
}

/**
 * Bind the shell's highlighter to one language.
 *
 * The upstream presence is fixed at materialization, so the hook order is the
 * same on every render of every tab.
 * @param language - the grammar hint from {@link languageOfPath}.
 * @returns a highlighter, or the plain-text fallback when the shell has none.
 */
export function useSourceHighlighter(language: string | undefined): CodeHighlighter {
  if (upstreamHook === undefined) return plain
  return upstreamHook(language)
}

/** Token lists for the two sides of one file, by line number. */
export interface HunkSpans {
  readonly old: ReadonlyMap<number, readonly HighlightSpan[]>
  readonly next: ReadonlyMap<number, readonly HighlightSpan[]>
}

/**
 * Highlight both sides of every hunk.
 *
 * A side is highlighted as one fragment rather than line by line: that is what
 * keeps a multi-line comment or string coloured across its lines. Lines the
 * hunk shows on both sides (the unchanged context) are highlighted twice, once
 * in each side's own run, which is cheap and keeps each map line-addressable.
 * @param hunks - the file's hunks, in order.
 * @param highlighter - the fragment highlighter; `undefined` answers leave the maps empty.
 * @returns the token lists of the old and the new side.
 */
export function spansForHunks(hunks: readonly ChangeHunk[], highlighter: CodeHighlighter): HunkSpans {
  const old = new Map<number, readonly HighlightSpan[]>()
  const next = new Map<number, readonly HighlightSpan[]>()
  for (const hunk of hunks) {
    const oldLines: { no: number; text: string }[] = []
    const newLines: { no: number; text: string }[] = []
    let oldNo = hunk.oldStart
    let newNo = hunk.newStart
    for (const line of hunk.lines) {
      if (line === "") continue
      const marker = line.charAt(0)
      const text = line.slice(1)
      if (marker === "-") {
        oldLines.push({ no: oldNo, text })
        oldNo += 1
        continue
      }
      if (marker === "+") {
        newLines.push({ no: newNo, text })
        newNo += 1
        continue
      }
      if (marker === " ") {
        oldLines.push({ no: oldNo, text })
        newLines.push({ no: newNo, text })
        oldNo += 1
        newNo += 1
      }
    }
    fill(old, oldLines, highlighter)
    fill(next, newLines, highlighter)
  }
  return { old, next }
}

/** Highlight one side's lines as one fragment and put each result back on its line. */
function fill(target: Map<number, readonly HighlightSpan[]>, lines: readonly { no: number; text: string }[], highlighter: CodeHighlighter): void {
  if (lines.length === 0) return
  const highlighted = highlighter(lines.map((line) => line.text).join("\n"))
  if (highlighted === undefined) return
  lines.forEach((line, index) => { target.set(line.no, highlighted[index] ?? []) })
}
/**
 * The file tree of one repository's change view.
 *
 * The tree is built from the paths alone, so a directory exists because a
 * changed file lives under it, and a folder nobody changed is not drawn. It is
 * a second way into the same list of file cards, not a second list: picking a
 * file scrolls its card into view.
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from "react"
import { useT } from "../../lib/i18n"
import type { ChangeFile } from "../../lib/types"
import { ChevronDown, ChevronRight } from "../icons"

interface Node {
  name: string
  path: string
  directories: Map<string, Node>
  files: ChangeFile[]
}

interface FileTreeProps {
  files: readonly ChangeFile[]
  onPick: (path: string) => void
  /** The width the splitter last gave the pane. */
  style?: CSSProperties
}

/**
 * Draw the tree, with a filter box and the file's own status letter.
 * @param props.files - the repository's changed files.
 * @param props.onPick - called with the path whose card should be shown.
 * @returns the tree.
 */
export function FileTree({ files, onPick, style }: FileTreeProps) {
  const t = useT()
  const [query, setQuery] = useState("")
  const [closed, setClosed] = useState<Set<string>>(() => new Set())
  const needle = query.trim().toLowerCase()
  const shown = useMemo(() => needle === "" ? files : files.filter((file) => file.path.toLowerCase().includes(needle)), [files, needle])
  const root = useMemo(() => buildTree(shown), [shown])
  const toggle = (path: string) => setClosed((previous) => {
    const next = new Set(previous)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })
  const draw = (node: Node, depth: number): ReactNode => {
    const children = [...node.directories.values()].sort((left, right) => left.name.localeCompare(right.name))
    return (
      <div key={node.path || "root"} className="dws-change-tree-branch">
        {node.files.map((file) => (
          <button key={file.path} type="button" className="dws-change-tree-file" style={{ paddingInlineStart: 8 + depth * 14 }} onClick={() => onPick(file.path)} title={file.path}>
            <span className={`dws-change-status dws-change-status-${file.status}`}>{statusLetter(file)}</span>
            <span className="dws-change-tree-name">{file.path.slice(file.path.lastIndexOf("/") + 1)}</span>
            {file.binary === true ? null : <span className="dws-change-tree-counts"><span className="dws-line-add">+{file.insertions}</span><span className="dws-line-del">−{file.deletions}</span></span>}
          </button>
        ))}
        {children.map((child) => {
          const open = !closed.has(child.path)
          return (
            <div key={child.path} className="dws-change-tree-dir">
              <button type="button" className="dws-change-tree-folder" style={{ paddingInlineStart: 4 + depth * 14 }} onClick={() => toggle(child.path)} aria-expanded={open}>
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span>{child.name}</span>
              </button>
              {open ? draw(child, depth + 1) : null}
            </div>
          )
        })}
      </div>
    )
  }
  return (
    <div className="dws-change-tree" style={style}>
      <input className="dws-input dws-change-tree-filter" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("changesFilterFiles")} aria-label={t("changesFilterFiles")} spellCheck={false} />
      {shown.length === 0 ? <p className="dws-change-tree-empty">{t("changesNoMatches")}</p> : draw(root, 0)}
    </div>
  )
}

function buildTree(files: readonly ChangeFile[]): Node {
  const root: Node = { name: "", path: "", directories: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.split("/")
    let node = root
    for (const part of parts.slice(0, -1)) {
      const path = node.path === "" ? part : `${node.path}/${part}`
      let next = node.directories.get(part)
      if (next === undefined) {
        next = { name: part, path, directories: new Map(), files: [] }
        node.directories.set(part, next)
      }
      node = next
    }
    node.files.push(file)
  }
  return root
}

/** The one letter a file's status wears in the tree. */
export function statusLetter(file: ChangeFile): string {
  // Git's own letters, with one addition the diff tools share: `U` marks a file
  // nobody has added to the index yet. Calling that one `A` would claim an
  // addition git has not recorded, and `?` is the status column's marker rather
  // than a letter a reader compares down a list. The header's own chip says the
  // same thing in words, so the letter stays short.
  if (file.status === "untracked" || file.untracked === true) return "U"
  if (file.status === "added") return "A"
  if (file.status === "deleted") return "D"
  if (file.status === "renamed") return "R"
  if (file.status === "copied") return "C"
  return "M"
}

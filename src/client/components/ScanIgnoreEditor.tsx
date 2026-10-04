import { useEffect, useMemo, useState } from "react"
import { Plus, Search, X } from "./icons"
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input } from "./ui"
import { format, useT } from "../lib/i18n"
import { MAX_IGNORED_SCAN_DIRECTORIES, forcedIgnoreNames } from "../lib/scan-ignore"

/**
 * The same names, with the repeats taken out.
 *
 * Case does not matter to the Host, which compares in lower case, so `Pods` and
 * `pods` are one entry however many times either is typed. A list that kept both
 * would render two tags that cannot be told apart and would match the same
 * directories; keeping the spelling that came first is what makes the tag the
 * user clicks the one they added.
 * @param names - the names as they were collected.
 * @returns each distinct name once, in the order first seen.
 */
function distinctNames(names: string[]): string[] {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const name of names) {
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(name)
  }
  return kept
}

/**
 * The question asked before a built-in name is taken off the list.
 *
 * Its own dialog rather than an expanded tag. The list is a wrapping grid of chips,
 * and a sentence plus two buttons inside one 28px chip breaks the run of them - at
 * this width the sentence wraps to three lines in a row that grew to hold it. A
 * second modal over the first is the ordinary arrangement: each is its own portal,
 * and the one underneath is marked inert, so nothing behind is reachable either way.
 *
 * It names the directory, and it hands the name back when confirmed rather than
 * closing over it. The caller's `confirming` is state typed `string | null`, which
 * the compiler will not let a handler close over after narrowing it in JSX - and
 * the honest way past that is for the dialog to pass the name it was asked about,
 * not to assert a cast on a value that might have changed in between.
 */
function RemoveConfirmDialog({ name, busy, onConfirm, onCancel }: {
  name: string
  busy: boolean
  onConfirm: (name: string) => void
  onCancel: () => void
}) {
  const t = useT()
  return <Dialog open onOpenChange={(open) => { if (!open) onCancel() }}>
    <DialogContent className="dws-confirm-dialog dws-confirm-narrow" busy={busy} showClose={false}>
      {/* No heading at all. The question is one sentence, and a 16px title above it
          read as two things to read rather than one - the sentence was doing the work
          the heading was taking credit for. It is the body now. */}
      <div className="dws-dialog-body">
        <DialogDescription className="dws-confirm-body">{format(t("ignoredScanDirectoriesConfirmRemove"), { name })}</DialogDescription>
      </div>
      <footer className="dws-dialog-footer">
        <Button disabled={busy} onClick={onCancel}>{t("cancel")}</Button>
        <Button className="dws-button-primary" disabled={busy} onClick={() => onConfirm(name)}>{t("configConfirm")}</Button>
      </footer>
    </DialogContent>
  </Dialog>
}

/**
 * The directory names a scan walks past, edited as one list.
 *
 * The names the Host ships and the names a user has added are the same kind of
 * thing and are drawn the same way, because to the person reading this they are:
 * a directory the scan walks into is a directory the scan walks into. Drawing the
 * built-ins differently - dimmed, or in a section of their own - would say the
 * two were not interchangeable when the only thing that makes them different is
 * that one of them needs a question asked before it is taken away.
 *
 * That question is the whole of the difference, and it is asked in the row rather
 * than in a dialog on top of this one. Switching `node_modules` back on costs
 * nothing here and everything on the next scan: a scan that walks a dependency
 * tree stops, or stops being fast. Twenty-odd bare crosses is exactly the shape
 * that gets clicked through, so a built-in one is worth a sentence first. A name
 * the user added is gone in one click, because undoing it is typing it again.
 *
 * Nothing is sent until Save. The Host holds one setting, and a dialog that wrote
 * on every keystroke would make a half-typed name a change to the running scan -
 * and make Cancel mean nothing at all.
 */
export interface ScanIgnoreEditorProps {
  /** The names the Host ships, which are in the list but take a question first. */
  builtIn: string[]
  /** The names the configuration adds on top of those. */
  configured: string[]
  /** The built-in names the configuration has already switched back on. */
  disabled?: string[]
  /** Whether a write is in flight, which closes the buttons that would race it. */
  busy?: boolean
  /** Save: the names to add, and the built-in names to stop skipping. */
  onSave: (added: string[], removed: string[]) => void
  /** Close without saving. */
  onClose: () => void
}

export function ScanIgnoreEditor({ builtIn, configured, disabled = [], busy = false, onSave, onClose }: ScanIgnoreEditorProps) {
  const t = useT()
  // The working copy: every name in force, built-in and added alike. Which of the
  // two a name is decides only whether taking it away asks first.
  const [present, setPresent] = useState<string[]>(() => forcedIgnoreNames(builtIn, configured, disabled))
  const [query, setQuery] = useState("")
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState("")
  // The banner is shown because the user asked to add and could not, not because
  // it is true at this instant: a list that is at the cap on open has not been
  // refused anything yet, and telling someone they hit a limit they did not reach
  // is the same mistake as a control that does nothing without a reason.
  const [full, setFull] = useState(false)
  // The one name waiting to be confirmed. One, not a set: a dialog that asked
  // about three at once would be asking about a bulk edit, and this is a decision
  // meant to be taken one name at a time.
  // An empty string rather than null, and the reason is the type: a
  // `string | null` binding narrowed by a conditional in JSX does not stay narrowed
  // in the prop positions and closures below, so every use would need a cast. A
  // non-nullable `string` needs no narrowing at all - `=== ""` reads as "nothing is
  // being asked" and the alternative branch is already `string`.
  const [confirming, setConfirming] = useState("")

  // Reopening must show what the Host serves, not what the last dialog left behind.
//
// Keyed on the names rather than on the three arrays, because the caller hands
// over `list(field)` and `list(removedField)` - both built fresh on every render.
// An effect keyed on that identity runs after every render; storing the result in
// state re-renders; the next render builds two more arrays; the effect runs again.
// That is a loop, and it hangs the Plugins page rather than merely refreshing it.
const servedKey = `${builtIn.join("\u0001")}\u0002${configured.join("\u0001")}\u0002${disabled.join("\u0001")}`
const served = useMemo(() => forcedIgnoreNames(builtIn, configured, disabled), [servedKey])
useEffect(() => {
  setPresent(served)
  setConfirming("")
}, [served])

  const shipped = useMemo(() => new Set(builtIn.map((name) => name.toLowerCase())), [builtIn])
  // The ceiling is on the names the user brings, which is where a runaway comes
  // from. Switching a built-in off makes room rather than adding to it, so a list
  // at the cap can still be edited down.
  const addedCount = useMemo(() => present.filter((name) => !shipped.has(name.toLowerCase())).length, [present, shipped])
  const atLimit = addedCount >= MAX_IGNORED_SCAN_DIRECTORIES
  // One list, one order, and the order is the reader's rather than the
  // implementation's: `builtIn` keeps whatever order it was declared in and a
  // user's additions land at the end, which is not an order anyone looks up
  // anything in.
  //
  // `Intl.Collator` is the scheme, rather than a hand-rolled comparator, because
  // the names are not one alphabet: the defaults are English (`node_modules`,
  // `deriveddatacache`) and a user's own are whatever their project is called,
  // which on a Chinese machine is 中文. A comparator written by hand would sort
  // Chinese by code point and put it after every Latin name and before every
  // number. The collator asks the platform, and `numeric` makes `2` sort before
  // `10` instead of after it.
  //
  // Defaults and additions are sorted together and told apart by how they are
  // drawn, not by where they sit. A list in two alphabets is harder to scan, and
  // the whole point of the order is to make it easy to find the one name.
  const collator = useMemo(() => new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }), [])
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return present
      .filter((name) => needle === "" || name.toLowerCase().includes(needle))
      .sort((left, right) => collator.compare(left, right))
  }, [present, query, collator])
  const take = (name: string) => {
    setPresent((current) => current.filter((entry) => entry.toLowerCase() !== name.toLowerCase()))
    // Taking one off is the way out of the banner, so the banner goes with it. Left
    // standing it would keep warning about a list that now has room, and a
    // persistent warning is a warning the reader learns to skip.
    setFull(false)
  }
  const submit = () => {
    const name = draft.trim().replace(/^[/\\]+|[/\\]+$/g, "")
    // A directory name is a single path component, so a slash in it is a mistake
    // rather than a nested path the walk would never match anyway.
    if (name === "" || /[/\\]/.test(name)) return
    const held = present.some((entry) => entry.toLowerCase() === name.toLowerCase())
    // Adding what is already there is not a mistake to report and not a second
    // entry to store: either way the answer is the list as it stands, so this
    // finishes and the outcome is the same one. That includes a built-in name that
    // was taken off a moment ago - putting it back is one click on it, not a
    // thing the add box has to know about.
    if (!held && addedCount < MAX_IGNORED_SCAN_DIRECTORIES) setPresent((current) => [...current, name])
    setDraft("")
    setAdding(false)
    setQuery("")
  }
  // A fragment, and not a wrapper element. The second root is the question about a
  // built-in name, which is a dialog of its own rather than a panel inside this one:
  // the tag row is a wrapping grid of chips, and a sentence plus two buttons inside
  // a 28px chip breaks the run of them.
  //
  // Written without one, this was a bug that cost a day to find and no test failure
  // to point at. `return <Dialog>...</Dialog>` followed by a `{...}` on the next line
  // is not two roots - JSX ends at the closing tag, so the braces are parsed as a
  // block statement, the element inside them is built and then thrown away, and
  // `tsc` is perfectly happy because nothing is malformed. `confirming` was being
  // set, the state really was changing, and the dialog never appeared. The tests
  // were right and the type checker had nothing to say.
  return <>
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
    <DialogContent className="dws-ignore-dialog" busy={busy}>
      <header className="dws-dialog-heading">
        <DialogTitle className="dws-dialog-title">{t("ignoredScanDirectoriesTitle")}</DialogTitle>
        <DialogDescription className="dws-form-note">{t("ignoredScanDirectoriesDialogHint")}</DialogDescription>
      </header>

      <div className="dws-dialog-body">
      <div className="dws-toolbar">
        <label className="dws-search"><Search size={16} aria-hidden="true" />
          <Input aria-label={t("ignoredScanDirectoriesSearch")} placeholder={t("ignoredScanDirectoriesSearch")} value={query} onChange={(event) => setQuery(event.target.value)} />
          {query ? <Button className="dws-icon-button" aria-label={t("clearFilters")} onClick={() => setQuery("")}><X size={14} /></Button> : null}
        </label>
        {adding
          ? <div className="dws-add-source-row">
            <Input aria-label={t("ignoredScanDirectoriesAdd")} placeholder={t("ignoredScanDirectoriesAddPlaceholder")} value={draft} autoFocus autoComplete="off" spellCheck={false}
              onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submit() } }} />
            <Button className="dws-button-primary" disabled={draft.trim() === "" || /[/\\]/.test(draft.trim())} onClick={submit}>{t("ignoredScanDirectoriesAddConfirm")}</Button>
            <Button className="dws-icon-button" aria-label={t("cancel")} onClick={() => { setAdding(false); setDraft("") }}><X size={14} /></Button>
          </div>
          : <Button className="dws-button dws-add-source-button" disabled={busy}
            onClick={() => {
              // Left enabled on purpose. Disabling it would answer the click with
              // silence, and "nothing happened" is the one reply that leaves a user
              // with nothing to act on. The row does not open, the banner says why,
              // and the way out is named in the same breath.
              if (atLimit) {
                setFull(true)
                return
              }
              setFull(false)
              setAdding(true)
            }}>
            <Plus size={14} />{t("ignoredScanDirectoriesAdd")}
          </Button>}
        {full ? <p className="dws-error" role="alert">{format(t("ignoredScanDirectoriesFull"), { count: String(MAX_IGNORED_SCAN_DIRECTORIES) })}</p> : null}
      </div>

      {shown.length > 0
        ? <div className="dws-ignore-tags" data-ignore-list="names" role="list">
          {shown.map((name) => <span className={shipped.has(name.toLowerCase()) ? "dws-ignore-tag dws-ignore-tag-shipped" : "dws-ignore-tag"} role="listitem" key={name}>
            <span className="dws-ignore-name">{name}</span>
            <Button className="dws-icon-button" aria-label={format(t("ignoredScanDirectoriesRemove"), { name })} disabled={busy}
              onClick={() => { if (shipped.has(name.toLowerCase())) setConfirming(name); else take(name) }}>
              <X size={12} />
            </Button>
          </span>)}
        </div>
        : <p className="dws-empty">{query.trim() === "" ? t("ignoredScanDirectoriesNone") : t("ignoredScanDirectoriesNoMatch")}</p>}
      </div>

      <footer className="dws-dialog-footer">
        <Button disabled={busy} onClick={onClose}>{t("cancel")}</Button>
        <Button className="dws-button-primary" disabled={busy}
          onClick={() => {
            // The list is the answer; the two settings are a compact way of writing
            // it down. Read back out of the list rather than carried alongside,
            // because carried alongside the two can drift - a name in both, or in
            // neither - and a name in neither means the Host falls back to skipping
            // a directory this list is showing as walkable.
            //
            // That case is real and easy to reach: take `target` off, then type it
            // back into the add box. It is on the list, and it is a built-in name,
            // so neither rule on its own would have claimed it. Hence the second
            // clause - a built-in name that had been switched off and is back on the
            // list is written down as an addition, which is the only way to say
            // "skip it again" without rewriting the whole list to say it.
            const held = new Set(present.map((name) => name.toLowerCase()))
            const removed = distinctNames(builtIn).filter((name) => !held.has(name.toLowerCase()))
            const wasOff = new Set(removed.map((name) => name.toLowerCase()))
            onSave(distinctNames(present).filter((name) => !shipped.has(name.toLowerCase()) || wasOff.has(name.toLowerCase())), removed)
          }}>
          {busy ? t("configSaving") : t("configSave")}
        </Button>
      </footer>
    </DialogContent>
  </Dialog>
    {confirming === "" ? null : <RemoveConfirmDialog name={confirming} busy={busy}
      onCancel={() => setConfirming("")}
      onConfirm={(name) => { take(name); setConfirming("") }} />}
  </>
}

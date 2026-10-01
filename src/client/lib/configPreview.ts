/**
 * Configuration choices that are on their way to the Host.
 *
 * A write takes a round trip, and until it lands the served section still carries
 * the old value. Both halves of this plugin read this store, so a choice shows in
 * the configuration card and in the sidebar at the same moment, and the entry it
 * governs appears or disappears with the click rather than a second later.
 *
 * A value is cleared once the Host agrees with it, or when the write is refused,
 * so nothing here can outlive the truth for long.
 */

type Values = Record<string, string>

let pending: Values = {}
const listeners = new Set<() => void>()

const notify = () => {
  for (const listener of listeners) listener()
}

/** The value chosen for a field but not yet served, if there is one. */
export function previewValue(field: string): string | undefined {
  return pending[field]
}

/** Remember a choice until the Host catches up. */
export function setPreview(field: string, value: string | undefined): void {
  if (value === undefined) {
    if (!(field in pending)) return
    const { [field]: _dropped, ...rest } = pending
    pending = rest
  } else {
    if (pending[field] === value) return
    pending = { ...pending, [field]: value }
  }
  notify()
}

/** Drop choices the served section now agrees with. */
export function settlePreview(served: Values): void {
  const kept: Values = {}
  for (const [field, value] of Object.entries(pending)) if (served[field] !== value) kept[field] = value
  if (Object.keys(kept).length === Object.keys(pending).length) return
  pending = kept
  notify()
}

/** Observe pending changes. */
export function subscribePreview(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

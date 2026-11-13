/**
 * Where the plugin's way in sits, in one answer.
 *
 * The configuration used to ask this as two independent switches - a row in the
 * sidebar's panel list, and a shortcut in its footer - which described two facts but
 * offered four arrangements, one of which (neither) left the plugin reachable only
 * from the workspace menu and the composer. It is one choice of three now: the panel
 * row, the footer shortcut, or one icon beside the settings row.
 *
 * The two old switches are still in the Host's schema and still read, so a
 * configuration written before this row existed keeps the entry it had. They are read
 * only while the new field is empty: the moment one of the three is chosen, that is
 * the answer and the old pair stops mattering.
 */

/** The Host field that holds the choice. */
export const ENTRY_STYLE_FIELD = "entryStyle"

/** The three entries this plugin can put in the sidebar. */
export type EntryStyle = "standard" | "quick" | "compact"

/**
 * What a configuration that has never been asked this serves.
 *
 * Quick rather than standard, and that is the migration: the shipped arrangement was
 * the footer shortcut with the panel row hidden, so every configuration in existence
 * derives to this and nothing moves under the user's feet.
 */
export const ENTRY_STYLE_FALLBACK: EntryStyle = "quick"

/** Whether a served value is one of the three. */
export function isEntryStyle(value: unknown): value is EntryStyle {
  return value === "standard" || value === "quick" || value === "compact"
}

/** The two switches this replaced, as the Host still serves them. */
export interface LegacyEntrySwitches {
  panelEntry?: string
  sidebarEntry?: string
}

/**
 * The entry the configuration asks for.
 *
 * A value chosen here wins outright. Otherwise the answer is derived from the two
 * switches, ordered by which entry the configuration was actually being used through.
 *
 * The footer shortcut comes first because it was the shipped default: a configuration
 * that still has it switched on belongs to someone who has been clicking it. That
 * includes the ones with BOTH switches on - the arrangement the old pair could express
 * and the new one cannot - and there the shortcut is the entry to keep. The panel row
 * was an addition beside the footer, never a replacement for it, so losing the row costs
 * a second way in while losing the shortcut costs the one in use.
 *
 * The panel row is therefore what a configuration gets when the footer was switched off
 * and the row left on: the only arrangement where the row was the sole way in.
 *
 * @param served - the field, plus the two legacy switches, as the Host serves them.
 * @returns the entry to register, never undefined.
 */
export function entryStyleOf(served: ({ entryStyle?: string } & LegacyEntrySwitches) | undefined): EntryStyle {
  if (served !== undefined && isEntryStyle(served.entryStyle)) return served.entryStyle
  if (served?.sidebarEntry !== "hide") return ENTRY_STYLE_FALLBACK
  return served?.panelEntry === "show" ? "standard" : ENTRY_STYLE_FALLBACK
}

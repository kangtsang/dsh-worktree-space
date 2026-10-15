// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { installLocale, t, useT } from "../src/client/lib/i18n"

function createLocale() {
  let snapshot = { active: "zh", revision: 0 }
  let dictionaries: Record<string, Record<string, string>> = {}
  const listeners = new Set<() => void>()
  const locale = {
    register(_namespace: string, next: Record<string, Record<string, string>>) {
      dictionaries = next
      return () => { dictionaries = {} }
    },
    bind(_namespace: string) {
      return (key: string) => dictionaries[snapshot.active]?.[key] ?? dictionaries.en?.[key] ?? key
    },
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setActive(active: string) {
      snapshot = { active, revision: snapshot.revision + 1 }
      listeners.forEach((listener) => listener())
    },
  }
  return locale
}

function CopyProbe() {
  const t = useT()
  return <><span>{t("taskName")}</span><span>{t("basedOn")}</span></>
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("i18n", () => {
  it("updates rendered copy when DSH changes the active locale", async () => {
    const locale = createLocale()
    const dispose = installLocale({ get: () => locale })
    render(<CopyProbe />)

    expect(screen.getByText(t("taskName"))).toBeTruthy()
    expect(screen.getByText(t("basedOn"))).toBeTruthy()

    act(() => locale.setActive("en"))
    await waitFor(() => expect(screen.getByText("Task name")).toBeTruthy())
    expect(screen.getByText("Branch from")).toBeTruthy()
    dispose()
  })
})

/**
 * The two dictionaries, taken from the locale service the plugin registers them with.
 *
 * They are module-private on purpose - the panel reaches them only through the Host's
 * locale service - so a test that wants to see both languages has to go through the
 * same door. `bind` is not used here: what this file checks is the dictionaries
 * themselves, before any language is chosen.
 */
function registeredDictionaries() {
  const registered: Record<string, Record<string, string>> = {}
  const dispose = installLocale({
    get: () => ({
      register: (_ns: string, dicts: Record<string, Record<string, string>>) => { Object.assign(registered, dicts); return () => {} },
      bind: () => (key: string) => registered.zh?.[key] ?? key,
    }),
  })
  return { dictionaries: registered, dispose }
}

/** The placeholders a template fills, as a set: `{count}` in one language and none in
 *  the other is the same class of bug as a missing key, and renders as a literal. */
const placeholders = (value: string) => new Set([...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))

/**
 * The two dictionaries are key-for-key aligned.
 *
 * Nothing in the type system enforces this: both are `Record<string, string>`, so a key
 * added to one language and forgotten in the other type-checks, and the interface in
 * that language renders the bare key - which is exactly the `deployOpen` bug this
 * change fixes, reintroduced by the fix. It is checked here rather than left to care
 * because the failure is silent in every other way: `pnpm test` stays green and one
 * language shows `someKey` where a sentence belongs.
 */
describe("the two dictionaries", () => {
  it("carry the same keys, and fail loudly naming the ones that drifted", () => {
    const { dictionaries, dispose } = registeredDictionaries()
    try {
      expect(dictionaries.zh, "the Chinese dictionary was not registered").toBeDefined()
      expect(dictionaries.en, "the English dictionary was not registered").toBeDefined()

      const zhKeys = Object.keys(dictionaries.zh).sort()
      const enKeys = Object.keys(dictionaries.en).sort()
      // `Object.prototype.hasOwnProperty.call` rather than `Object.hasOwn`: the latter
      // is ES2022 and this project's `lib` target predates it, so the check would not
      // compile. It is the same question asked with an older spelling.
      const owns = (source: Record<string, string>, key: string) => Object.prototype.hasOwnProperty.call(source, key)
      // Named rather than counted: "352 vs 351" sends the next person to diff two
      // dictionaries by hand, and the key itself is the whole of the answer.
      const missingFromEn = zhKeys.filter((key) => !owns(dictionaries.en, key))
      const missingFromZh = enKeys.filter((key) => !owns(dictionaries.zh, key))
      expect(missingFromEn, `in zh but not en: ${missingFromEn.join(", ")}`).toEqual([])
      expect(missingFromZh, `in en but not zh: ${missingFromZh.join(", ")}`).toEqual([])
      expect(zhKeys.length).toBeGreaterThan(0)
    } finally {
      dispose()
    }
  })

  it("use the same placeholders in both languages, key by key", () => {
    // A key present in both but built from `{count}` in one language and nothing in the
    // other is the same defect one level down: the sentence renders with a literal
    // `{count}` in it, which reads as a broken sentence rather than as a missing test.
    const { dictionaries, dispose } = registeredDictionaries()
    try {
      const mismatched: string[] = []
      for (const [key, zhValue] of Object.entries(dictionaries.zh)) {
        const enValue = dictionaries.en[key]
        if (enValue === undefined) continue
        const zhPlaceholders = [...placeholders(zhValue)].sort()
        const enPlaceholders = [...placeholders(enValue)].sort()
        if (zhPlaceholders.join(",") !== enPlaceholders.join(",")) {
          mismatched.push(`${key}: zh {${zhPlaceholders.join(",")}} vs en {${enPlaceholders.join(",")}}`)
        }
      }
      expect(mismatched, `placeholders differ: ${mismatched.join("; ")}`).toEqual([])
    } finally {
      dispose()
    }
  })
})

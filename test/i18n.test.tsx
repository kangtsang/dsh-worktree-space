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

import { describe, expect, it } from "vitest"
import { forcedIgnoreNames, sameIgnoreNames } from "../src/client/lib/scan-ignore"

/**
 * Why this file exists.
 *
 * `forcedIgnoreNames` answers with a fresh array on every call. That is fine until
 * an effect stores the answer in state after every render: the new reference is
 * never equal to the old one, so the state is always "changed", so it always
 * re-renders, so the effect always runs again. The Plugins page stops responding
 * and the worker climbs past a gigabyte of heap.
 *
 * `sameIgnoreNames` is what stops that, by letting the effect hold on to the
 * array it already has when nothing actually changed. These cases pin the
 * comparison it is allowed to make - content only, never identity.
 */
describe("comparing two answers from the ignore-name list", () => {
  it("calls two equal lists the same even though they are different arrays", () => {
    const names = ["node_modules", "dist"]
    expect(forcedIgnoreNames(names, [], [])).not.toBe(forcedIgnoreNames(names, [], []))
    expect(sameIgnoreNames(forcedIgnoreNames(names, [], []), forcedIgnoreNames(names, [], []))).toBe(true)
  })

  it("calls a changed list a different one", () => {
    expect(sameIgnoreNames(["dist", "node_modules"], ["node_modules", "dist"])).toBe(false)
    expect(sameIgnoreNames(["dist"], ["dist", "node_modules"])).toBe(false)
    expect(sameIgnoreNames(["dist"], [])).toBe(false)
  })

  it("compares order, because the order is the answer", () => {
    // forcedIgnoreNames documents that swapping its two lines would make the same
    // configuration mean two different things, so an order-blind comparison here
    // would let that same difference through as "unchanged".
    expect(sameIgnoreNames(["node_modules", "dist"], ["dist", "node_modules"])).toBe(false)
  })

  it("calls two empty lists the same", () => {
    expect(sameIgnoreNames([], [])).toBe(true)
  })
})
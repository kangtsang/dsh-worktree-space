import { describe, expect, it } from "vitest"
import { mapWithLimit } from "../src/host/task/concurrency.js"

describe("mapWithLimit", () => {
  it("keeps the results in the order of the items, not the order they finished", async () => {
    // A slower first item must not move to the back of the list: the panel paints
    // rows where the scan put them, and a list that reshuffles on every refresh
    // reads as the repositories moving.
    const results = await mapWithLimit([40, 5, 20, 1, 30], 5, async (delay) => {
      await new Promise((resolve) => setTimeout(resolve, delay))
      return delay
    })
    expect(results).toEqual([40, 5, 20, 1, 30])
  })

  it("never has more than the limit in flight", async () => {
    let active = 0
    let peak = 0
    await mapWithLimit(Array.from({ length: 40 }, (_, index) => index), 6, async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active--
      return null
    })
    expect(peak).toBe(6)
  })

  it("runs every item exactly once, whatever the limit", async () => {
    const seen = new Set()
    await mapWithLimit(Array.from({ length: 50 }, (_, index) => index), 7, async (item) => {      seen.add(item)
      return null
    })
    expect(seen.size).toBe(50)
  })

  it("treats a limit below one as one, rather than running nothing", async () => {
    const results = await mapWithLimit([1, 2, 3], 0, async (item) => item * 2)
    expect(results).toEqual([2, 4, 6])
  })

  it("answers an empty list without starting anything", async () => {
    let started = 0
    const results = await mapWithLimit([], 4, async () => { started++; return null })
    expect(results).toEqual([])
    expect(started).toBe(0)
  })

  it("propagates a failure rather than reporting a half-filled answer", async () => {
    // Nothing here catches. A scan swallows a repository that vanished mid-walk in
    // the worker it was given; the pool is not where that decision belongs, and a
    // pool that returned undefined in the gap would hand back an answer missing
    // entries with nothing to say which.
    await expect(mapWithLimit([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error("gone")
      return item
    })).rejects.toThrow("gone")
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mapWithLimit } from "../src/host/task/concurrency.js"

// No test here may sleep. `mapWithLimit` is a ceiling on work in flight, and the
// only way to observe that ceiling is to hold several workers at a point at once -
// which a real `setTimeout` does not guarantee. On a single-core runner or a busy
// one the sleeps finish in whatever order the scheduler allows, so "peak === 6"
// could read 5 and fail over nothing, and the order assertion could pass while
// proving nothing about order. A virtual clock makes both deterministic: the
// workers start together, the test decides which ones finish, and in what order.
//
// Timers are installed per test rather than in a `beforeAll`, so a test that does
// not advance the clock cannot leak pending virtual timers into the next one.
beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * Let the queued microtask chains run.
 *
 * A worker released by the clock continues in promise callbacks rather than timers,
 * and `advanceTimersByTimeAsync` stops at the timer callbacks. Awaiting a resolved
 * promise drains one turn of that queue, and each release hands off through several
 * turns - the worker returning, the pool taking the next item, the worker parking
 * again - so eight turns per advance is what it takes to reach the state the next
 * assertion reads. The count is a bound, not a subtlety: too few turns leaves a
 * worker counted as in flight after it has returned.
 * @returns a promise that settles after the queue has drained those turns.
 */
async function flushMicrotasks() {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve()
}

/**
 * Whether `promise` has settled, without waiting on it.
 *
 * The step loop below has to ask "is the pool done yet" between advances, and
 * `await promise` would instead wait for a timer this test has not fired yet.
 * @param promise - the promise to look at, not to wait for.
 * @returns a promise for whether it has already settled.
 */
async function settled(promise) {
  let answered = false
  promise.then(() => { answered = true }, () => { answered = true })
  await flushMicrotasks()
  return answered
}

describe("mapWithLimit", () => {
  it("keeps the results in the order of the items, not the order they finished", async () => {
    // A slower first item must not move to the back of the list: the panel paints
    // rows where the scan put them, and a list that reshuffles on every refresh
    // reads as the repositories moving.
    const finished = []
    const running = mapWithLimit([40, 5, 20, 1, 30], 5, async (delay) => {
      await new Promise((resolve) => setTimeout(resolve, delay))
      finished.push(delay)
      return delay
    })

    // The clock is advanced a millisecond at a time up to the longest delay, so every
    // worker is released at its own moment - 1, 5, 20, 30, 40 - which is the opposite
    // of their input order. That inversion is the point: completion order and input
    // order are different orders here, so a pool that collected as it went could not
    // match. One millisecond steps rather than one advance the size of the whole
    // delay: a worker whose timer is created while the clock is being advanced is
    // only reachable by an advance after that.
    for (let elapsed = 0; elapsed < 40; elapsed++) await vi.advanceTimersByTimeAsync(1)

    expect(await running).toEqual([40, 5, 20, 1, 30])
    expect(finished).toEqual([1, 5, 20, 30, 40])
  })

  it("never has more than the limit in flight", async () => {
    let active = 0
    let peak = 0
    const samples = []
    // Every worker parks on the virtual clock, so "in flight" is a fact the test
    // controls rather than a race between the pool and the scheduler. Under the
    // real clock the six could take their slots at six different moments and a
    // momentary five in flight was enough to fail an assertion about the ceiling.
    const running = mapWithLimit(Array.from({ length: 40 }, (_, index) => index), 6, async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active--
      return null
    })

    // A millisecond at a time: each advance releases the six workers parked on the
    // clock, and the pool takes the next six. Nobody new joins while all six are
    // parked, so a sampling of the count is a reading of what the pool allowed at once.
    //
    // `advanceTimersByTimeAsync` runs the callbacks of the timers it fires; the promise
    // chain that follows each callback is microtasks, and `flushMicrotasks` above is
    // what drains those. Without it a worker released by an advance has not yet taken
    // the next item, so the count sampled here would read one round behind. The loop has
    // to keep advancing until the pool settles, too: forty items take seven rounds, and
    // `await running` after fewer of them waits for timers nobody will fire.
    let done = false
    for (let step = 0; step < 40 && !done; step++) {
      await vi.advanceTimersByTimeAsync(1)
      await flushMicrotasks()
      if (samples.length < 4) samples.push(active)
      done = await settled(running)
    }

    expect(done).toBe(true)
    // Filled to six and never past it - the two halves of one claim. A pool that
    // ignored the limit would take more than six; one that serialised everything would
    // never reach six at all, which is why `samples` has to contain a six rather than
    // merely stay under it.
    expect(peak).toBe(6)
    expect(samples.every((count) => count <= 6)).toBe(true)
    expect(samples).toContain(6)
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

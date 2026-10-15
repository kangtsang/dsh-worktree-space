import { afterEach, describe, expect, it } from "vitest"
import { clearTaskLocks, withTaskLock } from "../src/host/task/task-lock.js"

afterEach(() => clearTaskLocks())

/** A promise that resolves when the test says so. */
function deferred() {
  let settle
  const promise = new Promise((resolve) => { settle = resolve })
  return { promise, settle }
}

/**
 * Let every already-queued microtask run.
 *
 * A locked body is chained off the previous link rather than called straight away, so
 * "has it started yet" is a question about the microtask queue and not about this call.
 * Awaiting a resolved promise drains that queue, which makes the assertions below about
 * ordering rather than about how many ticks the runtime happened to need.
 */
const tick = () => Promise.resolve()

describe("withTaskLock", () => {
  it("never lets two calls for one task space interleave", async () => {
    // The defect this exists for: two finishes each read the directory, each merge,
    // each delete. The assertion is on the order of the marks rather than on a final
    // value, because interleaving is exactly what a final value cannot show - both
    // orders end with the same writes made.
    const log = []
    const first = deferred()
    const a = withTaskLock("E:/spaces/proj/login", async () => {
      log.push("a:enter")
      await first.promise
      log.push("a:exit")
      return "a"
    })
    // Started while `a` holds the lock. Its body must not run until `a` has finished,
    // so the marks read enter/exit/enter/exit rather than enter/enter/exit/exit.
    const b = withTaskLock("E:/spaces/proj/login", async () => {
      log.push("b:enter")
      log.push("b:exit")
      return "b"
    })
    // `a` has started and `b` is queued behind it, so the marks read enter/exit/enter/exit
    // rather than enter/enter/exit/exit. `b`'s body must not have run: it is waiting on
    // `a`, which is waiting on the test.
    await tick()
    expect(log).toEqual(["a:enter"])
    first.settle()
    await expect(Promise.all([a, b])).resolves.toEqual(["a", "b"])
    expect(log).toEqual(["a:enter", "a:exit", "b:enter", "b:exit"])
  })

  it("runs calls for different task spaces at the same time", async () => {
    // Two tasks finishing at once is the parallel case this plugin exists for, so the
    // lock is per task space and not a global one.
    const held = deferred()
    const log = []
    const first = withTaskLock("E:/spaces/proj/login", async () => {
      log.push("login:enter")
      await held.promise
      log.push("login:exit")
    })
    const other = withTaskLock("E:/spaces/proj/logout", async () => {
      log.push("logout:enter")
      log.push("logout:exit")
    })
    await expect(other).resolves.toBeUndefined()
    // The second space's call ran to completion while the first was still holding.
    expect(log).toEqual(["login:enter", "logout:enter", "logout:exit"])
    held.settle()
    await first
  })

  it("releases the lock when the body throws", async () => {
    // A failed finish must not wedge the task space: the next call runs rather than
    // waiting on a rejection that already happened.
    await expect(withTaskLock("E:/spaces/proj/login", async () => { throw new Error("finish failed") }))
      .rejects.toThrow("finish failed")
    await expect(withTaskLock("E:/spaces/proj/login", async () => "ran")).resolves.toBe("ran")
  })

  it("keeps the queue moving after one caller fails", async () => {
    // The failure belongs to the caller that caused it. A queued call behind it still
    // runs, and gets its own answer - the chain is resolved by the release rather than
    // by the body's outcome, which is what stops one rejection from poisoning it.
    const first = withTaskLock("E:/spaces/proj/login", async () => { throw new Error("boom") })
    const second = withTaskLock("E:/spaces/proj/login", async () => "second")
    const third = withTaskLock("E:/spaces/proj/login", async () => "third")
    await expect(first).rejects.toThrow("boom")
    await expect(second).resolves.toBe("second")
    await expect(third).resolves.toBe("third")
  })

  it("serialises two spellings of one task space", async () => {
    // The key is the canonical path, so a trailing separator or the other separator
    // style does not buy a second, parallel chain for the same directory.
    const log = []
    const held = deferred()
    const first = withTaskLock("E:/spaces/proj/login", async () => {
      log.push("first:enter")
      await held.promise
      log.push("first:exit")
    })
    const second = withTaskLock("E:\\spaces\\proj\\login\\", async () => {
      log.push("second:enter")
      log.push("second:exit")
    })
    await tick()
    expect(log).toEqual(["first:enter"])
    held.settle()
    await Promise.all([first, second])
    expect(log).toEqual(["first:enter", "first:exit", "second:enter", "second:exit"])
  })
})

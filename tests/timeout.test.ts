import { describe, expect, it } from "vitest"
import { withTimeout } from "../src/timeout.js"

describe("withTimeout", () => {
  it("rejects immediately when the parent operation is cancelled", async () => {
    const controller = new AbortController()
    controller.abort(new DOMException("cancelled", "AbortError"))
    let called = false

    await expect(
      withTimeout(
        10_000,
        () => {
          called = true
          return new Promise<never>(() => undefined)
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(called).toBe(false)
  })
})

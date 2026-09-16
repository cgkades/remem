import { describe, expect, it } from "vitest"
import { isEpisodicStore } from "../src/observation.js"

describe("isEpisodicStore", () => {
  it("returns true for an object implementing both appendEvidence and readEvidence", () => {
    const store = {
      appendEvidence: () => Promise.resolve({ outcome: "appended" as const, id: "x" }),
      readEvidence: () => Promise.resolve(undefined),
    }

    expect(isEpisodicStore(store)).toBe(true)
  })

  it("returns false when only appendEvidence is present", () => {
    const partial = {
      appendEvidence: () => Promise.resolve({ outcome: "appended" as const, id: "x" }),
    }

    expect(isEpisodicStore(partial)).toBe(false)
  })

  it("returns false when only readEvidence is present", () => {
    const partial = { readEvidence: () => Promise.resolve(undefined) }

    expect(isEpisodicStore(partial)).toBe(false)
  })

  it("returns false for neither method present", () => {
    expect(isEpisodicStore({})).toBe(false)
  })

  it("returns false for non-function values at the expected keys", () => {
    expect(isEpisodicStore({ appendEvidence: "not a function", readEvidence: "also not" })).toBe(
      false,
    )
  })

  it("returns false for null/undefined/primitive values", () => {
    expect(isEpisodicStore(null)).toBe(false)
    expect(isEpisodicStore(undefined)).toBe(false)
    expect(isEpisodicStore("a string")).toBe(false)
    expect(isEpisodicStore(42)).toBe(false)
  })
})

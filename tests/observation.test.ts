import { describe, expect, it } from "vitest"
import { isEpisodicSearchStore, isEpisodicStore } from "../src/observation.js"

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

describe("isEpisodicSearchStore", () => {
  const base = {
    appendEvidence: () => Promise.resolve({ outcome: "appended" as const, id: "x" }),
    readEvidence: () => Promise.resolve(undefined),
  }

  it("returns true for an object implementing append/read/search", () => {
    const store = {
      ...base,
      searchEpisodes: () => Promise.resolve({ matches: [], budgetExhausted: false }),
    }
    expect(isEpisodicSearchStore(store)).toBe(true)
  })

  it("returns false when searchEpisodes is missing -- an EpisodicStore alone is not an EpisodicSearchStore", () => {
    expect(isEpisodicSearchStore(base)).toBe(false)
  })

  it("returns false when searchEpisodes is present but appendEvidence/readEvidence are not", () => {
    expect(
      isEpisodicSearchStore({
        searchEpisodes: () => Promise.resolve({ matches: [], budgetExhausted: false }),
      }),
    ).toBe(false)
  })

  it("returns false when searchEpisodes is not a function", () => {
    expect(isEpisodicSearchStore({ ...base, searchEpisodes: "not a function" })).toBe(false)
  })

  it("returns false for null/undefined/primitive values", () => {
    expect(isEpisodicSearchStore(null)).toBe(false)
    expect(isEpisodicSearchStore(undefined)).toBe(false)
    expect(isEpisodicSearchStore("a string")).toBe(false)
    expect(isEpisodicSearchStore(42)).toBe(false)
  })
})

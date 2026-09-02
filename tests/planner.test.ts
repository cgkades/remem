import { describe, expect, it } from "vitest"
import { DeterministicRetrievalPlanner } from "../src/planner.js"
import type { CatalogEntry } from "../src/types.js"

const phoenix: CatalogEntry = {
  id: "notes:phoenix",
  title: "Project Phoenix",
  aliases: ["phoenix database"],
  summary: "Active migration workstream",
  providerIds: ["notes"],
  scope: { kind: "workspace" },
  tags: ["database", "migration"],
  importance: 0.9,
  unresolved: true,
}

describe("DeterministicRetrievalPlanner", () => {
  const planner = new DeterministicRetrievalPlanner({ minimumConfidence: 0.42, maxTopics: 3 })

  it("routes named catalog entities", () => {
    const plan = planner.plan("Continue the Phoenix database work", [phoenix], ["notes"])

    expect(plan.shouldRetrieve).toBe(true)
    expect(plan.topics).toEqual(["Project Phoenix"])
    expect(plan.requests[0]?.providerId).toBe("notes")
    expect(plan.confidence).toBeGreaterThan(0.8)
  })

  it("does not route unrelated prompts", () => {
    const plan = planner.plan("Explain a Python list comprehension", [phoenix], ["notes"])

    expect(plan.shouldRetrieve).toBe(false)
    expect(plan.requests).toEqual([])
  })

  it("searches providers for explicit continuity when the catalog is incomplete", () => {
    const plan = planner.plan("What did we decide last time?", [], ["notes", "sessions"])

    expect(plan.shouldRetrieve).toBe(true)
    expect(plan.signals).toContain("explicit continuity phrase")
    expect(plan.requests.map((request) => request.providerId)).toEqual(["notes", "sessions"])
  })

  it("does not match catalog names inside unrelated words", () => {
    const hr = { ...phoenix, id: "notes:hr", title: "HR", aliases: [] }
    const plan = planner.plan("Walk through this function", [hr], ["notes"])

    expect(plan.shouldRetrieve).toBe(false)
  })
})

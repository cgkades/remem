import { describe, expect, it } from "vitest"
import { DeterministicRetrievalPlanner } from "../src/planner.js"
import type { CatalogEntry } from "../src/types.js"
import { memoryContext } from "./helpers.js"

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

  it("blocks specialized guidance before catalog matching regardless of title similarity", () => {
    const gated: CatalogEntry = {
      ...phoenix,
      id: "institutional:production",
      title: "Production rollback procedure",
      institutional: {
        role: "procedure",
        id: "procedure.production-rollback",
        steps: [{ id: "plan", instruction: "Prepare the plan." }],
        positionIds: ["position.rollback"],
        requiredEvidence: ["approval"],
        completionCriteria: ["plan approved"],
        escalationConditions: ["no approval"],
        applicability: {
          match: "all",
          conditions: [
            { id: "project", kind: "context", field: "projectId", value: "other-project" },
          ],
        },
        review: { reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: null },
      },
    }
    const plan = planner.plan("Production rollback procedure", [gated], ["notes"], memoryContext)

    expect(plan.shouldRetrieve).toBe(false)
    expect(plan.matches).toEqual([])
    expect(plan.applicability).toEqual([
      expect.objectContaining({
        applicable: false,
        institutionalId: "procedure.production-rollback",
      }),
    ])
  })

  it("records an applicable any-gate without claiming every condition passed", () => {
    const gated: CatalogEntry = {
      ...phoenix,
      institutional: {
        role: "position",
        id: "position.production",
        owner: "release-engineering",
        sourceRefs: ["policy"],
        boundaryConditions: ["Production only."],
        applicability: {
          match: "any",
          conditions: [
            { id: "other-project", kind: "context", field: "projectId", value: "other" },
            { id: "this-project", kind: "context", field: "projectId", value: "project-test" },
          ],
        },
        review: { reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: null },
      },
    }
    const [decision] =
      planner.plan("Phoenix", [gated], ["notes"], memoryContext).applicability ?? []

    expect(decision).toMatchObject({
      applicable: true,
      reason: "deterministic applicability conditions passed",
    })
  })
})

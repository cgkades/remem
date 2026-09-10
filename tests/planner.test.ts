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

  it("matches a multi-word topic applicability condition as a phrase, not a single token", () => {
    const gated: CatalogEntry = {
      ...phoenix,
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
          conditions: [{ id: "topic", kind: "topic", value: "production rollout" }],
        },
        review: { reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: null },
      },
    }
    const [decision] =
      planner.plan(
        "Can we skip the production rollout rollback plan?",
        [gated],
        ["notes"],
        memoryContext,
      ).applicability ?? []

    expect(decision).toMatchObject({
      applicable: true,
      reason: "deterministic applicability conditions passed",
    })
  })

  it("reports the actual failed condition for an unmatched multi-word topic", () => {
    const gated: CatalogEntry = {
      ...phoenix,
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
            { id: "production-rollout-topic", kind: "topic", value: "production rollout" },
          ],
        },
        review: { reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: null },
      },
    }
    const [decision] =
      planner.plan(
        "The rollout of the production database is done",
        [gated],
        ["notes"],
        memoryContext,
      ).applicability ?? []

    expect(decision).toMatchObject({
      applicable: false,
      reason: "failed deterministic gate production-rollout-topic",
    })
  })

  describe("short-continuity anchor fallback", () => {
    const orionMemory: CatalogEntry = {
      id: "postgres:orion-memory",
      title: "Orion uses PostgreSQL for durable memory.",
      aliases: [],
      summary: "",
      providerIds: ["postgres-a"],
      scope: { kind: "project", id: "project-test" },
      tags: [],
      importance: 0.5,
      unresolved: false,
    }
    const orionBlocker: CatalogEntry = {
      id: "postgres:orion-blocker",
      title: "The Orion rollout is blocked on a restore drill.",
      aliases: [],
      summary: "",
      providerIds: ["postgres-a"],
      scope: { kind: "project", id: "project-test" },
      tags: [],
      importance: 0.5,
      unresolved: true,
    }
    const zephyrDecision: CatalogEntry = {
      id: "postgres:zephyr-decision",
      title: "We chose Zephyr for the queueing rewrite.",
      aliases: ["zephyr queue"],
      summary: "",
      providerIds: ["postgres-b"],
      scope: { kind: "project", id: "project-test" },
      tags: [],
      importance: 0.5,
      unresolved: false,
    }

    it("routes only to the provider owning the anchor-matched entry with the anchor as query", () => {
      const plan = planner.plan(
        "Let's continue the Orion work.",
        [orionMemory, orionBlocker, zephyrDecision],
        ["postgres-a", "postgres-b"],
      )

      expect(plan.shouldRetrieve).toBe(true)
      expect(plan.signals).toContain("anchor-routed continuity fallback")
      expect(plan.requests).toHaveLength(1)
      expect(plan.requests[0]).toMatchObject({
        providerId: "postgres-a",
        query: "orion",
      })
      expect(plan.requests[0]?.reason).toContain("anchor routing")
    })

    it("does not route an anchor's owning provider when it is unavailable, and falls back safely for the rest", () => {
      const plan = planner.plan(
        "Let's continue the Orion work.",
        [orionMemory, zephyrDecision],
        ["postgres-b"],
      )

      // "postgres-a" owns the only anchor-matched ("orion") entry but is not
      // configured/available; the anchor route must not be granted to it, and the
      // fallback for the remaining available provider must use the existing
      // full-prompt reason rather than inventing an unrelated anchor match.
      expect(plan.requests.map((request) => request.providerId)).toEqual(["postgres-b"])
      expect(plan.requests[0]).toMatchObject({
        query: "Let's continue the Orion work.",
        reason: "continuity phrase with no catalog match",
      })
    })

    it("excludes institutionally blocked entries from anchor candidacy", () => {
      const blockedOrion: CatalogEntry = {
        ...orionMemory,
        id: "postgres:orion-blocked",
        institutional: {
          role: "procedure",
          id: "procedure.orion-blocked",
          steps: [{ id: "plan", instruction: "Prepare the plan." }],
          positionIds: ["position.orion"],
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

      const plan = planner.plan(
        "Let's continue the Orion work.",
        [blockedOrion, zephyrDecision],
        ["postgres-a", "postgres-b"],
        memoryContext,
      )

      // The only Orion-titled entry is institutionally blocked, so it must not
      // contribute an anchor candidate; there is no fallback anchor left to match
      // "orion" or "zephyr", so the existing full-prompt/all-providers fallback runs.
      expect(plan.requests.map((request) => request.providerId).sort()).toEqual([
        "postgres-a",
        "postgres-b",
      ])
      for (const request of plan.requests) {
        expect(request.reason).toBe("continuity phrase with no catalog match")
        expect(request.query).not.toBe("orion")
      }
    })

    it("breaks a document-frequency tie by earliest prompt order", () => {
      // "Nebula" and "Zephyr" each appear in exactly one entry (frequency 1); "Nebula"
      // appears first in the prompt, so it must win the tie over "Zephyr". Titles are
      // deliberately long/low-overlap so neither entry reaches minimumConfidence
      // through the ordinary title/alias scoring path -- this must exercise the
      // anchor fallback, not a qualified catalog match.
      const nebulaDecision: CatalogEntry = {
        id: "postgres:nebula-decision",
        title: "The infrastructure team benchmarked Nebula against three alternatives.",
        aliases: [],
        summary: "",
        providerIds: ["postgres-c"],
        scope: { kind: "project", id: "project-test" },
        tags: [],
        importance: 0.5,
        unresolved: false,
      }
      const zephyrDecisionNoAlias: CatalogEntry = {
        id: "postgres:zephyr-decision-no-alias",
        title: "The messaging team ultimately adopted Zephyr over two other brokers.",
        aliases: [],
        summary: "",
        providerIds: ["postgres-b"],
        scope: { kind: "project", id: "project-test" },
        tags: [],
        importance: 0.5,
        unresolved: false,
      }
      const plan = planner.plan(
        "Let's continue the Nebula and Zephyr work.",
        [nebulaDecision, zephyrDecisionNoAlias],
        ["postgres-c", "postgres-b"],
      )

      expect(plan.requests).toHaveLength(1)
      expect(plan.requests[0]).toMatchObject({ providerId: "postgres-c", query: "nebula" })
    })

    it("ignores case and punctuation when matching the anchor", () => {
      const plan = planner.plan(
        "LET'S CONTINUE THE ORION!!! WORK???",
        [orionMemory, zephyrDecision],
        ["postgres-a", "postgres-b"],
      )

      expect(plan.requests).toHaveLength(1)
      expect(plan.requests[0]).toMatchObject({ providerId: "postgres-a", query: "orion" })
    })

    it("preserves the full-prompt/all-providers fallback when the catalog has no anchor", () => {
      const plan = planner.plan("What did we decide last time?", [], ["postgres-a", "postgres-b"])

      expect(plan.shouldRetrieve).toBe(true)
      expect(plan.signals).not.toContain("anchor-routed continuity fallback")
      expect(plan.requests.map((request) => request.providerId)).toEqual([
        "postgres-a",
        "postgres-b",
      ])
      for (const request of plan.requests) {
        expect(request.query).toBe("What did we decide last time?")
        expect(request.reason).toBe("continuity phrase with no catalog match")
      }
    })

    it("does not gain a new anchor route for a bare 'continue the work' prompt", () => {
      const plan = planner.plan(
        "continue the work",
        [orionMemory, zephyrDecision],
        ["postgres-a", "postgres-b"],
      )

      // "continue" and "work" are both excluded anchor tokens; no catalog title/alias
      // token remains in the prompt, so no anchor route can exist.
      expect(plan.requests.map((request) => request.providerId).sort()).toEqual([
        "postgres-a",
        "postgres-b",
      ])
      for (const request of plan.requests) {
        expect(request.reason).toBe("continuity phrase with no catalog match")
      }
    })

    it("preserves qualified catalog matches and non-continuity behavior unchanged", () => {
      // A normal qualified match (no continuity phrase, no fallback) must be
      // unaffected by the anchor fallback: minimumConfidence and scoring rules apply
      // exactly as before.
      const plan = planner.plan(
        "Continue the Phoenix database work",
        [phoenix],
        ["notes", "postgres-a"],
      )

      expect(plan.shouldRetrieve).toBe(true)
      expect(plan.topics).toEqual(["Project Phoenix"])
      expect(plan.requests).toHaveLength(1)
      expect(plan.requests[0]?.providerId).toBe("notes")
      expect(plan.requests[0]?.query).not.toBe("phoenix")
      expect(plan.confidence).toBeGreaterThan(0.8)
    })
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

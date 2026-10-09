import { describe, expect, it } from "vitest"
import { catalogPolicyDecision, catalogPolicyAllows, recalledPolicyAllows } from "../src/retrieval-policy.js"
import { DeterministicRetrievalPlanner } from "../src/planner.js"
import { RecallEngine } from "../src/recall.js"
import { RememOrchestrator } from "../src/orchestrator.js"
import type { CatalogEntry, InstitutionalPosition, MemoryProvider, MemoryRecord, RetrievalPlan } from "../src/types.js"
import { memoryContext, testConfig } from "./helpers.js"

function institutional(): InstitutionalPosition {
  return {
    role: "position",
    id: "policy.rollback",
    owner: "release engineering",
    sourceRefs: ["policy-v3"],
    boundaryConditions: ["Requires current scope."],
    applicability: {
      match: "all",
      conditions: [{ id: "project", kind: "context", field: "projectId", value: memoryContext.projectId }],
    },
    review: { reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: null },
  }
}

function entry(): CatalogEntry {
  return {
    id: "rollback", title: "Phoenix rollback", aliases: [], summary: "Reviewed rollback policy",
    providerIds: ["test"], scope: { kind: "project", id: memoryContext.projectId },
    tags: [], importance: 0.8, unresolved: false, institutional: institutional(),
  }
}

function record(): MemoryRecord {
  return {
    providerId: "test", id: "rollback", title: "Phoenix rollback", content: "Prepare a rollback plan.",
    source: "policy-v3", scope: { kind: "project", id: memoryContext.projectId },
    type: "decision", freshness: "current", institutional: institutional(),
  }
}

function provider(records: MemoryRecord[], entries: CatalogEntry[] = [entry()]): MemoryProvider {
  return {
    id: "test",
    capabilities: () => ({
      lexicalSearch: true, semanticSearch: false, metadataFiltering: false, catalog: true,
      read: false, write: false, update: false, delete: false, episodicHistory: false,
      structuredEntities: false, filesystemDocuments: false,
    }),
    catalog: async () => entries,
    search: async () => records.map(record => ({ record, score: 0.9, reasons: ["fixture"] })),
  }
}

const plan: RetrievalPlan = {
  shouldRetrieve: true, confidence: 1, topics: ["Phoenix"],
  requests: [{ providerId: "test", query: "Phoenix rollback", reason: "test", limit: 8 }],
  matches: [], signals: [],
}

describe("fixed retrieval policy boundary", () => {
  it("preserves current review/applicability reasons in the planner", () => {
    const result = new DeterministicRetrievalPlanner(testConfig().planner).plan(
      "Phoenix rollback", [entry()], ["test"], memoryContext,
    )
    expect(result.applicability).toEqual([{
      catalogEntryId: "rollback", institutionalId: "policy.rollback", applicable: true,
      reason: "deterministic applicability conditions passed",
    }])
  })

  it("preserves the failing deterministic gate reason", () => {
    const item = entry()
    item.institutional = { ...institutional(), applicability: {
      match: "all", conditions: [{ id: "release", kind: "topic", value: "production rollout" }],
    } }
    expect(catalogPolicyDecision(item, memoryContext, "Phoenix rollback")).toMatchObject({
      applicable: false, reason: "failed deterministic gate release",
    })
  })

  it.each(["expired", "invalid"])("denies %s review in both planes with observable reasons", status => {
    const metadata = institutional()
    metadata.review = { reviewedAt: "2026-09-01T00:00:00.000Z",
      expiresAt: status === "expired" ? "2026-09-02T00:00:00.000Z" : "not-a-date" }
    const catalog = { ...entry(), institutional: metadata }
    expect(catalogPolicyDecision(catalog, memoryContext)).toMatchObject({
      applicable: false, reason: status === "expired" ? "institutional review expired" : "institutional review is invalid",
    })
    expect(recalledPolicyAllows({ ...record(), institutional: metadata }, memoryContext, "Phoenix", new Set())).toBe(false)
  })

  it("fails closed on absent applicability context", () => {
    expect(catalogPolicyDecision(entry())).toMatchObject({
      applicable: false, reason: "applicability context unavailable",
    })
  })

  it("fails closed on malformed metadata and on throwing policy input", () => {
    const catalog = entry()
    Object.defineProperty(catalog, "institutional", { get() { throw new Error("unsafe policy body") } })
    expect(catalogPolicyDecision(catalog, memoryContext)).toMatchObject({
      applicable: false, reason: "retrieval policy evaluation failed",
    })
    expect(catalogPolicyAllows(catalog, memoryContext)).toBe(false)
    expect(recalledPolicyAllows({ ...record(), metadata: { institutional: {} } }, memoryContext, "Phoenix", new Set())).toBe(false)
    const recalled = record()
    Object.defineProperty(recalled, "institutional", { get() { throw new Error("unsafe body") } })
    expect(recalledPolicyAllows(recalled, memoryContext, "Phoenix", new Set())).toBe(false)
  })

  it("checks both metadata representations and keeps explicit denial mandatory", () => {
    const foreign = { ...institutional(), applicability: { match: "all" as const,
      conditions: [{ id: "project", kind: "context" as const, field: "projectId" as const, value: "foreign" }] } }
    expect(recalledPolicyAllows({ ...record(), metadata: { institutional: foreign } }, memoryContext, "Phoenix", new Set())).toBe(false)
    expect(recalledPolicyAllows(record(), memoryContext, "Phoenix", new Set(["rollback"]))).toBe(false)
  })

  it("keeps scope and supersession checks mandatory even when generic policy allows", async () => {
    const current = { ...record(), institutional: undefined }
    const foreign = { ...current, id: "foreign", scope: { kind: "project" as const, id: "foreign" } }
    const obsolete = { ...current, id: "obsolete", freshness: "superseded" as const }
    const recall = await new RecallEngine([provider([current, foreign, obsolete])], testConfig()).execute(plan, memoryContext)
    expect(recall.memories.map(value => value.record.id)).toEqual(["rollback"])
  })

  it("contains one failed policy result while retaining eligible recall", async () => {
    const invalid = { ...record(), id: "invalid" }
    Object.defineProperty(invalid, "institutional", { get() { throw new Error("unsafe body") } })
    const recall = await new RecallEngine([provider([invalid, record()])], testConfig()).execute(plan, memoryContext)
    expect(recall.memories.map(value => value.record.id)).toEqual(["rollback"])
    expect(recall.attempts[0]?.status).toBe("ok")
  })

  it("preserves explain denial and excludes denied catalog/content during dispatch and compaction", async () => {
    const denied = institutional()
    denied.applicability.conditions[0]!.value = "foreign"
    const orchestrator = new RememOrchestrator(
      [provider([{ ...record(), institutional: denied }], [{ ...entry(), institutional: denied }])],
      testConfig(),
    )
    const injection = await orchestrator.processPrompt("Phoenix rollback", memoryContext)
    expect(injection.text).not.toContain("Reviewed rollback policy")
    expect(injection.text).not.toContain("Prepare a rollback plan.")
    expect(orchestrator.explain(memoryContext.sessionId)).toMatchObject({
      applicability: [{ catalogEntryId: "rollback", institutionalId: "policy.rollback", applicable: false,
        reason: "failed deterministic gate project" }],
      selectedResults: 0,
    })
    expect(await orchestrator.compactionContext(memoryContext)).not.toContain("Reviewed rollback policy")
  })
})

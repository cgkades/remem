import { describe, expect, it } from "vitest"
import { RecallEngine } from "../src/recall.js"
import type {
  CatalogEntry,
  MemoryCapabilities,
  MemoryContext,
  MemoryProvider,
  MemoryResult,
  MemorySearchRequest,
  RetrievalPlan,
} from "../src/types.js"
import { memoryContext, testConfig } from "./helpers.js"

const capabilities: MemoryCapabilities = {
  lexicalSearch: true,
  semanticSearch: false,
  metadataFiltering: false,
  catalog: true,
  read: true,
  write: false,
  update: false,
  delete: false,
  episodicHistory: false,
  structuredEntities: false,
  filesystemDocuments: false,
}

class FakeProvider implements MemoryProvider {
  constructor(
    readonly id: string,
    private readonly results: MemoryResult[] | Error,
    private readonly capabilitiesError = false,
  ) {}

  capabilities(): MemoryCapabilities {
    if (this.capabilitiesError) throw new Error("capabilities unavailable")
    return capabilities
  }

  catalog(_context: MemoryContext, _signal: AbortSignal): Promise<CatalogEntry[]> {
    return Promise.resolve([])
  }

  search(_request: MemorySearchRequest): Promise<MemoryResult[]> {
    if (this.results instanceof Error) return Promise.reject(this.results)
    return Promise.resolve(this.results)
  }
}

function result(id: string, source: string): MemoryResult {
  return {
    record: {
      providerId: "healthy",
      id,
      title: "Phoenix decision",
      content: "Decision: use logical replication.",
      source,
      scope: { kind: "workspace", id: memoryContext.worktree },
      type: "decision",
      freshness: "current",
      importance: 0.9,
    },
    score: 0.95,
    reasons: ["title"],
  }
}

function topicGatedResult(id: string, source: string): MemoryResult {
  const base = result(id, source)
  return {
    ...base,
    record: {
      ...base.record,
      institutional: {
        role: "position",
        id: "position.production-rollout",
        owner: "release-engineering",
        sourceRefs: ["policy"],
        boundaryConditions: ["Applies only to production rollouts."],
        applicability: {
          match: "all",
          conditions: [{ id: "topic", kind: "topic", value: "production rollout" }],
        },
        review: { reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: null },
      },
    },
  }
}

const plan: RetrievalPlan = {
  shouldRetrieve: true,
  confidence: 0.9,
  topics: ["Project Phoenix"],
  requests: [
    { providerId: "healthy", query: "Phoenix", reason: "test", limit: 8 },
    { providerId: "broken", query: "Phoenix", reason: "test", limit: 8 },
  ],
  matches: [],
  signals: [],
}

describe("RecallEngine", () => {
  it("keeps successful results when another provider fails and deduplicates content", async () => {
    const engine = new RecallEngine(
      [
        new FakeProvider("healthy", [result("one", "one.md"), result("two", "two.md")]),
        new FakeProvider("broken", new Error("offline")),
      ],
      testConfig(),
    )

    const recall = await engine.execute(plan, memoryContext)

    expect(recall.rawCount).toBe(2)
    expect(recall.deduplicatedCount).toBe(1)
    expect(recall.memories[0]?.duplicateSources).toHaveLength(1)
    expect(recall.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: "healthy", status: "ok" }),
        expect.objectContaining({ providerId: "broken", status: "failed" }),
      ]),
    )
  })

  it("uses provider fingerprints so bounded excerpts do not collapse distinct memories", async () => {
    const first = { ...result("one", "one.md"), fingerprint: "full-document-one" }
    const second = { ...result("two", "two.md"), fingerprint: "full-document-two" }
    const engine = new RecallEngine([new FakeProvider("healthy", [first, second])], testConfig())
    const oneProviderPlan = { ...plan, requests: [plan.requests[0]!] }

    const recall = await engine.execute(oneProviderPlan, memoryContext)

    expect(recall.deduplicatedCount).toBe(2)
  })

  it("isolates a provider that throws while reporting capabilities", async () => {
    const engine = new RecallEngine(
      [
        new FakeProvider("healthy", [result("one", "one.md")]),
        new FakeProvider("broken", [], true),
      ],
      testConfig(),
    )

    const recall = await engine.execute(plan, memoryContext)

    expect(recall.memories).toHaveLength(1)
    expect(recall.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: "healthy", status: "ok" }),
        expect.objectContaining({ providerId: "broken", status: "failed" }),
      ]),
    )
  })

  it("stamps provider identity and rejects cross-scope provider output", async () => {
    const valid = result("valid", "valid.md")
    valid.record.providerId = "spoofed-provider"
    const foreign = result("foreign", "foreign.md")
    foreign.record.scope = { kind: "project", id: "another-project" }
    const engine = new RecallEngine([new FakeProvider("healthy", [valid, foreign])], testConfig())
    const recall = await engine.execute({ ...plan, requests: [plan.requests[0]!] }, memoryContext)

    expect(recall.memories).toHaveLength(1)
    expect(recall.memories[0]?.record.providerId).toBe("healthy")
    expect(recall.attempts[0]?.error).toContain("out-of-scope")
  })

  it("includes a record gated by a multi-word institutional topic when the query contains that phrase", async () => {
    const engine = new RecallEngine(
      [new FakeProvider("healthy", [topicGatedResult("gated", "gated.md")])],
      testConfig(),
    )
    const matchingPlan: RetrievalPlan = {
      ...plan,
      requests: [{ ...plan.requests[0]!, query: "Can we skip the production rollout plan?" }],
    }

    const recall = await engine.execute(matchingPlan, memoryContext)

    expect(recall.memories).toHaveLength(1)
  })

  it("excludes a record gated by a multi-word institutional topic when the query doesn't contain that phrase", async () => {
    const engine = new RecallEngine(
      [new FakeProvider("healthy", [topicGatedResult("gated", "gated.md")])],
      testConfig(),
    )
    // Both words are present, but not adjacent as the phrase "production
    // rollout" -- this must still be excluded, not just any prompt that
    // happens to be missing both words entirely.
    const nonMatchingPlan: RetrievalPlan = {
      ...plan,
      requests: [{ ...plan.requests[0]!, query: "The rollout of the production database is done" }],
    }

    const recall = await engine.execute(nonMatchingPlan, memoryContext)

    expect(recall.memories).toHaveLength(0)
  })
})

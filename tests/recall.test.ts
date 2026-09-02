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
      scope: { kind: "workspace" },
      type: "decision",
      freshness: "current",
      importance: 0.9,
    },
    score: 0.95,
    reasons: ["title"],
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
})

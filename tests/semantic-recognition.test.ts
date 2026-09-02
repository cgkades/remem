import { describe, expect, it } from "vitest"
import { RememOrchestrator } from "../src/orchestrator.js"
import { LocalHashEmbeddingModel } from "../src/storage/embedding.js"
import type {
  CatalogEntry,
  MemoryContext,
  MemoryProvider,
  MemorySearchRequest,
} from "../src/types.js"
import { memoryContext, testConfig } from "./helpers.js"

const authEntry: CatalogEntry = {
  id: "bedrock-auth",
  title: "Bedrock Claude credential passthrough failure",
  aliases: [],
  summary: "Amazon identity credentials flow through the provider chain.",
  providerIds: ["managed"],
  scope: { kind: "project", id: "project-test" },
  tags: ["identity", "cloud"],
  importance: 0.9,
  unresolved: false,
}

class SemanticFixtureProvider implements MemoryProvider {
  readonly id = "managed"

  capabilities() {
    return {
      lexicalSearch: true,
      semanticSearch: true,
      metadataFiltering: true,
      catalog: true,
      read: true,
      write: false,
      update: false,
      delete: false,
      episodicHistory: true,
      structuredEntities: false,
      filesystemDocuments: false,
    }
  }

  descriptor() {
    return {
      id: this.id,
      name: "Managed project history",
      summary: "Prior authentication incidents, architecture decisions, and resolved failures.",
      categories: ["authentication", "incidents", "decisions"],
      aliases: ["prior troubleshooting"],
      scopeKinds: ["project" as const],
    }
  }

  catalog(_context: MemoryContext, _signal: AbortSignal) {
    return Promise.resolve([authEntry])
  }

  search(_request: MemorySearchRequest) {
    return Promise.resolve([
      {
        record: {
          providerId: this.id,
          id: authEntry.id,
          title: authEntry.title,
          content: "Forward the default credential provider chain into the Bedrock client.",
          source: "session://bedrock-fix",
          scope: authEntry.scope,
          type: "decision" as const,
          freshness: "current" as const,
        },
        score: 0.82,
        reasons: ["semantic fixture"],
      },
    ])
  }
}

describe("semantic catalog recognition", () => {
  it("routes a paraphrase through Stage 1 without nearest-memory dumping", async () => {
    const embeddingModel = new LocalHashEmbeddingModel()
    authEntry.embedding = await embeddingModel.embed(
      [authEntry.title, authEntry.summary, authEntry.tags.join(" ")].join("\n"),
    )
    const orchestrator = new RememOrchestrator(
      [new SemanticFixtureProvider()],
      testConfig(),
      undefined,
      { embeddingModel },
    )

    const result = await orchestrator.processPrompt(
      "What did we end up doing about the AWS auth thing?",
      memoryContext,
    )

    expect(result.plan.shouldRetrieve).toBe(true)
    expect(result.trace.recognitionStage).toBe("semantic")
    expect(result.plan.signals).toContain("semantic catalog match")
    expect(result.memoryText).toContain("default credential provider chain")
  })

  it("suppresses unrelated prompts despite a populated provider", async () => {
    const orchestrator = new RememOrchestrator([new SemanticFixtureProvider()], testConfig())
    const result = await orchestrator.processPrompt(
      "Center the CSS button and change its border radius.",
      memoryContext,
    )

    expect(result.plan.shouldRetrieve).toBe(false)
    expect(result.trace.selectedResults).toBe(0)
    expect(result.memoryText).toBe("")
  })
})

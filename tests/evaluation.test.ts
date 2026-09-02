import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { RememOrchestrator } from "../src/orchestrator.js"
import type {
  CatalogEntry,
  MemoryContext,
  MemoryFreshness,
  MemoryProvider,
  MemorySearchRequest,
  MemoryType,
} from "../src/types.js"
import { memoryContext, testConfig } from "./helpers.js"

interface EvaluationEntry {
  id: string
  title: string
  aliases: string[]
  summary: string
  tags: string[]
  type: MemoryType
  freshness: MemoryFreshness
  unresolved?: boolean
  content: string
}

interface EvaluationFixture {
  entries: EvaluationEntry[]
  cases: Array<{ prompt: string; expected: string | null }>
}

class EvaluationProvider implements MemoryProvider {
  readonly id = "evaluation"

  constructor(private readonly fixture: EvaluationFixture) {}

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
      name: "Evaluation memory",
      summary:
        "Project history, preferences, incidents, decisions, procedures, and unresolved tasks.",
      categories: ["history", "preferences", "incidents", "decisions", "tasks"],
      aliases: ["prior work"],
      scopeKinds: ["global" as const, "project" as const],
    }
  }

  catalog(_context: MemoryContext, _signal: AbortSignal): Promise<CatalogEntry[]> {
    return Promise.resolve(
      this.fixture.entries.map((entry) => ({
        id: entry.id,
        title: entry.title,
        aliases: entry.aliases,
        summary: entry.summary,
        providerIds: [this.id],
        scope: {
          kind: entry.id === "global-concise" ? "global" : "project",
          ...(entry.id === "global-concise" ? {} : { id: "project-test" }),
        },
        tags: entry.tags,
        importance: entry.unresolved ? 0.9 : 0.6,
        unresolved: entry.unresolved ?? false,
      })),
    )
  }

  search(request: MemorySearchRequest) {
    const topicIds = new Set(
      this.fixture.entries
        .filter((entry) => request.topics.includes(entry.title))
        .map((entry) => entry.id),
    )
    const selected = this.fixture.entries.filter((entry) => topicIds.has(entry.id)).slice(0, 1)
    return Promise.resolve(
      selected.flatMap((entry) =>
        ["primary", "duplicate"].map((suffix) => ({
          record: {
            providerId: this.id,
            id: `${entry.id}-${suffix}`,
            title: entry.title,
            content: entry.content,
            source: `evaluation://${entry.id}/${suffix}`,
            scope:
              entry.id === "global-concise"
                ? ({ kind: "global" } as const)
                : ({ kind: "project", id: "project-test" } as const),
            type: entry.type,
            freshness: entry.freshness,
            unresolved: entry.unresolved ?? false,
          },
          score: 0.9,
          reasons: ["evaluation fixture"],
        })),
      ),
    )
  }
}

describe("recognition evaluation", () => {
  it("reports useful recall with false-positive suppression across distractors", async () => {
    const fixturePath = fileURLToPath(
      new URL("./fixtures/evaluation/catalog.json", import.meta.url),
    )
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as EvaluationFixture
    const orchestrator = new RememOrchestrator(
      [new EvaluationProvider(fixture)],
      testConfig({ budgets: { catalogTokens: 1_400, recallTokens: 900, perProviderTokens: 700 } }),
    )
    let relevant = 0
    let recalled = 0
    let missed = 0
    let irrelevant = 0
    let deduplicated = 0
    let maxTokens = 0
    let maxLatency = 0
    let providerFailures = 0

    for (const evaluationCase of fixture.cases) {
      const result = await orchestrator.processPrompt(evaluationCase.prompt, memoryContext)
      maxTokens = Math.max(maxTokens, result.trace.catalogTokens + result.trace.recallTokens)
      maxLatency = Math.max(maxLatency, result.trace.totalDurationMs)
      providerFailures += result.trace.providers.filter(({ status }) => status !== "ok").length
      deduplicated += result.trace.rawResults - result.trace.deduplicatedResults
      if (evaluationCase.expected) {
        relevant++
        if (result.plan.matches.some(({ entry }) => entry.id === evaluationCase.expected))
          recalled++
        else missed++
      } else if (result.trace.selectedResults > 0) irrelevant++
    }

    const metrics = {
      relevantRecallRate: recalled / relevant,
      missedRecall: missed,
      irrelevantInjectionRate: irrelevant / (fixture.cases.length - relevant),
      selectedTokens: maxTokens,
      retrievalLatencyMs: maxLatency,
      providerFailures,
      deduplicated,
    }
    expect(metrics.relevantRecallRate).toBeGreaterThanOrEqual(0.8)
    expect(metrics.missedRecall).toBeLessThanOrEqual(1)
    expect(metrics.irrelevantInjectionRate).toBe(0)
    expect(metrics.selectedTokens).toBeLessThanOrEqual(2_300)
    expect(metrics.retrievalLatencyMs).toBeLessThan(500)
    expect(metrics.providerFailures).toBe(0)
    expect(metrics.deduplicated).toBeGreaterThan(0)
  })
})

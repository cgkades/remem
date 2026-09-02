import { MemoryCatalog, renderCatalog } from "./catalog.js"
import type { OrchestratorConfig } from "./config.js"
import { MemoryDiagnostics } from "./diagnostics.js"
import { DeterministicRetrievalPlanner } from "./planner.js"
import { RecallEngine } from "./recall.js"
import { DeterministicSynthesizer } from "./synthesizer.js"
import { withTimeout } from "./timeout.js"
import type {
  MemoryContext,
  MemoryInjection,
  MemoryProvider,
  MemoryTrace,
  RememLogger,
  RetrievalPlan,
} from "./types.js"

const NOOP_LOGGER: RememLogger = { log: () => undefined }

function emptyPlan(): RetrievalPlan {
  return {
    shouldRetrieve: false,
    confidence: 0,
    topics: [],
    requests: [],
    matches: [],
    signals: [],
  }
}

function safeLog(
  logger: RememLogger,
  level: "debug" | "info" | "warn" | "error",
  event: string,
  data?: Record<string, unknown>,
): void {
  try {
    void Promise.resolve(logger.log(level, event, data)).catch(() => undefined)
  } catch {
    // Logging is never on the critical path.
  }
}

export interface ManualSearchResult {
  text: string
  trace: MemoryTrace
}

export class RememOrchestrator {
  private readonly catalog: MemoryCatalog
  private readonly planner: DeterministicRetrievalPlanner
  private readonly recall: RecallEngine
  private readonly synthesizer: DeterministicSynthesizer
  private readonly diagnostics = new MemoryDiagnostics()
  private readonly providerIds: string[]
  private readonly providers: MemoryProvider[]

  constructor(
    providers: MemoryProvider[],
    private readonly config: OrchestratorConfig,
    private readonly logger: RememLogger = NOOP_LOGGER,
  ) {
    const byId = new Map<string, MemoryProvider>()
    for (const provider of providers) {
      if (!byId.has(provider.id)) byId.set(provider.id, provider)
    }
    this.providers = [...byId.values()]
    if (this.providers.length !== providers.length) {
      safeLog(this.logger, "warn", "providers.duplicate_id", {
        configured: providers.length,
        enabled: this.providers.length,
      })
    }
    this.catalog = new MemoryCatalog(
      this.providers,
      config.budgets.catalogTokens,
      config.providerTimeoutMs,
    )
    this.planner = new DeterministicRetrievalPlanner(config.planner)
    this.recall = new RecallEngine(this.providers, config)
    this.synthesizer = new DeterministicSynthesizer(config.budgets)
    this.providerIds = this.providers.map((provider) => provider.id)
  }

  async processPrompt(prompt: string, context: MemoryContext): Promise<MemoryInjection> {
    const started = performance.now()
    const fallbackCatalog = renderCatalog([], this.config.budgets.catalogTokens)
    let catalog = fallbackCatalog

    try {
      catalog = await this.catalog.get(context)
      const plan = this.planner.plan(prompt, catalog.entries, this.providerIds)
      const recall = await this.recall.execute(plan, context)
      const synthesis = this.synthesizer.synthesize(plan.topics, recall.memories)
      const diagnostics = [
        ...catalog.diagnostics,
        ...recall.attempts
          .filter((attempt) => attempt.status !== "ok")
          .map((attempt) => `provider ${attempt.providerId} ${attempt.status}`),
      ]
      const trace: MemoryTrace = {
        sessionId: context.sessionId ?? "unknown",
        timestamp: new Date().toISOString(),
        catalogEntries: catalog.entries.length,
        catalogMatches: plan.matches.slice(0, this.config.planner.maxTopics).map((match) => ({
          id: match.entry.id,
          title: match.entry.title,
          score: Number(match.score.toFixed(3)),
        })),
        shouldRetrieve: plan.shouldRetrieve,
        confidence: Number(plan.confidence.toFixed(3)),
        topics: plan.topics,
        signals: plan.signals,
        providers: recall.attempts,
        rawResults: recall.rawCount,
        deduplicatedResults: recall.deduplicatedCount,
        selectedResults: synthesis.selectedCount,
        catalogTokens: catalog.estimatedTokens,
        recallTokens: synthesis.estimatedTokens,
        totalDurationMs: Math.round(performance.now() - started),
        diagnostics,
      }
      this.diagnostics.record(trace)
      this.logTrace(trace)
      return {
        text: synthesis.text ? `${catalog.text}\n\n${synthesis.text}` : catalog.text,
        plan,
        trace,
      }
    } catch (error) {
      const diagnostic = error instanceof Error ? error.name : "unknown error"
      const trace: MemoryTrace = {
        sessionId: context.sessionId ?? "unknown",
        timestamp: new Date().toISOString(),
        catalogEntries: catalog.entries.length,
        catalogMatches: [],
        shouldRetrieve: false,
        confidence: 0,
        topics: [],
        signals: [],
        providers: [],
        rawResults: 0,
        deduplicatedResults: 0,
        selectedResults: 0,
        catalogTokens: catalog.estimatedTokens,
        recallTokens: 0,
        totalDurationMs: Math.round(performance.now() - started),
        diagnostics: [`orchestration failed: ${diagnostic}`],
      }
      this.diagnostics.record(trace)
      safeLog(this.logger, "warn", "orchestration.failed", { error: diagnostic })
      return { text: catalog.text, plan: emptyPlan(), trace }
    }
  }

  async search(
    query: string,
    context: MemoryContext,
    providerId?: string,
    signal?: AbortSignal,
  ): Promise<ManualSearchResult> {
    const started = performance.now()
    const requestedProviderIds = providerId ? [providerId] : this.providerIds
    const plan: RetrievalPlan = {
      shouldRetrieve: requestedProviderIds.length > 0,
      confidence: 1,
      topics: [query],
      requests: requestedProviderIds.map((id) => ({
        providerId: id,
        query,
        reason: "explicit memory_search tool request",
        limit: this.config.maxResults,
      })),
      matches: [],
      signals: ["explicit tool request"],
    }
    const recall = await this.recall.execute(plan, context, signal)
    const synthesis = this.synthesizer.synthesize(plan.topics, recall.memories)
    const trace: MemoryTrace = {
      sessionId: context.sessionId ?? "unknown",
      timestamp: new Date().toISOString(),
      catalogEntries: (await this.catalog.get(context)).entries.length,
      catalogMatches: [],
      shouldRetrieve: true,
      confidence: 1,
      topics: [query],
      signals: plan.signals,
      providers: recall.attempts,
      rawResults: recall.rawCount,
      deduplicatedResults: recall.deduplicatedCount,
      selectedResults: synthesis.selectedCount,
      catalogTokens: 0,
      recallTokens: synthesis.estimatedTokens,
      totalDurationMs: Math.round(performance.now() - started),
      diagnostics: recall.attempts
        .filter((attempt) => attempt.status !== "ok")
        .map((attempt) => `provider ${attempt.providerId} ${attempt.status}`),
    }
    this.diagnostics.record(trace)
    this.logTrace(trace)
    return {
      text: synthesis.text || "No relevant memories were found in the selected providers.",
      trace,
    }
  }

  async compactionContext(context: MemoryContext): Promise<string> {
    const catalog = await this.catalog.get(context)
    return [
      "## Remem continuity",
      "Preserve references to relevant external memory and unresolved work in the continuation summary.",
      "Do not promote ephemeral session details into durable facts. The catalog is incomplete.",
      catalog.text,
    ].join("\n")
  }

  async status(context: MemoryContext): Promise<Record<string, unknown>> {
    const catalog = await this.catalog.get(context)
    const providers = await Promise.all(
      this.providers.map(async (provider) => {
        let capabilities: ReturnType<MemoryProvider["capabilities"]> | undefined
        try {
          capabilities = provider.capabilities()
        } catch (error) {
          return {
            id: provider.id,
            capabilitiesError: error instanceof Error ? error.name : "unknown error",
          }
        }
        if (!provider.health)
          return { id: provider.id, capabilities, health: { status: "unknown" } }
        try {
          const health = provider.health.bind(provider)
          return {
            id: provider.id,
            capabilities,
            health: await withTimeout(this.config.providerTimeoutMs, () => health()),
          }
        } catch (error) {
          return {
            id: provider.id,
            capabilities,
            health: {
              status: "unavailable",
              message: error instanceof Error ? error.name : "unknown error",
            },
          }
        }
      }),
    )
    return {
      providers,
      catalog: {
        entries: catalog.entries.length,
        estimatedTokens: catalog.estimatedTokens,
        diagnostics: catalog.diagnostics,
      },
      budgets: this.config.budgets,
      lastTrace: this.diagnostics.latest(context.sessionId),
    }
  }

  private logTrace(trace: MemoryTrace): void {
    if (!this.config.debug) return
    safeLog(this.logger, "debug", "retrieval.trace", {
      sessionId: trace.sessionId,
      catalogMatches: trace.catalogMatches,
      shouldRetrieve: trace.shouldRetrieve,
      confidence: trace.confidence,
      topics: trace.topics,
      providers: trace.providers,
      resultCounts: {
        raw: trace.rawResults,
        deduplicated: trace.deduplicatedResults,
        selected: trace.selectedResults,
      },
      contextTokens: {
        catalog: trace.catalogTokens,
        recall: trace.recallTokens,
      },
      totalDurationMs: trace.totalDurationMs,
      diagnostics: trace.diagnostics,
    })
  }
}

import { MemoryCatalog, renderCatalog } from "./catalog.js"
import type { OrchestratorConfig } from "./config.js"
import { MemoryDiagnostics } from "./diagnostics.js"
import type { ObservationStore } from "./observation.js"
import { DeterministicRetrievalPlanner } from "./planner.js"
import { SemanticCatalogRecognizer, type SemanticRecognitionResult } from "./planning/semantic.js"
import { RecallEngine } from "./recall.js"
import { LocalHashEmbeddingModel } from "./storage/embedding.js"
import { DeterministicSynthesizer, type SynthesisStrategy } from "./synthesizer.js"
import { estimateTokens } from "./token-budget.js"
import { withTimeout } from "./timeout.js"
import type {
  MemoryContext,
  EmbeddingModel,
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

function semanticPlan(
  prompt: string,
  result: SemanticRecognitionResult,
  providerIds: string[],
  minimumSimilarity: number,
  maxTopics: number,
  maxResults: number,
): RetrievalPlan | undefined {
  const selected = result.matches
    .filter((match) => match.score >= minimumSimilarity)
    .slice(0, maxTopics)
  const providerReasons = new Map<string, string[]>()
  for (const match of selected) {
    for (const providerId of match.entry.providerIds) {
      if (!providerIds.includes(providerId)) continue
      providerReasons.set(providerId, [
        ...(providerReasons.get(providerId) ?? []),
        `${match.entry.title}: semantic catalog similarity ${match.score.toFixed(3)}`,
      ])
    }
  }
  if (selected.length === 0) {
    for (const match of result.providerMatches.filter(
      ({ score, provider }) => score >= minimumSimilarity && providerIds.includes(provider.id),
    )) {
      providerReasons.set(match.provider.id, [
        `provider awareness similarity ${match.score.toFixed(3)}`,
      ])
    }
  }
  if (providerReasons.size === 0) return undefined
  const query = prompt.trim().slice(0, 2_000)
  return {
    shouldRetrieve: true,
    confidence: Math.max(
      selected[0]?.score ?? 0,
      ...result.providerMatches
        .filter(({ provider }) => providerReasons.has(provider.id))
        .map(({ score }) => score),
    ),
    topics: selected.map((match) => match.entry.title),
    requests: [...providerReasons].map(([providerId, reasons]) => ({
      providerId,
      query,
      reason: reasons.join("; "),
      limit: maxResults,
      topics: selected
        .filter((match) => match.entry.providerIds.includes(providerId))
        .map((match) => match.entry.title),
    })),
    matches: selected,
    signals: [selected.length > 0 ? "semantic catalog match" : "semantic provider awareness"],
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

export interface OrchestratorDependencies {
  embeddingModel?: EmbeddingModel
  synthesizer?: SynthesisStrategy
}

export class RememOrchestrator {
  private readonly catalog: MemoryCatalog
  private readonly planner: DeterministicRetrievalPlanner
  private readonly semantic: SemanticCatalogRecognizer
  private readonly recall: RecallEngine
  private readonly synthesizer: SynthesisStrategy
  private readonly fallbackSynthesizer: DeterministicSynthesizer
  private readonly diagnostics = new MemoryDiagnostics()
  private readonly providerIds: string[]
  private readonly providers: MemoryProvider[]

  constructor(
    providers: MemoryProvider[],
    private readonly config: OrchestratorConfig,
    private readonly logger: RememLogger = NOOP_LOGGER,
    dependencies: OrchestratorDependencies = {},
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
    this.semantic = new SemanticCatalogRecognizer(
      dependencies.embeddingModel ?? new LocalHashEmbeddingModel(),
    )
    this.recall = new RecallEngine(this.providers, config)
    this.fallbackSynthesizer = new DeterministicSynthesizer(config.budgets)
    this.synthesizer = dependencies.synthesizer ?? this.fallbackSynthesizer
    this.providerIds = this.providers.map((provider) => provider.id)
  }

  async processPrompt(prompt: string, context: MemoryContext): Promise<MemoryInjection> {
    const started = performance.now()
    const fallbackCatalog = renderCatalog([], this.config.budgets.catalogTokens)
    let catalog = fallbackCatalog
    let catalogMs = 0
    let planningMs = 0
    let recallMs = 0
    let synthesisMs = 0
    let semanticAttempted = false
    const stageDiagnostics: string[] = []

    try {
      const catalogStarted = performance.now()
      catalog = await this.catalog.get(context)
      catalogMs = performance.now() - catalogStarted
      const planningStarted = performance.now()
      let plan = this.planner.plan(prompt, catalog.entries, this.providerIds)
      const semanticConfig = this.config.semantic ?? {
        enabled: true,
        minimumSimilarity: 0.55,
        deterministicHighConfidence: 0.82,
      }
      if (
        prompt.trim() &&
        semanticConfig.enabled &&
        (!plan.shouldRetrieve || plan.confidence < semanticConfig.deterministicHighConfidence)
      ) {
        semanticAttempted = true
        try {
          const recognized = await this.semantic.recognize(
            prompt,
            catalog.entries,
            catalog.providers,
          )
          const candidate = semanticPlan(
            prompt,
            recognized,
            this.providerIds,
            semanticConfig.minimumSimilarity,
            this.config.planner.maxTopics,
            this.config.maxResults,
          )
          if (candidate && (!plan.shouldRetrieve || candidate.confidence > plan.confidence)) {
            plan = candidate
          }
        } catch (error) {
          stageDiagnostics.push(
            `semantic recognition failed: ${error instanceof Error ? error.name : "unknown error"}`,
          )
        }
      }
      planningMs = performance.now() - planningStarted
      const recallStarted = performance.now()
      const recall = await this.recall.execute(plan, context)
      recallMs = performance.now() - recallStarted
      const synthesisStarted = performance.now()
      const synthesis = await this.synthesize(plan.topics, recall.memories, stageDiagnostics)
      synthesisMs = performance.now() - synthesisStarted
      const diagnostics = [
        ...catalog.diagnostics,
        ...stageDiagnostics,
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
        recognitionStage: plan.signals.includes("semantic catalog match")
          ? "semantic"
          : plan.signals.includes("semantic provider awareness")
            ? "semantic"
            : plan.signals.includes("explicit continuity phrase") && plan.matches.length === 0
              ? "continuity"
              : plan.shouldRetrieve
                ? "deterministic"
                : "none",
        semanticAttempted,
        timings: {
          catalogMs: Math.round(catalogMs),
          planningMs: Math.round(planningMs),
          recallMs: Math.round(recallMs),
          synthesisMs: Math.round(synthesisMs),
        },
      }
      this.diagnostics.record(trace)
      this.logTrace(trace)
      return {
        text: synthesis.text ? `${catalog.text}\n\n${synthesis.text}` : catalog.text,
        catalogText: catalog.text,
        memoryText: synthesis.text,
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
        diagnostics: [...stageDiagnostics, `orchestration failed: ${diagnostic}`],
        recognitionStage: "none",
        semanticAttempted,
        timings: {
          catalogMs: Math.round(catalogMs),
          planningMs: Math.round(planningMs),
          recallMs: Math.round(recallMs),
          synthesisMs: Math.round(synthesisMs),
        },
      }
      this.diagnostics.record(trace)
      safeLog(this.logger, "warn", "orchestration.failed", { error: diagnostic })
      return {
        text: catalog.text,
        catalogText: catalog.text,
        memoryText: "",
        plan: emptyPlan(),
        trace,
      }
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
        topics: [query],
      })),
      matches: [],
      signals: ["explicit tool request"],
    }
    const recall = await this.recall.execute(plan, context, signal)
    const synthesis = await this.synthesize(plan.topics, recall.memories, [])
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
    const candidates = await Promise.all(
      this.providers.map(async (provider) => {
        const store = provider as MemoryProvider & Partial<ObservationStore>
        if (!store.candidateStatus) return undefined
        try {
          const candidateStatus = store.candidateStatus.bind(store)
          return {
            providerId: provider.id,
            ...(await withTimeout(this.config.providerTimeoutMs, () => candidateStatus(context))),
          }
        } catch (error) {
          return {
            providerId: provider.id,
            status: "unavailable",
            error: error instanceof Error ? error.name : "unknown error",
          }
        }
      }),
    )
    return {
      providers,
      catalog: {
        entries: catalog.entries.length,
        providers: catalog.providers,
        estimatedTokens: catalog.estimatedTokens,
        diagnostics: catalog.diagnostics,
      },
      budgets: this.config.budgets,
      candidates: candidates.filter((candidate) => candidate !== undefined),
      lastTrace: this.diagnostics.latest(context.sessionId),
    }
  }

  explain(sessionId?: string): MemoryTrace | { status: "no-trace" } {
    return this.diagnostics.latest(sessionId) ?? { status: "no-trace" }
  }

  private async synthesize(
    topics: string[],
    memories: Parameters<SynthesisStrategy["synthesize"]>[1],
    diagnostics: string[],
  ) {
    try {
      const result = await withTimeout(this.config.providerTimeoutMs, (signal) =>
        Promise.resolve(this.synthesizer.synthesize(topics, memories, signal)),
      )
      if (estimateTokens(result.text) > this.config.budgets.recallTokens) {
        throw new Error("synthesis exceeded recall budget")
      }
      return result
    } catch (error) {
      if (this.synthesizer === this.fallbackSynthesizer) throw error
      diagnostics.push(
        `synthesis strategy failed: ${error instanceof Error ? error.name : "unknown error"}`,
      )
      return this.fallbackSynthesizer.synthesize(topics, memories)
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

import { MemoryCatalog, renderCatalog, type CatalogSnapshot } from "./catalog.js"
import type { OrchestratorConfig } from "./config.js"
import type {
  CandidateLifecycleState,
  CorrectionCandidate,
  CorrectionInput,
  CorrectionReviewQueue,
} from "./correction.js"
import { MemoryDiagnostics } from "./diagnostics.js"
import { institutionalApplies, institutionalReviewStatus } from "./institutional.js"
import { isObservationStore } from "./observation.js"
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
    applicability: [],
  }
}

function semanticPlan(
  prompt: string,
  result: SemanticRecognitionResult,
  providerIds: string[],
  minimumSimilarity: number,
  maxTopics: number,
  maxResults: number,
  applicability: NonNullable<RetrievalPlan["applicability"]>,
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
    applicability,
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
  /**
   * Owns the correction-candidate review lifecycle. Deliberately not exposed
   * with its mutating approve/reject/requestChanges methods anywhere in this
   * class -- only read-only status/diagnostics are surfaced here, so no
   * agent-facing host tool can grant approval by wiring against the
   * orchestrator.
   */
  reviewQueue?: CorrectionReviewQueue
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
  private readonly reviewQueue?: CorrectionReviewQueue

  constructor(
    providers: MemoryProvider[],
    private readonly config: OrchestratorConfig,
    private readonly logger: RememLogger = NOOP_LOGGER,
    dependencies: OrchestratorDependencies = {},
  ) {
    if (dependencies.reviewQueue) this.reviewQueue = dependencies.reviewQueue
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

  private renderActiveCatalog(
    catalog: CatalogSnapshot,
    context: MemoryContext,
    prompt?: string,
    blockedCatalogIds: ReadonlySet<string> = new Set(),
  ): CatalogSnapshot {
    const rendered = renderCatalog(
      catalog.entries.filter(
        (entry) =>
          !blockedCatalogIds.has(entry.id) &&
          (!entry.institutional ||
            (institutionalReviewStatus(entry.institutional) === "current" &&
              institutionalApplies(entry.institutional, context, prompt))),
      ),
      this.config.budgets.catalogTokens,
      catalog.providers,
    )
    return { ...rendered, diagnostics: [...catalog.diagnostics, ...rendered.diagnostics] }
  }

  /**
   * `turnId`, when supplied by the host, identifies the user turn this
   * dispatch belongs to -- see `MemoryDiagnostics.priorDispatch`. Opaque to
   * this method beyond being forwarded to `diagnostics.record`.
   */
  async processPrompt(
    prompt: string,
    context: MemoryContext,
    turnId?: string,
  ): Promise<MemoryInjection> {
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
      const loadedCatalog = await this.catalog.get(context)
      catalogMs = performance.now() - catalogStarted
      const planningStarted = performance.now()
      let plan = this.planner.plan(prompt, loadedCatalog.entries, this.providerIds, context)
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
            loadedCatalog.entries.filter(
              (entry) =>
                !(plan.applicability ?? []).some(
                  ({ catalogEntryId, applicable }) => catalogEntryId === entry.id && !applicable,
                ),
            ),
            catalog.providers,
          )
          const candidate = semanticPlan(
            prompt,
            recognized,
            this.providerIds,
            semanticConfig.minimumSimilarity,
            this.config.planner.maxTopics,
            this.config.maxResults,
            plan.applicability ?? [],
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
      catalog = this.renderActiveCatalog(
        loadedCatalog,
        context,
        prompt,
        new Set(
          (plan.applicability ?? [])
            .filter(({ applicable }) => !applicable)
            .map(({ catalogEntryId }) => catalogEntryId),
        ),
      )
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
        prompt,
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
        applicability: plan.applicability ?? [],
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
      this.diagnostics.record(trace, "dispatch", turnId)
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
        prompt,
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
      this.diagnostics.record(trace, "dispatch", turnId)
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
      prompt: query,
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
    this.diagnostics.record(trace, "search")
    this.logTrace(trace)
    return {
      text: synthesis.text || "No relevant memories were found in the selected providers.",
      trace,
    }
  }

  async compactionContext(context: MemoryContext): Promise<string> {
    const catalog = this.renderActiveCatalog(await this.catalog.get(context), context)
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
        if (!isObservationStore(provider)) return undefined
        try {
          const candidateStatus = provider.candidateStatus.bind(provider)
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

  /**
   * The dispatch trace for the turn before the current one, for callers
   * (e.g. `memory_submit_correction`) that need the retrieval decision
   * behind an already-delivered response, not whatever the current turn's
   * own message happens to be. A single "latest trace" per session cannot
   * disambiguate these: when the current turn's message is itself a
   * correction ("that answer was wrong; X is required"), the "context" hook
   * running for that turn records a fresh dispatch trace for the
   * correction message before any tool call in that same turn can run, so
   * `explain()`'s "latest" would return the trace for the correction text,
   * not for the disputed response. See `MemoryDiagnostics.priorDispatch`.
   */
  explainPreviousTurn(sessionId: string): MemoryTrace | { status: "no-trace" } {
    return this.diagnostics.priorDispatch(sessionId) ?? { status: "no-trace" }
  }

  /**
   * Submits a correction to the review queue, then immediately runs
   * diagnosis/mutation-proposal/structural-validation/replay -- validation
   * is a deterministic, fully automatic pipeline with no human judgment
   * involved, unlike approve/reject/requestChanges, so running it here
   * (rather than requiring a second call nothing in this codebase's shipped
   * surfaces would ever make) is what gets a candidate to "validated" or
   * "needs_changes" at all. Read/write access to approve, reject, or
   * request changes on the resulting candidate is intentionally not
   * available through the orchestrator -- see
   * `OrchestratorDependencies.reviewQueue`.
   */
  async submitCorrection(
    correction: CorrectionInput,
  ): Promise<CorrectionCandidate | { status: "unavailable" }> {
    if (!this.reviewQueue) return { status: "unavailable" }
    const submitted = await this.reviewQueue.submit(correction)
    return this.reviewQueue.runValidation(submitted.id)
  }

  /**
   * Re-runs validation for a candidate already in "pending_validation" or
   * "needs_changes" -- e.g. after a human fixes whatever caused
   * "needs_changes" the first time, or as an explicit retry. Not needed
   * after a plain `submitCorrection` call, which already validates once.
   */
  async runCorrectionValidation(
    candidateId: string,
  ): Promise<CorrectionCandidate | { status: "unavailable" }> {
    if (!this.reviewQueue) return { status: "unavailable" }
    return this.reviewQueue.runValidation(candidateId)
  }

  async reviewCandidates(filter?: {
    state?: CandidateLifecycleState
  }): Promise<CorrectionCandidate[] | { status: "unavailable" }> {
    if (!this.reviewQueue) return { status: "unavailable" }
    return this.reviewQueue.list(filter)
  }

  async explainCorrectionCandidate(
    candidateId: string,
  ): Promise<CorrectionCandidate | { status: "unavailable" | "not-found" }> {
    if (!this.reviewQueue) return { status: "unavailable" }
    return (await this.reviewQueue.get(candidateId)) ?? { status: "not-found" }
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

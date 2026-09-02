import type { OrchestratorConfig } from "./config.js"
import { clamp, contentFingerprint } from "./text.js"
import { OperationTimeoutError, withTimeout } from "./timeout.js"
import type {
  MemoryContext,
  MemoryFreshness,
  MemoryProvider,
  MemoryResult,
  MemoryScopeKind,
  ProviderAttempt,
  RankedMemory,
  RecallResult,
  RetrievalPlan,
} from "./types.js"

const SCOPE_BONUS: Record<MemoryScopeKind, number> = {
  session: 0.05,
  project: 0.04,
  workspace: 0.03,
  global: 0.01,
}

const FRESHNESS_BONUS: Record<MemoryFreshness, number> = {
  current: 0.05,
  unknown: 0,
  stale: -0.08,
  superseded: -0.2,
}

function recencyBonus(updatedAt?: string): number {
  if (!updatedAt) return 0
  const timestamp = Date.parse(updatedAt)
  if (!Number.isFinite(timestamp)) return 0
  const ageDays = (Date.now() - timestamp) / 86_400_000
  if (ageDays <= 30) return 0.04
  if (ageDays <= 365) return 0.02
  return 0
}

function rankMemory(result: MemoryResult, plannerConfidence: number): RankedMemory {
  const record = result.record
  const rank = clamp(
    clamp(result.score) * 0.66 +
      plannerConfidence * 0.12 +
      clamp(record.importance ?? 0.5) * 0.08 +
      clamp(record.confidence ?? 0.5) * 0.04 +
      SCOPE_BONUS[record.scope.kind] +
      FRESHNESS_BONUS[record.freshness] +
      recencyBonus(record.updatedAt),
  )
  return { ...result, rank, duplicateSources: [] }
}

function deduplicate(results: MemoryResult[], confidence: number): RankedMemory[] {
  const ranked = results
    .map((result) => rankMemory(result, confidence))
    .sort((a, b) => b.rank - a.rank)
  const identities = new Map<string, RankedMemory>()
  const fingerprints = new Map<string, RankedMemory>()
  const unique: RankedMemory[] = []

  for (const result of ranked) {
    const identity = `${result.record.providerId}\0${result.record.id}`
    const fingerprint = result.fingerprint ?? contentFingerprint(result.record.content)
    const existing = identities.get(identity) ?? fingerprints.get(fingerprint)
    if (existing) {
      existing.duplicateSources.push({
        providerId: result.record.providerId,
        id: result.record.id,
        source: result.record.source,
      })
      identities.set(identity, existing)
      continue
    }
    identities.set(identity, result)
    if (fingerprint.length > 0) fingerprints.set(fingerprint, result)
    unique.push(result)
  }
  return unique
}

function errorLabel(error: unknown): string {
  if (error instanceof OperationTimeoutError) return "timeout"
  if (error instanceof Error) return error.name || "Error"
  return "unknown error"
}

export class RecallEngine {
  private readonly providers: Map<string, MemoryProvider>

  constructor(
    providers: MemoryProvider[],
    private readonly config: OrchestratorConfig,
  ) {
    this.providers = new Map()
    for (const provider of providers) {
      if (!this.providers.has(provider.id)) this.providers.set(provider.id, provider)
    }
  }

  async execute(
    plan: RetrievalPlan,
    context: MemoryContext,
    parentSignal?: AbortSignal,
  ): Promise<RecallResult> {
    if (!plan.shouldRetrieve) {
      return { memories: [], attempts: [], rawCount: 0, deduplicatedCount: 0 }
    }

    const settled = await Promise.all(
      plan.requests.map(async (request) => {
        const provider = this.providers.get(request.providerId)
        if (!provider) {
          return {
            results: [] as MemoryResult[],
            attempt: {
              providerId: request.providerId,
              status: "failed",
              durationMs: 0,
              resultCount: 0,
              error: "provider unavailable",
            } satisfies ProviderAttempt,
          }
        }
        const started = performance.now()
        try {
          const capabilities = provider.capabilities()
          if (!capabilities.lexicalSearch && !capabilities.semanticSearch) {
            return {
              results: [] as MemoryResult[],
              attempt: {
                providerId: provider.id,
                status: "failed",
                durationMs: 0,
                resultCount: 0,
                error: "provider does not advertise search capability",
              } satisfies ProviderAttempt,
            }
          }
          const results = await withTimeout(
            this.config.providerTimeoutMs,
            (signal) =>
              provider.search({
                query: request.query,
                topics: plan.topics,
                context,
                limit: Math.min(request.limit, this.config.maxResults),
                maxTokens: this.config.budgets.perProviderTokens,
                reason: request.reason,
                signal,
              }),
            parentSignal,
          )
          return {
            results: results.slice(0, this.config.maxResults),
            attempt: {
              providerId: provider.id,
              status: "ok",
              durationMs: Math.round(performance.now() - started),
              resultCount: results.length,
            } satisfies ProviderAttempt,
          }
        } catch (error) {
          if (parentSignal?.aborted) throw error
          return {
            results: [] as MemoryResult[],
            attempt: {
              providerId: provider.id,
              status: error instanceof OperationTimeoutError ? "timed_out" : "failed",
              durationMs: Math.round(performance.now() - started),
              resultCount: 0,
              error: errorLabel(error),
            } satisfies ProviderAttempt,
          }
        }
      }),
    )

    const raw = settled.flatMap((result) => result.results)
    const deduplicated = deduplicate(raw, plan.confidence)
    const memories = deduplicated.slice(0, this.config.maxResults)
    return {
      memories,
      attempts: settled.map((result) => result.attempt),
      rawCount: raw.length,
      deduplicatedCount: deduplicated.length,
    }
  }
}

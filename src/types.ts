export type MemoryScopeKind = "global" | "workspace" | "project" | "session"

export interface MemoryScope {
  kind: MemoryScopeKind
  id?: string
}

export type MemoryType =
  "semantic" | "episodic" | "decision" | "preference" | "procedure" | "task" | "other"

export type MemoryFreshness = "current" | "stale" | "superseded" | "unknown"

export interface MemoryCapabilities {
  lexicalSearch: boolean
  semanticSearch: boolean
  metadataFiltering: boolean
  catalog: boolean
  read: boolean
  write: boolean
  update: boolean
  delete: boolean
  episodicHistory: boolean
  structuredEntities: boolean
  filesystemDocuments: boolean
}

export interface MemoryContext {
  directory: string
  worktree: string
  projectId: string
  sessionId?: string
}

export interface CatalogEntry {
  id: string
  title: string
  aliases: string[]
  summary: string
  providerIds: string[]
  scope: MemoryScope
  tags: string[]
  importance: number
  unresolved: boolean
  source?: string
}

export interface MemoryRecord {
  providerId: string
  id: string
  title: string
  content: string
  source: string
  scope: MemoryScope
  type: MemoryType
  freshness: MemoryFreshness
  createdAt?: string
  updatedAt?: string
  confidence?: number
  importance?: number
  metadata?: Record<string, unknown>
}

export interface MemoryResult {
  record: MemoryRecord
  score: number
  reasons: string[]
  fingerprint?: string
}

export interface MemorySearchRequest {
  query: string
  topics: string[]
  context: MemoryContext
  scopes?: MemoryScopeKind[]
  types?: MemoryType[]
  limit: number
  maxTokens: number
  reason: string
  signal: AbortSignal
}

export interface MemoryWrite {
  title: string
  content: string
  source?: string
  scope: MemoryScope
  type: MemoryType
  confidence?: number
  importance?: number
  metadata?: Record<string, unknown>
}

export interface ProviderHealth {
  status: "healthy" | "degraded" | "unavailable"
  message?: string
  checkedAt: string
}

export interface MemoryProvider {
  readonly id: string
  capabilities(): MemoryCapabilities
  catalog(context: MemoryContext, signal: AbortSignal): Promise<CatalogEntry[]>
  search(request: MemorySearchRequest): Promise<MemoryResult[]>
  get?(id: string, context: MemoryContext): Promise<MemoryRecord | undefined>
  write?(memory: MemoryWrite): Promise<MemoryRecord>
  update?(id: string, memory: MemoryWrite): Promise<MemoryRecord>
  delete?(id: string, context: MemoryContext): Promise<void>
  health?(): Promise<ProviderHealth>
  refresh?(): void | Promise<void>
}

export interface CatalogMatch {
  entry: CatalogEntry
  score: number
  reasons: string[]
}

export interface ProviderRetrievalRequest {
  providerId: string
  query: string
  reason: string
  limit: number
}

export interface RetrievalPlan {
  shouldRetrieve: boolean
  confidence: number
  topics: string[]
  requests: ProviderRetrievalRequest[]
  matches: CatalogMatch[]
  signals: string[]
}

export interface RankedMemory extends MemoryResult {
  rank: number
  duplicateSources: Array<{
    providerId: string
    id: string
    source: string
  }>
}

export interface ProviderAttempt {
  providerId: string
  status: "ok" | "failed" | "timed_out"
  durationMs: number
  resultCount: number
  error?: string
}

export interface RecallResult {
  memories: RankedMemory[]
  attempts: ProviderAttempt[]
  rawCount: number
  deduplicatedCount: number
}

export interface SynthesisResult {
  text: string
  estimatedTokens: number
  selectedCount: number
  omittedCount: number
}

export interface MemoryTrace {
  sessionId: string
  timestamp: string
  catalogEntries: number
  catalogMatches: Array<{ id: string; title: string; score: number }>
  shouldRetrieve: boolean
  confidence: number
  topics: string[]
  signals: string[]
  providers: ProviderAttempt[]
  rawResults: number
  deduplicatedResults: number
  selectedResults: number
  catalogTokens: number
  recallTokens: number
  totalDurationMs: number
  diagnostics: string[]
}

export interface MemoryInjection {
  text: string
  plan: RetrievalPlan
  trace: MemoryTrace
}

export interface RememLogger {
  log(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    data?: Record<string, unknown>,
  ): void | Promise<void>
}

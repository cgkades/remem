export type MemoryScopeKind = "global" | "workspace" | "project" | "session"

export interface MemoryScope {
  kind: MemoryScopeKind
  id?: string
}

export interface InstitutionalReview {
  reviewedAt: string
  expiresAt: string | null
}

export type ApplicabilityCondition =
  | {
      id: string
      kind: "context"
      field: "directory" | "worktree" | "projectId" | "sessionId"
      value: string
    }
  | {
      id: string
      kind: "topic"
      value: string
    }

export interface InstitutionalApplicability {
  match: "all" | "any"
  conditions: ApplicabilityCondition[]
}

export interface InstitutionalPosition {
  role: "position"
  id: string
  owner?: string
  authority?: string
  sourceRefs: string[]
  boundaryConditions: string[]
  applicability: InstitutionalApplicability
  review: InstitutionalReview
  dependsOnPositionIds?: string[]
}

export interface InstitutionalProcedureStep {
  id: string
  instruction: string
}

export interface InstitutionalProcedure {
  role: "procedure"
  id: string
  steps: InstitutionalProcedureStep[]
  positionIds: string[]
  procedureIds?: string[]
  requiredEvidence: string[]
  completionCriteria: string[]
  escalationConditions: string[]
  applicability: InstitutionalApplicability
  review: InstitutionalReview
}

export type InstitutionalMemory = InstitutionalPosition | InstitutionalProcedure

export type MemoryType =
  "semantic" | "episodic" | "decision" | "preference" | "procedure" | "task" | "other"

export type MemoryFreshness = "current" | "stale" | "superseded" | "unknown"

export interface MemorySource {
  id?: string
  kind: "user" | "session" | "document" | "provider" | "import" | "generated" | "other"
  uri?: string
  providerId?: string
  externalId?: string
  observedAt?: string
  metadata?: Record<string, unknown>
}

export interface MemoryProvenance {
  source: MemorySource
  capturedAt: string
  original: boolean
  note?: string
}

export interface MemoryEntity {
  id?: string
  name: string
  type?: string
  aliases?: string[]
  metadata?: Record<string, unknown>
}

export interface MemoryRelationship {
  type: string
  targetMemoryId?: string
  targetEntity?: string
  metadata?: Record<string, unknown>
}

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
  parentId?: string
  embedding?: number[]
  institutional?: InstitutionalMemory
}

export interface ProviderDescriptor {
  id: string
  name: string
  summary: string
  categories: string[]
  aliases: string[]
  scopeKinds: MemoryScopeKind[]
  embedding?: number[]
}

export interface MemoryRecord {
  providerId: string
  id: string
  title: string
  content: string
  summary?: string
  source: string
  scope: MemoryScope
  type: MemoryType
  freshness: MemoryFreshness
  createdAt?: string
  updatedAt?: string
  observedAt?: string
  confidence?: number
  importance?: number
  aliases?: string[]
  tags?: string[]
  entities?: MemoryEntity[]
  relationships?: MemoryRelationship[]
  unresolved?: boolean
  provenance?: MemoryProvenance[]
  metadata?: Record<string, unknown>
  institutional?: InstitutionalMemory
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
  id?: string
  title: string
  content: string
  summary?: string
  source?: string
  scope: MemoryScope
  type: MemoryType
  freshness?: MemoryFreshness
  observedAt?: string
  confidence?: number
  importance?: number
  aliases?: string[]
  tags?: string[]
  entities?: MemoryEntity[]
  relationships?: MemoryRelationship[]
  unresolved?: boolean
  provenance?: MemoryProvenance[]
  embedding?: number[]
  metadata?: Record<string, unknown>
  institutional?: InstitutionalMemory
}

export interface MemoryMutationOptions {
  context?: MemoryContext
  signal?: AbortSignal
  actor?: string
  reason?: string
}

export interface ProviderHealth {
  status: "healthy" | "degraded" | "unavailable"
  message?: string
  checkedAt: string
}

export interface MemoryProvider {
  readonly id: string
  capabilities(): MemoryCapabilities
  descriptor?(): ProviderDescriptor | Promise<ProviderDescriptor>
  catalog(context: MemoryContext, signal: AbortSignal): Promise<CatalogEntry[]>
  search(request: MemorySearchRequest): Promise<MemoryResult[]>
  get?(id: string, context: MemoryContext): Promise<MemoryRecord | undefined>
  write?(memory: MemoryWrite, options?: MemoryMutationOptions): Promise<MemoryRecord>
  update?(id: string, memory: MemoryWrite, options?: MemoryMutationOptions): Promise<MemoryRecord>
  supersede?(
    id: string,
    replacement: MemoryWrite,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord>
  delete?(id: string, context: MemoryContext, options?: MemoryMutationOptions): Promise<void>
  health?(): Promise<ProviderHealth>
  refresh?(): void | Promise<void>
  dispose?(): void | Promise<void>
}

export interface EmbeddingModel {
  readonly id: string
  readonly dimensions: number
  embed(text: string, signal?: AbortSignal): Promise<number[]>
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
  topics?: string[]
}

export interface RetrievalPlan {
  shouldRetrieve: boolean
  confidence: number
  topics: string[]
  requests: ProviderRetrievalRequest[]
  matches: CatalogMatch[]
  signals: string[]
  applicability?: ApplicabilityDecision[]
}

export interface ApplicabilityDecision {
  catalogEntryId: string
  institutionalId: string
  applicable: boolean
  reason: string
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
  applicability?: ApplicabilityDecision[]
  providers: ProviderAttempt[]
  rawResults: number
  deduplicatedResults: number
  selectedResults: number
  catalogTokens: number
  recallTokens: number
  totalDurationMs: number
  diagnostics: string[]
  recognitionStage?: "none" | "deterministic" | "semantic" | "continuity"
  semanticAttempted?: boolean
  timings?: {
    catalogMs: number
    planningMs: number
    recallMs: number
    synthesisMs: number
  }
}

export interface MemoryInjection {
  text: string
  catalogText: string
  memoryText: string
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

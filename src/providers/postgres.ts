import { randomUUID } from "node:crypto"
import { Pool, type PoolClient, type QueryResultRow } from "pg"
import type { PostgresProviderConfig } from "../config.js"
import {
  COMPACTION_ELIGIBILITY_DAYS,
  DEFAULT_CAPACITY_LIMITS,
  DEFAULT_HARD_LIMIT_WARNING_THROTTLE_MS,
  bulkArtifactTargetBytes,
  capacityStatus,
  compactionLevelAtIndex,
  compactionLevelIndex,
  decideEscalation,
  narrativeTargetBytes,
  type CapacityLimits,
  type CapacityStatus,
  type CompactionLevel,
  type HardLimitWarning,
} from "../capacity.js"
import { looksLikeToolOutput, reduceBulkArtifact } from "../bulk-artifact-reduction.js"
import type {
  CandidateMemory,
  CandidateReviewItem,
  CandidateReviewStore,
  CandidateStatusSummary,
  CapacityStore,
  CompactionReport,
  EnforceCapacityOptions,
  EnforceCapacityReport,
  EpisodicAppendResult,
  EpisodicNeighbor,
  EpisodicSearchMatch,
  EpisodicSearchOptions,
  EpisodicSearchResult,
  EpisodicSearchStore,
  EpisodicSupersessionStore,
  ForgetConfirmation,
  ForgetPreview,
  ForgetStore,
  HardLimitEvictionReport,
  SessionObservation,
  SupersessionCandidate,
} from "../observation.js"
import {
  EPISODIC_SEARCH_MAX_NEIGHBORS_PER_SIDE,
  EPISODIC_SEARCH_MAX_OUTPUT_TOKENS,
  EPISODIC_SEARCH_MAX_RESULTS,
  FORGET_PREVIEW_TTL_MS,
  SUPERSESSION_CANDIDATE_MAX_RESULTS,
} from "../observation.js"
import {
  EVIDENCE_KINDS,
  EVIDENCE_ORIGINS,
  EVIDENCE_ROLES,
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceEnvelope,
  type EvidenceReference,
} from "../observation-admission.js"
import {
  DeterministicConsolidationPipeline,
  PostgresConsolidationRunner,
} from "../consolidation.js"
import {
  institutionalReviewStatus,
  isInstitutionalMemory,
  validateInstitutionalMemory,
} from "../institutional.js"
import { PostgresReembedRunner } from "../reembedding.js"
import { FORGET_RESTORE_ADVISORY_LOCK } from "../forget.js"
import { LocalHashEmbeddingModel, vectorLiteral } from "../storage/embedding.js"
import { EMBEDDING_DIMENSIONS } from "../storage/embedding-model-ids.js"
import { estimateTokens, truncateToTokens } from "../token-budget.js"
import type {
  CatalogEntry,
  EmbeddingModel,
  MemoryContext,
  MemoryEntity,
  MemoryMutationOptions,
  MemoryProvenance,
  MemoryProvider,
  MemoryRecord,
  MemoryRelationship,
  MemoryResult,
  MemoryScope,
  MemorySearchRequest,
  MemorySource,
  MemoryWrite,
  ProviderDescriptor,
  ProviderHealth,
} from "../types.js"

/**
 * TASK-012/TASK-060: bounds how many rows one `runCompaction`/
 * `enforceHardLimit` call processes. A single call is not guaranteed to
 * fully drain a large backlog -- a caller (or scheduler) invokes these
 * repeatedly. Deliberately conservative for the current pre-launch scale
 * of installations; revisit if a project accumulates a backlog large
 * enough that draining it requires many repeated calls in practice.
 */
const COMPACTION_BATCH_SIZE = 500
const HARD_LIMIT_BATCH_SIZE = 1000
const EVIDENCE_ID_PATTERN = /^[a-f0-9]{64}$/u

interface MemoryRow extends QueryResultRow {
  id: string
  provider_id: string
  title: string
  content: string
  summary: string
  source: string | null
  scope_kind: MemoryScope["kind"]
  scope_id: string | null
  type: MemoryRecord["type"]
  freshness: MemoryRecord["freshness"]
  created_at: Date
  updated_at: Date
  observed_at: Date | null
  confidence: number | null
  importance: number
  unresolved: boolean
  metadata: Record<string, unknown>
  aliases: string[]
  tags: string[]
  lexical_score?: number
  semantic_score?: number
  provenance?: MemoryProvenance[]
  entities?: MemoryEntity[]
  relationships?: MemoryRelationship[]
}

interface ForgetPreviewRow extends QueryResultRow {
  id: string
  provider_id: string
  project_id: string
  evidence_id: string
  session_event_id: string
  candidate_ids: string[]
  created_at: Date
  expires_at: Date
  confirmed_at: Date | null
}

interface SupersessionCandidateRow extends QueryResultRow {
  evidence_id: string
  newer_decision_evidence_id: string
  shared_entity_id: string
  occurred_at: Date
  newer_decision_occurred_at: Date
}

function forgetPreviewFromRow(row: ForgetPreviewRow): ForgetPreview {
  return {
    id: row.id,
    providerId: row.provider_id,
    projectId: row.project_id,
    evidenceId: row.evidence_id,
    episodeCount: 1,
    candidateCount: row.candidate_ids.length,
    semanticMemoryCount: 0,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  }
}

/** Phase 3 (TASK-010): the columns `appendEvidence`/`readEvidence` (and TASK-011's search) read back from `remem.session_events` for the evidence-admission path. Only rows with `evidence_id IS NOT NULL` are ever selected into this shape. */
interface EpisodicEventRow extends QueryResultRow {
  id: string
  session_id: string
  project_id: string
  provider_id: string
  kind: EvidenceEnvelope["kind"]
  occurred_at: Date
  host: string
  role: EvidenceEnvelope["role"]
  origin: EvidenceEnvelope["origin"]
  turn_id: string | null
  message_id: string | null
  safe_text: string | null
  /** The pre-existing `payload jsonb` column, holding `EvidencePayload.metadata` for evidence-admission rows (`{}` if the envelope had none). */
  payload: Record<string, unknown>
  evidence_refs: EvidenceReference[]
  evidence_id: string
  content_hash: string
  schema_version: number
}

/**
 * Reconstructs an `EvidenceEnvelope` from a stored row. `directory`/
 * `worktree` are not persisted columns (the plan's Observation Field
 * Checklist scopes episodic admission by project/session, not by a
 * specific filesystem path) -- they are not meaningful to reconstruct from
 * storage, so this returns an empty-string placeholder for both regardless
 * of what the original admitting session's filesystem path was; callers
 * must not treat a read-back envelope's `context.directory`/`worktree` as
 * authoritative.
 */
function episodicRowToEnvelope(row: EpisodicEventRow): EvidenceEnvelope {
  // schema_version has no DB CHECK constraint (unlike role/origin/kind) --
  // its entire purpose is to let a future incompatible envelope shape be
  // detected rather than silently mis-cast as today's shape. Reject rather
  // than blindly narrow an unexpected value into the current literal type.
  if (row.schema_version !== EVIDENCE_SCHEMA_VERSION) {
    throw new Error(
      `episodic evidence row has unsupported schemaVersion ${row.schema_version} (expected ${EVIDENCE_SCHEMA_VERSION})`,
    )
  }
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    id: row.evidence_id,
    providerId: row.provider_id,
    host: row.host,
    context: {
      directory: "",
      worktree: "",
      projectId: row.project_id,
      sessionId: row.session_id,
    },
    ...(row.turn_id !== null ? { turnId: row.turn_id } : {}),
    ...(row.message_id !== null ? { messageId: row.message_id } : {}),
    role: row.role,
    origin: row.origin,
    kind: row.kind,
    occurredAt: row.occurred_at.toISOString(),
    payload: {
      ...(row.safe_text !== null ? { text: row.safe_text } : {}),
      ...(Object.keys(row.payload ?? {}).length > 0 ? { metadata: row.payload } : {}),
    },
    evidenceRefs: row.evidence_refs,
    contentHash: row.content_hash,
  }
}

/**
 * TASK-011: shrinks an envelope's `payload.text` (never `metadata` or any
 * other field) to fit within `remainingTokens`, so a single verbose event
 * cannot silently consume the entire output-token budget meant to also
 * cover its neighbors and the remaining ranked matches. Token cost is
 * estimated over the whole envelope (not just the text) so the running
 * budget also accounts for metadata/refs/identity fields, not merely the
 * free-text portion.
 *
 * `fits: false` means the envelope could not be brought under
 * `remainingTokens` even after shrinking `text` to nothing (either because
 * there was no `text` to shrink -- a metadata-only event -- or because the
 * fixed (non-text) portion of the envelope alone already exceeds the
 * budget). The caller must omit the envelope entirely in that case: this
 * function never returns an envelope known to exceed the caller's stated
 * budget, so `EPISODIC_SEARCH_MAX_OUTPUT_TOKENS` remains a real ceiling
 * rather than one a large-metadata, no-text event can silently blow past.
 */
function fitEnvelopeToBudget(
  envelope: EvidenceEnvelope,
  remainingTokens: number,
): { envelope: EvidenceEnvelope; truncated: boolean; tokensUsed: number; fits: boolean } {
  const wholeCost = estimateTokens(JSON.stringify(envelope))
  if (wholeCost <= remainingTokens) {
    return { envelope, truncated: false, tokensUsed: wholeCost, fits: true }
  }
  if (envelope.payload.text === undefined) {
    // No free text to shrink -- a metadata-only envelope that alone
    // exceeds the budget cannot be fit by this function at all.
    return { envelope, truncated: false, tokensUsed: wholeCost, fits: false }
  }
  const fixedCost = estimateTokens(
    JSON.stringify({ ...envelope, payload: { ...envelope.payload, text: "" } }),
  )
  if (fixedCost > remainingTokens) {
    // Even fully truncating text to "" wouldn't fit -- the envelope's
    // non-text fields alone (metadata, refs, identity) exceed the budget.
    return { envelope, truncated: false, tokensUsed: fixedCost, fits: false }
  }
  const textBudget = Math.max(0, remainingTokens - fixedCost)
  const { text, truncated } = truncateToTokens(envelope.payload.text, textBudget)
  const fitted: EvidenceEnvelope = { ...envelope, payload: { ...envelope.payload, text } }
  return {
    envelope: fitted,
    truncated,
    tokensUsed: estimateTokens(JSON.stringify(fitted)),
    fits: true,
  }
}

interface CatalogRow extends QueryResultRow {
  id: string
  memory_id: string | null
  parent_id: string | null
  title: string
  summary: string
  aliases: string[]
  tags: string[]
  scope_kind: MemoryScope["kind"]
  scope_id: string | null
  importance: number
  unresolved: boolean
  source: string | null
  embedding: string | null
  institutional?: unknown
}

export interface PostgresMemoryProviderOptions {
  pool?: Pool
  embeddingModel?: EmbeddingModel
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

// The remem.memory_embeddings and remem.catalog_entries.embedding columns are
// fixed-width vector(384). Switching to a different-dimension model requires
// a dedicated schema migration that is not yet implemented.
const SUPPORTED_EMBEDDING_DIMENSIONS = EMBEDDING_DIMENSIONS

function clamp(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.min(1, value))
}

function uniqueStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))]
}

function parseVector(value: string): number[] {
  return value.slice(1, -1).split(",").map(Number)
}

function institutionalMetadata(
  value: unknown,
): NonNullable<MemoryRecord["institutional"]> | undefined {
  return isInstitutionalMemory(value) ? value : undefined
}

function assertValidInstitutionalReview(memory: MemoryWrite): void {
  if (
    memory.institutional &&
    (!institutionalMetadata(memory.institutional) ||
      institutionalReviewStatus(memory.institutional) === "invalid")
  ) {
    throw new TypeError("institutional memory has an invalid review timestamp")
  }
  if (
    (memory.institutional?.role === "position" && memory.type !== "decision") ||
    (memory.institutional?.role === "procedure" && memory.type !== "procedure")
  ) {
    throw new TypeError("institutional memory has an invalid memory type")
  }
  if (memory.institutional) {
    const validation = validateInstitutionalMemory({
      ...memory,
      provenance:
        memory.provenance && memory.provenance.length > 0
          ? memory.provenance
          : [
              {
                source: sourceFromWrite(memory),
                capturedAt: new Date().toISOString(),
                original: true,
              },
            ],
    })
    if (!validation.valid) {
      throw new TypeError(validation.issues[0]?.message ?? "invalid institutional memory")
    }
  }
}

function rowToRecord(row: MemoryRow): MemoryRecord {
  const institutional = institutionalMetadata(row.metadata.institutional)
  return {
    providerId: row.provider_id,
    id: row.id,
    title: row.title,
    content: row.content,
    summary: row.summary,
    source: row.source ?? `remem://${row.provider_id}/${row.id}`,
    scope: { kind: row.scope_kind, ...(row.scope_id ? { id: row.scope_id } : {}) },
    type: row.type,
    freshness: row.freshness,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.observed_at ? { observedAt: row.observed_at.toISOString() } : {}),
    ...(row.confidence === null ? {} : { confidence: row.confidence }),
    importance: row.importance,
    aliases: row.aliases ?? [],
    tags: row.tags ?? [],
    entities: row.entities ?? [],
    relationships: row.relationships ?? [],
    unresolved: row.unresolved,
    provenance: row.provenance ?? [],
    metadata: row.metadata ?? {},
    ...(institutional ? { institutional } : {}),
  }
}

function scopeId(memory: MemoryWrite, context?: MemoryContext): string | undefined {
  if (memory.scope.kind === "global") return undefined
  if (memory.scope.id) return memory.scope.id
  if (!context) return undefined
  if (memory.scope.kind === "workspace") return context.worktree
  if (memory.scope.kind === "project") return context.projectId
  return context.sessionId
}

function sourceFromWrite(memory: MemoryWrite): MemorySource {
  const first = memory.provenance?.[0]?.source
  if (first) return first
  return {
    kind: "user",
    ...(memory.source ? { uri: memory.source } : { uri: "remem://explicit-write" }),
  }
}

const BASE_SELECT = `
  SELECT
    m.id, m.provider_id, m.title, m.content, m.summary,
    COALESCE(s.uri, s.external_id) AS source,
    m.scope_kind, m.scope_id, m.type, m.freshness,
    m.created_at, m.updated_at, m.observed_at, m.confidence, m.importance,
    m.unresolved, m.metadata,
    COALESCE((SELECT array_agg(a.alias ORDER BY a.alias) FROM remem.memory_aliases a WHERE a.memory_id = m.id), '{}') AS aliases,
    COALESCE((SELECT array_agg(t.tag ORDER BY t.tag) FROM remem.memory_tags t WHERE t.memory_id = m.id), '{}') AS tags,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'source', jsonb_build_object(
          'id', ps.id, 'kind', ps.kind, 'uri', ps.uri, 'providerId', ps.provider_id,
          'externalId', ps.external_id, 'observedAt', ps.observed_at, 'metadata', ps.metadata
        ),
        'capturedAt', mp.captured_at, 'original', mp.original, 'note', mp.note
      ) ORDER BY mp.captured_at)
      FROM remem.memory_provenance mp
      JOIN remem.sources ps ON ps.id = mp.source_id
      WHERE mp.memory_id = m.id
    ), '[]'::jsonb) AS provenance,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', e.id, 'name', e.name, 'type', e.type, 'aliases', e.aliases, 'metadata', e.metadata
      ) ORDER BY e.name)
      FROM remem.memory_entities me
      JOIN remem.entities e ON e.id = me.entity_id
      WHERE me.memory_id = m.id
    ), '[]'::jsonb) AS entities,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'type', r.type, 'targetMemoryId', r.target_memory_id,
        'targetEntity', e.name, 'metadata', r.metadata
      ) ORDER BY r.created_at)
      FROM remem.relationships r
      LEFT JOIN remem.entities e ON e.id = r.target_entity_id
      WHERE r.source_memory_id = m.id
    ), '[]'::jsonb) AS relationships
  FROM remem.memories m
  LEFT JOIN remem.sources s ON s.id = m.source_id
`

export class PostgresMemoryProvider
  implements
    MemoryProvider,
    CandidateReviewStore,
    EpisodicSearchStore,
    CapacityStore,
    ForgetStore,
    EpisodicSupersessionStore
{
  readonly id: string
  private readonly pool: Pool
  private readonly embeddingModel: EmbeddingModel
  private readonly ownsPool: boolean

  /** Exposes the underlying connection pool so other durable stores (e.g. `PostgresCorrectionCandidateStore`) can share it instead of opening a second pool to the same database. */
  get connectionPool(): Pool {
    return this.pool
  }

  constructor(
    private readonly config: PostgresProviderConfig,
    options: PostgresMemoryProviderOptions = {},
  ) {
    this.id = config.id
    this.embeddingModel = options.embeddingModel ?? new LocalHashEmbeddingModel()
    if (this.embeddingModel.dimensions !== SUPPORTED_EMBEDDING_DIMENSIONS) {
      throw new TypeError(
        `PostgreSQL storage currently requires ${SUPPORTED_EMBEDDING_DIMENSIONS}-dimensional ` +
          "embeddings (the remem.memory_embeddings column is a fixed-width vector(384)); " +
          "switching to a different-dimension model requires a dedicated schema migration " +
          "that is not yet implemented",
      )
    }
    this.ownsPool = !options.pool
    this.pool =
      options.pool ??
      new Pool({
        connectionString: config.connectionString,
        max: config.maxConnections,
        connectionTimeoutMillis: 2_000,
        idleTimeoutMillis: 30_000,
        query_timeout: 5_000,
        application_name: "remem",
      })
    // Best-effort bookkeeping for a future re-embed job to detect model
    // drift without re-deriving it from a scan. Fire-and-forget: this must
    // never block construction or throw out of the constructor, since it is
    // auxiliary and not load-bearing for correctness.
    void this.recordEmbeddingSettings()
  }

  capabilities() {
    return {
      lexicalSearch: true,
      semanticSearch: true,
      metadataFiltering: true,
      catalog: true,
      read: true,
      write: true,
      update: true,
      delete: true,
      episodicHistory: true,
      structuredEntities: true,
      filesystemDocuments: false,
    }
  }

  async descriptor(): Promise<ProviderDescriptor> {
    const summary =
      "Managed durable memory containing decisions, preferences, procedures, incidents, tasks, and project history."
    // An embedding backend failure must never break OpenCode prompt
    // execution (see search()'s identical fallback): `embedding` is
    // optional on ProviderDescriptor, so this descriptor is still usable
    // for lexical/keyword catalog matching without it.
    let embedding: number[] | undefined
    try {
      embedding = await this.embeddingModel.embed(summary)
    } catch {
      // Fall through with no embedding.
    }
    return {
      id: this.id,
      name: "Remem managed memory",
      summary,
      categories: ["decisions", "preferences", "procedures", "incidents", "tasks", "history"],
      aliases: ["local memory", "managed memory", "prior work"],
      scopeKinds: ["global", "workspace", "project", "session"],
      ...(embedding ? { embedding } : {}),
    }
  }

  async catalog(context: MemoryContext, signal: AbortSignal): Promise<CatalogEntry[]> {
    signal.throwIfAborted()
    const result = await this.pool.query<CatalogRow>(
      `
        SELECT ce.id, ce.memory_id, ce.parent_id, ce.title, ce.summary, ce.aliases, ce.tags,
          ce.scope_kind, ce.scope_id, ce.unresolved, ce.source,
          m.metadata->'institutional' AS institutional,
          CASE WHEN m.freshness = 'stale' THEN ce.importance * 0.5 ELSE ce.importance END AS importance,
          CASE WHEN ce.embedding_model = $6 AND ce.embedding_dimensions = $7
            THEN ce.embedding::text ELSE NULL END AS embedding
        FROM remem.catalog_entries ce
        LEFT JOIN remem.memories m ON m.id = ce.memory_id
        WHERE ce.provider_id = $1 AND (
          ce.scope_kind = 'global' OR
          (ce.scope_kind = 'workspace' AND ce.scope_id = $2) OR
          (ce.scope_kind = 'project' AND ce.scope_id = $3) OR
          (ce.scope_kind = 'session' AND ce.scope_id = $4)
        ) AND (m.id IS NULL OR m.freshness <> 'superseded')
        ORDER BY importance DESC, ce.updated_at DESC
        LIMIT $5
      `,
      [
        this.id,
        context.worktree,
        context.projectId,
        context.sessionId ?? null,
        this.config.catalogLimit,
        this.embeddingModel.id,
        this.embeddingModel.dimensions,
      ],
    )
    signal.throwIfAborted()
    return result.rows.flatMap((row) => {
      const institutional = institutionalMetadata(row.institutional)
      if (row.institutional !== undefined && row.institutional !== null && !institutional) return []
      return [
        {
          id: row.memory_id ?? row.id,
          title: row.title,
          aliases: row.aliases ?? [],
          summary: row.summary,
          providerIds: [this.id],
          scope: { kind: row.scope_kind, ...(row.scope_id ? { id: row.scope_id } : {}) },
          tags: row.tags ?? [],
          importance: row.importance,
          unresolved: row.unresolved,
          ...(row.source ? { source: row.source } : {}),
          ...(row.parent_id ? { parentId: row.parent_id } : {}),
          ...(row.embedding ? { embedding: parseVector(row.embedding) } : {}),
          ...(institutional ? { institutional } : {}),
        },
      ]
    })
  }

  async search(request: MemorySearchRequest): Promise<MemoryResult[]> {
    request.signal.throwIfAborted()
    let embedding: string | null = null
    try {
      embedding = vectorLiteral(await this.embeddingModel.embed(request.query, request.signal))
    } catch {
      request.signal.throwIfAborted()
    }
    const perResultCharacters = Math.max(
      128,
      Math.floor(request.maxTokens / Math.max(1, request.limit)),
    )
    const result = await this.pool.query<MemoryRow>(
      `
        WITH settings AS MATERIALIZED (
          SELECT set_config('hnsw.iterative_scan', 'strict_order', true)
        ),
        query AS (SELECT plainto_tsquery('simple', $5) AS terms),
        lexical_candidates AS (
          SELECT m.id, ts_rank_cd(m.search_vector, query.terms) AS lexical_score,
            0::double precision AS semantic_score
          FROM remem.memories m, query
          WHERE m.provider_id = $1 AND (
            m.scope_kind = 'global' OR
            (m.scope_kind = 'workspace' AND m.scope_id = $2) OR
            (m.scope_kind = 'project' AND m.scope_id = $3) OR
            (m.scope_kind = 'session' AND m.scope_id = $4)
          )
          AND ($8::text[] IS NULL OR m.type = ANY($8::text[]))
          AND ($9::text[] IS NULL OR m.scope_kind = ANY($9::text[]))
          AND m.search_vector @@ query.terms
          ORDER BY lexical_score DESC
          LIMIT $7
        ),
        semantic_candidates AS (
          SELECT m.id, 0::double precision AS lexical_score,
            1 - (me.embedding <=> $6::vector) AS semantic_score
          FROM remem.memory_embeddings me
          JOIN remem.memories m ON m.id = me.memory_id
          CROSS JOIN settings
          WHERE $6::vector IS NOT NULL
          AND me.model = $10 AND me.dimensions = $11
          AND m.provider_id = $1 AND (
            m.scope_kind = 'global' OR
            (m.scope_kind = 'workspace' AND m.scope_id = $2) OR
            (m.scope_kind = 'project' AND m.scope_id = $3) OR
            (m.scope_kind = 'session' AND m.scope_id = $4)
          )
          AND ($8::text[] IS NULL OR m.type = ANY($8::text[]))
          AND ($9::text[] IS NULL OR m.scope_kind = ANY($9::text[]))
          ORDER BY me.embedding <=> $6::vector
          LIMIT $13
        ),
        candidates AS (
          SELECT id, max(lexical_score) AS lexical_score, max(semantic_score) AS semantic_score
          FROM (
            SELECT * FROM lexical_candidates
            UNION ALL
            SELECT * FROM semantic_candidates
          ) combined
          GROUP BY id
          HAVING max(lexical_score) > 0 OR max(semantic_score) >= 0.34
        )
        SELECT m.id, m.provider_id, m.title, left(m.content, $12) AS content, m.summary,
          COALESCE(s.uri, s.external_id) AS source,
          m.scope_kind, m.scope_id, m.type, m.freshness, m.created_at, m.updated_at,
          m.observed_at, m.confidence, m.importance, m.unresolved, m.metadata,
          COALESCE((SELECT array_agg(a.alias ORDER BY a.alias) FROM remem.memory_aliases a WHERE a.memory_id = m.id), '{}') AS aliases,
          COALESCE((SELECT array_agg(t.tag ORDER BY t.tag) FROM remem.memory_tags t WHERE t.memory_id = m.id), '{}') AS tags,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'source', jsonb_build_object(
                'id', ps.id, 'kind', ps.kind, 'uri', ps.uri, 'providerId', ps.provider_id,
                'externalId', ps.external_id, 'observedAt', ps.observed_at, 'metadata', ps.metadata
              ),
              'capturedAt', mp.captured_at, 'original', mp.original, 'note', mp.note
            ) ORDER BY mp.captured_at)
            FROM remem.memory_provenance mp
            JOIN remem.sources ps ON ps.id = mp.source_id
            WHERE mp.memory_id = m.id
          ), '[]'::jsonb) AS provenance,
          candidates.lexical_score, candidates.semantic_score
        FROM candidates
        JOIN remem.memories m ON m.id = candidates.id
        LEFT JOIN remem.sources s ON s.id = m.source_id
        ORDER BY GREATEST(candidates.lexical_score, candidates.semantic_score) DESC,
          m.updated_at DESC
        LIMIT $7
      `,
      [
        this.id,
        request.context.worktree,
        request.context.projectId,
        request.context.sessionId ?? null,
        request.query,
        embedding,
        request.limit,
        request.types ?? null,
        request.scopes ?? null,
        this.embeddingModel.id,
        this.embeddingModel.dimensions,
        perResultCharacters,
        Math.max(32, request.limit * 4),
      ],
    )
    request.signal.throwIfAborted()
    return result.rows.map((row) => {
      const lexical = Number(row.lexical_score ?? 0)
      const semantic = Number(row.semantic_score ?? 0)
      return {
        record: rowToRecord(row),
        score: Math.max(0, Math.min(1, Math.max(lexical, semantic))),
        reasons: [
          ...(lexical > 0 ? ["PostgreSQL full-text match"] : []),
          ...(semantic >= 0.34 ? ["pgvector semantic match"] : []),
        ],
      }
    })
  }

  async get(id: string, context: MemoryContext): Promise<MemoryRecord | undefined> {
    if (!UUID_PATTERN.test(id)) return undefined
    const result = await this.pool.query<MemoryRow>(
      `${BASE_SELECT}
       WHERE m.id = $1 AND m.provider_id = $2 AND (
         m.scope_kind = 'global' OR
         (m.scope_kind = 'workspace' AND m.scope_id = $3) OR
         (m.scope_kind = 'project' AND m.scope_id = $4) OR
         (m.scope_kind = 'session' AND m.scope_id = $5)
       )`,
      [id, this.id, context.worktree, context.projectId, context.sessionId ?? null],
    )
    return result.rows[0] ? rowToRecord(result.rows[0]) : undefined
  }

  async findByConsolidationCandidateId(
    candidateId: string,
    scope: MemoryScope,
    signal?: AbortSignal,
  ): Promise<MemoryRecord | undefined> {
    signal?.throwIfAborted()
    if (!UUID_PATTERN.test(candidateId)) return undefined
    const result = await this.pool.query<MemoryRow>(
      `${BASE_SELECT}
       WHERE m.provider_id = $2
         AND (
           m.metadata->'consolidation'->>'candidateId' = $1 OR
           m.metadata->'consolidation'->>'lastCandidateId' = $1
         )
         AND m.scope_kind = $3
         AND m.scope_id IS NOT DISTINCT FROM $4
       ORDER BY m.updated_at DESC
       LIMIT 1`,
      [candidateId, this.id, scope.kind, scope.id ?? null],
    )
    signal?.throwIfAborted()
    return result.rows[0] ? rowToRecord(result.rows[0]) : undefined
  }

  async write(memory: MemoryWrite, options: MemoryMutationOptions = {}): Promise<MemoryRecord> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const record = await this.writeWithClient(client, memory, options)
      await client.query("COMMIT")
      return record
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  async update(
    id: string,
    memory: MemoryWrite,
    options: MemoryMutationOptions = {},
  ): Promise<MemoryRecord> {
    if (!UUID_PATTERN.test(id)) throw new TypeError("memory id must be a UUID")
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const existing = await client.query<{ created_at: Date; freshness: string }>(
        "SELECT created_at, freshness FROM remem.memories WHERE id = $1 AND provider_id = $2 FOR UPDATE",
        [id, this.id],
      )
      if (!existing.rows[0]) throw new Error("memory not found")
      if (existing.rows[0].freshness === "superseded") {
        throw new Error("superseded memories cannot be updated; update their successor")
      }
      const temporaryId = randomUUID()
      const record = await this.writeWithClient(client, { ...memory, id: temporaryId }, options)
      await client.query(
        `UPDATE remem.memories original SET
           source_id = replacement.source_id,
           type = replacement.type,
           title = replacement.title,
           content = replacement.content,
           summary = replacement.summary,
           scope_kind = replacement.scope_kind,
           scope_id = replacement.scope_id,
           freshness = replacement.freshness,
           confidence = replacement.confidence,
           importance = replacement.importance,
           unresolved = replacement.unresolved,
           superseded_by = replacement.superseded_by,
           observed_at = replacement.observed_at,
           updated_at = now(),
           metadata = replacement.metadata
         FROM remem.memories replacement
         WHERE original.id = $1 AND replacement.id = $2`,
        [id, temporaryId],
      )
      await client.query("DELETE FROM remem.memory_aliases WHERE memory_id = $1", [id])
      await client.query("UPDATE remem.memory_aliases SET memory_id = $1 WHERE memory_id = $2", [
        id,
        temporaryId,
      ])
      await client.query("DELETE FROM remem.memory_tags WHERE memory_id = $1", [id])
      await client.query("UPDATE remem.memory_tags SET memory_id = $1 WHERE memory_id = $2", [
        id,
        temporaryId,
      ])
      await client.query("DELETE FROM remem.memory_provenance WHERE memory_id = $1", [id])
      await client.query("UPDATE remem.memory_provenance SET memory_id = $1 WHERE memory_id = $2", [
        id,
        temporaryId,
      ])
      await client.query("DELETE FROM remem.memory_entities WHERE memory_id = $1", [id])
      await client.query("UPDATE remem.memory_entities SET memory_id = $1 WHERE memory_id = $2", [
        id,
        temporaryId,
      ])
      await client.query("DELETE FROM remem.relationships WHERE source_memory_id = $1", [id])
      await client.query(
        "UPDATE remem.relationships SET source_memory_id = $1 WHERE source_memory_id = $2",
        [id, temporaryId],
      )
      await client.query("DELETE FROM remem.memory_embeddings WHERE memory_id = $1", [id])
      await client.query("UPDATE remem.memory_embeddings SET memory_id = $1 WHERE memory_id = $2", [
        id,
        temporaryId,
      ])
      const temporarySource = `remem://${this.id}/${temporaryId}`
      const canonicalSource = `remem://${this.id}/${id}`
      await client.query(
        `UPDATE remem.catalog_entries original SET
           title = replacement.title,
           summary = replacement.summary,
           aliases = replacement.aliases,
           tags = replacement.tags,
           scope_kind = replacement.scope_kind,
           scope_id = replacement.scope_id,
           importance = replacement.importance,
           unresolved = replacement.unresolved,
           source = CASE WHEN replacement.source = $3 THEN $4 ELSE replacement.source END,
           embedding_model = replacement.embedding_model,
           embedding_dimensions = replacement.embedding_dimensions,
           embedding = replacement.embedding,
           updated_at = now()
         FROM remem.catalog_entries replacement
         WHERE original.memory_id = $1 AND replacement.memory_id = $2`,
        [id, temporaryId, temporarySource, canonicalSource],
      )
      await client.query("DELETE FROM remem.catalog_entries WHERE memory_id = $1", [temporaryId])
      await client.query("DELETE FROM remem.memories WHERE id = $1", [temporaryId])
      await client.query("COMMIT")
      return {
        ...record,
        id,
        source: record.source === temporarySource ? canonicalSource : record.source,
        createdAt: existing.rows[0].created_at.toISOString(),
      }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  async supersede(
    id: string,
    replacement: MemoryWrite,
    options: MemoryMutationOptions = {},
  ): Promise<MemoryRecord> {
    if (!UUID_PATTERN.test(id)) throw new TypeError("memory id must be a UUID")
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const existing = await client.query<{ freshness: string; superseded_by: string | null }>(
        "SELECT freshness, superseded_by FROM remem.memories WHERE id = $1 AND provider_id = $2 FOR UPDATE",
        [id, this.id],
      )
      if (!existing.rows[0]) throw new Error("memory not found")
      if (existing.rows[0].freshness === "superseded" || existing.rows[0].superseded_by) {
        throw new Error("memory is already superseded")
      }
      const record = await this.writeWithClient(client, replacement, options)
      await client.query(
        "UPDATE remem.memories SET freshness = 'superseded', superseded_by = $3, updated_at = now() WHERE id = $1 AND provider_id = $2",
        [id, this.id, record.id],
      )
      await client.query("COMMIT")
      return record
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  async delete(id: string, _context: MemoryContext): Promise<void> {
    if (!UUID_PATTERN.test(id)) return
    await this.pool.query("DELETE FROM remem.memories WHERE id = $1 AND provider_id = $2", [
      id,
      this.id,
    ])
  }

  async persistCandidate(
    observation: SessionObservation,
    candidate: CandidateMemory,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    options.signal?.throwIfAborted()
    if (candidate.status !== "pending")
      throw new TypeError("automatic capture may only persist pending candidates")
    const sessionId = observation.context.sessionId
    if (!sessionId) throw new TypeError("captured observations require a session id")
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      if (options.timeoutMs) {
        await client.query("SELECT set_config('statement_timeout', $1, true)", [
          String(options.timeoutMs),
        ])
      }
      options.signal?.throwIfAborted()
      const persistedObservation = await client.query<{ id: string }>(
        `INSERT INTO remem.session_events
         (id, session_id, project_id, kind, occurred_at, payload)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
         WHERE remem.session_events.session_id = EXCLUDED.session_id
           AND remem.session_events.project_id = EXCLUDED.project_id
         RETURNING id`,
        [
          observation.id,
          sessionId,
          observation.context.projectId,
          observation.kind,
          observation.occurredAt,
          JSON.stringify({
            ...Object.fromEntries(
              Object.entries(observation.payload).filter(([key]) => key !== "text"),
            ),
            source: observation.source,
          }),
        ],
      )
      if (!persistedObservation.rows[0]) {
        throw new Error("captured observation id belongs to another context")
      }
      options.signal?.throwIfAborted()
      const persistedCandidate = await client.query<{ id: string }>(
        `INSERT INTO remem.candidate_memories
         (id, session_event_id, type, title, content, scope_kind, scope_id, confidence, status, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           session_event_id = EXCLUDED.session_event_id,
           type = EXCLUDED.type,
           title = EXCLUDED.title,
           content = EXCLUDED.content,
           scope_kind = EXCLUDED.scope_kind,
           scope_id = EXCLUDED.scope_id,
           confidence = EXCLUDED.confidence,
           metadata = EXCLUDED.metadata
         WHERE remem.candidate_memories.status = 'pending'
           AND remem.candidate_memories.session_event_id = EXCLUDED.session_event_id
           AND remem.candidate_memories.scope_kind = EXCLUDED.scope_kind
           AND remem.candidate_memories.scope_id IS NOT DISTINCT FROM EXCLUDED.scope_id
           AND remem.candidate_memories.metadata->>'providerId' = EXCLUDED.metadata->>'providerId'
         RETURNING id`,
        [
          candidate.id,
          observation.id,
          candidate.memory.type,
          candidate.memory.title,
          candidate.memory.content,
          candidate.memory.scope.kind,
          scopeId(candidate.memory, observation.context) ?? null,
          clamp(candidate.confidence, 0.5),
          JSON.stringify({
            providerId: this.id,
            memory: Object.fromEntries(
              Object.entries(candidate.memory).filter(
                ([key]) => key !== "title" && key !== "content" && key !== "summary",
              ),
            ),
            reasons: candidate.reasons,
            observationIds: candidate.observationIds,
          }),
        ],
      )
      if (!persistedCandidate.rows[0]) {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM remem.candidate_memories
           WHERE id = $1 AND session_event_id = $2
             AND scope_kind = $3 AND scope_id IS NOT DISTINCT FROM $4
             AND metadata->>'providerId' = $5`,
          [
            candidate.id,
            observation.id,
            candidate.memory.scope.kind,
            scopeId(candidate.memory, observation.context) ?? null,
            this.id,
          ],
        )
        if (!existing.rows[0]) throw new Error("captured candidate id belongs to another context")
      }
      options.signal?.throwIfAborted()
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  async candidateStatus(context: MemoryContext): Promise<CandidateStatusSummary> {
    const result = await this.pool.query<{ status: keyof CandidateStatusSummary; count: string }>(
      `SELECT c.status, count(*)::text AS count
       FROM remem.candidate_memories c
       JOIN remem.session_events e ON e.id = c.session_event_id
       WHERE c.metadata->>'providerId' = $1
         AND e.project_id = $2
         AND ($3::text IS NULL OR e.session_id = $3)
       GROUP BY c.status`,
      [this.id, context.projectId, context.sessionId ?? null],
    )
    const summary: CandidateStatusSummary = {
      pending: 0,
      approved: 0,
      consolidating: 0,
      rejected: 0,
      promoted: 0,
      expired: 0,
    }
    for (const row of result.rows) summary[row.status] = Number(row.count)
    return summary
  }

  /**
   * Phase 3 (TASK-010): persists an admitted `EvidenceEnvelope` into
   * `remem.session_events`, independently of semantic candidate extraction.
   * "Episode" is initially the provider/host/project/session grouping (per
   * the plan's storage decision), so a session id is required -- the same
   * requirement `persistCandidate` above already enforces for the legacy
   * capture path.
   */
  async appendEvidence(
    envelope: EvidenceEnvelope,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<EpisodicAppendResult> {
    options.signal?.throwIfAborted()
    const sessionId = envelope.context.sessionId
    if (!sessionId) throw new TypeError("episodic evidence requires a session id")
    // Defense-in-depth: `admitEvidence` (observation-admission.ts) already
    // validates these against the same allowlists before an EvidenceEnvelope
    // is ever constructed, but TypeScript's compile-time types are not
    // enforced at runtime -- a caller that bypasses admission (a future code
    // path, a test harness, or a manually-constructed object at a JS/TS
    // boundary) must not reach an unhandled Postgres CHECK-violation
    // exception; it gets a clear, typed error instead.
    if (!EVIDENCE_ROLES.includes(envelope.role)) {
      throw new TypeError(`invalid evidence role: ${envelope.role}`)
    }
    if (!EVIDENCE_ORIGINS.includes(envelope.origin)) {
      throw new TypeError(`invalid evidence origin: ${envelope.origin}`)
    }
    if (!EVIDENCE_KINDS.includes(envelope.kind)) {
      throw new TypeError(`invalid evidence kind: ${envelope.kind}`)
    }

    return this.withEvidenceIdentityLock(
      envelope.providerId,
      envelope.context.projectId,
      envelope.id,
      async (client) => {
        if (options.timeoutMs) {
          await client.query("SELECT set_config('statement_timeout', $1, true)", [
            String(options.timeoutMs),
          ])
        }
        options.signal?.throwIfAborted()

        // A privacy tombstone wins over every append path, including a host
        // replay arriving after the original event was forgotten. The same
        // identity-scoped advisory lock used by `confirmForget` closes the
        // read-then-insert race with that confirmation transaction.
        const tombstone = await client.query(
          `SELECT 1
         FROM remem.forget_tombstones
         WHERE provider_id = $1 AND project_id = $2
           AND target_kind = 'evidence' AND target_id = $3`,
          [envelope.providerId, envelope.context.projectId, envelope.id],
        )
        if (tombstone.rows[0]) return { outcome: "forgotten", id: envelope.id }

        const insertParams = [
          sessionId,
          envelope.context.projectId,
          envelope.kind,
          envelope.occurredAt,
          JSON.stringify(envelope.payload.metadata ?? {}),
          envelope.providerId,
          envelope.host,
          envelope.role,
          envelope.origin,
          envelope.turnId ?? null,
          envelope.messageId ?? null,
          envelope.payload.text ?? null,
          JSON.stringify(envelope.evidenceRefs),
          envelope.id,
          envelope.contentHash,
          envelope.schemaVersion,
        ]

        // At most one retry: TASK-012's enforceHardLimit can now genuinely
        // DELETE a session_events row (this table previously had no
        // DELETE/UPDATE path at all when this logic was first written). If
        // a conflicting row is concurrently evicted between this INSERT's
        // conflict detection and the follow-up SELECT below, the identity
        // slot is now free -- a second INSERT attempt should simply
        // succeed as a fresh append, not be misreported as an anomaly.
        for (let attempt = 0; attempt < 2; attempt++) {
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO remem.session_events
             (id, session_id, project_id, kind, occurred_at, payload,
              provider_id, host, role, origin, turn_id, message_id, safe_text,
              evidence_refs, evidence_id, content_hash, schema_version)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,
                   $7,$8,$9,$10,$11,$12,$13,
                   $14::jsonb,$15,$16,$17)
           ON CONFLICT (provider_id, project_id, evidence_id) WHERE evidence_id IS NOT NULL DO NOTHING
           RETURNING id`,
            [randomUUID(), ...insertParams],
          )
          if (inserted.rows[0]) return { outcome: "appended", id: envelope.id }

          // The unique (provider_id, project_id, evidence_id) index rejected the
          // insert: this is either an exact replay (duplicate, a no-op) or a
          // genuine collision (same identity, different evidence) --
          // distinguished by comparing content_hash, never by re-deriving or
          // trusting the new envelope's own claim.
          const existing = await client.query<{ content_hash: string | null }>(
            `SELECT content_hash FROM remem.session_events
           WHERE provider_id = $1 AND project_id = $2 AND evidence_id = $3`,
            [envelope.providerId, envelope.context.projectId, envelope.id],
          )
          const existingRow = existing.rows[0]
          if (!existingRow) {
            if (attempt === 0) continue // retry once -- see comment above
            // Still missing after a retry: this is no longer explainable by
            // the single-DELETE race the retry exists for (a second
            // eviction landing in the exact same narrow window, on the very
            // row this call itself just tried to (re)insert, would be an
            // extraordinary coincidence) -- surface it distinctly rather
            // than silently mislabeling a genuine data-integrity anomaly as
            // ordinary identity contention.
            throw new Error(
              `episodic evidence conflict reported for ${envelope.providerId}/${envelope.id}, but no conflicting row could be read back after a retry`,
            )
          }
          const outcome =
            existingRow.content_hash === envelope.contentHash ? "duplicate" : "collision"
          return { outcome, id: envelope.id }
        }
        /* istanbul ignore next -- the loop above always returns or throws within its two iterations. */
        throw new Error("unreachable: appendEvidence retry loop exited without returning")
      },
    )
  }

  /**
   * TASK-013's non-destructive half. This stores a short-lived, body-free
   * preview of exactly one scoped episode and the candidates directly linked
   * to it. Semantic memories, embeddings, and catalog entries are explicitly
   * excluded: before Phase 4's durable association ledger, this provider
   * cannot prove any semantic record has no independent supporting evidence.
   */
  async previewForget(
    providerId: string,
    evidenceId: string,
    projectId: string,
  ): Promise<ForgetPreview | undefined> {
    if (providerId !== this.id || !EVIDENCE_ID_PATTERN.test(evidenceId)) return undefined
    return this.withEvidenceIdentityLock(providerId, projectId, evidenceId, async (client) => {
      await client.query("DELETE FROM remem.forget_previews WHERE expires_at <= now()")
      const event = await client.query<{ id: string }>(
        `SELECT id
         FROM remem.session_events
         WHERE provider_id = $1 AND project_id = $2 AND evidence_id = $3
         FOR SHARE`,
        [providerId, projectId, evidenceId],
      )
      const sessionEventId = event.rows[0]?.id
      if (!sessionEventId) return undefined
      const candidates = await client.query<{ id: string }>(
        `SELECT id
         FROM remem.candidate_memories
         WHERE session_event_id = $1
         ORDER BY id`,
        [sessionEventId],
      )
      const preview = await client.query<ForgetPreviewRow>(
        `INSERT INTO remem.forget_previews
           (id, provider_id, project_id, evidence_id, session_event_id, candidate_ids, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::uuid[], now() + ($7::bigint * interval '1 millisecond'))
         RETURNING id, provider_id, project_id, evidence_id, session_event_id, candidate_ids,
                   created_at, expires_at, confirmed_at`,
        [
          randomUUID(),
          providerId,
          projectId,
          evidenceId,
          sessionEventId,
          candidates.rows.map((candidate) => candidate.id),
          FORGET_PREVIEW_TTL_MS,
        ],
      )
      const previewRow = preview.rows[0]
      if (!previewRow) {
        throw new Error("forget preview INSERT ... RETURNING unexpectedly returned no row")
      }
      return forgetPreviewFromRow(previewRow)
    })
  }

  /**
   * TASK-013's destructive half. The opaque preview id is locked and consumed
   * in one transaction. A changed direct-candidate set invalidates the
   * preview rather than extending human confirmation to data that was not
   * shown in it. Every tombstone remains body-free and blocks host replay.
   */
  async confirmForget(previewId: string): Promise<ForgetConfirmation> {
    if (!UUID_PATTERN.test(previewId)) throw new TypeError("forget preview id must be a UUID")
    return this.withForgetRestoreLock(async (client) => {
      const lookup = await client.query<
        Pick<ForgetPreviewRow, "provider_id" | "project_id" | "evidence_id">
      >(
        `SELECT provider_id, project_id, evidence_id
         FROM remem.forget_previews
         WHERE id = $1 AND confirmed_at IS NULL AND expires_at > now()`,
        [previewId],
      )
      const scope = lookup.rows[0]
      if (!scope || scope.provider_id !== this.id) {
        throw new Error("forget preview is unavailable or expired")
      }
      return this.withEvidenceIdentityLockOnClient(
        client,
        scope.provider_id,
        scope.project_id,
        scope.evidence_id,
        async () => {
          await client.query("BEGIN")
          try {
            const preview = await client.query<ForgetPreviewRow>(
              `SELECT id, provider_id, project_id, evidence_id, session_event_id, candidate_ids,
                    created_at, expires_at, confirmed_at
             FROM remem.forget_previews
             WHERE id = $1 AND confirmed_at IS NULL AND expires_at > now()
             FOR UPDATE`,
              [previewId],
            )
            const row = preview.rows[0]
            if (!row || row.provider_id !== this.id) {
              throw new Error("forget preview is unavailable or expired")
            }
            const additionalCandidates = await client.query<{ id: string }>(
              `SELECT id
             FROM remem.candidate_memories
             WHERE session_event_id = $1 AND NOT (id = ANY($2::uuid[]))
             LIMIT 1`,
              [row.session_event_id, row.candidate_ids],
            )
            if (additionalCandidates.rows[0]) {
              throw new Error("forget preview changed; request a new preview before confirming")
            }
            const deletedCandidates = await client.query<{ id: string }>(
              `DELETE FROM remem.candidate_memories
             WHERE id = ANY($1::uuid[])
             RETURNING id`,
              [row.candidate_ids],
            )
            const deletedEvent = await client.query<{ id: string }>(
              `DELETE FROM remem.session_events
             WHERE id = $1 AND provider_id = $2 AND project_id = $3 AND evidence_id = $4
             RETURNING id`,
              [row.session_event_id, row.provider_id, row.project_id, row.evidence_id],
            )
            await client.query(
              `INSERT INTO remem.forget_tombstones
               (provider_id, project_id, target_kind, target_id, preview_id)
             VALUES ($1, $2, 'evidence', $3, $4)
             ON CONFLICT (provider_id, project_id, target_kind, target_id) DO NOTHING`,
              [row.provider_id, row.project_id, row.evidence_id, row.id],
            )
            // One set-based insert rather than a query per candidate: keeps
            // the transaction's lock-hold time bounded regardless of how many
            // candidates the episode produced.
            if (row.candidate_ids.length > 0) {
              await client.query(
                `INSERT INTO remem.forget_tombstones
                 (provider_id, project_id, target_kind, target_id, preview_id)
               SELECT $1, $2, 'candidate', candidate_id::text, $4
               FROM unnest($3::uuid[]) AS candidate_id
               ON CONFLICT (provider_id, project_id, target_kind, target_id) DO NOTHING`,
                [row.provider_id, row.project_id, row.candidate_ids, row.id],
              )
            }
            await client.query(
              "UPDATE remem.forget_previews SET confirmed_at = now() WHERE id = $1",
              [row.id],
            )
            await client.query("COMMIT")
            return {
              previewId: row.id,
              evidenceDeleted: Boolean(deletedEvent.rows[0]),
              candidatesDeleted: deletedCandidates.rowCount ?? 0,
            }
          } catch (error) {
            await client.query("ROLLBACK")
            throw error
          }
        },
      )
    })
  }

  /**
   * TASK-061: accepts only a previously created project-scoped entity; it
   * does not parse, classify, or otherwise derive an entity from episode
   * content. The same identity lock used by forgetting/replay makes a link
   * impossible to add to an episode after that episode is forgotten.
   */
  async linkEvidenceEntity(
    providerId: string,
    evidenceId: string,
    entityId: string,
    projectId: string,
  ): Promise<boolean> {
    if (
      providerId !== this.id ||
      !EVIDENCE_ID_PATTERN.test(evidenceId) ||
      !UUID_PATTERN.test(entityId)
    ) {
      return false
    }
    return this.withEvidenceIdentityLock(providerId, projectId, evidenceId, async (client) => {
      const linked = await client.query(
        `INSERT INTO remem.evidence_entities (session_event_id, entity_id)
         SELECT event.id, entity.id
         FROM remem.session_events event
         JOIN remem.entities entity
           ON entity.id = $4
          AND entity.provider_id = $1
          AND entity.scope_kind = 'project'
          AND entity.scope_id = $2
         WHERE event.provider_id = $1 AND event.project_id = $2 AND event.evidence_id = $3
         ON CONFLICT DO NOTHING
         RETURNING session_event_id`,
        [providerId, projectId, evidenceId, entityId],
      )
      if (linked.rows[0]) return true
      // Idempotent link success must remain distinguishable from a foreign or
      // unknown target without disclosing which identity was not found.
      const existing = await client.query(
        `SELECT 1
         FROM remem.evidence_entities link
         JOIN remem.session_events event ON event.id = link.session_event_id
         JOIN remem.entities entity ON entity.id = link.entity_id
         WHERE event.provider_id = $1 AND event.project_id = $2 AND event.evidence_id = $3
           AND entity.id = $4 AND entity.provider_id = $1
           AND entity.scope_kind = 'project' AND entity.scope_id = $2`,
        [providerId, projectId, evidenceId, entityId],
      )
      return Boolean(existing.rows[0])
    })
  }

  /**
   * TASK-061: deterministic, bounded, project/provider-local proposal list.
   * It emits no text from either episode and deliberately does not attempt to
   * decide whether the newer approved/promoted decision candidate actually
   * supersedes older evidence. A single lexically-smallest shared entity id
   * identifies why each row is present without allowing a high-degree entity
   * graph to inflate one response row. Evidence event kinds are deliberately
   * raw transport categories; treating one as a decision here would bypass
   * the Phase 6 classifier.
   *
   * The newer side is collapsed to distinct qualifying decision events in a
   * CTE before the entity self-join. Joining `evidence_entities` to itself on
   * `entity_id` is O(older-degree x newer-degree) per shared entity, so a
   * single high-degree entity (a feature/project linked to thousands of
   * events) would otherwise produce a quadratic intermediate blowup that
   * `LIMIT` -- applied only after aggregation and the full sort -- cannot
   * bound. Pre-filtering the newer side to the far smaller set of events that
   * actually carry an approved/promoted decision candidate (and de-duplicating
   * multiple such candidates per event) shrinks that product without changing
   * the result: GROUP BY still yields one row per (older, newer) pair.
   *
   * Correctness of that DISTINCT depends on `min(entity_id)` being the ONLY
   * aggregate: `min` is duplicate-insensitive, so collapsing the per-event
   * candidate multiplicity before the join cannot change its value or group
   * membership (which is existence-based, not count-based). If a
   * count-sensitive aggregate is ever added here (`count`, `sum`, `array_agg`,
   * etc.), the CTE de-duplication would silently change results and must be
   * revisited.
   */
  async listSupersessionCandidates(
    providerId: string,
    projectId: string,
    options: { limit?: number } = {},
  ): Promise<SupersessionCandidate[]> {
    if (providerId !== this.id) return []
    const requestedLimit = options.limit
    const limit =
      requestedLimit !== undefined && Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(SUPERSESSION_CANDIDATE_MAX_RESULTS, Math.floor(requestedLimit)))
        : SUPERSESSION_CANDIDATE_MAX_RESULTS
    const result = await this.pool.query<SupersessionCandidateRow>(
      `WITH newer_decision AS (
         SELECT DISTINCT newer.id, newer.evidence_id, newer.occurred_at
         FROM remem.session_events newer
         JOIN remem.candidate_memories decision_candidate
           ON decision_candidate.session_event_id = newer.id
          AND decision_candidate.type = 'decision'
          AND decision_candidate.status IN ('approved', 'promoted')
          AND decision_candidate.metadata->>'providerId' = $1
         WHERE newer.provider_id = $1 AND newer.project_id = $2 AND newer.evidence_id IS NOT NULL
       )
       -- min() must stay the only aggregate: it is duplicate-insensitive, which
       -- is what makes the CTE's SELECT DISTINCT safe. A count-sensitive
       -- aggregate here would break equivalence with the pre-CTE query.
       SELECT older.evidence_id, newer.evidence_id AS newer_decision_evidence_id,
              min(older_link.entity_id::text) AS shared_entity_id,
              older.occurred_at, newer.occurred_at AS newer_decision_occurred_at
       FROM newer_decision newer
       JOIN remem.evidence_entities newer_link ON newer_link.session_event_id = newer.id
       JOIN remem.evidence_entities older_link ON older_link.entity_id = newer_link.entity_id
       JOIN remem.session_events older ON older.id = older_link.session_event_id
       WHERE older.provider_id = $1 AND older.project_id = $2 AND older.evidence_id IS NOT NULL
         AND newer.occurred_at > older.occurred_at
       GROUP BY older.evidence_id, newer.evidence_id, older.occurred_at, newer.occurred_at
       ORDER BY newer.occurred_at DESC, older.occurred_at DESC, older.evidence_id, newer.evidence_id
       LIMIT $3`,
      [providerId, projectId, limit],
    )
    return result.rows.map((row) => ({
      evidenceId: row.evidence_id,
      newerDecisionEvidenceId: row.newer_decision_evidence_id,
      sharedEntityId: row.shared_entity_id,
      occurredAt: row.occurred_at.toISOString(),
      newerDecisionOccurredAt: row.newer_decision_occurred_at.toISOString(),
      reason: "newer-decision-shares-entity",
    }))
  }

  /**
   * A foreign (different project than `context`) or otherwise-unknown
   * `(providerId, evidenceId)` returns `undefined` -- a non-disclosing
   * not-found result, not evidence about another project's retention state.
   */
  async readEvidence(
    providerId: string,
    evidenceId: string,
    context: MemoryContext,
  ): Promise<EvidenceEnvelope | undefined> {
    const result = await this.pool.query<EpisodicEventRow>(
      `SELECT id, session_id, project_id, provider_id, kind, occurred_at, host, role, origin,
              turn_id, message_id, safe_text, payload, evidence_refs, evidence_id,
              content_hash, schema_version
       FROM remem.session_events
       WHERE provider_id = $1 AND evidence_id = $2 AND project_id = $3
         AND evidence_id IS NOT NULL`,
      [providerId, evidenceId, context.projectId],
    )
    const row = result.rows[0]
    if (!row) return undefined
    return episodicRowToEnvelope(row)
  }

  /**
   * TASK-011: scoped lexical search over `remem.session_events` evidence
   * rows, with bounded same-session neighbor expansion. Deliberately
   * lexical (`plainto_tsquery`/`search_vector`) only -- vector/semantic
   * episode indexing is explicitly deferred per the plan. Performs no
   * `role`/`origin` trust filtering: an unclassified or failed-approach
   * event is just as findable as any other, so a caller can always
   * independently locate and label historical/untrusted evidence rather
   * than have it silently excluded from search.
   *
   * Neighbor `preceding_id`/`following_id` are computed with `LAG`/`LEAD`
   * over *every* evidence row in the session (not just the matched rows),
   * so a neighbor that itself never matched the query is still found --
   * that is the entire point of "surrounding context". A second, single
   * batched query then fetches all neighbor rows by id at once, so a
   * search returning up to `EPISODIC_SEARCH_MAX_RESULTS` matches costs
   * exactly two queries total, not one-plus-N.
   */
  async searchEpisodes(
    providerId: string,
    query: string,
    context: MemoryContext,
    options: EpisodicSearchOptions = {},
  ): Promise<EpisodicSearchResult> {
    // `Number.isFinite` guards against a caller-supplied `NaN` (which
    // survives `Math.min`/`Math.max` unclamped -- `Math.min(NaN, 10)` is
    // `NaN`, not `10`) reaching the SQL `LIMIT` parameter as an invalid
    // value; a non-finite request falls back to the hard ceiling, mirroring
    // the existing `clamp` helper used elsewhere in this file for the same
    // class of untrusted numeric input.
    const requestedLimit = options.limit
    const limit = Math.max(
      0,
      Math.min(
        Number.isFinite(requestedLimit) ? (requestedLimit as number) : EPISODIC_SEARCH_MAX_RESULTS,
        EPISODIC_SEARCH_MAX_RESULTS,
      ),
    )
    const requestedMaxOutputTokens = options.maxOutputTokens
    const maxOutputTokens = Math.max(
      0,
      Math.min(
        Number.isFinite(requestedMaxOutputTokens)
          ? (requestedMaxOutputTokens as number)
          : EPISODIC_SEARCH_MAX_OUTPUT_TOKENS,
        EPISODIC_SEARCH_MAX_OUTPUT_TOKENS,
      ),
    )
    if (limit === 0 || maxOutputTokens === 0 || query.trim().length === 0) {
      return { matches: [], budgetExhausted: false }
    }

    interface MatchRow extends EpisodicEventRow {
      preceding_id: string | null
      following_id: string | null
    }
    const matched = await this.pool.query<MatchRow>(
      `WITH scope AS (
         SELECT id, session_id, project_id, provider_id, kind, occurred_at, host, role, origin,
                turn_id, message_id, safe_text, payload, evidence_refs, evidence_id,
                content_hash, schema_version, search_vector,
                LAG(id) OVER (PARTITION BY session_id ORDER BY occurred_at, id) AS preceding_id,
                LEAD(id) OVER (PARTITION BY session_id ORDER BY occurred_at, id) AS following_id
         FROM remem.session_events
         WHERE provider_id = $1 AND project_id = $2 AND evidence_id IS NOT NULL
       ),
       query AS (SELECT plainto_tsquery('simple', $3) AS terms)
       SELECT scope.id, scope.session_id, scope.project_id, scope.provider_id, scope.kind,
              scope.occurred_at, scope.host, scope.role, scope.origin, scope.turn_id,
              scope.message_id, scope.safe_text, scope.payload, scope.evidence_refs,
              scope.evidence_id, scope.content_hash, scope.schema_version,
              scope.preceding_id, scope.following_id
       FROM scope, query
       WHERE scope.search_vector @@ query.terms
       ORDER BY ts_rank_cd(scope.search_vector, query.terms) DESC, scope.occurred_at DESC
       LIMIT $4`,
      [providerId, context.projectId, query, limit],
    )
    if (matched.rows.length === 0) return { matches: [], budgetExhausted: false }

    const neighborIds = [
      ...new Set(
        matched.rows.flatMap((row) =>
          [row.preceding_id, row.following_id].filter((id) => id !== null),
        ),
      ),
    ]
    const neighborRowsById = new Map<string, EpisodicEventRow>()
    if (neighborIds.length > 0) {
      const neighborResult = await this.pool.query<EpisodicEventRow>(
        `SELECT id, session_id, project_id, provider_id, kind, occurred_at, host, role, origin,
                turn_id, message_id, safe_text, payload, evidence_refs, evidence_id,
                content_hash, schema_version
         FROM remem.session_events
         WHERE id = ANY($1::uuid[]) AND provider_id = $2 AND project_id = $3`,
        [neighborIds, providerId, context.projectId],
      )
      for (const row of neighborResult.rows) neighborRowsById.set(row.id, row)
    }

    let remainingTokens = maxOutputTokens
    let budgetExhausted = false
    const matches: EpisodicSearchMatch[] = []
    for (const row of matched.rows) {
      if (remainingTokens <= 0) {
        budgetExhausted = true
        break
      }
      const fittedMatch = fitEnvelopeToBudget(episodicRowToEnvelope(row), remainingTokens)
      if (!fittedMatch.fits) {
        // This ranked match (and, by the rank-descending order, every
        // match after it) cannot be brought under the remaining budget even
        // after truncating its own text to nothing -- stop here rather
        // than silently returning an over-budget envelope, which would
        // defeat `EPISODIC_SEARCH_MAX_OUTPUT_TOKENS` as a real ceiling.
        budgetExhausted = true
        break
      }
      remainingTokens -= fittedMatch.tokensUsed
      const neighbors: EpisodicNeighbor[] = []
      for (const [position, neighborId] of [
        ["preceding", row.preceding_id],
        ["following", row.following_id],
      ] as const) {
        if (!neighborId) continue
        if (remainingTokens <= 0) {
          budgetExhausted = true
          break
        }
        const neighborRow = neighborRowsById.get(neighborId)
        if (!neighborRow) continue // should be unreachable: fetched by the ids just collected above
        const fittedNeighbor = fitEnvelopeToBudget(
          episodicRowToEnvelope(neighborRow),
          remainingTokens,
        )
        if (!fittedNeighbor.fits) {
          // Unlike a match, a neighbor that cannot fit is simply omitted --
          // the primary match itself is still a valid, on-budget result.
          budgetExhausted = true
          continue
        }
        remainingTokens -= fittedNeighbor.tokensUsed
        neighbors.push({
          position,
          envelope: fittedNeighbor.envelope,
          truncated: fittedNeighbor.truncated,
        })
      }
      // The query shape only ever computes one LAG and one LEAD id per row,
      // so `neighbors` structurally cannot exceed one preceding + one
      // following entry -- this assertion exists to fail loudly (not
      // silently exceed the plan's bound) if a future SQL change to the
      // neighbor query ever violates that invariant.
      if (neighbors.length > EPISODIC_SEARCH_MAX_NEIGHBORS_PER_SIDE * 2) {
        throw new Error(
          `episodic search produced ${neighbors.length} neighbors for one match, exceeding the ${EPISODIC_SEARCH_MAX_NEIGHBORS_PER_SIDE}-per-side bound`,
        )
      }
      matches.push({ envelope: fittedMatch.envelope, truncated: fittedMatch.truncated, neighbors })
    }
    if (matches.length < matched.rows.length) budgetExhausted = true

    return { matches, budgetExhausted }
  }

  /**
   * TASK-013: serializes one evidence identity across preview, confirmation,
   * and replay append. This is intentionally narrower than the capacity lock:
   * ordinary appends for different evidence ids remain independent while an
   * append for a forgotten id cannot race past the tombstone check.
   */
  private async withEvidenceIdentityLock<T>(
    providerId: string,
    projectId: string,
    evidenceId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect()
    try {
      return await this.withEvidenceIdentityLockOnClient(
        client,
        providerId,
        projectId,
        evidenceId,
        () => fn(client),
      )
    } finally {
      client.release()
    }
  }

  private async withEvidenceIdentityLockOnClient<T>(
    client: PoolClient,
    providerId: string,
    projectId: string,
    evidenceId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const lockKey = `${providerId}\u0001${projectId}\u0001${evidenceId}`
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey])
    try {
      return await fn()
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey])
    }
  }

  /** Keeps a confirmation from landing between restore's tombstone snapshot
   * and post-restore reapplication, which would otherwise resurrect data. */
  private async withForgetRestoreLock<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query("SELECT pg_advisory_lock($1)", [FORGET_RESTORE_ADVISORY_LOCK])
      try {
        return await fn(client)
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [FORGET_RESTORE_ADVISORY_LOCK])
      }
    } finally {
      client.release()
    }
  }

  /**
   * TASK-012/TASK-060: serializes `runCompaction`/`enforceHardLimit` per
   * `(providerId, projectId)` using a Postgres advisory lock held for the
   * duration of `fn`, on a single dedicated connection. Without this, two
   * concurrent callers for the same scope (two scheduler ticks, a manual
   * CLI invocation racing a background job, etc.) would each read the same
   * starting `capacity_state`/total-bytes snapshot and independently
   * decide "enough" rows to delete/compact, and the *union* of both
   * decisions can jointly do more than either alone would have --
   * irreversibly over-deleting evidence in `enforceHardLimit`'s case, or
   * losing an escalation-counter update in `runCompaction`'s case (a
   * classic lost-update). `hashtextextended` gives a stable 64-bit lock
   * key from the two identity strings without needing two separate int4
   * lock keys.
   */
  private async withCapacityLock<T>(
    providerId: string,
    projectId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect()
    // A NUL byte (`\u0000`) is invalid in a Postgres text parameter and
    // would fail the query outright -- `\u0001` is a valid, effectively
    // never-user-visible separator instead. Collision risk between two
    // different (providerId, projectId) pairs hashing to the same lock key
    // is only a (harmless) serialization performance concern, never a
    // correctness one -- this lock exists purely to order operations, not
    // to authorize them.
    const lockKey = `${providerId}\u0001${projectId}`
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey])
      try {
        return await fn(client)
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey])
      }
    } finally {
      client.release()
    }
  }

  /**
   * TASK-012/TASK-060: "logical bytes" for capacity accounting -- the
   * serialized size of what a caller actually sees (`safe_text` +
   * `payload`/metadata + `evidence_refs`), not raw on-disk storage (which
   * includes index/TOAST overhead this policy is not trying to model
   * exactly; the plan's limits are stated as approximate logical-byte
   * budgets, not a precise disk-usage guarantee).
   */
  private async computeTotalBytes(
    providerId: string,
    projectId: string,
    queryable: Pool | PoolClient = this.pool,
  ): Promise<number> {
    const result = await queryable.query<{ total: string | null }>(
      `SELECT SUM(
         COALESCE(octet_length(safe_text), 0) +
         COALESCE(octet_length(payload::text), 0) +
         COALESCE(octet_length(evidence_refs::text), 0)
       )::bigint AS total
       FROM remem.session_events
       WHERE provider_id = $1 AND project_id = $2 AND evidence_id IS NOT NULL`,
      [providerId, projectId],
    )
    return Number(result.rows[0]?.total ?? 0)
  }

  /**
   * Loads the persisted `remem.capacity_state` row for a provider/project,
   * creating it with defaults (level "conservative", no prior checks) if
   * this is the first time capacity has ever been checked for this scope.
   * `lastTotalBytes`/`lastCheckedAt` being absent (not merely zero) is what
   * lets `decideEscalation` distinguish "never checked before" from "was
   * checked and found empty," so a brand-new project is never treated as
   * having already failed to improve.
   */
  private async loadCapacityState(
    providerId: string,
    projectId: string,
    queryable: Pool | PoolClient = this.pool,
  ): Promise<{
    level: CompactionLevel
    previousTotalBytes: number | undefined
    consecutiveNoImprovement: number
  }> {
    const result = await queryable.query<{
      compaction_level: number
      last_total_bytes: string
      consecutive_no_improvement: number
      last_checked_at: Date | null
    }>(
      `INSERT INTO remem.capacity_state (provider_id, project_id)
       VALUES ($1, $2)
       ON CONFLICT (provider_id, project_id) DO UPDATE SET provider_id = EXCLUDED.provider_id
       RETURNING compaction_level, last_total_bytes, consecutive_no_improvement, last_checked_at`,
      [providerId, projectId],
    )
    const row = result.rows[0]!
    return {
      level: compactionLevelAtIndex(row.compaction_level),
      previousTotalBytes: row.last_checked_at === null ? undefined : Number(row.last_total_bytes),
      consecutiveNoImprovement: row.consecutive_no_improvement,
    }
  }

  async getCapacityStatus(
    providerId: string,
    projectId: string,
    limits: CapacityLimits = DEFAULT_CAPACITY_LIMITS,
  ): Promise<CapacityStatus> {
    const [totalBytes, state] = await Promise.all([
      this.computeTotalBytes(providerId, projectId),
      this.loadCapacityState(providerId, projectId),
    ])
    return capacityStatus(totalBytes, state.level, limits)
  }

  /**
   * One bounded batch of compaction (see `COMPACTION_BATCH_SIZE`) -- a
   * caller invokes this repeatedly to fully drain a large backlog. Only
   * shrinks `safe_text`; never touches `payload`/metadata, mirroring
   * TASK-059's own scope boundary. Every eligible row considered is
   * stamped `compacted_at`/`compacted_at_level` regardless of whether its
   * text actually changed, so a row already within the current level's
   * target is not re-examined again until the level escalates further.
   *
   * Serialized per `(providerId, projectId)` via an advisory lock (see
   * `withCapacityLock`) so two concurrent calls for the same scope cannot
   * both read the same starting escalation state and race to write it
   * back (a lost update).
   */
  async runCompaction(
    providerId: string,
    projectId: string,
    options: EnforceCapacityOptions = {},
  ): Promise<CompactionReport> {
    const limits = options.limits ?? DEFAULT_CAPACITY_LIMITS
    const force = options.force ?? false

    return this.withCapacityLock(providerId, projectId, async (client) => {
      const state = await this.loadCapacityState(providerId, projectId, client)
      const totalBytesBefore = await this.computeTotalBytes(providerId, projectId, client)
      const status = capacityStatus(totalBytesBefore, state.level, limits)

      if (!force && !status.overSoft) {
        // Refresh the baseline even though nothing was compacted -- being
        // under the soft limit is itself an improvement, so the
        // non-improvement streak resets rather than staying frozen at
        // whatever it was during the last pressure episode. Without this,
        // a project that dips under soft for a long stretch and then
        // crosses back over would compare its next real compaction run
        // against an arbitrarily stale total from long before, producing
        // a meaningless escalation signal. The level itself is never
        // touched here -- only ever escalated by an actual compaction run
        // below, never reset by simply checking status.
        await client.query(
          `UPDATE remem.capacity_state
           SET last_total_bytes = $3, consecutive_no_improvement = 0, last_checked_at = now(),
               updated_at = now()
           WHERE provider_id = $1 AND project_id = $2`,
          [providerId, projectId, totalBytesBefore],
        )
        return {
          rowsReduced: 0,
          rowsProcessed: 0,
          bytesReclaimed: 0,
          level: state.level,
          escalated: false,
          totalBytesAfter: totalBytesBefore,
        }
      }

      const targetLevelIndex = compactionLevelIndex(state.level)
      const bulkTarget = bulkArtifactTargetBytes(state.level)
      const narrativeTarget = narrativeTargetBytes(state.level)

      const eligible = await client.query<{ id: string; safe_text: string | null }>(
        `SELECT id, safe_text FROM remem.session_events
         WHERE provider_id = $1 AND project_id = $2 AND evidence_id IS NOT NULL
           AND ($3 OR occurred_at <= now() - ($4 || ' days')::interval)
           AND (compacted_at_level IS NULL OR compacted_at_level < $5)
         ORDER BY occurred_at ASC
         LIMIT $6`,
        [
          providerId,
          projectId,
          force,
          COMPACTION_ELIGIBILITY_DAYS,
          targetLevelIndex,
          COMPACTION_BATCH_SIZE,
        ],
      )

      let rowsReduced = 0
      let bytesReclaimed = 0
      const ids: string[] = []
      const newTexts: (string | null)[] = []
      for (const row of eligible.rows) {
        const originalText = row.safe_text
        let newText = originalText
        if (originalText !== null) {
          if (looksLikeToolOutput(originalText)) {
            const { text, reduced } = reduceBulkArtifact(originalText, bulkTarget)
            if (reduced) newText = text
          } else if (
            narrativeTarget !== undefined &&
            Buffer.byteLength(originalText, "utf8") > narrativeTarget
          ) {
            newText = truncateToTokens(originalText, narrativeTarget).text
          }
        }
        const changed = newText !== originalText
        if (changed) {
          rowsReduced++
          bytesReclaimed +=
            Buffer.byteLength(originalText ?? "", "utf8") - Buffer.byteLength(newText ?? "", "utf8")
        }
        ids.push(row.id)
        newTexts.push(newText)
      }

      if (ids.length > 0) {
        // One batched UPDATE for the whole eligible set, rather than one
        // round trip per row -- `COMPACTION_BATCH_SIZE` (500) sequential
        // round trips per call would otherwise be a real, avoidable
        // latency cost for what is meant to be a backlog-draining
        // maintenance operation.
        await client.query(
          `UPDATE remem.session_events AS se
           SET safe_text = v.safe_text, compacted_at = now(), compacted_at_level = $3
           FROM unnest($1::uuid[], $2::text[]) AS v(id, safe_text)
           WHERE se.id = v.id`,
          [ids, newTexts, targetLevelIndex],
        )
      }

      const totalBytesAfter = await this.computeTotalBytes(providerId, projectId, client)
      // A forced compaction that ran only because of `force` (the project
      // was *not* actually over the soft limit) must not feed the
      // sustained-pressure escalation counter at all -- escalation is
      // meant to reflect autonomous, pressure-driven behavior, never a
      // side effect of an on-demand user action on an otherwise healthy
      // project.
      const escalationApplies = status.overSoft
      const decision = escalationApplies
        ? decideEscalation(
            {
              level: state.level,
              previousTotalBytes: state.previousTotalBytes,
              consecutiveNoImprovement: state.consecutiveNoImprovement,
            },
            totalBytesAfter,
          )
        : {
            level: state.level,
            consecutiveNoImprovement: state.consecutiveNoImprovement,
            escalated: false,
          }

      await client.query(
        `UPDATE remem.capacity_state
         SET compaction_level = $3, last_total_bytes = $4, consecutive_no_improvement = $5,
             last_checked_at = now(),
             last_compacted_at = CASE WHEN $6 THEN now() ELSE last_compacted_at END,
             updated_at = now()
         WHERE provider_id = $1 AND project_id = $2`,
        [
          providerId,
          projectId,
          compactionLevelIndex(decision.level),
          totalBytesAfter,
          decision.consecutiveNoImprovement,
          ids.length > 0,
        ],
      )

      return {
        rowsReduced,
        rowsProcessed: eligible.rows.length,
        bytesReclaimed,
        level: decision.level,
        escalated: decision.escalated,
        totalBytesAfter,
      }
    })
  }

  /**
   * One bounded batch (see `HARD_LIMIT_BATCH_SIZE`) of oldest-eligible-
   * first removal. Never considers a row younger than
   * `COMPACTION_ELIGIBILITY_DAYS`, even if still over the hard limit
   * afterward (`exhaustedEligibleRows` reports that case explicitly,
   * rather than silently reaching into recent data).
   *
   * Serialized per `(providerId, projectId)` via an advisory lock (see
   * `withCapacityLock`): this issues a real, irreversible `DELETE`, so two
   * concurrent callers for the same scope must never independently decide
   * "enough eligible rows" from the same stale snapshot and jointly delete
   * more than either alone would have.
   */
  async enforceHardLimit(
    providerId: string,
    projectId: string,
    limits: CapacityLimits = DEFAULT_CAPACITY_LIMITS,
  ): Promise<HardLimitEvictionReport> {
    return this.withCapacityLock(providerId, projectId, async (client) => {
      let totalBytes = await this.computeTotalBytes(providerId, projectId, client)
      if (totalBytes <= limits.hardLimitBytes) {
        return {
          rowsRemoved: 0,
          bytesReclaimed: 0,
          totalBytesAfter: totalBytes,
          exhaustedEligibleRows: false,
        }
      }

      const candidates = await client.query<{ id: string; bytes: string }>(
        `SELECT id,
           (COALESCE(octet_length(safe_text), 0) + COALESCE(octet_length(payload::text), 0) +
            COALESCE(octet_length(evidence_refs::text), 0))::bigint AS bytes
         FROM remem.session_events
         WHERE provider_id = $1 AND project_id = $2 AND evidence_id IS NOT NULL
           AND occurred_at <= now() - ($3 || ' days')::interval
         ORDER BY occurred_at ASC
         LIMIT $4`,
        [providerId, projectId, COMPACTION_ELIGIBILITY_DAYS, HARD_LIMIT_BATCH_SIZE],
      )

      const idsToRemove: string[] = []
      let bytesReclaimed = 0
      for (const row of candidates.rows) {
        if (totalBytes <= limits.hardLimitBytes) break
        idsToRemove.push(row.id)
        const rowBytes = Number(row.bytes)
        totalBytes -= rowBytes
        bytesReclaimed += rowBytes
      }

      if (idsToRemove.length > 0) {
        await client.query(`DELETE FROM remem.session_events WHERE id = ANY($1::uuid[])`, [
          idsToRemove,
        ])
      }

      const totalBytesAfter = await this.computeTotalBytes(providerId, projectId, client)
      return {
        rowsRemoved: idsToRemove.length,
        bytesReclaimed,
        totalBytesAfter,
        exhaustedEligibleRows: totalBytesAfter > limits.hardLimitBytes,
      }
    })
  }

  /**
   * The main entry point: checks status, compacts if over the soft limit
   * (or if `force`d), then evicts if still over the hard limit afterward.
   * Compaction always runs strictly before eviction within one call --
   * never the reverse -- matching the plan's "only after compaction has
   * already run."
   */
  async enforceCapacity(
    providerId: string,
    projectId: string,
    options: EnforceCapacityOptions = {},
  ): Promise<EnforceCapacityReport> {
    const limits = options.limits ?? DEFAULT_CAPACITY_LIMITS
    let status = await this.getCapacityStatus(providerId, projectId, limits)

    let compaction: CompactionReport | undefined
    if (status.overSoft || options.force) {
      compaction = await this.runCompaction(providerId, projectId, options)
      status = await this.getCapacityStatus(providerId, projectId, limits)
    }

    let hardLimitEviction: HardLimitEvictionReport | undefined
    if (status.overHard) {
      hardLimitEviction = await this.enforceHardLimit(providerId, projectId, limits)
      status = await this.getCapacityStatus(providerId, projectId, limits)
    }

    return {
      status,
      ...(compaction !== undefined ? { compaction } : {}),
      ...(hardLimitEviction !== undefined ? { hardLimitEviction } : {}),
    }
  }

  /**
   * TASK-062: session-start hard-limit capacity warning. No advisory lock
   * is needed to enforce the throttle: firing is a single conditional
   * `UPDATE ... WHERE (last_hard_limit_warning_at IS NULL OR ... elapsed)`
   * that both tests and stamps `last_hard_limit_warning_at` atomically.
   * Under READ COMMITTED, two concurrent session-start checks racing the
   * same throttle window serialize on the row: the first UPDATE stamps
   * `now()` and reports one affected row; the second blocks on the row
   * lock, then re-evaluates its `WHERE` against the freshly committed
   * timestamp, fails the throttle predicate, and reports zero affected
   * rows -- so exactly one fires. The preceding read (`computeTotalBytes`)
   * only feeds the informational byte counts in the returned warning; it
   * has no bearing on the throttle decision, so it needs no serialization
   * with the UPDATE.
   *
   * The throttle-elapsed decision is evaluated inside that single SQL
   * `UPDATE ... WHERE ...` using Postgres's own `now()` throughout, rather
   * than reading `last_hard_limit_warning_at` back into Node and comparing
   * it against a Node-side `new Date()` (`capacity.ts`'s
   * `shouldFireHardLimitWarning` is the pure reference spec for this
   * decision, useful for unit testing the intended behavior in isolation,
   * but is deliberately not called with a cross-clock timestamp here) --
   * mixing a Node process clock with a Postgres-server-stored timestamp
   * would make the throttle boundary sensitive to clock skew between the
   * two, which is avoidable by keeping the whole comparison on one clock.
   */
  async checkHardLimitWarning(
    providerId: string,
    projectId: string,
    options: { limits?: CapacityLimits; throttleMs?: number } = {},
  ): Promise<HardLimitWarning | undefined> {
    const limits = options.limits ?? DEFAULT_CAPACITY_LIMITS
    const throttleMs = options.throttleMs ?? DEFAULT_HARD_LIMIT_WARNING_THROTTLE_MS
    const totalBytes = await this.computeTotalBytes(providerId, projectId, this.pool)
    if (totalBytes <= limits.hardLimitBytes) return undefined

    await this.pool.query(
      `INSERT INTO remem.capacity_state (provider_id, project_id)
       VALUES ($1, $2)
       ON CONFLICT (provider_id, project_id) DO NOTHING`,
      [providerId, projectId],
    )

    const fired = await this.pool.query(
      `UPDATE remem.capacity_state
       SET last_hard_limit_warning_at = now(), updated_at = now()
       WHERE provider_id = $1 AND project_id = $2
         AND (last_hard_limit_warning_at IS NULL
              OR last_hard_limit_warning_at <= now() - ($3 || ' milliseconds')::interval)`,
      [providerId, projectId, throttleMs],
    )
    if (!fired.rowCount) return undefined
    return { totalBytes, hardLimitBytes: limits.hardLimitBytes }
  }

  async listCandidates(status?: CandidateMemory["status"]): Promise<CandidateReviewItem[]> {
    const result = await this.pool.query<{
      id: string
      type: MemoryRecord["type"]
      title: string
      content: string
      scope_kind: MemoryScope["kind"]
      scope_id: string | null
      confidence: number | null
      status: CandidateMemory["status"]
      created_at: Date
      reasons: string[]
    }>(
      `SELECT c.id, c.type, c.title, c.content, c.scope_kind, c.scope_id, c.confidence, c.status, c.created_at,
         COALESCE(c.metadata->'reasons', '[]'::jsonb) AS reasons
       FROM remem.candidate_memories c
       WHERE c.metadata->>'providerId' = $1
         AND ($2::text IS NULL OR c.status = $2)
       ORDER BY c.created_at DESC
       LIMIT 100`,
      [this.id, status ?? null],
    )
    return result.rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      content: row.content,
      scope: { kind: row.scope_kind, ...(row.scope_id ? { id: row.scope_id } : {}) },
      ...(row.confidence === null ? {} : { confidence: row.confidence }),
      status: row.status,
      createdAt: row.created_at.toISOString(),
      reasons: row.reasons,
    }))
  }

  async reviewCandidate(id: string, status: "approved" | "rejected"): Promise<void> {
    if (!UUID_PATTERN.test(id)) throw new TypeError("candidate id must be a UUID")
    const result = await this.pool.query<{ id: string }>(
      `UPDATE remem.candidate_memories
       SET status = $3, reviewed_at = now()
       WHERE id = $1 AND metadata->>'providerId' = $2 AND status = 'pending'
       RETURNING id`,
      [id, this.id, status],
    )
    if (!result.rows[0]) throw new Error("pending candidate not found")
  }

  async consolidateCandidates(batchSize = 50) {
    return new PostgresConsolidationRunner(
      this.pool,
      new DeterministicConsolidationPipeline(this, { batchSize }),
      batchSize,
      undefined,
      this.id,
    ).run()
  }

  async reembedStale(batchSize = 25) {
    return new PostgresReembedRunner(
      this.pool,
      (text, signal) => this.embeddingModel.embed(text, signal),
      {
        modelId: this.embeddingModel.id,
        dimensions: this.embeddingModel.dimensions,
        batchSize,
      },
    ).run()
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString()
    try {
      const result = await this.pool.query<{
        postgres_version: string
        vector_version: string | null
        schema_version: number
      }>(`
        SELECT current_setting('server_version') AS postgres_version,
          (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector_version,
          COALESCE((SELECT max(version) FROM remem.schema_migrations), 0)::int AS schema_version
      `)
      const row = result.rows[0]
      if (!row?.vector_version)
        return { status: "degraded", message: "pgvector is unavailable", checkedAt }
      return {
        status: "healthy",
        message: `PostgreSQL ${row.postgres_version}; pgvector ${row.vector_version}; schema ${row.schema_version}`,
        checkedAt,
      }
    } catch (error) {
      return {
        status: "unavailable",
        message: error instanceof Error ? error.name : "database unavailable",
        checkedAt,
      }
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end()
  }

  dispose(): Promise<void> {
    return this.close()
  }

  private async recordEmbeddingSettings(): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO remem.embedding_settings (id, model, dimensions, updated_at)
         VALUES (true, $1, $2, now())
         ON CONFLICT (id) DO UPDATE SET model = $1, dimensions = $2, updated_at = now()`,
        [this.embeddingModel.id, this.embeddingModel.dimensions],
      )
    } catch {
      // Auxiliary bookkeeping only; a failure here must never affect
      // provider construction or availability.
    }
  }

  private async writeWithClient(
    client: PoolClient,
    memory: MemoryWrite,
    options: MemoryMutationOptions,
  ): Promise<MemoryRecord> {
    options.signal?.throwIfAborted()
    assertValidInstitutionalReview(memory)
    const id = memory.id ?? randomUUID()
    if (!UUID_PATTERN.test(id)) throw new TypeError("memory id must be a UUID")
    const resolvedScopeId = scopeId(memory, options.context)
    if (memory.scope.kind !== "global" && !resolvedScopeId) {
      throw new TypeError(`${memory.scope.kind} memories require a scope id`)
    }
    await client.query(
      `INSERT INTO remem.providers (id, kind, name, summary)
       VALUES ($1, 'postgres', 'Remem managed memory', 'Durable local memories')
       ON CONFLICT (id) DO UPDATE SET updated_at = now()`,
      [this.id],
    )

    const provenance =
      memory.provenance && memory.provenance.length > 0
        ? memory.provenance
        : [
            {
              source: sourceFromWrite(memory),
              capturedAt: new Date().toISOString(),
              original: true,
            },
          ]
    const sourceIds: string[] = []
    for (const item of provenance) sourceIds.push(await this.insertSource(client, item.source))
    const genericMetadata = { ...(memory.metadata ?? {}) }
    delete genericMetadata.institutional
    const metadata = {
      ...genericMetadata,
      ...(memory.institutional ? { institutional: memory.institutional } : {}),
      ...(options.actor || options.reason
        ? {
            mutation: {
              ...(options.actor ? { actor: options.actor } : {}),
              ...(options.reason ? { reason: options.reason } : {}),
            },
          }
        : {}),
    }
    const aliases = uniqueStrings(memory.aliases)
    const tags = uniqueStrings(memory.tags)
    const created = await client.query<MemoryRow>(
      `INSERT INTO remem.memories (
         id, provider_id, source_id, type, title, content, summary, scope_kind, scope_id,
         freshness, confidence, importance, unresolved, observed_at, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
       RETURNING *, NULL::text AS source, '{}'::text[] AS aliases, '{}'::text[] AS tags`,
      [
        id,
        this.id,
        sourceIds[0] ?? null,
        memory.type,
        memory.title,
        memory.content,
        memory.summary ?? "",
        memory.scope.kind,
        resolvedScopeId ?? null,
        memory.freshness ?? "current",
        memory.confidence === undefined ? null : clamp(memory.confidence, 0.5),
        clamp(memory.importance, 0.5),
        memory.unresolved ?? false,
        memory.observedAt ?? null,
        JSON.stringify(metadata),
      ],
    )

    for (const alias of aliases) {
      await client.query("INSERT INTO remem.memory_aliases (memory_id, alias) VALUES ($1, $2)", [
        id,
        alias,
      ])
    }
    for (const tag of tags) {
      await client.query("INSERT INTO remem.memory_tags (memory_id, tag) VALUES ($1, $2)", [
        id,
        tag,
      ])
    }
    for (let index = 0; index < provenance.length; index++) {
      const item = provenance[index]
      const sourceId = sourceIds[index]
      if (!item || !sourceId) continue
      await client.query(
        `INSERT INTO remem.memory_provenance
           (id, memory_id, source_id, captured_at, original, note, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          randomUUID(),
          id,
          sourceId,
          item.capturedAt,
          item.original,
          item.note ?? null,
          JSON.stringify({}),
        ],
      )
    }
    await this.insertEntitiesAndRelationships(
      client,
      id,
      memory.scope,
      resolvedScopeId,
      memory.entities ?? [],
      memory.relationships ?? [],
    )

    let catalogEmbedding: number[] | undefined
    try {
      const embedding =
        memory.embedding ??
        (await this.embeddingModel.embed(
          [memory.title, memory.summary, memory.content, aliases.join(" "), tags.join(" ")]
            .filter(Boolean)
            .join("\n"),
          options.signal,
        ))
      await client.query(
        `INSERT INTO remem.memory_embeddings (memory_id, model, dimensions, embedding)
         VALUES ($1, $2, $3, $4::vector)`,
        [id, this.embeddingModel.id, this.embeddingModel.dimensions, vectorLiteral(embedding)],
      )
      catalogEmbedding = await this.embeddingModel.embed(
        [memory.title, memory.summary, aliases.join(" "), tags.join(" ")]
          .filter(Boolean)
          .join("\n"),
        options.signal,
      )
    } catch {
      options.signal?.throwIfAborted()
    }
    const source = memory.source ?? provenance[0]?.source.uri ?? `remem://${this.id}/${id}`
    await client.query(
      `INSERT INTO remem.catalog_entries (
         id, provider_id, memory_id, title, summary, aliases, tags, scope_kind, scope_id,
         importance, unresolved, source, embedding_model, embedding_dimensions, embedding
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::vector)`,
      [
        randomUUID(),
        this.id,
        id,
        memory.title,
        memory.summary ?? memory.content.slice(0, 320),
        aliases,
        tags,
        memory.scope.kind,
        resolvedScopeId ?? null,
        clamp(memory.importance, 0.5),
        memory.unresolved ?? false,
        source,
        catalogEmbedding ? this.embeddingModel.id : null,
        catalogEmbedding ? this.embeddingModel.dimensions : null,
        catalogEmbedding ? vectorLiteral(catalogEmbedding) : null,
      ],
    )
    options.signal?.throwIfAborted()
    const row = created.rows[0]
    if (!row) throw new Error("database did not return the created memory")
    return {
      ...rowToRecord({ ...row, source, aliases, tags }),
      provenance,
      entities: memory.entities ?? [],
      relationships: memory.relationships ?? [],
    }
  }

  private async insertSource(client: PoolClient, source: MemorySource): Promise<string> {
    const id = source.id && UUID_PATTERN.test(source.id) ? source.id : randomUUID()
    const result = await client.query<{ id: string }>(
      `INSERT INTO remem.sources
         (id, provider_id, kind, uri, external_id, observed_at, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (provider_id, external_id) DO UPDATE SET
         uri = COALESCE(EXCLUDED.uri, remem.sources.uri),
         observed_at = COALESCE(EXCLUDED.observed_at, remem.sources.observed_at),
         metadata = remem.sources.metadata || EXCLUDED.metadata
       RETURNING id`,
      [
        id,
        this.id,
        source.kind,
        source.uri ?? null,
        source.externalId ?? null,
        source.observedAt ?? null,
        JSON.stringify(source.metadata ?? {}),
      ],
    )
    const returned = result.rows[0]?.id
    if (!returned) throw new Error("database did not return the memory source")
    return returned
  }

  private async insertEntitiesAndRelationships(
    client: PoolClient,
    memoryId: string,
    scope: MemoryScope,
    resolvedScopeId: string | undefined,
    entities: MemoryEntity[],
    relationships: MemoryRelationship[],
  ): Promise<void> {
    const entityIds = new Map<string, string>()
    for (const entity of entities) {
      const result = await client.query<{ id: string }>(
        `INSERT INTO remem.entities
           (id, provider_id, scope_kind, scope_id, name, type, aliases, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT (provider_id, scope_kind, scope_id, name, type) DO UPDATE SET
           aliases = ARRAY(SELECT DISTINCT unnest(remem.entities.aliases || EXCLUDED.aliases)),
           metadata = remem.entities.metadata || EXCLUDED.metadata,
           updated_at = now()
         RETURNING id`,
        [
          entity.id && UUID_PATTERN.test(entity.id) ? entity.id : randomUUID(),
          this.id,
          scope.kind,
          resolvedScopeId ?? "",
          entity.name,
          entity.type ?? "other",
          uniqueStrings(entity.aliases),
          JSON.stringify(entity.metadata ?? {}),
        ],
      )
      const entityId = result.rows[0]?.id
      if (!entityId) continue
      entityIds.set(entity.name, entityId)
      await client.query(
        "INSERT INTO remem.memory_entities (memory_id, entity_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [memoryId, entityId],
      )
    }
    for (const relationship of relationships) {
      const targetEntityId = relationship.targetEntity
        ? entityIds.get(relationship.targetEntity)
        : undefined
      if (!relationship.targetMemoryId && !targetEntityId) continue
      await client.query(
        `INSERT INTO remem.relationships
           (id, source_memory_id, target_memory_id, target_entity_id, type, metadata)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          randomUUID(),
          memoryId,
          relationship.targetMemoryId ?? null,
          targetEntityId ?? null,
          relationship.type,
          JSON.stringify(relationship.metadata ?? {}),
        ],
      )
    }
  }
}

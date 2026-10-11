import type { EvidenceOrigin } from "../observation-admission.js"
import { MODEL_PROPOSAL_VERSION, validateModelProposal } from "../model-proposal.js"
import { sourceIsSafe } from "../source-safety.js"
import {
  EVIDENCE_REFLECTION_VERSION,
  type EvidenceExtractionClaim,
} from "../evidence-reflection.js"
import { embedQuery, embedDocument, modelFingerprint } from "../storage/embedding-space.js"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { episodeResults } from "../episodic-recall.js"
import type { CandidateLineage } from "../learning-ledger.js"
import {
  CAPTURE_GAP_REASONS,
  LEARNING_DIAGNOSTIC_LIMIT,
  type CaptureGap,
  type LearningHistory,
  type LearningHistoryEntry,
} from "../learning-diagnostics.js"
import { DeterministicCandidateExtractor } from "../capture.js"
import {
  assertionLearningKey,
  decideLearning,
  REVALIDATABLE_LEARNING_POLICY_VERSIONS,
  type CaptureReceipt,
  type LearningDecision,
} from "../learning-policy.js"
import { PROCEDURE_WINDOW_LIMIT, verifiedProcedureFromEvidence } from "../verified-procedure.js"
import { extractProcedureCandidate, observationFromResolvedTask } from "../procedure.js"
import { parseConfig } from "../config.js"
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
  EPISODIC_SEARCH_MAX_QUERY_LENGTH,
  EPISODIC_SEARCH_MAX_RESULTS,
  FORGET_PREVIEW_TTL_MS,
  SUPERSESSION_CANDIDATE_MAX_RESULTS,
} from "../observation.js"
import {
  admitEvidence,
  DEFAULT_EVIDENCE_ADMISSION_CONFIG,
  EVIDENCE_KINDS,
  EVIDENCE_ORIGINS,
  EVIDENCE_ROLES,
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceEnvelope,
  type EvidenceReference,
} from "../observation-admission.js"
import {
  candidateFromRow,
  type CandidateRow,
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

function learningComparableMemory(memory: MemoryWrite): MemoryWrite {
  return {
    ...memory,
    ...(memory.metadata
      ? {
          metadata: Object.fromEntries(
            Object.entries(memory.metadata).filter(
              ([name]) => !["learningPolicy", "learningKey"].includes(name),
            ),
          ),
        }
      : {}),
  }
}

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
  catalog_topic_match?: boolean
  full_text_match?: boolean
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
  // schema_version has no DB CHECK constraint (unlike role/origin) -- its
  // entire purpose is to let a future incompatible envelope shape be
  // detected rather than silently mis-cast as today's shape. Reject rather
  // than blindly narrow an unexpected value into the current literal type.
  if (row.schema_version !== EVIDENCE_SCHEMA_VERSION) {
    throw new Error(
      `episodic evidence row has unsupported schemaVersion ${row.schema_version} (expected ${EVIDENCE_SCHEMA_VERSION})`,
    )
  }
  // role/origin are pinned to their exact literal sets by DB CHECKs, but
  // kind is NOT: session_events_evidence_kind_check allows the full 11-value
  // superset shared with legacy SessionEventKind rows, whereas an evidence
  // envelope's kind is the 3-value EvidenceEventKind. appendEvidence enforces
  // that narrower set on write, so any row this SELECT reaches should already
  // conform -- but the row type is an unchecked pg cast, so re-validate here
  // (mirroring the schema_version guard) rather than narrow an out-of-set
  // legacy kind into EvidenceEventKind.
  if (!EVIDENCE_KINDS.includes(row.kind)) {
    throw new Error(
      `episodic evidence row has unsupported kind ${row.kind} (expected one of ${EVIDENCE_KINDS.join(", ")})`,
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
 *
 * `tokensUsed` (present only on the `fits: true` result) is an estimate: for
 * a truncated envelope it is recomputed over the fitted JSON, whose string
 * escaping can push the serialized size a few bytes past `remainingTokens`.
 * Callers must treat the running budget as approximate and tolerate it going
 * slightly negative (searchEpisodes stops on `remainingTokens <= 0`), rather
 * than relying on `tokensUsed <= remainingTokens` holding exactly.
 *
 * The result is a discriminated union on `fits` so a caller physically
 * cannot read the (deliberately over-budget) envelope from a `fits: false`
 * result without narrowing first.
 */
type FitEnvelopeResult =
  | { fits: true; envelope: EvidenceEnvelope; truncated: boolean; tokensUsed: number }
  | { fits: false }

function fitEnvelopeToBudget(
  envelope: EvidenceEnvelope,
  remainingTokens: number,
): FitEnvelopeResult {
  const wholeCost = estimateTokens(JSON.stringify(envelope))
  if (wholeCost <= remainingTokens) {
    return { fits: true, envelope, truncated: false, tokensUsed: wholeCost }
  }
  if (envelope.payload.text === undefined) {
    // No free text to shrink -- a metadata-only envelope that alone
    // exceeds the budget cannot be fit by this function at all.
    return { fits: false }
  }
  const fixedCost = estimateTokens(
    JSON.stringify({ ...envelope, payload: { ...envelope.payload, text: "" } }),
  )
  if (fixedCost > remainingTokens) {
    // Even fully truncating text to "" wouldn't fit -- the envelope's
    // non-text fields alone (metadata, refs, identity) exceed the budget.
    return { fits: false }
  }
  const textBudget = Math.max(0, remainingTokens - fixedCost)
  const { text, truncated } = truncateToTokens(envelope.payload.text, textBudget)
  const fitted: EvidenceEnvelope = { ...envelope, payload: { ...envelope.payload, text } }
  return {
    fits: true,
    envelope: fitted,
    truncated,
    tokensUsed: estimateTokens(JSON.stringify(fitted)),
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
  source_content?: string | null
  source_metadata?: unknown
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

/**
 * Coerces a Postgres bigint/`octet_length` aggregate (returned by the driver
 * as a decimal string, or null for an empty aggregate) into a finite,
 * non-negative byte count. Byte counts here gate an irreversible eviction
 * DELETE and the escalation decision, so a malformed value must fail loudly
 * rather than silently become `NaN`: a `NaN` byte count would defeat the
 * eviction loop's `totalBytes <= hardLimit` break (every `NaN` comparison is
 * false), pushing the entire batch into the delete set. The safe-integer
 * bound also flags the (currently unreachable at GiB-scale limits) case
 * where a total exceeds JS's exact-integer range before it silently loses
 * precision in a soft/hard comparison.
 */
function toFiniteByteCount(raw: string | number | null | undefined): number {
  const value = raw === null || raw === undefined ? 0 : Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`capacity accounting read a non-finite byte count: ${String(raw)}`)
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`capacity accounting read a byte count beyond the safe-integer range: ${value}`)
  }
  return value
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
      embedding = await embedDocument(this.embeddingModel, summary)
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
      ...(embedding
        ? { embedding, embeddingFingerprint: modelFingerprint(this.embeddingModel) }
        : {}),
    }
  }

  async catalog(context: MemoryContext, signal: AbortSignal): Promise<CatalogEntry[]> {
    signal.throwIfAborted()
    const result = await this.pool.query<CatalogRow>(
      `
        SELECT ce.id, ce.memory_id, ce.parent_id, ce.title, ce.summary, ce.aliases, ce.tags,
          ce.scope_kind, ce.scope_id, ce.unresolved, ce.source,
          m.metadata->'institutional' AS institutional,
          left(m.content, 2000001) AS source_content, m.metadata AS source_metadata,
          CASE WHEN m.freshness = 'stale' THEN ce.importance * 0.5 ELSE ce.importance END AS importance,
          CASE WHEN ce.embedding_model = $6 AND ce.embedding_dimensions = $7 AND ce.embedding_fingerprint = $8
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
        modelFingerprint(this.embeddingModel) ?? null,
      ],
    )
    signal.throwIfAborted()
    return result.rows.flatMap((row) => {
      if (!sourceIsSafe(row)) return []
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
          ...(row.embedding
            ? {
                embedding: parseVector(row.embedding),
                embeddingFingerprint: modelFingerprint(this.embeddingModel),
              }
            : {}),
          ...(institutional ? { institutional } : {}),
        },
      ]
    })
  }

  async search(request: MemorySearchRequest): Promise<MemoryResult[]> {
    return this.searchWithClient(this.pool, request)
  }

  private async searchWithClient(
    queryable: Pool | PoolClient,
    request: MemorySearchRequest,
  ): Promise<MemoryResult[]> {
    request.signal.throwIfAborted()
    let embedding: string | null = null
    try {
      embedding = vectorLiteral(
        await embedQuery(this.embeddingModel, request.query, request.signal),
      )
    } catch {
      request.signal.throwIfAborted()
    }
    const perResultCharacters = Math.max(
      128,
      Math.floor(request.maxTokens / Math.max(1, request.limit)),
    )
    const result = await queryable.query<MemoryRow>(
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
          AND m.freshness <> 'superseded'
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
          AND me.model = $10 AND me.dimensions = $11 AND me.fingerprint = $16
          AND m.provider_id = $1 AND (
            m.scope_kind = 'global' OR
            (m.scope_kind = 'workspace' AND m.scope_id = $2) OR
            (m.scope_kind = 'project' AND m.scope_id = $3) OR
            (m.scope_kind = 'session' AND m.scope_id = $4)
          )
          AND ($8::text[] IS NULL OR m.type = ANY($8::text[]))
          AND ($9::text[] IS NULL OR m.scope_kind = ANY($9::text[]))
          AND m.freshness <> 'superseded'
          ORDER BY me.embedding <=> $6::vector
          LIMIT $13
        ),
        topic_candidates AS (
          SELECT m.id, 0.5::double precision AS lexical_score,
            0::double precision AS semantic_score
          FROM remem.memories m
          WHERE m.provider_id = $1 AND (
            m.scope_kind = 'global' OR
            (m.scope_kind = 'workspace' AND m.scope_id = $2) OR
            (m.scope_kind = 'project' AND m.scope_id = $3) OR
            (m.scope_kind = 'session' AND m.scope_id = $4)
          )
          AND ($8::text[] IS NULL OR m.type = ANY($8::text[]))
          AND ($9::text[] IS NULL OR m.scope_kind = ANY($9::text[]))
          AND m.freshness <> 'superseded'
          AND m.title = ANY($14::text[])
          ORDER BY m.updated_at DESC
          LIMIT $7
        ),
        candidates AS (
          SELECT id, max(lexical_score) AS lexical_score, max(semantic_score) AS semantic_score
          FROM (
            SELECT * FROM lexical_candidates
            UNION ALL
            SELECT * FROM semantic_candidates
            UNION ALL
            SELECT * FROM topic_candidates
          ) combined
          GROUP BY id
          HAVING max(lexical_score) > 0 OR max(semantic_score) >= 0.34
        )
        SELECT m.id, m.provider_id, m.title, left(m.content, GREATEST($12, 2000001)) AS content, m.summary,
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
          candidates.lexical_score, candidates.semantic_score,
          m.title = ANY($14::text[]) AS catalog_topic_match,
          m.search_vector @@ (SELECT terms FROM query) AS full_text_match
        FROM candidates
        JOIN remem.memories m ON m.id = candidates.id
        LEFT JOIN remem.sources s ON s.id = m.source_id
        WHERE NOT $15::boolean OR m.title = ANY($14::text[])
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
        request.topics.filter((topic) => typeof topic === "string").slice(0, 8),
        request.catalogOnly === true && request.topics.length > 0,
        modelFingerprint(this.embeddingModel) ?? null,
      ],
    )
    request.signal.throwIfAborted()
    return result.rows.flatMap((row) => {
      const record = rowToRecord(row)
      if (!sourceIsSafe(record)) return []
      const lexical = Number(row.lexical_score ?? 0)
      const semantic = Number(row.semantic_score ?? 0)
      return [
        {
          record: { ...record, content: record.content.slice(0, perResultCharacters) },
          score: Math.max(0, Math.min(1, Math.max(lexical, semantic))),
          reasons: [
            ...(row.full_text_match ? ["PostgreSQL full-text match"] : []),
            ...(row.catalog_topic_match ? ["PostgreSQL catalog topic match"] : []),
            ...(semantic >= 0.34 ? ["pgvector semantic match"] : []),
          ],
        },
      ]
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
           EXISTS (SELECT 1 FROM remem.candidate_lineage l
             WHERE l.provider_id = m.provider_id AND l.scope_kind = m.scope_kind
               AND l.scope_key = COALESCE(m.scope_id, '') AND l.candidate_id = $1::uuid
               AND l.memory_id = m.id AND l.state = 'promoted') OR
           (NOT EXISTS (SELECT 1 FROM remem.candidate_lineage l
             WHERE l.provider_id = $2 AND l.scope_kind = $3 AND l.scope_key = COALESCE($4, '')
               AND l.candidate_id = $1::uuid) AND
             (m.metadata->'consolidation'->>'candidateId' = $1::text OR
              m.metadata->'consolidation'->>'lastCandidateId' = $1::text))
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
    return this.mutateWithClient((client) => this.updateWithClient(client, id, memory, options))
  }

  private async updateWithClient(
    client: PoolClient,
    id: string,
    memory: MemoryWrite,
    options: MemoryMutationOptions,
  ): Promise<MemoryRecord> {
    if (!UUID_PATTERN.test(id)) throw new TypeError("memory id must be a UUID")
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
           embedding_fingerprint = replacement.embedding_fingerprint,
           embedding = replacement.embedding,
           updated_at = now()
         FROM remem.catalog_entries replacement
         WHERE original.memory_id = $1 AND replacement.memory_id = $2`,
      [id, temporaryId, temporarySource, canonicalSource],
    )
    await client.query("DELETE FROM remem.catalog_entries WHERE memory_id = $1", [temporaryId])
    await client.query("DELETE FROM remem.memories WHERE id = $1", [temporaryId])
    return {
      ...record,
      id,
      source: record.source === temporarySource ? canonicalSource : record.source,
      createdAt: existing.rows[0].created_at.toISOString(),
    }
  }

  async supersede(
    id: string,
    replacement: MemoryWrite,
    options: MemoryMutationOptions = {},
  ): Promise<MemoryRecord> {
    return this.mutateWithClient((client) =>
      this.supersedeWithClient(client, id, replacement, options),
    )
  }

  private async supersedeWithClient(
    client: PoolClient,
    id: string,
    replacement: MemoryWrite,
    options: MemoryMutationOptions,
  ): Promise<MemoryRecord> {
    if (!UUID_PATTERN.test(id)) throw new TypeError("memory id must be a UUID")
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
    return record
  }

  private async mutateWithClient<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const result = await operation(client)
      await client.query("COMMIT")
      return result
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

  /** The domain pipeline runs on one serializable transaction. Its callback
   * may be retried, so it must only use this transaction-bound provider. */
  async withCandidateTransaction(
    candidate: CandidateMemory,
    operation: (provider: MemoryProvider, candidate: CandidateMemory) => Promise<CandidateMemory>,
    signal?: AbortSignal,
  ): Promise<CandidateMemory> {
    if (!UUID_PATTERN.test(candidate.id) || candidate.status !== "approved")
      throw new TypeError("consolidation requires an approved candidate identity")
    const scope = candidate.memory.scope
    const key = scope.id ?? ""
    if (scope.kind !== "global" && !key) throw new TypeError("candidate scope is required")
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted()
      const client = await this.pool.connect()
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
        await client.query("SET LOCAL statement_timeout = '5s'")
        await this.lockLearningScope(client, scope)
        const ledger = await client.query<{
          state: CandidateMemory["status"] | "forgotten"
          memory_id: string | null
          actor: string
        }>(
          `SELECT state, memory_id, actor FROM remem.candidate_lineage
           WHERE provider_id=$1 AND scope_kind=$2 AND scope_key=$3 AND candidate_id=$4 FOR UPDATE`,
          [this.id, scope.kind, key, candidate.id],
        )
        const previous = ledger.rows[0]
        if (previous && !["pending", "approved"].includes(previous.state)) {
          const stored =
            previous.memory_id && previous.state === "promoted"
              ? await client.query<MemoryRow>(
                  `${BASE_SELECT} WHERE m.id=$1 AND m.provider_id=$2
                AND m.scope_kind=$3 AND COALESCE(m.scope_id,'')=$4`,
                  [previous.memory_id, this.id, scope.kind, key],
                )
              : undefined
          const record = stored?.rows[0] ? rowToRecord(stored.rows[0]) : undefined
          await client.query("COMMIT")
          return {
            ...candidate,
            status: record ? "promoted" : previous.state === "rejected" ? "rejected" : "expired",
            reasons: [
              ...candidate.reasons,
              record ? "reused processed candidate" : "processed candidate unavailable",
            ],
            memory: {
              ...(record ?? candidate.memory),
              metadata: {
                ...(record?.metadata ?? {}),
                consolidation: {
                  ...(record ? { memoryId: record.id } : {}),
                  action: "reused processed candidate",
                },
              },
            },
          }
        }
        const saved = await client.query<CandidateRow>(
          "SELECT * FROM remem.candidate_memories WHERE id=$1 FOR UPDATE",
          [candidate.id],
        )
        const row = saved.rows[0]
        if (
          row &&
          (row.metadata.providerId !== this.id ||
            row.scope_kind !== scope.kind ||
            (row.scope_id ?? "") !== key ||
            !["approved", "consolidating"].includes(row.status))
        )
          throw new Error("candidate is not approved in this scope")
        if (previous?.state === "pending") throw new Error("candidate approval is required")
        // Persisted reviewed bodies are authoritative; a supplied approved flag
        // cannot replace them. Absent rows retain the existing trusted core API.
        const durable = row ? { ...candidateFromRow(row), status: "approved" as const } : candidate
        if (row?.metadata.canonicalEvidence === true) {
          await this.assertCanonicalPromotionEvidence(client, durable)
        }
        const policy: unknown = row?.metadata.learningPolicy
        if (
          policy &&
          typeof policy === "object" &&
          "outcome" in policy &&
          policy.outcome === "auto-promote" &&
          previous?.actor !== "review"
        ) {
          if (
            !("version" in policy) ||
            typeof policy.version !== "string" ||
            !REVALIDATABLE_LEARNING_POLICY_VERSIONS.includes(policy.version)
          )
            throw new Error("automatic learning policy version is unsupported")
          const savedObservation: unknown = row?.metadata.learningObservation
          if (
            !savedObservation ||
            typeof savedObservation !== "object" ||
            !("payload" in savedObservation) ||
            !savedObservation.payload ||
            typeof savedObservation.payload !== "object"
          )
            throw new Error("automatic learning observation is unavailable")
          const observation = savedObservation as Omit<SessionObservation, "context">
          const sources = await client.query<EpisodicEventRow>(
            "SELECT * FROM remem.session_events WHERE id=ANY($1::uuid[]) AND provider_id=$2",
            [durable.observationIds, this.id],
          )
          const firstSource = sources.rows.find((source) => source.id === durable.observationIds[0])
          if (!firstSource) throw new Error("automatic learning evidence is unavailable")
          const context = {
            directory: key,
            worktree: key,
            projectId: firstSource.project_id,
            sessionId: firstSource.session_id,
          }
          const reconstructed: SessionObservation = {
            ...observation,
            context,
            payload: {
              ...observation.payload,
              text: observation.payload.verificationRule
                ? durable.memory.content
                : firstSource.safe_text,
            },
          }
          await this.canonicalCaptureEvidence(client, reconstructed, durable)
          const decision = await this.storedLearningDecision(
            client,
            reconstructed,
            durable,
            durable.observationIds,
            true,
          )
          if (decision.outcome !== "auto-promote") {
            await client.query(
              "UPDATE remem.candidate_memories SET status='pending', metadata=jsonb_set(metadata,'{learningPolicy}',$2::jsonb) WHERE id=$1",
              [candidate.id, JSON.stringify(decision)],
            )
            await client.query(
              `UPDATE remem.candidate_lineage SET state='pending',action='learning-requires-review',actor='learning-policy',
              policy_version=$5,policy_outcome=$6,policy_reason=$7 WHERE provider_id=$1 AND scope_kind=$2 AND scope_key=$3 AND candidate_id=$4`,
              [
                this.id,
                scope.kind,
                key,
                candidate.id,
                decision.version,
                decision.outcome,
                decision.reason,
              ],
            )
            await client.query("COMMIT")
            return { ...durable, status: "pending", reasons: [...durable.reasons, decision.reason] }
          }
          if (policy.version !== decision.version) {
            durable.memory.metadata = { ...durable.memory.metadata, learningPolicy: decision }
            await client.query(
              "UPDATE remem.candidate_memories SET metadata=jsonb_set(metadata,'{memory,metadata,learningPolicy}',$2::jsonb) || jsonb_build_object('learningPolicy',$2::jsonb) WHERE id=$1",
              [candidate.id, JSON.stringify(decision)],
            )
            await client.query(
              "UPDATE remem.candidate_lineage SET policy_version=$5,policy_outcome=$6,policy_reason=$7,action='learning-policy-revalidated',actor='learning-policy' WHERE provider_id=$1 AND scope_kind=$2 AND scope_key=$3 AND candidate_id=$4",
              [
                this.id,
                scope.kind,
                key,
                candidate.id,
                decision.version,
                decision.outcome,
                decision.reason,
              ],
            )
          }
        }
        const forgotten = await client.query(
          `SELECT 1 FROM remem.forget_tombstones WHERE provider_id=$1 AND project_id=$2
             AND target_kind='candidate' AND target_id=$3`,
          [this.id, key, candidate.id],
        )
        if (forgotten.rowCount) throw new Error("candidate was forgotten")
        await client.query(
          `INSERT INTO remem.candidate_lineage
          (provider_id,scope_kind,scope_key,candidate_id,state,observation_ids,action,actor)
          VALUES ($1,$2,$3,$4,'approved',$5,'approved-core-candidate','consolidation')
          ON CONFLICT DO NOTHING`,
          [this.id, scope.kind, key, candidate.id, durable.observationIds],
        )
        const assertScope = (memory: MemoryWrite) => {
          if (memory.scope.kind !== scope.kind || (memory.scope.id ?? "") !== key)
            throw new Error("consolidation mutation crossed scope")
        }
        const assertTarget = async (id: string) => {
          const target = await client.query(
            `SELECT 1 FROM remem.memories WHERE id=$1 AND provider_id=$2
            AND scope_kind=$3 AND COALESCE(scope_id,'')=$4 FOR UPDATE`,
            [id, this.id, scope.kind, key],
          )
          if (!target.rowCount) throw new Error("consolidation target unavailable")
        }
        const transaction: MemoryProvider = {
          id: this.id,
          capabilities: () => this.capabilities(),
          catalog: () => Promise.reject(new Error("catalog is outside the learning transaction")),
          search: (request) => this.searchWithClient(client, request),
          write: (memory, options = {}) => {
            assertScope(memory)
            return this.writeWithClient(client, memory, options)
          },
          update: async (id, memory, options = {}) => {
            assertScope(memory)
            await assertTarget(id)
            return this.updateWithClient(client, id, memory, options)
          },
          supersede: async (id, memory, options = {}) => {
            assertScope(memory)
            await assertTarget(id)
            return this.supersedeWithClient(client, id, memory, options)
          },
        }
        const result = await operation(transaction, durable)
        const consolidation = result.memory.metadata?.consolidation
        const memoryId =
          consolidation && typeof consolidation === "object" && "memoryId" in consolidation
            ? String(consolidation.memoryId)
            : ""
        if (result.status !== "promoted" || !UUID_PATTERN.test(memoryId))
          throw new Error("learning transaction did not produce a memory")
        await assertTarget(memoryId)
        await client.query(
          `UPDATE remem.candidate_lineage SET state='promoted', memory_id=$5,
          action='promotion-committed', actor='consolidation'
          WHERE provider_id=$1 AND scope_kind=$2 AND scope_key=$3 AND candidate_id=$4`,
          [this.id, scope.kind, key, candidate.id, memoryId],
        )
        await client.query(
          `UPDATE remem.candidate_memories SET status='promoted', reviewed_at=now()
          WHERE id=$1 AND metadata->>'providerId'=$2 AND status IN ('approved','consolidating')`,
          [candidate.id, this.id],
        )
        signal?.throwIfAborted()
        await client.query("COMMIT")
        return result
      } catch (error) {
        await client.query("ROLLBACK")
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined
        if (attempt < 2 && (code === "40001" || code === "40P01")) continue
        throw error
      } finally {
        client.release()
      }
    }
    throw new Error("learning transaction retry limit exceeded")
  }

  /** Body-free lineage inspection, authorized by the same scope rules as reads.
   * Missing evidence stays unavailable; retention does not refresh a claim. */
  async candidateLineage(
    candidateId: string,
    context: MemoryContext,
  ): Promise<CandidateLineage | undefined> {
    if (!UUID_PATTERN.test(candidateId)) return undefined
    const result = await this.pool.query<{
      scope_kind: string
      scope_key: string
      state: string
      memory_id: string | null
      revision: number
      observation_ids: string[]
      available_ids: string[]
      policy_version: string
      policy_outcome: string | null
      policy_reason: string | null
    }>(
      `SELECT l.*, ARRAY(SELECT e.id FROM remem.session_events e
          WHERE e.id=ANY(l.observation_ids) AND e.project_id=$3
            AND (e.provider_id=$1 OR e.provider_id IS NULL)) AS available_ids
        FROM remem.candidate_lineage l WHERE provider_id=$1 AND candidate_id=$2
          AND (scope_kind='global' OR (scope_kind='project' AND scope_key=$3)
            OR (scope_kind='workspace' AND scope_key=$4) OR (scope_kind='session' AND scope_key=$5))`,
      [this.id, candidateId, context.projectId, context.worktree, context.sessionId ?? ""],
    )
    const row = result.rows[0]
    if (!row) return undefined
    const audit = await this.pool.query<CandidateLineage["audit"][number]>(
      `SELECT revision,state,action,actor FROM remem.candidate_lineage_audit
       WHERE provider_id=$1 AND scope_kind=$2 AND scope_key=$3 AND candidate_id=$4
       ORDER BY revision DESC LIMIT 100`,
      [this.id, row.scope_kind, row.scope_key, candidateId],
    )
    return {
      candidateId,
      state: row.state,
      revision: row.revision,
      ...(row.memory_id ? { memoryId: row.memory_id } : {}),
      observationIds: row.observation_ids,
      availableObservationIds: row.available_ids,
      policyVersion: row.policy_version,
      ...(row.policy_outcome ? { policyOutcome: row.policy_outcome } : {}),
      ...(row.policy_reason ? { policyReason: row.policy_reason } : {}),
      audit: audit.rows,
    }
  }

  /** Project-only, body-free snapshots. No project means no history disclosure. */
  async learningHistory(
    context: MemoryContext,
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<LearningHistory> {
    options.signal?.throwIfAborted()
    if (!context.projectId) return { entries: [], gaps: [], limited: false }
    const limit = Number.isFinite(options.limit)
      ? Math.max(1, Math.min(LEARNING_DIAGNOSTIC_LIMIT, Math.floor(options.limit!)))
      : 5
    const result = await this.pool.query<{
      candidate_id: string
      state: string
      memory_id: string | null
      revision: number
      observation_ids: string[]
      available_ids: string[]
      policy_version: string
      policy_outcome: string | null
      policy_reason: string | null
      extractor_version: string
      confidence: number | null
      updated_at: Date
      audit: CandidateLineage["audit"]
    }>(
      `SELECT l.candidate_id,l.state,l.memory_id,l.revision,l.observation_ids[1:16] AS observation_ids,
        l.policy_version,l.policy_outcome,l.policy_reason,l.extractor_version,l.confidence,l.updated_at,
        ARRAY(SELECT e.id FROM remem.session_events e WHERE e.id=ANY(l.observation_ids[1:16])
          AND e.provider_id=$1 AND e.project_id=$2) AS available_ids,
        COALESCE((SELECT jsonb_agg(a) FROM (SELECT revision,state,action,actor
          FROM remem.candidate_lineage_audit WHERE provider_id=$1 AND scope_kind='project'
            AND scope_key=$2 AND candidate_id=l.candidate_id ORDER BY revision DESC LIMIT 3) a),'[]') AS audit
      FROM remem.candidate_lineage l WHERE provider_id=$1 AND scope_kind='project' AND scope_key=$2
      ORDER BY updated_at DESC,candidate_id LIMIT $3`,
      [this.id, context.projectId, limit + 1],
    )
    options.signal?.throwIfAborted()
    // Labels are server codes, never an arbitrary source/model diagnostic string.
    const code = (value: string) => (/^[a-z0-9.-]{1,80}$/u.test(value) ? value : "unrecognized")
    const entries: LearningHistoryEntry[] = result.rows.slice(0, limit).map((row) => ({
      candidateId: row.candidate_id,
      state: code(row.state),
      revision: row.revision,
      ...(row.memory_id ? { memoryId: row.memory_id } : {}),
      observationIds: row.observation_ids,
      availableObservationIds: row.available_ids,
      policyVersion: code(row.policy_version),
      extractorVersion: code(row.extractor_version),
      ...(row.policy_outcome ? { policyOutcome: code(row.policy_outcome) } : {}),
      ...(row.policy_reason ? { policyReason: code(row.policy_reason) } : {}),
      ...(row.confidence !== null && Number.isFinite(row.confidence)
        ? { confidence: row.confidence }
        : {}),
      updatedAt: row.updated_at.toISOString(),
      audit: row.audit.map((a) => ({
        revision: a.revision,
        state: code(a.state),
        action: code(a.action),
        actor: code(a.actor),
      })),
    }))
    const counters = await this.pool.query<{
      host: CaptureGap["host"]
      reason: CaptureGap["reason"]
      count: number
      updated_at: Date
    }>(
      `SELECT host,reason,count,updated_at FROM remem.learning_capture_gaps
       WHERE provider_id=$1 AND project_id=$2 AND updated_at >= now()-interval '30 days'
       ORDER BY updated_at DESC,host,reason LIMIT 68`,
      [this.id, context.projectId],
    )
    options.signal?.throwIfAborted()
    return {
      entries,
      limited: result.rows.length > limit,
      gaps: counters.rows.map((row) => ({
        host: row.host,
        reason: row.reason,
        count: row.count,
        lastObservedAt: row.updated_at.toISOString(),
      })),
    }
  }

  async recordCaptureGap(
    context: MemoryContext,
    gap: Pick<CaptureGap, "host" | "reason" | "count">,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    if (!context.projectId || context.projectId.length > 256 || context.projectId.includes("\0"))
      return
    if (
      !CAPTURE_GAP_REASONS.includes(gap.reason) ||
      !["opencode-v1", "opencode-v2", "pi", "other"].includes(gap.host) ||
      !Number.isInteger(gap.count) ||
      gap.count < 1 ||
      gap.count > 1_000_000
    )
      throw new TypeError("invalid capture gap counter")
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("SET LOCAL statement_timeout='1000ms'")
      await client.query(
        `INSERT INTO remem.providers(id,kind,name) VALUES($1,'postgres','Remem managed memory')
        ON CONFLICT(id) DO NOTHING`,
        [this.id],
      )
      // Do not revive a stale cumulative count as though its events were recent.
      await client.query(
        `INSERT INTO remem.learning_capture_gaps(provider_id,project_id,host,reason,count)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(provider_id,project_id,host,reason) DO UPDATE SET
        count=CASE WHEN learning_capture_gaps.updated_at < now()-interval '30 days' THEN EXCLUDED.count
          ELSE LEAST(2147483647::bigint,learning_capture_gaps.count::bigint+EXCLUDED.count)::integer END,
        updated_at=now()`,
        [this.id, context.projectId, gap.host, gap.reason, gap.count],
      )
      await client.query(
        `DELETE FROM remem.learning_capture_gaps WHERE provider_id=$1 AND updated_at < now()-interval '30 days'`,
        [this.id],
      )
      signal?.throwIfAborted()
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  private async lockLearningScope(client: PoolClient, scope: MemoryScope): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock_shared($1)", [FORGET_RESTORE_ADVISORY_LOCK])
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify(["learning", this.id, scope.kind, scope.id ?? ""]),
    ])
  }

  private async assertCanonicalPromotionEvidence(
    client: PoolClient,
    candidate: CandidateMemory,
  ): Promise<void> {
    const ids = [...new Set(candidate.observationIds)]
    if (ids.length === 0 || ids.length > 16) throw new Error("candidate evidence is unavailable")
    const result = await client.query<EpisodicEventRow>(
      "SELECT * FROM remem.session_events WHERE id=ANY($1::uuid[]) AND provider_id=$2 FOR SHARE",
      [ids, this.id],
    )
    const first = result.rows[0]
    if (!first || result.rows.length !== ids.length)
      throw new Error("candidate evidence is unavailable")
    const scope = candidate.memory.scope
    if (
      (scope.kind === "project" && scope.id !== first.project_id) ||
      (scope.kind === "session" && scope.id !== first.session_id)
    )
      throw new Error("candidate evidence is unavailable")
    for (const row of result.rows) {
      if (
        row.project_id !== first.project_id ||
        row.session_id !== first.session_id ||
        row.host !== first.host
      )
        throw new Error("candidate evidence is unavailable")
      const envelope = episodicRowToEnvelope(row)
      if (!sourceIsSafe(envelope)) throw new Error("candidate evidence is unavailable")
      const admitted = admitEvidence(
        {
          ...envelope,
          context: {
            directory: scope.id ?? this.id,
            worktree: scope.id ?? this.id,
            projectId: first.project_id,
            sessionId: first.session_id,
          },
        },
        { providerId: this.id, host: first.host, projectId: first.project_id },
        { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
      )
      if (
        admitted.outcome !== "admitted" ||
        admitted.envelope.id !== envelope.id ||
        admitted.envelope.contentHash !== envelope.contentHash
      )
        throw new Error("candidate evidence is unavailable")
    }
  }

  /** Resolve declared references inside the capture transaction. A source URI
   * or a hash-shaped string is not proof that evidence exists or is usable. */
  private async canonicalCaptureEvidence(
    client: PoolClient,
    observation: SessionObservation,
    candidate: CandidateMemory,
  ): Promise<string[] | undefined> {
    const raw: unknown = observation.payload.evidenceRefs
    const provenanceRefs = (candidate.memory.provenance ?? []).flatMap((entry) => {
      const refs: unknown = entry.source.metadata?.evidenceRefs
      if (refs === undefined) return []
      if (!Array.isArray(refs)) throw new Error("candidate evidence is unavailable")
      return refs as unknown[]
    })
    if (raw === undefined && provenanceRefs.length === 0) {
      if (observation.payload.verificationRule !== undefined)
        throw new Error("candidate evidence is unavailable")
      return undefined
    }
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 16 || provenanceRefs.length > 16)
      throw new Error("candidate evidence is unavailable")
    const refs = raw.map((value: unknown) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("providerId" in value) ||
        value.providerId !== this.id ||
        !("eventId" in value) ||
        typeof value.eventId !== "string" ||
        !EVIDENCE_ID_PATTERN.test(value.eventId)
      )
        throw new Error("candidate evidence is unavailable")
      return value.eventId
    })
    for (const value of provenanceRefs) {
      if (
        !value ||
        typeof value !== "object" ||
        !("providerId" in value) ||
        value.providerId !== this.id ||
        !("eventId" in value) ||
        typeof value.eventId !== "string" ||
        !refs.includes(value.eventId)
      )
        throw new Error("candidate evidence is unavailable")
    }
    const ids: string[] = []
    const canonicalSources: EvidenceEnvelope[] = []
    for (const evidenceId of [...new Set(refs)]) {
      const result = await client.query<EpisodicEventRow>(
        `SELECT * FROM remem.session_events
         WHERE provider_id=$1 AND evidence_id=$2 AND project_id=$3 AND session_id=$4
           AND NOT EXISTS (SELECT 1 FROM remem.forget_tombstones t
             WHERE t.provider_id=$1 AND t.project_id=$3 AND t.target_kind='evidence'
               AND t.target_id=$2)
         FOR SHARE`,
        [this.id, evidenceId, observation.context.projectId, observation.context.sessionId],
      )
      const row = result.rows[0]
      if (!row) throw new Error("candidate evidence is unavailable")
      const envelope = episodicRowToEnvelope(row)
      if (!sourceIsSafe(envelope)) throw new Error("candidate evidence is unavailable")
      const admitted = admitEvidence(
        { ...envelope, context: observation.context },
        {
          providerId: this.id,
          host: String(observation.payload.host),
          projectId: observation.context.projectId,
        },
        { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
      )
      if (
        admitted.outcome !== "admitted" ||
        admitted.envelope.id !== envelope.id ||
        admitted.envelope.contentHash !== envelope.contentHash
      )
        throw new Error("candidate evidence is unavailable")
      // Legacy assertion extraction consumes original user text only. Tool
      // evidence may support a future verified procedure, not a user assertion.
      if (
        observation.payload.modelProposal === undefined &&
        observation.kind !== "task-resolved" &&
        (envelope.role !== "user" ||
          envelope.origin !== "direct-user" ||
          envelope.payload.text?.trim() !== String(observation.payload.text).trim())
      )
        throw new Error("candidate evidence does not support this capture")
      ids.push(row.id)
      canonicalSources.push(envelope)
    }
    if (observation.payload.modelProposal !== undefined)
      validateModelProposal(observation, candidate, canonicalSources)
    if (observation.payload.verificationRule !== undefined) {
      const window = await this.procedureEvidenceWindow(
        client,
        this.id,
        refs.at(-1)!,
        observation.context,
      )
      const episode = verifiedProcedureFromEvidence(window, observation.context)
      const expected = episode && observationFromResolvedTask(episode)
      const extracted =
        expected && extractProcedureCandidate(expected, parseConfig({}).config.capture)
      if (
        !expected ||
        !extracted ||
        observation.payload.verificationRule !== expected.payload.verificationRule ||
        observation.id !== expected.id ||
        observation.payload.text !== expected.payload.text ||
        !isDeepStrictEqual(raw, expected.payload.evidenceRefs) ||
        candidate.id !== extracted.id ||
        candidate.memory.type !== "procedure" ||
        candidate.memory.content !== extracted.memory.content ||
        !isDeepStrictEqual(learningComparableMemory(candidate.memory), extracted.memory) ||
        candidate.memory.scope.kind !== "project" ||
        candidate.memory.scope.id !== observation.context.projectId ||
        observation.payload.requireReview !== true
      )
        throw new Error("candidate evidence does not verify this procedure")
    } else if (observation.kind === "task-resolved") {
      // Declaring canonical tool evidence opts into the new source contract.
      // The legacy trusted helper without references retains its old behavior.
      throw new Error("candidate evidence does not verify this procedure")
    }
    return ids
  }

  private async storedLearningDecision(
    client: PoolClient,
    observation: SessionObservation,
    candidate: CandidateMemory,
    ids: string[],
    autoPromote: boolean,
  ): Promise<LearningDecision> {
    const rows = await client.query<EpisodicEventRow>(
      "SELECT * FROM remem.session_events WHERE id=ANY($1::uuid[]) AND provider_id=$2 FOR SHARE",
      [ids, this.id],
    )
    const evidence = ids
      .map((id) => rows.rows.find((row) => row.id === id))
      .filter((row): row is EpisodicEventRow => Boolean(row))
      .map(episodicRowToEnvelope)
    let supportedExtraction = Boolean(observation.payload.verificationRule)
    if (observation.payload.modelProposal !== undefined)
      supportedExtraction = validateModelProposal(observation, candidate, evidence)
    else if (!supportedExtraction) {
      const extracted = await new DeterministicCandidateExtractor(
        parseConfig({ capture: { maxInputCharacters: 20000, maxCandidateCharacters: 10000 } })
          .config.capture,
      ).extract([observation])
      supportedExtraction = extracted.some(
        (expected) =>
          expected.id === candidate.id &&
          expected.memory.content === candidate.memory.content &&
          expected.memory.title === candidate.memory.title &&
          expected.memory.type === candidate.memory.type &&
          isDeepStrictEqual(learningComparableMemory(candidate.memory), expected.memory),
      )
    }
    const input = {
      candidate,
      observation,
      evidence,
      supportedExtraction,
      autoPromote,
      now: Date.now(),
    }
    const preliminary = decideLearning(input)
    if (!preliminary.key || preliminary.outcome !== "auto-promote") return preliminary
    const existing = await client.query<{
      title: string
      content: string
      metadata: Record<string, unknown>
    }>(
      `SELECT title,content,metadata FROM remem.memories WHERE provider_id=$1 AND scope_kind='project'
       AND scope_id=$2 AND type=$3 AND freshness='current' ORDER BY created_at DESC,id LIMIT 51`,
      [this.id, observation.context.projectId, candidate.memory.type],
    )
    const hasConflict =
      existing.rows.length > 50 ||
      existing.rows.some((row) => {
        const key =
          row.metadata.learningKey ??
          (candidate.memory.type === "procedure"
            ? undefined
            : assertionLearningKey({ ...candidate.memory, title: row.title, content: row.content }))
        return (
          key === preliminary.key &&
          row.content.replace(/\s+/gu, " ").trim() !==
            candidate.memory.content.replace(/\s+/gu, " ").trim()
        )
      })
    return hasConflict ? decideLearning({ ...input, hasConflict }) : preliminary
  }

  async persistCandidate(
    observation: SessionObservation,
    candidate: CandidateMemory,
    options: {
      timeoutMs?: number
      signal?: AbortSignal
      autoApprove?: boolean
      applyLearningPolicy?: boolean
      expectedRevision?: number
    } = {},
  ): Promise<void | CaptureReceipt> {
    options.signal?.throwIfAborted()
    if (
      observation.payload.verificationRule !== undefined &&
      options.autoApprove &&
      !options.applyLearningPolicy
    )
      throw new Error("host-derived procedures require review")
    if (candidate.status !== "pending")
      throw new TypeError("automatic capture may only persist pending candidates")
    const sessionId = observation.context.sessionId
    if (!sessionId) throw new TypeError("captured observations require a session id")
    const scope = candidate.memory.scope
    const key = scopeId(candidate.memory, observation.context) ?? ""
    const authorizedKey =
      scope.kind === "project"
        ? observation.context.projectId
        : scope.kind === "workspace"
          ? observation.context.worktree
          : scope.kind === "session"
            ? sessionId
            : ""
    if (key !== authorizedKey) throw new Error("captured candidate scope is not authorized")
    if (
      candidate.observationIds.length > 16 ||
      !candidate.observationIds.every((id) => UUID_PATTERN.test(id))
    )
      throw new TypeError("invalid candidate observation identities")
    const storedMemory = Object.fromEntries(
      Object.entries(candidate.memory).filter(
        ([field]) => field !== "title" && field !== "content" && field !== "summary",
      ),
    )
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      if (options.timeoutMs) {
        await client.query("SELECT set_config('statement_timeout', $1, true)", [
          String(options.timeoutMs),
        ])
      }
      await this.lockLearningScope(client, scope)
      const canonicalIds = await this.canonicalCaptureEvidence(client, observation, candidate)
      if (options.applyLearningPolicy && !canonicalIds)
        throw new Error("learning policy requires canonical evidence")
      const decision =
        options.applyLearningPolicy && canonicalIds
          ? await this.storedLearningDecision(
              client,
              observation,
              candidate,
              canonicalIds,
              Boolean(options.autoApprove),
            )
          : undefined
      const approved = decision ? decision.outcome === "auto-promote" : Boolean(options.autoApprove)
      const receipt: CaptureReceipt | undefined = decision
        ? {
            decision,
            status: approved
              ? "approved"
              : decision.outcome === "require-review"
                ? "pending"
                : "rejected",
          }
        : undefined
      if (decision) {
        // Policy revalidation compares the complete authorized extraction.
        // Legacy storage omitted this derived field; retain it for this path.
        storedMemory.summary = candidate.memory.summary
        storedMemory.metadata = {
          ...learningComparableMemory(candidate.memory).metadata,
          learningPolicy: decision,
          ...(decision.key ? { learningKey: decision.key } : {}),
        }
      }
      const observationIds = canonicalIds ?? candidate.observationIds
      const primaryObservationId = canonicalIds?.[0] ?? observation.id
      const prior = await client.query<{
        status: CandidateMemory["status"]
        same_context: boolean
        unchanged: boolean
      }>(
        `SELECT c.status,
          (c.metadata->>'providerId'=$2 AND c.scope_kind=$3 AND COALESCE(c.scope_id,'')=$4
            AND c.session_event_id IN ($5::uuid,$12::uuid) AND e.session_id=$6 AND e.project_id=$7) AS same_context,
          (c.title=$8 AND c.content=$9 AND c.type=$10 AND c.metadata->'memory'=$11::jsonb) AS unchanged
         FROM remem.candidate_memories c LEFT JOIN remem.session_events e ON e.id=c.session_event_id
         WHERE c.id=$1 FOR UPDATE OF c`,
        [
          candidate.id,
          this.id,
          scope.kind,
          key,
          observation.id,
          sessionId,
          observation.context.projectId,
          candidate.memory.title,
          candidate.memory.content,
          candidate.memory.type,
          JSON.stringify(storedMemory),
          primaryObservationId,
        ],
      )
      const old = prior.rows[0]
      if (old && !old.same_context)
        throw new Error("captured candidate id belongs to another context")
      const ledger = await client.query<{ state: string; revision: number }>(
        `SELECT state,revision FROM remem.candidate_lineage WHERE provider_id=$1 AND scope_kind=$2
          AND scope_key=$3 AND candidate_id=$4 FOR UPDATE`,
        [this.id, scope.kind, key, candidate.id],
      )
      const previous = ledger.rows[0]
      const tombstone = await client.query(
        `SELECT 1 FROM remem.forget_tombstones
        WHERE provider_id=$1 AND project_id=$2 AND target_kind='candidate' AND target_id=$3`,
        [this.id, observation.context.projectId, candidate.id],
      )
      if (
        tombstone.rowCount ||
        (previous && !["pending"].includes(previous.state)) ||
        (old && old.status !== "pending")
      ) {
        await client.query("COMMIT")
        return receipt &&
          (tombstone.rowCount ||
            ["rejected", "expired", "forgotten"].includes(previous?.state ?? "") ||
            old?.status === "rejected" ||
            old?.status === "expired")
          ? {
              status: "rejected",
              decision: {
                ...receipt.decision,
                outcome: "reject",
                reason: "processed-candidate-unavailable",
              },
            }
          : receipt
      }
      if (
        old &&
        !old.unchanged &&
        (options.expectedRevision === undefined ||
          options.expectedRevision !== (previous?.revision ?? 0))
      )
        throw new Error("candidate revision conflict")
      if (old?.unchanged && !approved) {
        await client.query("COMMIT")
        return receipt
      }
      if (decision && receipt?.status === "rejected") {
        await client.query(
          `INSERT INTO remem.candidate_lineage
           (provider_id,scope_kind,scope_key,candidate_id,state,observation_ids,action,actor,policy_version,extractor_version,policy_outcome,policy_reason,confidence)
           VALUES ($1,$2,$3,$4,'rejected',$5,'learning-declined','learning-policy',$6,$7,$8,$9,$10)
           ON CONFLICT DO NOTHING`,
          [
            this.id,
            scope.kind,
            key,
            candidate.id,
            observationIds,
            decision.version,
            observation.payload.modelProposal !== undefined
              ? MODEL_PROPOSAL_VERSION
              : "evidence-linked-v1",
            decision.outcome,
            decision.reason,
            Number.isFinite(candidate.confidence) &&
            candidate.confidence >= 0 &&
            candidate.confidence <= 1
              ? candidate.confidence
              : null,
          ],
        )
        await client.query("COMMIT")
        return receipt
      }
      options.signal?.throwIfAborted()
      const persistedObservation = canonicalIds
        ? undefined
        : await client.query<{ id: string }>(
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
      if (!canonicalIds && !persistedObservation?.rows[0]) {
        throw new Error("captured observation id belongs to another context")
      }
      options.signal?.throwIfAborted()
      const persistedCandidate = await client.query<{ id: string }>(
        `INSERT INTO remem.candidate_memories
         (id, session_event_id, type, title, content, scope_kind, scope_id, confidence, status, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$10,$9::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           session_event_id = EXCLUDED.session_event_id,
           type = EXCLUDED.type,
           title = EXCLUDED.title,
           content = EXCLUDED.content,
           scope_kind = EXCLUDED.scope_kind,
           scope_id = EXCLUDED.scope_id,
           confidence = EXCLUDED.confidence,
           status = EXCLUDED.status,
           metadata = EXCLUDED.metadata
         WHERE remem.candidate_memories.status = 'pending'
           AND remem.candidate_memories.session_event_id IN (EXCLUDED.session_event_id,$11::uuid)
           AND remem.candidate_memories.scope_kind = EXCLUDED.scope_kind
           AND remem.candidate_memories.scope_id IS NOT DISTINCT FROM EXCLUDED.scope_id
           AND remem.candidate_memories.metadata->>'providerId' = EXCLUDED.metadata->>'providerId'
         RETURNING id`,
        [
          candidate.id,
          primaryObservationId,
          candidate.memory.type,
          candidate.memory.title,
          candidate.memory.content,
          candidate.memory.scope.kind,
          scopeId(candidate.memory, observation.context) ?? null,
          clamp(candidate.confidence, 0.5),
          JSON.stringify({
            providerId: this.id,
            memory: storedMemory,
            reasons: candidate.reasons,
            observationIds,
            ...(canonicalIds ? { canonicalEvidence: true } : {}),
            ...(decision
              ? {
                  learningPolicy: decision,
                  learningObservation: {
                    id: observation.id,
                    kind: observation.kind,
                    occurredAt: observation.occurredAt,
                    source: observation.source,
                    payload: Object.fromEntries(
                      Object.entries(observation.payload).filter(([name]) => name !== "text"),
                    ),
                  },
                }
              : {}),
          }),
          approved ? "approved" : "pending",
          observation.id,
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
            primaryObservationId,
            candidate.memory.scope.kind,
            scopeId(candidate.memory, observation.context) ?? null,
            this.id,
          ],
        )
        if (!existing.rows[0]) throw new Error("captured candidate id belongs to another context")
      }
      await client.query(
        `INSERT INTO remem.candidate_lineage
        (provider_id,scope_kind,scope_key,candidate_id,state,observation_ids,action,actor,policy_version,extractor_version,policy_outcome,policy_reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'capture',$8,$9,$10,$11)
        ON CONFLICT (provider_id,scope_kind,scope_key,candidate_id) DO UPDATE SET
          state=EXCLUDED.state, observation_ids=EXCLUDED.observation_ids, action=EXCLUDED.action, actor='capture',
          policy_version=EXCLUDED.policy_version,extractor_version=EXCLUDED.extractor_version,
          policy_outcome=EXCLUDED.policy_outcome,policy_reason=EXCLUDED.policy_reason`,
        [
          this.id,
          scope.kind,
          key,
          candidate.id,
          approved ? "approved" : "pending",
          observationIds,
          approved ? "capture-auto-approved" : old ? "capture-refreshed" : "capture-persisted",
          decision?.version ?? "deterministic-consolidation-v1",
          observation.payload.modelProposal !== undefined
            ? MODEL_PROPOSAL_VERSION
            : decision
              ? "evidence-linked-v1"
              : "legacy-or-capture-v1",
          decision?.outcome ?? null,
          decision?.reason ?? null,
        ],
      )
      options.signal?.throwIfAborted()
      await client.query("COMMIT")
      return receipt
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

    // TASK-013: take the identity-scoped advisory lock first so an in-flight
    // `confirmForget` for this exact `(provider, project, evidence)` cannot
    // interleave between the tombstone check and the INSERT below. The lock
    // is session-scoped (pg_advisory_lock), so it is unaffected by the
    // BEGIN/COMMIT opened inside the callback.
    return this.withEvidenceIdentityLock(
      envelope.providerId,
      envelope.context.projectId,
      envelope.id,
      async (client) => {
        // A local statement_timeout only survives inside an explicit
        // transaction (set_config is_local => true is transaction-scoped); in
        // autocommit each statement is its own transaction and the setting is
        // discarded before it can take effect. Wrap the tombstone check, the
        // INSERT, and the fallback SELECT in one BEGIN/COMMIT so the timeout
        // is honored and the statements observe a single, consistent snapshot.
        await client.query("BEGIN")
        try {
          if (options.timeoutMs) {
            await client.query("SELECT set_config('statement_timeout', $1, true)", [
              String(options.timeoutMs),
            ])
          }
          options.signal?.throwIfAborted()
          const result = await this.appendEvidenceInTransaction(client, envelope, sessionId)
          await client.query("COMMIT")
          return result
        } catch (error) {
          await client.query("ROLLBACK")
          throw error
        }
      },
    )
  }

  /**
   * Body of {@link appendEvidence}, run inside the caller's open transaction
   * and identity advisory lock. Returns the append outcome; the caller
   * commits before returning it.
   */
  private async appendEvidenceInTransaction(
    client: PoolClient,
    envelope: EvidenceEnvelope,
    sessionId: string,
  ): Promise<EpisodicAppendResult> {
    // A privacy tombstone wins over every append path, including a host
    // replay arriving after the original event was forgotten. The same
    // identity-scoped advisory lock held by the caller (and by `confirmForget`)
    // closes the read-then-insert race with that confirmation transaction.
    const tombstone = await client.query(
      `SELECT 1
         FROM remem.forget_tombstones
         WHERE provider_id = $1 AND project_id = $2
           AND target_kind = 'evidence' AND target_id = $3`,
      [envelope.providerId, envelope.context.projectId, envelope.id],
    )
    if (tombstone.rows[0]) return { outcome: "forgotten", id: envelope.id }

    // Evidence exists before semantic learning. Register its admitted provider
    // in this transaction so privacy previews do not depend on a later memory write.
    await client.query(
      `INSERT INTO remem.providers(id,kind,name) VALUES($1,'postgres','Remem managed memory')
      ON CONFLICT(id) DO NOTHING`,
      [envelope.providerId],
    )

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
      const outcome = existingRow.content_hash === envelope.contentHash ? "duplicate" : "collision"
      return { outcome, id: envelope.id }
    }
    /* istanbul ignore next -- the loop above always returns or throws within its two iterations. */
    throw new Error("unreachable: appendEvidence retry loop exited without returning")
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
        `SELECT c.id FROM remem.candidate_memories c
         WHERE c.session_event_id=$1 OR EXISTS (
           SELECT 1 FROM remem.candidate_lineage l
           WHERE l.candidate_id=c.id AND l.provider_id=$2
             AND l.observation_ids @> ARRAY[$1::uuid])
         ORDER BY c.id`,
        [sessionEventId, this.id],
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
              `SELECT c.id FROM remem.candidate_memories c
             WHERE (c.session_event_id=$1 OR EXISTS (
               SELECT 1 FROM remem.candidate_lineage l
               WHERE l.candidate_id=c.id AND l.provider_id=$3
                 AND l.observation_ids @> ARRAY[$1::uuid]))
               AND NOT (c.id = ANY($2::uuid[]))
             LIMIT 1`,
              [row.session_event_id, row.candidate_ids, this.id],
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

  async readModelEvidenceWindow(
    context: MemoryContext,
    signal?: AbortSignal,
  ): Promise<EvidenceEnvelope[]> {
    signal?.throwIfAborted()
    if (!context.projectId || !context.sessionId) return []
    const result = await this.pool.query<EpisodicEventRow>(
      `SELECT * FROM remem.session_events WHERE provider_id=$1 AND project_id=$2 AND session_id=$3
       AND evidence_id IS NOT NULL AND occurred_at >= now()-interval '24 hours'
       AND ((role='user' AND origin='direct-user') OR (role='tool' AND origin='host-observed'))
       ORDER BY created_at DESC,id DESC LIMIT 8`,
      [this.id, context.projectId, context.sessionId],
    )
    signal?.throwIfAborted()
    return result.rows.reverse().map(episodicRowToEnvelope)
  }

  async readProcedureEvidenceWindow(
    providerId: string,
    triggerId: string,
    context: MemoryContext,
  ): Promise<EvidenceEnvelope[]> {
    return this.procedureEvidenceWindow(this.pool, providerId, triggerId, context)
  }

  /** Bounded original-task window, ordered by PostgreSQL ingestion time,
   * not the host's absent timestamp or lexical evidence hash. Equal times
   * and a missing original prompt are unsupported, never guessed. */
  private async procedureEvidenceWindow(
    queryable: Pool | PoolClient,
    providerId: string,
    triggerId: string,
    context: MemoryContext,
  ): Promise<EvidenceEnvelope[]> {
    if (providerId !== this.id || !context.sessionId) return []
    const result = await queryable.query<EpisodicEventRow & { evidence_order: string }>(
      `WITH trigger AS (
         SELECT created_at,host FROM remem.session_events
         WHERE provider_id=$1 AND evidence_id=$2 AND project_id=$3 AND session_id=$4
           AND host IN ('opencode-v2','pi')
       )
       SELECT e.*, e.created_at::text AS evidence_order FROM remem.session_events e, trigger t
       WHERE e.provider_id=$1 AND e.project_id=$3 AND e.session_id=$4
         AND e.host=t.host AND e.evidence_id IS NOT NULL AND e.created_at<=t.created_at
       ORDER BY e.created_at DESC, e.id DESC LIMIT $5`,
      [providerId, triggerId, context.projectId, context.sessionId, PROCEDURE_WINDOW_LIMIT + 1],
    )
    const rows = result.rows
    if (rows[0]?.evidence_id !== triggerId) return []
    const prompt = rows.findIndex((row) => row.role === "user")
    if (prompt < 0 || prompt >= PROCEDURE_WINDOW_LIMIT) return []
    const selected = rows.slice(0, prompt + 1)
    if (
      selected.some(
        (row, index) => index > 0 && row.evidence_order === selected[index - 1]?.evidence_order,
      )
    )
      return []
    return selected.reverse().map(episodicRowToEnvelope)
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
    const roles = options.roles ?? EVIDENCE_ROLES
    if (
      !Array.isArray(roles) ||
      roles.length === 0 ||
      roles.some((role: unknown) => !EVIDENCE_ROLES.some((allowed) => allowed === role))
    ) {
      return { matches: [], budgetExhausted: false }
    }
    // `Number.isFinite` guards against a caller-supplied `NaN` (which
    // survives `Math.min`/`Math.max` unclamped -- `Math.min(NaN, 10)` is
    // `NaN`, not `10`) reaching the SQL `LIMIT` parameter as an invalid
    // value; a non-finite request falls back to the hard ceiling, mirroring
    // the existing `clamp` helper used elsewhere in this file for the same
    // class of untrusted numeric input.
    const requestedLimit = options.limit
    // `Math.trunc` keeps the SQL `LIMIT` an integer: a fractional caller
    // request (e.g. `2.7`) survives the clamp unchanged and Postgres rejects
    // a non-integer `LIMIT` bound at execution time.
    const limit = Math.trunc(
      Math.max(
        0,
        Math.min(
          requestedLimit !== undefined && Number.isFinite(requestedLimit)
            ? requestedLimit
            : EPISODIC_SEARCH_MAX_RESULTS,
          EPISODIC_SEARCH_MAX_RESULTS,
        ),
      ),
    )
    const requestedMaxOutputTokens = options.maxOutputTokens
    const maxOutputTokens = Math.max(
      0,
      Math.min(
        requestedMaxOutputTokens !== undefined && Number.isFinite(requestedMaxOutputTokens)
          ? requestedMaxOutputTokens
          : EPISODIC_SEARCH_MAX_OUTPUT_TOKENS,
        EPISODIC_SEARCH_MAX_OUTPUT_TOKENS,
      ),
    )
    if (limit === 0 || maxOutputTokens === 0 || query.trim().length === 0) {
      return { matches: [], budgetExhausted: false }
    }
    // Bound the raw input handed to plainto_tsquery so an oversized query
    // cannot exhaust database resources (see EPISODIC_SEARCH_MAX_QUERY_LENGTH).
    const boundedQuery =
      query.length > EPISODIC_SEARCH_MAX_QUERY_LENGTH
        ? query.slice(0, EPISODIC_SEARCH_MAX_QUERY_LENGTH)
        : query

    interface MatchRow extends EpisodicEventRow {
      preceding_id: string | null
      following_id: string | null
    }
    const matched = await this.pool.query<MatchRow>(
      `WITH query AS (SELECT plainto_tsquery('simple', $3) AS terms),
       matched AS MATERIALIZED (
         SELECT e.*, ts_rank_cd(e.search_vector, query.terms) AS search_rank,
           CASE WHEN $6::boolean AND e.payload->>'status'='completed'
             AND (e.payload->'result'->>'exit' IS NULL OR e.payload->'result'->>'exit'='0')
             THEN 0 ELSE 1 END AS outcome_rank
         FROM remem.session_events e, query
         WHERE e.provider_id=$1 AND e.project_id=$2 AND e.evidence_id IS NOT NULL
           AND e.search_vector @@ query.terms AND e.role=ANY($5::text[])
           AND (NOT $6::boolean OR e.session_id <> $7::text)
         ORDER BY search_rank DESC, outcome_rank, e.occurred_at DESC, e.id
         LIMIT $4
       )
       SELECT matched.id, matched.session_id, matched.project_id, matched.provider_id, matched.kind,
              matched.occurred_at, matched.host, matched.role, matched.origin, matched.turn_id,
              matched.message_id, matched.safe_text, matched.payload, matched.evidence_refs,
              matched.evidence_id, matched.content_hash, matched.schema_version,
              preceding.id AS preceding_id, following.id AS following_id
       FROM matched
       LEFT JOIN LATERAL (
         SELECT e.id FROM remem.session_events e
         WHERE $8::boolean AND e.provider_id=$1 AND e.project_id=$2
           AND e.session_id=matched.session_id AND e.evidence_id IS NOT NULL
           AND (e.occurred_at,e.id) < (matched.occurred_at,matched.id)
         ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1
       ) preceding ON true
       LEFT JOIN LATERAL (
         SELECT e.id FROM remem.session_events e
         WHERE $8::boolean AND e.provider_id=$1 AND e.project_id=$2
           AND e.session_id=matched.session_id AND e.evidence_id IS NOT NULL
           AND (e.occurred_at,e.id) > (matched.occurred_at,matched.id)
         ORDER BY e.occurred_at,e.id LIMIT 1
       ) following ON true
       ORDER BY matched.search_rank DESC, matched.outcome_rank, matched.occurred_at DESC, matched.id`,
      [
        providerId,
        context.projectId,
        boundedQuery,
        limit,
        roles,
        options.automaticRecall === true,
        context.sessionId ?? "",
        options.includeNeighbors !== false && options.automaticRecall !== true,
      ],
    )
    if (matched.rows.length === 0) return { matches: [], budgetExhausted: false }

    const neighborIds =
      options.includeNeighbors === false || options.automaticRecall === true
        ? []
        : [
            ...new Set(
              matched.rows.flatMap((row) =>
                [row.preceding_id, row.following_id].filter((id): id is string => id !== null),
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
    let withheldResults = 0
    const matches: EpisodicSearchMatch[] = []
    for (const row of matched.rows) {
      if (remainingTokens <= 0) {
        budgetExhausted = true
        break
      }
      const envelope = episodicRowToEnvelope(row)
      if (options.screenUnsafeSources && !sourceIsSafe(envelope)) {
        withheldResults++
        continue
      }
      if (
        options.automaticRecall &&
        episodeResults(
          { matches: [{ envelope, truncated: false, neighbors: [] }], budgetExhausted: false },
          providerId,
          context,
        ).length === 0
      )
        continue
      const fittedMatch = fitEnvelopeToBudget(envelope, remainingTokens)
      if (options.automaticRecall && (!fittedMatch.fits || fittedMatch.truncated)) {
        budgetExhausted = true
        continue
      }
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
        if (!neighborId || options.includeNeighbors === false || options.automaticRecall) continue
        if (remainingTokens <= 0) {
          budgetExhausted = true
          break
        }
        const neighborRow = neighborRowsById.get(neighborId)
        if (!neighborRow) continue // should be unreachable: fetched by the ids just collected above
        if (options.screenUnsafeSources && !sourceIsSafe(episodicRowToEnvelope(neighborRow))) {
          withheldResults++
          continue
        }
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
    if (!options.automaticRecall && matches.length < matched.rows.length) budgetExhausted = true

    return { matches, budgetExhausted, ...(options.screenUnsafeSources ? { withheldResults } : {}) }
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
    // Release the pooled connection at most once. If the unlock query itself
    // fails, the session may still hold the advisory lock, so the connection
    // must be *discarded* from the pool (`release(err)`) rather than handed to
    // the next caller -- otherwise that caller inherits a still-held lock on
    // the same key and blocks forever. The common failure (a dead connection)
    // already auto-releases the session lock server-side; this guards the
    // rarer case where unlock fails on a connection the pool would still reuse.
    let released = false
    const releaseOnce = (err?: Error) => {
      if (released) return
      released = true
      client.release(err)
    }
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey])
      // Run the critical section and capture its outcome rather than
      // returning directly, so the unlock is attempted next in normal control
      // flow (not inside a `finally`, where a rethrow would silently override
      // fn's own result/throw -- eslint no-unsafe-finally).
      let result: T
      try {
        result = await fn(client)
      } catch (fnError) {
        // fn failed: still attempt to release the advisory lock before
        // propagating. If unlock also fails the connection is poisoned, so
        // discard it and surface the unlock failure (the lock leak is the more
        // operationally severe signal); otherwise re-throw fn's original error.
        try {
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey])
        } catch (unlockError) {
          releaseOnce(unlockError instanceof Error ? unlockError : new Error(String(unlockError)))
          throw unlockError
        }
        throw fnError
      }
      // fn succeeded: unlock, discarding the connection if unlock fails so a
      // still-lock-holding connection is never handed to the next caller.
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey])
      } catch (unlockError) {
        releaseOnce(unlockError instanceof Error ? unlockError : new Error(String(unlockError)))
        throw unlockError
      }
      return result
    } finally {
      releaseOnce()
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
    return toFiniteByteCount(result.rows[0]?.total)
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
    // INSERT ... ON CONFLICT DO UPDATE ... RETURNING always yields exactly
    // one row (the upserted capacity_state row). Assert it explicitly rather
    // than with a non-null assertion so a broken invariant surfaces as a
    // descriptive error instead of an opaque property access on undefined.
    const row = result.rows[0]
    if (row === undefined) {
      throw new Error(
        `capacity_state upsert returned no row for provider=${providerId} project=${projectId}`,
      )
    }
    return {
      level: compactionLevelAtIndex(row.compaction_level),
      previousTotalBytes:
        row.last_checked_at === null ? undefined : toFiniteByteCount(row.last_total_bytes),
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
            // narrativeTarget is a byte count; this passes it as
            // truncateToTokens' "maxTokens" only because that helper's token
            // weight is Buffer.byteLength (token-budget.ts) -- i.e. its
            // "tokens" are bytes today. If that ever becomes a real token
            // estimate, this call must switch to a byte-based truncation.
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
        //
        // content_hash is intentionally NOT recomputed here. It reflects the
        // admission-time content and remains the dedup key: admission compares
        // an incoming envelope's hash against the stored content_hash (see the
        // SELECT/compare at ~postgres.ts:1112/1132) and never re-derives a hash
        // from safe_text. Compaction rewrites safe_text in place, so after this
        // UPDATE the stored content_hash no longer matches the current
        // safe_text -- that divergence is by design, not a bug: dedup must key
        // on what was originally admitted, not on the post-compaction text.
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
        // Validate before enqueueing for deletion: a NaN here would defeat the
        // `<=` break above and push the whole batch into the DELETE set (see
        // toFiniteByteCount, which throws on a non-finite value). Coercing
        // first keeps the invariant self-evident -- a row only enters
        // idsToRemove after its byte count is known good, so a throw aborts
        // before any id is queued rather than leaving a partially-built set.
        const rowBytes = toFiniteByteCount(row.bytes)
        idsToRemove.push(row.id)
        totalBytes -= rowBytes
        bytesReclaimed += rowBytes
      }

      if (idsToRemove.length > 0) {
        await client.query(`DELETE FROM remem.session_events WHERE id = ANY($1::uuid[])`, [
          idsToRemove,
        ])
      }

      const totalBytesAfter = await this.computeTotalBytes(providerId, projectId, client)
      // "Eligible rows exhausted" means we are still over the hard limit AND
      // there are no more eligible rows a subsequent call could remove. When
      // this batch was capped at HARD_LIMIT_BATCH_SIZE, more eligible rows may
      // remain, so this is not genuine exhaustion -- the caller can re-invoke
      // to remove the next batch.
      const batchWasCapped = candidates.rows.length >= HARD_LIMIT_BATCH_SIZE
      return {
        rowsRemoved: idsToRemove.length,
        bytesReclaimed,
        totalBytesAfter,
        exhaustedEligibleRows: totalBytesAfter > limits.hardLimitBytes && !batchWasCapped,
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

  async reviewCandidate(
    id: string,
    status: "approved" | "rejected",
    expectedRevision?: number,
  ): Promise<void> {
    if (!UUID_PATTERN.test(id)) throw new TypeError("candidate id must be a UUID")
    if (!["approved", "rejected"].includes(status)) throw new TypeError("invalid review transition")
    await this.mutateWithClient(async (client) => {
      const lookup = await client.query<{
        scope_kind: MemoryScope["kind"]
        scope_id: string | null
      }>(
        "SELECT scope_kind,scope_id FROM remem.candidate_memories WHERE id=$1 AND metadata->>'providerId'=$2",
        [id, this.id],
      )
      const scope = lookup.rows[0]
      if (!scope) throw new Error("pending candidate not found")
      await this.lockLearningScope(client, {
        kind: scope.scope_kind,
        ...(scope.scope_id ? { id: scope.scope_id } : {}),
      })
      const current = await client.query<{ revision: number }>(
        `SELECT revision FROM remem.candidate_lineage
        WHERE provider_id=$1 AND scope_kind=$2 AND scope_key=$3 AND candidate_id=$4 FOR UPDATE`,
        [this.id, scope.scope_kind, scope.scope_id ?? "", id],
      )
      if (expectedRevision !== undefined && current.rows[0]?.revision !== expectedRevision)
        throw new Error("candidate revision conflict")
      const result = await client.query(
        `UPDATE remem.candidate_memories SET status=$3, reviewed_at=now()
        WHERE id=$1 AND metadata->>'providerId'=$2 AND status='pending' RETURNING id`,
        [id, this.id, status],
      )
      if (!result.rowCount) throw new Error("pending candidate not found")
      await client.query(
        `INSERT INTO remem.candidate_lineage
        (provider_id,scope_kind,scope_key,candidate_id,state,observation_ids,action,actor)
        SELECT $1,scope_kind,COALESCE(scope_id,''),id,$3,
          CASE WHEN session_event_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[session_event_id] END,
          'human-review','review' FROM remem.candidate_memories WHERE id=$2
        ON CONFLICT (provider_id,scope_kind,scope_key,candidate_id) DO UPDATE SET
          state=EXCLUDED.state, action='human-review', actor='review'`,
        [this.id, id, status],
      )
    })
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

  async claimEvidenceExtraction(
    context: MemoryContext,
    host: string,
    origins: readonly EvidenceOrigin[],
    version: string,
    signal?: AbortSignal,
  ): Promise<EvidenceExtractionClaim[]> {
    signal?.throwIfAborted()
    if (
      !context.projectId ||
      !["pi", "opencode-v2"].includes(host) ||
      !version.startsWith(EVIDENCE_REFLECTION_VERSION + ":")
    )
      return []
    const token = randomUUID()
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("SET LOCAL statement_timeout='1000ms'")
      const rows = await client.query<EpisodicEventRow>(
        `
        WITH eligible AS (
          SELECT e.id FROM remem.session_events e
          WHERE e.provider_id=$1 AND e.project_id=$2 AND e.host=$3
            AND e.schema_version=1 AND e.origin=ANY($4::text[])
            AND e.role IN ('user','tool') AND e.occurred_at >= now()-interval '24 hours'
            AND e.occurred_at <= now()+interval '5 minutes'
            AND e.extraction_version IS DISTINCT FROM $5
            AND (e.extraction_claim_until IS NULL OR e.extraction_claim_until <= now())
            AND NOT EXISTS (SELECT 1 FROM remem.candidate_lineage l
              WHERE l.provider_id=$1 AND l.observation_ids @> ARRAY[e.id])
            AND NOT EXISTS (SELECT 1 FROM remem.forget_tombstones t
              WHERE t.provider_id=$1 AND t.project_id=$2 AND t.target_kind='evidence' AND t.target_id=e.evidence_id)
          ORDER BY e.occurred_at,e.id LIMIT 8 FOR UPDATE OF e SKIP LOCKED
        )
        UPDATE remem.session_events e SET extraction_claim_token=$6,
          extraction_claim_until=now()+interval '30 seconds',
          extraction_attempts=LEAST(2147483647::bigint,e.extraction_attempts::bigint+1)::integer
        FROM eligible WHERE e.id=eligible.id RETURNING e.*
      `,
        [this.id, context.projectId, host, origins, version, token],
      )
      signal?.throwIfAborted()
      await client.query("COMMIT")
      return rows.rows.map((row) => ({
        envelope: {
          ...episodicRowToEnvelope(row),
          context: { ...context, projectId: row.project_id, sessionId: row.session_id },
        },
        token,
      }))
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  async finishEvidenceExtraction(
    claim: EvidenceExtractionClaim,
    version: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    signal?.throwIfAborted()
    if (
      claim.envelope.providerId !== this.id ||
      !version.startsWith(EVIDENCE_REFLECTION_VERSION + ":")
    )
      return false
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("SET LOCAL statement_timeout='1000ms'")
      const result = await client.query(
        `UPDATE remem.session_events SET extraction_version=$6,
        extraction_claim_token=NULL,extraction_claim_until=NULL,extracted_at=now()
        WHERE provider_id=$1 AND project_id=$2 AND evidence_id=$3 AND content_hash=$4
          AND extraction_claim_token=$5 AND extraction_claim_until>now()
          AND NOT EXISTS (SELECT 1 FROM remem.forget_tombstones t
            WHERE t.provider_id=$1 AND t.project_id=$2 AND t.target_kind='evidence' AND t.target_id=$3)`,
        [
          this.id,
          claim.envelope.context.projectId,
          claim.envelope.id,
          claim.envelope.contentHash,
          claim.token,
          version,
        ],
      )
      signal?.throwIfAborted()
      await client.query("COMMIT")
      return result.rowCount === 1
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  async reflectionStatus(
    context: MemoryContext,
  ): Promise<{ unprocessed: number; claimed: number }> {
    if (!context.projectId) return { unprocessed: 0, claimed: 0 }
    const result = await this.pool.query<{ unprocessed: number; claimed: number }>(
      `SELECT
      count(*) FILTER (WHERE extraction_version IS NULL)::int AS unprocessed,
      count(*) FILTER (WHERE extraction_claim_until>now())::int AS claimed
      FROM remem.session_events e WHERE provider_id=$1 AND project_id=$2 AND schema_version=1
        AND occurred_at >= now()-interval '24 hours' AND role IN ('user','tool')
        AND NOT EXISTS (SELECT 1 FROM remem.candidate_lineage l
          WHERE l.provider_id=$1 AND l.observation_ids @> ARRAY[e.id])`,
      [this.id, context.projectId],
    )
    return result.rows[0] ?? { unprocessed: 0, claimed: 0 }
  }

  async recoverLearningCandidates(
    context: MemoryContext,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ selected: number; promoted: number; pending: number; failed: number }> {
    options.signal?.throwIfAborted()
    if (!context.projectId) throw new TypeError("learning recovery requires a project")
    // Direct capture has no durable intermediate claim: its first promotion
    // is atomic. Concurrent startup attempts reuse the managed scope lock and
    // processed ledger. Keep this one small batch, not a new background worker.
    const rows = await this.pool.query<CandidateRow>(
      `SELECT * FROM remem.candidate_memories WHERE status='approved'
       AND scope_kind='project' AND scope_id=$1 AND metadata->>'providerId'=$2
       AND metadata->>'canonicalEvidence'='true'
       AND metadata->'learningPolicy'->>'version'=ANY($3::text[])
       AND metadata->'learningPolicy'->>'outcome'='auto-promote'
       ORDER BY created_at,id LIMIT 8`,
      [context.projectId, this.id, REVALIDATABLE_LEARNING_POLICY_VERSIONS],
    )
    options.signal?.throwIfAborted()
    const results = await new DeterministicConsolidationPipeline(this, {
      batchSize: 8,
    }).consolidate(rows.rows.map(candidateFromRow), options.signal)
    return {
      selected: rows.rows.length,
      promoted: results.filter((candidate) => candidate.status === "promoted").length,
      pending: results.filter((candidate) => candidate.status === "pending").length,
      failed: results.filter((candidate) => candidate.status === "approved").length,
    }
  }

  async reembedStale(batchSize = 25, signal?: AbortSignal) {
    const fingerprint = modelFingerprint(this.embeddingModel)
    if (!fingerprint) throw new TypeError("reindex requires a canonical embedding space identity")
    return new PostgresReembedRunner(
      this.pool,
      (text, signal) => embedDocument(this.embeddingModel, text, signal),
      {
        providerId: this.id,
        fingerprint,
        modelId: this.embeddingModel.id,
        dimensions: this.embeddingModel.dimensions,
        batchSize,
      },
    ).run(signal)
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
        `INSERT INTO remem.embedding_settings (id, model, dimensions, fingerprint, updated_at)
         VALUES (true, $1, $2, $3, now())
         ON CONFLICT (id) DO UPDATE SET model = $1, dimensions = $2, fingerprint = $3, updated_at = now()`,
        [
          this.embeddingModel.id,
          this.embeddingModel.dimensions,
          modelFingerprint(this.embeddingModel) ?? null,
        ],
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
    await client.query("SAVEPOINT remem_optional_embedding")
    try {
      const embedding =
        (memory.embeddingFingerprint &&
        memory.embeddingFingerprint === modelFingerprint(this.embeddingModel)
          ? memory.embedding
          : undefined) ??
        (await embedDocument(
          this.embeddingModel,
          [memory.title, memory.summary, memory.content, aliases.join(" "), tags.join(" ")]
            .filter(Boolean)
            .join("\n"),
          options.signal,
        ))
      await client.query(
        `INSERT INTO remem.memory_embeddings (memory_id, model, dimensions, embedding, fingerprint)
         VALUES ($1, $2, $3, $4::vector, $5)`,
        [
          id,
          this.embeddingModel.id,
          this.embeddingModel.dimensions,
          vectorLiteral(embedding),
          modelFingerprint(this.embeddingModel) ?? null,
        ],
      )
      catalogEmbedding = await embedDocument(
        this.embeddingModel,
        [memory.title, memory.summary, aliases.join(" "), tags.join(" ")]
          .filter(Boolean)
          .join("\n"),
        options.signal,
      )
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT remem_optional_embedding")
      options.signal?.throwIfAborted()
    } finally {
      await client.query("RELEASE SAVEPOINT remem_optional_embedding")
    }
    const source = memory.source ?? provenance[0]?.source.uri ?? `remem://${this.id}/${id}`
    await client.query(
      `INSERT INTO remem.catalog_entries (
         id, provider_id, memory_id, title, summary, aliases, tags, scope_kind, scope_id,
         importance, unresolved, source, embedding_model, embedding_dimensions, embedding, embedding_fingerprint
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::vector,$16)`,
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
        catalogEmbedding ? (modelFingerprint(this.embeddingModel) ?? null) : null,
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
    // A retrieved source can have a UUID without an external ID. PostgreSQL's
    // external-ID upsert cannot handle that primary-key replay. Reuse only the
    // same provider and immutable identity, never a caller's foreign UUID.
    if (source.id && UUID_PATTERN.test(source.id)) {
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM remem.sources WHERE id=$1 FOR UPDATE",
        [id],
      )
      if (existing.rowCount) {
        const reused = await client.query<{ id: string }>(
          `UPDATE remem.sources SET
            observed_at=COALESCE($6,observed_at), metadata=metadata || $7::jsonb
           WHERE id=$1 AND provider_id=$2 AND kind=$3
             AND uri IS NOT DISTINCT FROM $4 AND external_id IS NOT DISTINCT FROM $5
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
        if (!reused.rows[0]) throw new Error("source identity does not match this provider")
        return reused.rows[0].id
      }
    }
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

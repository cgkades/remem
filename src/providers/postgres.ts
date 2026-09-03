import { randomUUID } from "node:crypto"
import { Pool, type PoolClient, type QueryResultRow } from "pg"
import type { PostgresProviderConfig } from "../config.js"
import type {
  CandidateMemory,
  CandidateReviewItem,
  CandidateReviewStore,
  CandidateStatusSummary,
  SessionObservation,
} from "../observation.js"
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
import { LocalHashEmbeddingModel, vectorLiteral } from "../storage/embedding.js"
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
const SUPPORTED_EMBEDDING_DIMENSIONS = 384

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

export class PostgresMemoryProvider implements MemoryProvider, CandidateReviewStore {
  readonly id: string
  private readonly pool: Pool
  private readonly embeddingModel: EmbeddingModel
  private readonly ownsPool: boolean

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
    return {
      id: this.id,
      name: "Remem managed memory",
      summary,
      categories: ["decisions", "preferences", "procedures", "incidents", "tasks", "history"],
      aliases: ["local memory", "managed memory", "prior work"],
      scopeKinds: ["global", "workspace", "project", "session"],
      embedding: await this.embeddingModel.embed(summary),
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
      await client.query(
        `INSERT INTO remem.session_events
         (id, session_id, project_id, kind, occurred_at, payload)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT (id) DO NOTHING`,
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
      options.signal?.throwIfAborted()
      await client.query(
        `INSERT INTO remem.candidate_memories
         (id, session_event_id, type, title, content, scope_kind, scope_id, confidence, status, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9::jsonb)
         ON CONFLICT (id) DO NOTHING`,
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

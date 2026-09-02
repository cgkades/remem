import { randomUUID } from "node:crypto"
import { Pool, type PoolClient, type QueryResultRow } from "pg"
import type { PostgresProviderConfig } from "../config.js"
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
}

export interface PostgresMemoryProviderOptions {
  pool?: Pool
  embeddingModel?: EmbeddingModel
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function clamp(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.min(1, value))
}

function uniqueStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))]
}

function parseVector(value: string): number[] {
  return value.slice(1, -1).split(",").map(Number)
}

function rowToRecord(row: MemoryRow): MemoryRecord {
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

export class PostgresMemoryProvider implements MemoryProvider {
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
        SELECT ce.*, me.embedding::text AS embedding
        FROM remem.catalog_entries ce
        LEFT JOIN remem.memory_embeddings me ON me.memory_id = ce.memory_id
        WHERE ce.provider_id = $1 AND (
          ce.scope_kind = 'global' OR
          (ce.scope_kind = 'workspace' AND ce.scope_id = $2) OR
          (ce.scope_kind = 'project' AND ce.scope_id = $3) OR
          (ce.scope_kind = 'session' AND ce.scope_id = $4)
        )
        ORDER BY ce.importance DESC, ce.updated_at DESC
        LIMIT $5
      `,
      [
        this.id,
        context.worktree,
        context.projectId,
        context.sessionId ?? null,
        this.config.catalogLimit,
      ],
    )
    signal.throwIfAborted()
    return result.rows.map((row) => ({
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
    }))
  }

  async search(request: MemorySearchRequest): Promise<MemoryResult[]> {
    request.signal.throwIfAborted()
    let embedding: string | null = null
    try {
      embedding = vectorLiteral(await this.embeddingModel.embed(request.query, request.signal))
    } catch {
      request.signal.throwIfAborted()
    }
    const result = await this.pool.query<MemoryRow>(
      `
        WITH query AS (SELECT plainto_tsquery('simple', $5) AS terms)
        SELECT records.*,
          ts_rank_cd(records.search_vector, query.terms) AS lexical_score,
          CASE WHEN $6::vector IS NULL OR records.embedding IS NULL THEN 0
               ELSE 1 - (records.embedding <=> $6::vector) END AS semantic_score
        FROM (
          SELECT m.*, COALESCE(s.uri, s.external_id) AS source,
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
            me.embedding
          FROM remem.memories m
          LEFT JOIN remem.sources s ON s.id = m.source_id
          LEFT JOIN remem.memory_embeddings me ON me.memory_id = m.id
          WHERE m.provider_id = $1 AND (
            m.scope_kind = 'global' OR
            (m.scope_kind = 'workspace' AND m.scope_id = $2) OR
            (m.scope_kind = 'project' AND m.scope_id = $3) OR
            (m.scope_kind = 'session' AND m.scope_id = $4)
          )
          AND ($8::text[] IS NULL OR m.type = ANY($8::text[]))
          AND ($9::text[] IS NULL OR m.scope_kind = ANY($9::text[]))
        ) records, query
        WHERE records.search_vector @@ query.terms
           OR ($6::vector IS NOT NULL AND records.embedding IS NOT NULL AND 1 - (records.embedding <=> $6::vector) >= 0.34)
        ORDER BY GREATEST(
          ts_rank_cd(records.search_vector, query.terms),
          CASE WHEN $6::vector IS NULL OR records.embedding IS NULL THEN 0
               ELSE 1 - (records.embedding <=> $6::vector) END
        ) DESC, records.updated_at DESC
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
      const existing = await client.query<{ created_at: Date }>(
        "SELECT created_at FROM remem.memories WHERE id = $1 AND provider_id = $2 FOR UPDATE",
        [id, this.id],
      )
      if (!existing.rows[0]) throw new Error("memory not found")
      await client.query("DELETE FROM remem.memories WHERE id = $1", [id])
      const record = await this.writeWithClient(client, { ...memory, id }, options)
      await client.query("UPDATE remem.memories SET created_at = $2 WHERE id = $1", [
        id,
        existing.rows[0].created_at,
      ])
      await client.query("COMMIT")
      return { ...record, createdAt: existing.rows[0].created_at.toISOString() }
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
      const existing = await client.query(
        "SELECT id FROM remem.memories WHERE id = $1 FOR UPDATE",
        [id],
      )
      if (!existing.rows[0]) throw new Error("memory not found")
      const record = await this.writeWithClient(client, replacement, options)
      await client.query(
        "UPDATE remem.memories SET freshness = 'superseded', superseded_by = $2, updated_at = now() WHERE id = $1",
        [id, record.id],
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

  private async writeWithClient(
    client: PoolClient,
    memory: MemoryWrite,
    options: MemoryMutationOptions,
  ): Promise<MemoryRecord> {
    options.signal?.throwIfAborted()
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
    const metadata = {
      ...(memory.metadata ?? {}),
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
      memory.entities ?? [],
      memory.relationships ?? [],
    )

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
    } catch {
      options.signal?.throwIfAborted()
    }
    const source = memory.source ?? provenance[0]?.source.uri ?? `remem://${this.id}/${id}`
    await client.query(
      `INSERT INTO remem.catalog_entries (
         id, provider_id, memory_id, title, summary, aliases, tags, scope_kind, scope_id,
         importance, unresolved, source
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
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
    entities: MemoryEntity[],
    relationships: MemoryRelationship[],
  ): Promise<void> {
    const entityIds = new Map<string, string>()
    for (const entity of entities) {
      const result = await client.query<{ id: string }>(
        `INSERT INTO remem.entities (id, name, type, aliases, metadata)
         VALUES ($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT (name, type) DO UPDATE SET
           aliases = ARRAY(SELECT DISTINCT unnest(remem.entities.aliases || EXCLUDED.aliases)),
           metadata = remem.entities.metadata || EXCLUDED.metadata,
           updated_at = now()
         RETURNING id`,
        [
          entity.id && UUID_PATTERN.test(entity.id) ? entity.id : randomUUID(),
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

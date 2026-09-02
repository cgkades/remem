import { randomUUID } from "node:crypto"
import type { Pool, QueryResultRow } from "pg"
import type { CandidateMemory, ConsolidationPipeline } from "./observation.js"
import type {
  MemoryContext,
  MemoryMutationOptions,
  MemoryProvider,
  MemoryRecord,
  MemoryScope,
  MemoryType,
  MemoryWrite,
} from "./types.js"

const MEMORY_TYPES = new Set<MemoryType>([
  "semantic",
  "episodic",
  "decision",
  "preference",
  "procedure",
  "task",
  "other",
])

function normalize(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

function tokens(value: string): Set<string> {
  return new Set(
    normalize(value)
      .split(" ")
      .filter((token) => token.length > 2),
  )
}

function similarity(left: string, right: string): number {
  const leftTokens = tokens(left)
  const rightTokens = tokens(right)
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0
  let overlap = 0
  for (const token of leftTokens) if (rightTokens.has(token)) overlap++
  return overlap / (leftTokens.size + rightTokens.size - overlap)
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return left.kind === right.kind && left.id === right.id
}

function candidateContext(candidate: CandidateMemory): MemoryContext {
  const scopeId = candidate.memory.scope.id ?? ""
  return {
    directory: scopeId,
    worktree: candidate.memory.scope.kind === "workspace" ? scopeId : "",
    projectId: candidate.memory.scope.kind === "project" ? scopeId : "",
    ...(candidate.memory.scope.kind === "session" ? { sessionId: scopeId } : {}),
  }
}

function deduplicated<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const valueKey = key(value)
    if (seen.has(valueKey)) return false
    seen.add(valueKey)
    return true
  })
}

function writeFromRecord(record: MemoryRecord): MemoryWrite {
  return {
    title: record.title,
    content: record.content,
    source: record.source,
    scope: record.scope,
    type: record.type,
    freshness: record.freshness,
    ...(record.summary ? { summary: record.summary } : {}),
    ...(record.observedAt ? { observedAt: record.observedAt } : {}),
    ...(record.confidence === undefined ? {} : { confidence: record.confidence }),
    ...(record.importance === undefined ? {} : { importance: record.importance }),
    ...(record.aliases ? { aliases: record.aliases } : {}),
    ...(record.tags ? { tags: record.tags } : {}),
    ...(record.entities ? { entities: record.entities } : {}),
    ...(record.relationships ? { relationships: record.relationships } : {}),
    ...(record.unresolved === undefined ? {} : { unresolved: record.unresolved }),
    ...(record.provenance ? { provenance: record.provenance } : {}),
    ...(record.metadata ? { metadata: record.metadata } : {}),
  }
}

function mutationOptions(
  context: MemoryContext,
  reason: string,
  signal?: AbortSignal,
): MemoryMutationOptions {
  return {
    context,
    actor: "consolidation",
    reason,
    ...(signal ? { signal } : {}),
  }
}

function mergeRecord(record: MemoryRecord, candidate: CandidateMemory): MemoryWrite {
  const memory = candidate.memory
  return {
    ...writeFromRecord(record),
    aliases: deduplicated([...(record.aliases ?? []), ...(memory.aliases ?? [])], normalize),
    tags: deduplicated([...(record.tags ?? []), ...(memory.tags ?? [])], normalize),
    provenance: deduplicated([...(record.provenance ?? []), ...(memory.provenance ?? [])], (item) =>
      JSON.stringify([
        item.source.kind,
        item.source.uri,
        item.source.providerId,
        item.source.externalId,
        item.capturedAt,
      ]),
    ),
    importance: Math.max(record.importance ?? 0.5, memory.importance ?? 0.5),
    confidence: Math.max(record.confidence ?? 0, memory.confidence ?? 0),
    metadata: {
      ...(record.metadata ?? {}),
      consolidation: { lastCandidateId: candidate.id, action: "merged-duplicate" },
    },
  }
}

function withResult(
  candidate: CandidateMemory,
  status: CandidateMemory["status"],
  reason: string,
  memoryId?: string,
): CandidateMemory {
  return {
    ...candidate,
    status,
    reasons: [...candidate.reasons, reason],
    memory: {
      ...candidate.memory,
      metadata: {
        ...(candidate.memory.metadata ?? {}),
        consolidation: { ...(memoryId ? { memoryId } : {}), action: reason },
      },
    },
  }
}

function observedAfter(candidate: CandidateMemory, record: MemoryRecord): boolean {
  if (!candidate.memory.observedAt || !record.observedAt) return false
  return Date.parse(candidate.memory.observedAt) > Date.parse(record.observedAt)
}

export interface DeterministicConsolidationOptions {
  batchSize?: number
  nearDuplicateSimilarity?: number
}

/**
 * Consolidates only explicit candidate data. Memory bodies remain inert text and are never executed.
 */
export class DeterministicConsolidationPipeline implements ConsolidationPipeline {
  private readonly batchSize: number
  private readonly nearDuplicateSimilarity: number

  constructor(
    private readonly provider: MemoryProvider,
    options: DeterministicConsolidationOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 50
    this.nearDuplicateSimilarity = options.nearDuplicateSimilarity ?? 0.92
  }

  async consolidate(
    candidates: CandidateMemory[],
    signal?: AbortSignal,
  ): Promise<CandidateMemory[]> {
    const output: CandidateMemory[] = []
    for (const [index, candidate] of candidates.entries()) {
      if (index >= this.batchSize) {
        output.push(candidate)
        continue
      }
      signal?.throwIfAborted()
      if (candidate.status !== "approved") {
        output.push(candidate)
        continue
      }
      try {
        output.push(await this.consolidateCandidate(candidate, signal))
      } catch (error) {
        signal?.throwIfAborted()
        output.push(
          withResult(
            candidate,
            "approved",
            `consolidation failed: ${error instanceof Error ? error.name : "unknown error"}`,
          ),
        )
      }
    }
    return output
  }

  private async consolidateCandidate(
    candidate: CandidateMemory,
    signal?: AbortSignal,
  ): Promise<CandidateMemory> {
    if (!this.provider.search || !this.provider.write) {
      throw new Error("provider does not support consolidation reads and writes")
    }
    const context = candidateContext(candidate)
    const matches = await this.provider.search({
      query: candidate.memory.title,
      topics: [candidate.memory.title],
      context,
      scopes: [candidate.memory.scope.kind],
      types: [candidate.memory.type],
      limit: 12,
      maxTokens: 4_000,
      reason: "deterministic consolidation candidate comparison",
      signal: signal ?? new AbortController().signal,
    })
    const comparable = matches
      .map((match) => match.record)
      .filter(
        (record) =>
          record.freshness === "current" &&
          record.type === candidate.memory.type &&
          sameScope(record.scope, candidate.memory.scope),
      )
    const exact = comparable.find(
      (record) =>
        normalize(record.title) === normalize(candidate.memory.title) &&
        normalize(record.content) === normalize(candidate.memory.content),
    )
    const nearDuplicate = comparable.find(
      (record) =>
        normalize(record.title) === normalize(candidate.memory.title) &&
        similarity(record.content, candidate.memory.content) >= this.nearDuplicateSimilarity,
    )
    const duplicate = exact ?? nearDuplicate
    if (duplicate) {
      if (!this.provider.update) throw new Error("provider does not support duplicate merging")
      const merged = await this.provider.update(
        duplicate.id,
        mergeRecord(duplicate, candidate),
        mutationOptions(context, exact ? "exact duplicate" : "near duplicate", signal),
      )
      return withResult(
        candidate,
        "promoted",
        exact ? "merged exact duplicate" : "merged near duplicate",
        merged.id,
      )
    }

    const sameTitle = comparable.find(
      (record) => normalize(record.title) === normalize(candidate.memory.title),
    )
    if (sameTitle && candidate.memory.type === "decision" && observedAfter(candidate, sameTitle)) {
      if (!this.provider.supersede) throw new Error("provider does not support supersession")
      const replacement = await this.provider.supersede(
        sameTitle.id,
        {
          ...candidate.memory,
          metadata: {
            ...(candidate.memory.metadata ?? {}),
            consolidation: { candidateId: candidate.id, action: "supersedes" },
          },
        },
        mutationOptions(context, "newer explicit decision", signal),
      )
      return withResult(candidate, "promoted", "superseded older decision", replacement.id)
    }

    if (sameTitle) {
      const conflict = await this.provider.write(
        {
          ...candidate.memory,
          unresolved: true,
          relationships: [
            ...(candidate.memory.relationships ?? []),
            { type: "conflicts_with", targetMemoryId: sameTitle.id },
          ],
          metadata: {
            ...(candidate.memory.metadata ?? {}),
            consolidation: { candidateId: candidate.id, action: "preserved-conflict" },
          },
        },
        mutationOptions(context, "unresolved conflicting evidence", signal),
      )
      if (this.provider.update) {
        await this.provider.update(
          sameTitle.id,
          {
            ...writeFromRecord(sameTitle),
            unresolved: true,
            relationships: [
              ...(sameTitle.relationships ?? []),
              { type: "conflicts_with", targetMemoryId: conflict.id },
            ],
          },
          mutationOptions(context, "unresolved conflicting evidence", signal),
        )
      }
      return withResult(candidate, "promoted", "preserved unresolved conflict", conflict.id)
    }

    const created = await this.provider.write(
      {
        ...candidate.memory,
        metadata: {
          ...(candidate.memory.metadata ?? {}),
          consolidation: { candidateId: candidate.id, action: "promoted" },
        },
      },
      mutationOptions(context, "promoted candidate", signal),
    )
    return withResult(candidate, "promoted", "promoted candidate", created.id)
  }
}

interface CandidateRow extends QueryResultRow {
  id: string
  session_event_id: string | null
  type: string
  title: string
  content: string
  scope_kind: MemoryScope["kind"]
  scope_id: string | null
  confidence: number | null
  status: CandidateMemory["status"]
  metadata: Record<string, unknown>
}

function candidateFromRow(row: CandidateRow): CandidateMemory {
  const saved = row.metadata.memory
  const memoryMetadata =
    saved && typeof saved === "object" && !Array.isArray(saved)
      ? (saved as Partial<MemoryWrite>)
      : {}
  const type = MEMORY_TYPES.has(row.type as MemoryType) ? (row.type as MemoryType) : "other"
  return {
    id: row.id,
    observationIds: row.session_event_id ? [row.session_event_id] : [],
    memory: {
      ...memoryMetadata,
      type,
      title: row.title,
      content: row.content,
      scope: { kind: row.scope_kind, ...(row.scope_id ? { id: row.scope_id } : {}) },
      ...(row.confidence === null ? {} : { confidence: row.confidence }),
      provenance: memoryMetadata.provenance ?? [
        {
          source: { kind: "session", externalId: row.session_event_id ?? row.id },
          capturedAt: new Date().toISOString(),
          original: true,
        },
      ],
    },
    confidence: row.confidence ?? 0.5,
    status: row.status,
    reasons: Array.isArray(row.metadata.reasons)
      ? row.metadata.reasons.filter((reason): reason is string => typeof reason === "string")
      : [],
  }
}

export interface ConsolidationRun {
  id: string
  status: "completed" | "failed"
  candidates: number
  promoted: number
  outputMemoryIds: string[]
  errors: string[]
}

/**
 * PostgreSQL-backed batch runner. A stale started run is returned to approved before each new claim.
 */
export class PostgresConsolidationRunner {
  constructor(
    private readonly pool: Pool,
    private readonly pipeline: ConsolidationPipeline,
    private readonly batchSize = 50,
    private readonly recoveryAfterMs = 15 * 60_000,
    private readonly providerId?: string,
  ) {}

  async run(signal?: AbortSignal): Promise<ConsolidationRun> {
    signal?.throwIfAborted()
    await this.recoverInterruptedRuns()
    const claim = await this.claimCandidates()
    if (!claim) {
      return {
        id: "none",
        status: "completed",
        candidates: 0,
        promoted: 0,
        outputMemoryIds: [],
        errors: [],
      }
    }
    try {
      const consolidated = await this.pipeline.consolidate(claim.candidates, signal)
      const promoted = consolidated.filter((candidate) => candidate.status === "promoted")
      const errors = consolidated.flatMap((candidate) =>
        candidate.reasons.filter((reason) => reason.startsWith("consolidation failed:")),
      )
      const outputMemoryIds = deduplicated(
        promoted.flatMap((candidate) => {
          const consolidation = candidate.memory.metadata?.consolidation
          return consolidation && typeof consolidation === "object" && "memoryId" in consolidation
            ? [String(consolidation.memoryId)]
            : []
        }),
        (id) => id,
      )
      await this.complete(claim.id, claim.candidates, consolidated, outputMemoryIds, errors)
      return {
        id: claim.id,
        status: "completed",
        candidates: claim.candidates.length,
        promoted: promoted.length,
        outputMemoryIds,
        errors,
      }
    } catch (error) {
      const message = error instanceof Error ? error.name : "unknown error"
      await this.fail(
        claim.id,
        claim.candidates.map((candidate) => candidate.id),
        message,
      )
      return {
        id: claim.id,
        status: "failed",
        candidates: claim.candidates.length,
        promoted: 0,
        outputMemoryIds: [],
        errors: [message],
      }
    }
  }

  private async recoverInterruptedRuns(): Promise<void> {
    await this.pool.query(
      `
      UPDATE remem.candidate_memories
      SET status = 'approved'
       WHERE status = 'consolidating'
         AND id = ANY(
           SELECT unnest(input_memory_ids)
           FROM remem.consolidation_records
           WHERE status = 'started'
             AND started_at < now() - ($1 * interval '1 millisecond')
             AND ($2::text IS NULL OR metadata->>'providerId' = $2 OR metadata->>'providerId' IS NULL)
        )
    `,
      [this.recoveryAfterMs, this.providerId ?? null],
    )
    await this.pool.query(
      `
      UPDATE remem.consolidation_records
       SET status = 'failed', completed_at = now(),
         metadata = metadata || '{"recovery":"interrupted run returned candidates to approved"}'::jsonb
       WHERE status = 'started'
         AND ($2::text IS NULL OR metadata->>'providerId' = $2 OR metadata->>'providerId' IS NULL)
         AND started_at < now() - ($1 * interval '1 millisecond')
    `,
      [this.recoveryAfterMs, this.providerId ?? null],
    )
  }

  private async claimCandidates(): Promise<
    { id: string; candidates: CandidateMemory[] } | undefined
  > {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const candidates = await client.query<CandidateRow>(
        `SELECT * FROM remem.candidate_memories
         WHERE status = 'approved'
           AND ($2::text IS NULL OR metadata->>'providerId' = $2)
         ORDER BY created_at, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [this.batchSize, this.providerId ?? null],
      )
      if (candidates.rows.length === 0) {
        await client.query("COMMIT")
        return undefined
      }
      const id = randomUUID()
      const candidateIds = candidates.rows.map((candidate) => candidate.id)
      await client.query(
        "UPDATE remem.candidate_memories SET status = 'consolidating' WHERE id = ANY($1)",
        [candidateIds],
      )
      await client.query(
        `INSERT INTO remem.consolidation_records (id, kind, status, input_memory_ids, metadata)
         VALUES ($1, 'candidate-consolidation', 'started', $2, $3::jsonb)`,
        [id, candidateIds, JSON.stringify(this.providerId ? { providerId: this.providerId } : {})],
      )
      await client.query("COMMIT")
      return { id, candidates: candidates.rows.map(candidateFromRow) }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  private async complete(
    runId: string,
    input: CandidateMemory[],
    consolidated: CandidateMemory[],
    outputMemoryIds: string[],
    errors: string[],
  ): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      for (const candidate of consolidated) {
        await client.query(
          `UPDATE remem.candidate_memories
           SET status = $2, reviewed_at = now(),
             metadata = metadata || $3::jsonb
           WHERE id = $1`,
          [
            candidate.id,
            candidate.status,
            JSON.stringify({ consolidation: { runId, reasons: candidate.reasons } }),
          ],
        )
      }
      await client.query(
        `UPDATE remem.consolidation_records
         SET status = 'completed', output_memory_ids = $2, summary = $3,
           metadata = metadata || $4::jsonb, completed_at = now()
         WHERE id = $1`,
        [
          runId,
          outputMemoryIds,
          `Consolidated ${input.length} candidate memories; promoted ${consolidated.filter((candidate) => candidate.status === "promoted").length}.`,
          JSON.stringify(errors.length > 0 ? { errors } : {}),
        ],
      )
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  private async fail(runId: string, candidateIds: string[], error: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(
        "UPDATE remem.candidate_memories SET status = 'approved' WHERE id = ANY($1) AND status = 'consolidating'",
        [candidateIds],
      )
      await client.query(
        `UPDATE remem.consolidation_records
         SET status = 'failed', metadata = metadata || $2::jsonb, completed_at = now()
         WHERE id = $1`,
        [runId, JSON.stringify({ error })],
      )
      await client.query("COMMIT")
    } catch (failure) {
      await client.query("ROLLBACK")
      throw failure
    } finally {
      client.release()
    }
  }
}

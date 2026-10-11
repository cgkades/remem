import { randomUUID } from "node:crypto"
import type { Pool } from "pg"
import { vectorLiteral } from "./storage/embedding.js"
import { describeError } from "./text.js"

export interface ReembedTarget {
  memoryId: string
  text: string
  catalogText: string
  sourceVersion: string
}

export interface ReembedRunOptions {
  providerId: string
  fingerprint: string
  modelId: string
  dimensions: number
  batchSize?: number
  recoveryAfterMs?: number
}

export interface ReembedRunResult {
  id: string
  status: "completed" | "failed" | "no-op"
  claimed: number
  reembedded: number
  errors: string[]
  coverage: {
    total: number
    compatible: number
    staged: number
    pending: number
    cutover: "building" | "completed"
  }
}

/** Default cooldown, overridable via `RememConfig.reembedCooldownMs` (see `config.ts`). */
export const DEFAULT_REEMBED_COOLDOWN_MS = 5 * 60_000

/**
 * Cooldown gate for opportunistic hook-triggered re-embedding: avoids
 * hammering the database with a reembedStale() attempt on every prompt.
 */
export function shouldAttemptReembed(
  lastAttemptMs: number | undefined,
  now: () => number = Date.now,
  cooldownMs: number = DEFAULT_REEMBED_COOLDOWN_MS,
): boolean {
  return lastAttemptMs === undefined || now() - lastAttemptMs >= cooldownMs
}

/**
 * Re-embeds remem.memory_embeddings rows whose stored model/dimensions don't
 * match the currently configured embedding model. Mirrors
 * PostgresConsolidationRunner's claim/complete/fail/recover pattern (see
 * src/consolidation.ts) reusing the existing remem.consolidation_records
 * table for run tracking, so stuck runs from a crashed process are safely
 * reclaimed rather than silently lost.
 */
export class PostgresReembedRunner {
  private readonly batchSize: number
  private readonly recoveryAfterMs: number

  constructor(
    private readonly pool: Pool,
    private readonly embed: (text: string, signal?: AbortSignal) => Promise<number[]>,
    private readonly options: ReembedRunOptions,
  ) {
    this.batchSize = options.batchSize ?? 25
    this.recoveryAfterMs = options.recoveryAfterMs ?? 15 * 60_000
  }

  async run(signal?: AbortSignal): Promise<ReembedRunResult> {
    signal?.throwIfAborted()
    await this.recoverInterruptedRuns()
    // Include retained memories whose initial embedding failed, not just rows
    // already in memory_embeddings. Unknown zero placeholders cannot be searched.
    await this.pool.query(
      `INSERT INTO remem.memory_embeddings(memory_id,model,dimensions,embedding)
      SELECT id,'unavailable',384,$2::vector FROM remem.memories WHERE provider_id=$1
      ON CONFLICT(memory_id) DO NOTHING`,
      [this.options.providerId, vectorLiteral(Array.from<number>({ length: 384 }).fill(0))],
    )
    const claim = await this.claimStaleRows()
    if (!claim) {
      return {
        id: "none",
        status: "no-op",
        claimed: 0,
        reembedded: 0,
        errors: [],
        coverage: await this.cutover(),
      }
    }
    const errors: string[] = []
    let reembedded = 0
    for (const target of claim.targets) {
      try {
        signal?.throwIfAborted()
        const embedding = await this.embed(target.text, signal)
        const catalogEmbedding = await this.embed(target.catalogText, signal)
        signal?.throwIfAborted()
        if (
          embedding.length !== this.options.dimensions ||
          catalogEmbedding.length !== this.options.dimensions
        )
          throw new TypeError("reindex encoder dimension mismatch")
        const updated = await this.pool.query(
          `INSERT INTO remem.embedding_reindex_stage(memory_id,fingerprint,model,dimensions,source_version,embedding,catalog_embedding)
           SELECT $1,$2,$3,$4,$5,$6::vector,$7::vector
           FROM remem.memory_embeddings me JOIN remem.memories m ON m.id=me.memory_id
           WHERE me.memory_id=$1 AND me.reembed_claim_id=$8 AND m.updated_at=$5
           ON CONFLICT(memory_id,fingerprint) DO UPDATE SET model=excluded.model,dimensions=excluded.dimensions,
             source_version=excluded.source_version,embedding=excluded.embedding,catalog_embedding=excluded.catalog_embedding`,
          [
            target.memoryId,
            this.options.fingerprint,
            this.options.modelId,
            this.options.dimensions,
            target.sourceVersion,
            vectorLiteral(embedding),
            vectorLiteral(catalogEmbedding),
            claim.id,
          ],
        )
        if (updated.rowCount !== null && updated.rowCount > 0) reembedded++
        else errors.push("source changed or reindex claim lost; retry retained source")
      } catch (error) {
        errors.push(describeError(error))
        if (signal?.aborted) {
          await this.fail(claim.id, errors)
          signal.throwIfAborted()
        }
      }
    }
    if (errors.length > 0 && reembedded === 0) {
      await this.fail(claim.id, errors)
      signal?.throwIfAborted()
      return {
        id: claim.id,
        status: "failed",
        claimed: claim.targets.length,
        reembedded: 0,
        errors,
        coverage: await this.cutover(),
      }
    }
    await this.complete(claim.id, reembedded, errors)
    if (signal?.aborted) signal.throwIfAborted()
    return {
      id: claim.id,
      status: "completed",
      claimed: claim.targets.length,
      reembedded,
      errors,
      coverage: await this.cutover(),
    }
  }

  private async recoverInterruptedRuns(): Promise<void> {
    await this.pool.query(
      `UPDATE remem.memory_embeddings
         SET reembed_claim_id = NULL
       WHERE reembed_claim_id IN (
         SELECT id
           FROM remem.consolidation_records
          WHERE kind = 'embedding-reembed'
            AND status = 'started'
            AND started_at < now() - ($1 * interval '1 millisecond')
       )`,
      [this.recoveryAfterMs],
    )
    await this.pool.query(
      `UPDATE remem.consolidation_records
         SET status = 'failed', completed_at = now(),
           metadata = metadata || '{"recovery":"interrupted reembed run"}'::jsonb
       WHERE kind = 'embedding-reembed'
         AND status = 'started'
         AND started_at < now() - ($1 * interval '1 millisecond')`,
      [this.recoveryAfterMs],
    )
  }

  private async claimStaleRows(): Promise<{ id: string; targets: ReembedTarget[] } | undefined> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const rows = await client.query<{
        memory_id: string
        content: string
        catalog_text: string
        source_version: string
      }>(
        `SELECT me.memory_id, m.updated_at::text AS source_version,
           concat_ws(E'\\n',m.title,NULLIF(m.summary,''),m.content,
             NULLIF((SELECT string_agg(alias,' ' ORDER BY alias) FROM remem.memory_aliases WHERE memory_id=m.id),''),
             NULLIF((SELECT string_agg(tag,' ' ORDER BY tag) FROM remem.memory_tags WHERE memory_id=m.id),'')) AS content,
           concat_ws(E'\\n',COALESCE(ce.title,m.title),NULLIF(COALESCE(ce.summary,m.summary),''),
             NULLIF(array_to_string(ce.aliases,' '),''),NULLIF(array_to_string(ce.tags,' '),'')) AS catalog_text
           FROM remem.memory_embeddings me JOIN remem.memories m ON m.id=me.memory_id
           LEFT JOIN remem.catalog_entries ce ON ce.memory_id=m.id
           WHERE m.provider_id=$4 AND
             (me.model <> $1 OR me.dimensions <> $2 OR me.fingerprint IS DISTINCT FROM $5
               OR (ce.memory_id IS NOT NULL AND ce.embedding_fingerprint IS DISTINCT FROM $5))
             AND me.reembed_claim_id IS NULL
             AND NOT EXISTS(SELECT 1 FROM remem.embedding_reindex_stage stage
               WHERE stage.memory_id=m.id AND stage.fingerprint=$5 AND stage.source_version=m.updated_at)
          ORDER BY me.updated_at
          LIMIT $3
          FOR UPDATE OF me SKIP LOCKED`,
        [
          this.options.modelId,
          this.options.dimensions,
          this.batchSize,
          this.options.providerId,
          this.options.fingerprint,
        ],
      )
      if (rows.rows.length === 0) {
        await client.query("COMMIT")
        return undefined
      }
      const id = randomUUID()
      const memoryIds = rows.rows.map((row) => row.memory_id)
      await client.query(
        `UPDATE remem.memory_embeddings
            SET reembed_claim_id = $1
          WHERE memory_id = ANY($2)`,
        [id, memoryIds],
      )
      await client.query(
        `INSERT INTO remem.consolidation_records (id, kind, status, input_memory_ids, metadata)
         VALUES ($1, 'embedding-reembed', 'started', $2, '{}'::jsonb)`,
        [id, memoryIds],
      )
      await client.query("COMMIT")
      return {
        id,
        targets: rows.rows.map((row) => ({
          memoryId: row.memory_id,
          text: row.content,
          catalogText: row.catalog_text,
          sourceVersion: row.source_version,
        })),
      }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  /** A batch completion is not a generation cutover. Only full compatible coverage qualifies. */
  private async cutover(): Promise<ReembedRunResult["coverage"]> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("SET LOCAL lock_timeout = '5s'")
      await client.query("SET LOCAL statement_timeout = '10s'")
      // Prevent retained-source changes/new writes between coverage and promotion.
      // Inference runs outside this short transaction.
      await client.query(
        "LOCK TABLE remem.memories, remem.memory_embeddings, remem.catalog_entries IN SHARE ROW EXCLUSIVE MODE",
      )
      const coverage = await client.query<{ total: number; compatible: number; staged: number }>(
        `
        SELECT count(*)::int AS total,
          count(*) FILTER(WHERE me.fingerprint=$2 AND me.model=$3 AND me.dimensions=$4
            AND (ce.memory_id IS NULL OR ce.embedding_fingerprint=$2))::int AS compatible,
          count(*) FILTER(WHERE stage.memory_id IS NOT NULL AND NOT
            COALESCE(me.fingerprint=$2 AND me.model=$3 AND me.dimensions=$4
              AND (ce.memory_id IS NULL OR ce.embedding_fingerprint=$2),false))::int AS staged
        FROM remem.memories m LEFT JOIN remem.memory_embeddings me ON me.memory_id=m.id
        LEFT JOIN remem.catalog_entries ce ON ce.memory_id=m.id
        LEFT JOIN remem.embedding_reindex_stage stage ON stage.memory_id=m.id AND stage.fingerprint=$2
          AND stage.source_version=m.updated_at AND stage.model=$3 AND stage.dimensions=$4
        WHERE m.provider_id=$1`,
        [
          this.options.providerId,
          this.options.fingerprint,
          this.options.modelId,
          this.options.dimensions,
        ],
      )
      const row = coverage.rows[0] ?? { total: 0, compatible: 0, staged: 0 }
      const complete = row.compatible + row.staged === row.total
      if (complete) {
        await client.query(
          `UPDATE remem.memory_embeddings me SET model=stage.model,dimensions=stage.dimensions,
          fingerprint=stage.fingerprint,embedding=stage.embedding,updated_at=now(),reembed_claim_id=NULL
          FROM remem.embedding_reindex_stage stage JOIN remem.memories m ON m.id=stage.memory_id
          WHERE me.memory_id=stage.memory_id AND m.provider_id=$1 AND stage.fingerprint=$2 AND stage.source_version=m.updated_at`,
          [this.options.providerId, this.options.fingerprint],
        )
        await client.query(
          `UPDATE remem.catalog_entries ce SET embedding_model=stage.model,embedding_dimensions=stage.dimensions,
          embedding_fingerprint=stage.fingerprint,embedding=stage.catalog_embedding
          FROM remem.embedding_reindex_stage stage JOIN remem.memories m ON m.id=stage.memory_id
          WHERE ce.memory_id=stage.memory_id AND m.provider_id=$1 AND stage.fingerprint=$2 AND stage.source_version=m.updated_at`,
          [this.options.providerId, this.options.fingerprint],
        )
        await client.query(
          `DELETE FROM remem.embedding_reindex_stage stage USING remem.memories m
          WHERE stage.memory_id=m.id AND m.provider_id=$1 AND stage.fingerprint=$2`,
          [this.options.providerId, this.options.fingerprint],
        )
      }
      await client.query(
        `INSERT INTO remem.embedding_reindex_generations(provider_id,fingerprint,state,completed_at)
        SELECT $1,$2,$3,CASE WHEN $3='completed' THEN now() END FROM remem.providers WHERE id=$1
        ON CONFLICT(provider_id,fingerprint) DO UPDATE SET state=excluded.state,completed_at=excluded.completed_at`,
        [this.options.providerId, this.options.fingerprint, complete ? "completed" : "building"],
      )
      await client.query("COMMIT")
      return {
        total: row.total,
        compatible: complete ? row.total : row.compatible,
        staged: complete ? 0 : row.staged,
        pending: complete ? 0 : row.total - row.compatible - row.staged,
        cutover: complete ? "completed" : "building",
      }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  private async complete(runId: string, reembedded: number, errors: string[]): Promise<void> {
    await this.releaseClaim(runId)
    await this.pool.query(
      `UPDATE remem.consolidation_records
         SET status = 'completed', completed_at = now(),
           summary = $2,
           metadata = metadata || $3::jsonb
       WHERE id = $1`,
      [runId, `reembedded ${reembedded} row(s)`, JSON.stringify({ errors })],
    )
  }

  private async fail(runId: string, errors: string[]): Promise<void> {
    await this.releaseClaim(runId)
    await this.pool.query(
      `UPDATE remem.consolidation_records
         SET status = 'failed', completed_at = now(),
           metadata = metadata || $2::jsonb
       WHERE id = $1`,
      [runId, JSON.stringify({ errors })],
    )
  }

  private async releaseClaim(runId: string): Promise<void> {
    await this.pool.query(
      `UPDATE remem.memory_embeddings
          SET reembed_claim_id = NULL
        WHERE reembed_claim_id = $1`,
      [runId],
    )
  }
}

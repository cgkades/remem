import { randomUUID } from "node:crypto"
import type { Pool } from "pg"

export interface ReembedTarget {
  memoryId: string
  text: string
}

export interface ReembedRunOptions {
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
}

/**
 * Cooldown gate for opportunistic hook-triggered re-embedding: avoids
 * hammering the database with a reembedStale() attempt on every prompt.
 */
export function shouldAttemptReembed(
  lastAttemptMs: number | undefined,
  now: () => number = Date.now,
  cooldownMs = 5 * 60_000,
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
    const claim = await this.claimStaleRows()
    if (!claim) {
      return { id: "none", status: "no-op", claimed: 0, reembedded: 0, errors: [] }
    }
    const errors: string[] = []
    let reembedded = 0
    for (const target of claim.targets) {
      try {
        signal?.throwIfAborted()
        const embedding = await this.embed(target.text, signal)
        await this.pool.query(
          `UPDATE remem.memory_embeddings
             SET model = $2, dimensions = $3, embedding = $4::vector, updated_at = now()
           WHERE memory_id = $1`,
          [target.memoryId, this.options.modelId, this.options.dimensions, `[${embedding.join(",")}]`],
        )
        reembedded++
      } catch (error) {
        errors.push(error instanceof Error ? error.name : "unknown error")
      }
    }
    if (errors.length > 0 && reembedded === 0) {
      await this.fail(claim.id, errors)
      return { id: claim.id, status: "failed", claimed: claim.targets.length, reembedded: 0, errors }
    }
    await this.complete(claim.id, reembedded, errors)
    return { id: claim.id, status: "completed", claimed: claim.targets.length, reembedded, errors }
  }

  private async recoverInterruptedRuns(): Promise<void> {
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
      const rows = await client.query<{ memory_id: string; content: string }>(
        `SELECT me.memory_id, m.content
           FROM remem.memory_embeddings me
           JOIN remem.memories m ON m.id = me.memory_id
          WHERE me.model <> $1 OR me.dimensions <> $2
          ORDER BY me.updated_at
          LIMIT $3
          FOR UPDATE OF me SKIP LOCKED`,
        [this.options.modelId, this.options.dimensions, this.batchSize],
      )
      if (rows.rows.length === 0) {
        await client.query("COMMIT")
        return undefined
      }
      const id = randomUUID()
      await client.query(
        `INSERT INTO remem.consolidation_records (id, kind, status, input_memory_ids, metadata)
         VALUES ($1, 'embedding-reembed', 'started', $2, '{}'::jsonb)`,
        [id, rows.rows.map((row) => row.memory_id)],
      )
      await client.query("COMMIT")
      return {
        id,
        targets: rows.rows.map((row) => ({ memoryId: row.memory_id, text: row.content })),
      }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  private async complete(runId: string, reembedded: number, errors: string[]): Promise<void> {
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
    await this.pool.query(
      `UPDATE remem.consolidation_records
         SET status = 'failed', completed_at = now(),
           metadata = metadata || $2::jsonb
       WHERE id = $1`,
      [runId, JSON.stringify({ errors })],
    )
  }
}

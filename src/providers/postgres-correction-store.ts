import type { Pool, PoolClient } from "pg"
import type {
  CandidateAuditEntry,
  CandidateLifecycleState,
  CandidateMutation,
  CandidateReviewerDecision,
  CorrectionCandidate,
  CorrectionCandidateStore,
  CorrectionInput,
  CorrectionRootCause,
  ReplayGateResult,
  StructuralValidationSummary,
} from "../correction.js"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

interface CorrectionCandidateRow {
  id: string
  state: CandidateLifecycleState
  correction: CorrectionInput
  root_cause: CorrectionRootCause | null
  root_cause_reason: string | null
  affected_memory_ids: string[]
  impacted_memory_ids: string[]
  mutation: CandidateMutation | null
  structural_validation: StructuralValidationSummary | null
  replay: ReplayGateResult | null
  reviewer_decision: CandidateReviewerDecision | null
  applied_memory_id: string | null
  audit: CandidateAuditEntry[]
  created_at: Date
  updated_at: Date
}

function rowToCandidate(row: CorrectionCandidateRow): CorrectionCandidate {
  return {
    id: row.id,
    state: row.state,
    correction: row.correction,
    ...(row.root_cause ? { rootCause: row.root_cause } : {}),
    ...(row.root_cause_reason ? { rootCauseReason: row.root_cause_reason } : {}),
    affectedMemoryIds: row.affected_memory_ids,
    ...(row.impacted_memory_ids.length > 0 ? { impactedMemoryIds: row.impacted_memory_ids } : {}),
    ...(row.mutation ? { mutation: row.mutation } : {}),
    ...(row.structural_validation ? { structuralValidation: row.structural_validation } : {}),
    ...(row.replay ? { replay: row.replay } : {}),
    ...(row.reviewer_decision ? { reviewerDecision: row.reviewer_decision } : {}),
    ...(row.applied_memory_id ? { appliedMemoryId: row.applied_memory_id } : {}),
    audit: row.audit,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

/**
 * Durable, cross-process `CorrectionCandidateStore` backed by
 * `remem.correction_candidates` (migration 0007). `update` uses
 * `SELECT ... FOR UPDATE` inside a transaction, so a concurrent `update` on
 * the same id blocks until this one commits or rolls back -- the same
 * atomicity guarantee `InMemoryCorrectionCandidateStore` gets for free from
 * JS's single-threaded execution, extended across processes.
 */
export class PostgresCorrectionCandidateStore implements CorrectionCandidateStore {
  constructor(
    private readonly pool: Pool,
    private readonly providerId: string,
  ) {}

  async insert(candidate: CorrectionCandidate): Promise<void> {
    if (!UUID_PATTERN.test(candidate.id)) throw new TypeError("candidate id must be a UUID")
    await this.pool.query(
      `INSERT INTO remem.correction_candidates
         (id, provider_id, state, correction, root_cause, root_cause_reason,
          affected_memory_ids, impacted_memory_ids, mutation, structural_validation,
          replay, reviewer_decision, applied_memory_id, audit, created_at, updated_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14::jsonb,$15,$16)`,
      [
        candidate.id,
        this.providerId,
        candidate.state,
        JSON.stringify(candidate.correction),
        candidate.rootCause ?? null,
        candidate.rootCauseReason ?? null,
        candidate.affectedMemoryIds,
        candidate.impactedMemoryIds ?? [],
        candidate.mutation ? JSON.stringify(candidate.mutation) : null,
        candidate.structuralValidation ? JSON.stringify(candidate.structuralValidation) : null,
        candidate.replay ? JSON.stringify(candidate.replay) : null,
        candidate.reviewerDecision ? JSON.stringify(candidate.reviewerDecision) : null,
        candidate.appliedMemoryId ?? null,
        JSON.stringify(candidate.audit),
        candidate.createdAt,
        candidate.updatedAt,
      ],
    )
  }

  async get(candidateId: string): Promise<CorrectionCandidate | undefined> {
    if (!UUID_PATTERN.test(candidateId)) return undefined
    const result = await this.pool.query<CorrectionCandidateRow>(
      `SELECT id, state, correction, root_cause, root_cause_reason, affected_memory_ids,
              impacted_memory_ids, mutation, structural_validation, replay,
              reviewer_decision, applied_memory_id, audit, created_at, updated_at
       FROM remem.correction_candidates
       WHERE id = $1 AND provider_id = $2`,
      [candidateId, this.providerId],
    )
    const row = result.rows[0]
    return row ? rowToCandidate(row) : undefined
  }

  async list(filter?: { state?: CandidateLifecycleState }): Promise<CorrectionCandidate[]> {
    const result = await this.pool.query<CorrectionCandidateRow>(
      `SELECT id, state, correction, root_cause, root_cause_reason, affected_memory_ids,
              impacted_memory_ids, mutation, structural_validation, replay,
              reviewer_decision, applied_memory_id, audit, created_at, updated_at
       FROM remem.correction_candidates
       WHERE provider_id = $1 AND ($2::text IS NULL OR state = $2)
       ORDER BY updated_at DESC
       LIMIT 200`,
      [this.providerId, filter?.state ?? null],
    )
    return result.rows.map(rowToCandidate)
  }

  async update(
    candidateId: string,
    mutate: (candidate: CorrectionCandidate) => CorrectionCandidate,
  ): Promise<CorrectionCandidate> {
    if (!UUID_PATTERN.test(candidateId)) {
      throw new Error(`unknown correction candidate: ${candidateId}`)
    }
    const client: PoolClient = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const result = await client.query<CorrectionCandidateRow>(
        `SELECT id, state, correction, root_cause, root_cause_reason, affected_memory_ids,
                impacted_memory_ids, mutation, structural_validation, replay,
                reviewer_decision, applied_memory_id, audit, created_at, updated_at
         FROM remem.correction_candidates
         WHERE id = $1 AND provider_id = $2
         FOR UPDATE`,
        [candidateId, this.providerId],
      )
      const row = result.rows[0]
      if (!row) throw new Error(`unknown correction candidate: ${candidateId}`)
      // `mutate` must be synchronous (see the CorrectionCandidateStore
      // contract) so no other statement can run on this connection --
      // and therefore no other transaction can observe this row -- between
      // the SELECT ... FOR UPDATE above and the UPDATE below.
      const updated = mutate(rowToCandidate(row))
      await client.query(
        `UPDATE remem.correction_candidates
         SET state = $3, correction = $4::jsonb, root_cause = $5, root_cause_reason = $6,
             affected_memory_ids = $7, impacted_memory_ids = $8, mutation = $9::jsonb,
             structural_validation = $10::jsonb, replay = $11::jsonb,
             reviewer_decision = $12::jsonb, applied_memory_id = $13, audit = $14::jsonb,
             updated_at = $15
         WHERE id = $1 AND provider_id = $2`,
        [
          candidateId,
          this.providerId,
          updated.state,
          JSON.stringify(updated.correction),
          updated.rootCause ?? null,
          updated.rootCauseReason ?? null,
          updated.affectedMemoryIds,
          updated.impactedMemoryIds ?? [],
          updated.mutation ? JSON.stringify(updated.mutation) : null,
          updated.structuralValidation ? JSON.stringify(updated.structuralValidation) : null,
          updated.replay ? JSON.stringify(updated.replay) : null,
          updated.reviewerDecision ? JSON.stringify(updated.reviewerDecision) : null,
          updated.appliedMemoryId ?? null,
          JSON.stringify(updated.audit),
          updated.updatedAt,
        ],
      )
      await client.query("COMMIT")
      return updated
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }
}

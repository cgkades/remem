import type { EvidenceEnvelope } from "./observation-admission.js"
import type { MemoryContext, MemoryWrite } from "./types.js"

export type SessionEventKind =
  | "user-correction"
  | "decision"
  | "preference"
  | "incident-resolved"
  | "fact-discovered"
  | "task-opened"
  | "task-resolved"
  | "project-state"

export interface SessionObservation {
  id: string
  kind: SessionEventKind
  context: MemoryContext
  occurredAt: string
  source: string
  payload: Record<string, unknown>
}

export interface CandidateMemory {
  id: string
  observationIds: string[]
  memory: MemoryWrite
  confidence: number
  status: "pending" | "approved" | "consolidating" | "rejected" | "promoted" | "expired"
  reasons: string[]
}

export interface CandidateStatusSummary {
  pending: number
  approved: number
  consolidating: number
  rejected: number
  promoted: number
  expired: number
}

export interface CandidateReviewItem {
  id: string
  type: MemoryWrite["type"]
  title: string
  content: string
  scope: MemoryWrite["scope"]
  confidence?: number
  status: CandidateMemory["status"]
  createdAt: string
  reasons: string[]
}

export interface ObservationStore {
  persistCandidate(
    observation: SessionObservation,
    candidate: CandidateMemory,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void>
  candidateStatus(context: MemoryContext): Promise<CandidateStatusSummary>
}

export interface CandidateReviewStore extends ObservationStore {
  listCandidates(status?: CandidateMemory["status"]): Promise<CandidateReviewItem[]>
  reviewCandidate(id: string, status: "approved" | "rejected"): Promise<void>
}

export function isObservationStore(value: unknown): value is ObservationStore {
  return (
    typeof value === "object" &&
    value !== null &&
    "persistCandidate" in value &&
    typeof value.persistCandidate === "function" &&
    "candidateStatus" in value &&
    typeof value.candidateStatus === "function"
  )
}

export interface CandidateExtractor {
  extract(observations: SessionObservation[], signal?: AbortSignal): Promise<CandidateMemory[]>
}

export interface CandidateValidator {
  validate(candidate: CandidateMemory, signal?: AbortSignal): Promise<CandidateMemory | undefined>
}

export interface ConsolidationPipeline {
  consolidate(candidates: CandidateMemory[], signal?: AbortSignal): Promise<CandidateMemory[]>
}

/**
 * Phase 3 (TASK-010) of `plan/feature-memory-recovery-1.md`: persists and
 * reads admitted evidence (`EvidenceEnvelope`, from
 * `observation-admission.ts`'s `admitEvidence`) independently of semantic
 * candidate extraction -- proposed beside `ObservationStore`, not replacing
 * it. `episodicHistory` capability alone does not establish method support
 * (see `isEpisodicStore`); a provider must actually implement these methods.
 */
export type EpisodicAppendOutcome = "appended" | "duplicate" | "collision"

export interface EpisodicAppendResult {
  outcome: EpisodicAppendOutcome
  /** The envelope's own derived id (present regardless of outcome, including `collision`, so a caller can log which identity conflicted without needing the rejected content). */
  id: string
}

export interface EpisodicStore {
  /**
   * Exact repeated append (same id, same contentHash) is a no-op
   * (`"duplicate"`). Same id with a different contentHash is a collision
   * (`"collision"`) and does not modify the first record -- this is a
   * persistence-layer enforcement of the same invariant
   * `observation-admission.ts`'s `admitEvidence` already expresses at the
   * admission layer (same identity, different evidence is a collision, not
   * an upsert), now backed by an actual unique constraint rather than a
   * caller-supplied `existing` parameter.
   */
  appendEvidence(
    envelope: EvidenceEnvelope,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<EpisodicAppendResult>
  /**
   * A foreign (different project than `context`) or otherwise-unknown
   * `(providerId, evidenceId)` returns `undefined` -- a non-disclosing
   * not-found result, not evidence about another project's retention
   * state (matches the plan's Observation Field Checklist).
   */
  readEvidence(
    providerId: string,
    evidenceId: string,
    context: MemoryContext,
  ): Promise<EvidenceEnvelope | undefined>
}

export function isEpisodicStore(value: unknown): value is EpisodicStore {
  return (
    typeof value === "object" &&
    value !== null &&
    "appendEvidence" in value &&
    typeof value.appendEvidence === "function" &&
    "readEvidence" in value &&
    typeof value.readEvidence === "function"
  )
}

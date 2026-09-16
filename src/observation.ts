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

/**
 * Hard ceilings for TASK-011 scoped episode search. A caller-supplied
 * `EpisodicSearchOptions` may only lower these, never raise them -- the
 * implementation clamps rather than trusting a caller's larger request, so
 * a misbehaving or compromised caller cannot force an unbounded response.
 */
export const EPISODIC_SEARCH_MAX_RESULTS = 10
export const EPISODIC_SEARCH_MAX_NEIGHBORS_PER_SIDE = 1
export const EPISODIC_SEARCH_MAX_OUTPUT_TOKENS = 2000

export interface EpisodicSearchOptions {
  /** Clamped to at most `EPISODIC_SEARCH_MAX_RESULTS`. */
  limit?: number
  /** Clamped to at most `EPISODIC_SEARCH_MAX_OUTPUT_TOKENS`. */
  maxOutputTokens?: number
}

export type EpisodicNeighborPosition = "preceding" | "following"

/**
 * A single event adjacent (by `occurredAt` within the same session) to a
 * matched result, included for surrounding context. Carries the same
 * `role`/`origin` labeling as the envelope it wraps -- a neighbor is never
 * unlabeled or presented as if it were itself a search match, so a caller
 * cannot mistake unclassified/historical context for a verified result.
 */
export interface EpisodicNeighbor {
  position: EpisodicNeighborPosition
  envelope: EvidenceEnvelope
  /** True if `envelope.payload.text` was shortened to fit the response's output-token budget. */
  truncated: boolean
}

export interface EpisodicSearchMatch {
  envelope: EvidenceEnvelope
  /** True if `envelope.payload.text` was shortened to fit the response's output-token budget. */
  truncated: boolean
  /** At most one preceding and one following neighbor; omitted (not a zero-length placeholder) once the output-token budget is exhausted. */
  neighbors: EpisodicNeighbor[]
}

export interface EpisodicSearchResult {
  matches: EpisodicSearchMatch[]
  /** True if the output-token budget was reached before every eligible match/neighbor could be included -- distinct from "no more matches exist". */
  budgetExhausted: boolean
}

/**
 * TASK-011: scoped lexical search over previously appended episodic
 * evidence, with bounded same-session neighbor expansion. Deliberately
 * lexical only -- semantic/vector episode indexing is explicitly deferred
 * per the plan. Every `EvidenceEnvelope` ever appended (regardless of
 * `role`/`origin`, including an unclassified or failed-approach event) is
 * searchable: this store performs no trust filtering, so a caller can
 * always independently find and label historical/untrusted evidence
 * rather than have it silently excluded.
 */
export interface EpisodicSearchStore extends EpisodicStore {
  searchEpisodes(
    providerId: string,
    query: string,
    context: MemoryContext,
    options?: EpisodicSearchOptions,
  ): Promise<EpisodicSearchResult>
}

export function isEpisodicSearchStore(value: unknown): value is EpisodicSearchStore {
  return (
    isEpisodicStore(value) &&
    "searchEpisodes" in value &&
    typeof (value as { searchEpisodes: unknown }).searchEpisodes === "function"
  )
}

import type {
  CapacityLimits,
  CapacityStatus,
  CompactionLevel,
  HardLimitWarning,
} from "./capacity.js"
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
export type EpisodicAppendOutcome = "appended" | "duplicate" | "collision" | "forgotten"

export interface EpisodicAppendResult {
  outcome: EpisodicAppendOutcome
  /** The envelope's own derived id (present regardless of outcome, including `collision`, so a caller can log which identity conflicted without needing the rejected content). */
  id: string
}

export interface EpisodicStore {
  /**
   * A confirmed TASK-013 tombstone returns `"forgotten"` and never restores
   * evidence. Otherwise, exact repeated append (same id, same contentHash) is a no-op
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

/** TASK-013: previews are short-lived so confirmation binds to a recent,
 * body-free view of exactly one evidence record and its direct candidates. */
export const FORGET_PREVIEW_TTL_MS = 15 * 60 * 1000

export interface ForgetPreview {
  id: string
  providerId: string
  projectId: string
  evidenceId: string
  /** The directly targeted canonical episode row; never rendered as content. */
  episodeCount: 1
  /** Candidate rows directly derived from that episode. */
  candidateCount: number
  /** Deliberately always zero in TASK-013: semantic memories can have independent support. */
  semanticMemoryCount: 0
  createdAt: string
  expiresAt: string
}

export interface ForgetConfirmation {
  previewId: string
  evidenceDeleted: boolean
  candidatesDeleted: number
}

/**
 * TASK-013's review-gated privacy boundary. A preview is non-destructive;
 * the caller must separately invoke `confirmForget` with its opaque preview
 * id. TASK-013 intentionally does not remove semantic memories, embeddings,
 * or catalog entries because no durable ledger can prove they are supported
 * only by this episode (that association is Phase 4 work).
 */
export interface ForgetStore extends EpisodicStore {
  previewForget(
    providerId: string,
    evidenceId: string,
    projectId: string,
  ): Promise<ForgetPreview | undefined>
  confirmForget(previewId: string): Promise<ForgetConfirmation>
}

export function isForgetStore(value: unknown): value is ForgetStore {
  return (
    isEpisodicStore(value) &&
    "previewForget" in value &&
    typeof (value as { previewForget: unknown }).previewForget === "function" &&
    "confirmForget" in value &&
    typeof (value as { confirmForget: unknown }).confirmForget === "function"
  )
}

/** TASK-061's hard ceiling: callers may lower it, never enumerate an
 * unbounded project history. Suggestions are identifiers and timestamps only,
 * not an authorization or an instruction to remove anything. */
export const SUPERSESSION_CANDIDATE_MAX_RESULTS = 100

export interface SupersessionCandidate {
  /** Older episode that a human may separately pass to TASK-013's forget preview. */
  evidenceId: string
  /** A newer same-project episode with a deterministic `decision` candidate. */
  newerDecisionEvidenceId: string
  /** One deterministic, scoped entity UUID explicitly linked to both events. */
  sharedEntityId: string
  occurredAt: string
  newerDecisionOccurredAt: string
  /** Fixed, deterministic reason code; no model-produced conclusion. */
  reason: "newer-decision-shares-entity"
}

export interface EpisodicSupersessionStore extends EpisodicStore {
  /**
   * Associates admitted evidence with an existing project-scoped entity.
   * This method never derives an entity from the evidence's text and returns
   * false for unknown/foreign inputs without disclosing which was absent.
   */
  linkEvidenceEntity(
    providerId: string,
    evidenceId: string,
    entityId: string,
    projectId: string,
  ): Promise<boolean>
  /**
   * Lists potential supersession only: older evidence sharing an explicit
   * entity link with a newer event that has an approved/promoted `decision`
   * candidate. A caller must still create
   * and explicitly confirm a TASK-013 forget preview to remove anything.
   */
  listSupersessionCandidates(
    providerId: string,
    projectId: string,
    options?: { limit?: number },
  ): Promise<SupersessionCandidate[]>
}

export function isEpisodicSupersessionStore(value: unknown): value is EpisodicSupersessionStore {
  return (
    isEpisodicStore(value) &&
    "linkEvidenceEntity" in value &&
    typeof (value as { linkEvidenceEntity: unknown }).linkEvidenceEntity === "function" &&
    "listSupersessionCandidates" in value &&
    typeof (value as { listSupersessionCandidates: unknown }).listSupersessionCandidates ===
      "function"
  )
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
/**
 * Upper bound on the raw search string length. A misbehaving or compromised
 * caller cannot force the database to parse an arbitrarily large
 * `plainto_tsquery` input -- the query is clamped to this length before it
 * reaches SQL, in the same spirit as the result/token ceilings above.
 */
export const EPISODIC_SEARCH_MAX_QUERY_LENGTH = 10_000

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

/**
 * TASK-012/TASK-060: reports produced by the capacity/compaction store
 * methods. See `capacity.ts` for the policy this store applies (limits,
 * ordered levels, escalation decision) -- this interface is the storage
 * boundary that actually queries/mutates `remem.session_events`/
 * `remem.capacity_state`.
 */
export interface CompactionReport {
  /** Rows whose `safe_text` was actually reduced (or, for a row already at/under its target, simply stamped as processed at the current level -- see `rowsProcessed`). */
  rowsReduced: number
  /** Every eligible row considered this run, including ones left unchanged because they were already within the current level's target. */
  rowsProcessed: number
  /** Logical bytes reclaimed by this run's reductions. */
  bytesReclaimed: number
  level: CompactionLevel
  /** True if this run caused an escalation to a more aggressive level than it started at. */
  escalated: boolean
  totalBytesAfter: number
}

export interface HardLimitEvictionReport {
  rowsRemoved: number
  bytesReclaimed: number
  totalBytesAfter: number
  /** True if still over the hard limit after this run because no more removal-eligible (60+ day old) rows remain -- distinct from "under the limit now." */
  exhaustedEligibleRows: boolean
}

export interface EnforceCapacityOptions {
  limits?: CapacityLimits
  /** Bypasses both the 60-day eligibility gate and the soft-limit gate for compaction -- an explicit, user-triggered forced full compaction (the plan's "user may also force an immediate full compaction on demand, ignoring the 60-day gate"). Never affects hard-limit eviction's own age gate: removal is never forced. */
  force?: boolean
}

export interface EnforceCapacityReport {
  status: CapacityStatus
  compaction?: CompactionReport
  hardLimitEviction?: HardLimitEvictionReport
}

export interface CapacityStore {
  getCapacityStatus(
    providerId: string,
    projectId: string,
    limits?: CapacityLimits,
  ): Promise<CapacityStatus>

  /** Runs one bounded batch of compaction. A caller (or scheduler) invokes this repeatedly to fully drain a large backlog; a single call is not guaranteed to bring a project fully under the soft limit. */
  runCompaction(
    providerId: string,
    projectId: string,
    options?: EnforceCapacityOptions,
  ): Promise<CompactionReport>

  /** Runs one bounded batch of oldest-eligible-first removal. Never removes an entry younger than `COMPACTION_ELIGIBILITY_DAYS`, even if still over the hard limit afterward (see `exhaustedEligibleRows`). */
  enforceHardLimit(
    providerId: string,
    projectId: string,
    limits?: CapacityLimits,
  ): Promise<HardLimitEvictionReport>

  /** The main entry point: checks status, compacts if over the soft limit (or if forced), then evicts if still over the hard limit afterward. */
  enforceCapacity(
    providerId: string,
    projectId: string,
    options?: EnforceCapacityOptions,
  ): Promise<EnforceCapacityReport>

  /**
   * TASK-062: session-start hard-limit capacity warning. Returns a
   * `HardLimitWarning` only when the scope is genuinely over the *hard*
   * limit (never the soft limit) and the per-scope throttle allows firing
   * again; returns `undefined` otherwise (under the hard limit, or
   * throttled). See `capacity.ts`'s `shouldFireHardLimitWarning` doc
   * comment: the throttle interval/cadence design here is a disclosed
   * provisional default, not yet a maintainer-confirmed one.
   */
  checkHardLimitWarning(
    providerId: string,
    projectId: string,
    options?: { limits?: CapacityLimits; throttleMs?: number },
  ): Promise<HardLimitWarning | undefined>
}

export function isCapacityStore(value: unknown): value is CapacityStore {
  return (
    typeof value === "object" &&
    value !== null &&
    "getCapacityStatus" in value &&
    typeof value.getCapacityStatus === "function" &&
    "runCompaction" in value &&
    typeof (value as { runCompaction: unknown }).runCompaction === "function" &&
    "enforceHardLimit" in value &&
    typeof (value as { enforceHardLimit: unknown }).enforceHardLimit === "function" &&
    "enforceCapacity" in value &&
    typeof (value as { enforceCapacity: unknown }).enforceCapacity === "function" &&
    "checkHardLimitWarning" in value &&
    typeof (value as { checkHardLimitWarning: unknown }).checkHardLimitWarning === "function"
  )
}

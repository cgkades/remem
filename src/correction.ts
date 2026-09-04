import { randomUUID } from "node:crypto"
import {
  institutionalReviewStatus,
  procedureContent,
  validateInstitutionalMemories,
  type InstitutionalValidationIssue,
  type InstitutionalWrite,
} from "./institutional.js"
import type {
  ApplicabilityDecision,
  InstitutionalApplicability,
  InstitutionalMemory,
  MemoryContext,
  MemoryTrace,
  MemoryWrite,
} from "./types.js"

export type CorrectionRootCause =
  "knowledge_gap" | "procedure_fault" | "duplicate_conflict" | "stale_position" | "ambiguous"

export type CandidateMutation =
  | { kind: "create"; proposed: MemoryWrite }
  | { kind: "update" | "supersede"; targetMemoryId: string; proposed: MemoryWrite }
  | { kind: "retire"; targetMemoryId: string; note: string }
  | { kind: "route_adjustment"; targetMemoryId?: string; note: string }

export type CandidateMutationKind = CandidateMutation["kind"]

export type CandidateLifecycleState =
  | "pending_validation"
  | "validated"
  | "needs_changes"
  | "rejected"
  /** Transient: an approve() call has atomically claimed the candidate and is applying its mutation. Not itself terminal -- on apply failure it reverts to "validated" so the candidate stays retryable. */
  | "applying"
  | "applied"

export interface CorrectionInput {
  id?: string
  sessionId: string
  prompt: string
  correctionText: string
  expectedOutcome: string
  /**
   * An unauthenticated provenance hint, not a verified identity. This
   * library has no concept of authentication -- callers that expose
   * `submit`/`list`/`get` to multiple tenants or untrusted agents are
   * responsible for scoping access and for supplying a trustworthy `actor`
   * to `approve`/`reject`/`requestChanges` from their own session context,
   * not from this field.
   */
  actor: string
  context: MemoryContext
  trace: MemoryTrace
  /** Memory IDs the correction disputes as wrong, missing, or stale. Empty means the correction reports a pure knowledge gap. */
  disputedMemoryIds?: string[]
  evidence?: string[]
}

export interface StructuralValidationSummary {
  valid: boolean
  issues: InstitutionalValidationIssue[]
}

export interface ReplayGateResult {
  passed: boolean
  caseIds: string[]
  failures: string[]
}

export interface ReplayGate {
  run(candidate: CorrectionCandidate): Promise<ReplayGateResult>
}

export type CandidateAuditEvent =
  | "submitted"
  | "diagnosed"
  | "validated"
  | "validation_failed"
  | "replay_passed"
  | "replay_failed"
  | "approved"
  | "rejected"
  | "changes_requested"
  | "applied"

export interface CandidateAuditEntry {
  at: string
  actor: string
  event: CandidateAuditEvent
  detail?: string
}

export interface CandidateReviewerDecision {
  actor: string
  decision: "approved" | "rejected" | "changes_requested"
  reason?: string
  at: string
}

export interface CorrectionCandidate {
  readonly id: string
  state: CandidateLifecycleState
  correction: CorrectionInput
  rootCause?: CorrectionRootCause
  rootCauseReason?: string
  affectedMemoryIds: string[]
  mutation?: CandidateMutation
  /** Institutional records that reference the mutation's target via #24's dependency fields (`dependsOnPositionIds`/`positionIds`/`procedureIds`) and would be impacted by applying it. */
  impactedMemoryIds?: string[]
  structuralValidation?: StructuralValidationSummary
  replay?: ReplayGateResult
  reviewerDecision?: CandidateReviewerDecision
  appliedMemoryId?: string
  audit: CandidateAuditEntry[]
  readonly createdAt: string
  updatedAt: string
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

export interface CorrectionDiagnosis {
  rootCause: CorrectionRootCause
  reason: string
  affectedMemoryIds: string[]
}

function applicabilitySignature(applicability: InstitutionalApplicability): string {
  const conditions = applicability.conditions
    .map((condition) =>
      condition.kind === "context"
        ? `context:${condition.field}:${condition.value}`
        : `topic:${condition.value}`,
    )
    .sort()
  return `${applicability.match}|${conditions.join(",")}`
}

function institutionalApplicabilityFor(
  institutionalId: string,
  applicability: ApplicabilityDecision[] | undefined,
): ApplicabilityDecision | undefined {
  return applicability?.find((decision) => decision.institutionalId === institutionalId)
}

/**
 * Classifies why a correction happened by checking whether the disputed memory
 * was present -- and applicable -- in the retrieval manifest recorded at the
 * time of the original response. This is the deterministic check the issue
 * requires to distinguish a knowledge gap (nothing existed) from a
 * procedure/routing fault (the right material existed but was not surfaced).
 */
export function diagnoseCorrection(
  correction: CorrectionInput,
  existing: InstitutionalMemory[],
): CorrectionDiagnosis {
  const disputedIds = correction.disputedMemoryIds ?? []
  const disputedRecords = disputedIds
    .map((id) => existing.find((memory) => memory.id === id))
    .filter(isDefined)

  if (disputedIds.length === 0) {
    return {
      rootCause: "knowledge_gap",
      reason:
        "no disputed memory was identified and no approved material exists for this correction",
      affectedMemoryIds: [],
    }
  }

  if (disputedRecords.length < disputedIds.length) {
    const missing = disputedIds.filter((id) => !disputedRecords.some((record) => record.id === id))
    return {
      rootCause: "ambiguous",
      reason: `disputed memory ids do not resolve to existing institutional records: ${missing.join(", ")}`,
      affectedMemoryIds: disputedRecords.map((record) => record.id),
    }
  }

  const [record] = disputedRecords
  if (disputedRecords.length === 1 && record) {
    const decision = institutionalApplicabilityFor(record.id, correction.trace.applicability)
    if (decision && !decision.applicable) {
      return {
        rootCause: "procedure_fault",
        reason: `approved material ${record.id} existed but the applicability gateway excluded it: ${decision.reason}`,
        affectedMemoryIds: [record.id],
      }
    }
    if (!decision) {
      return {
        rootCause: "procedure_fault",
        reason: `approved material ${record.id} existed but was never evaluated during retrieval planning`,
        affectedMemoryIds: [record.id],
      }
    }
    if (institutionalReviewStatus(record) === "expired") {
      return {
        rootCause: "stale_position",
        reason: `${record.id} was surfaced and applicable but its review has expired`,
        affectedMemoryIds: [record.id],
      }
    }
    return {
      rootCause: "ambiguous",
      reason: `${record.id} was surfaced, applicable, and current, so the failure mode is not deterministic from the retrieval manifest`,
      affectedMemoryIds: [record.id],
    }
  }

  const expired = disputedRecords.filter(
    (record) => institutionalReviewStatus(record) === "expired",
  )
  if (expired.length > 0) {
    return {
      rootCause: "stale_position",
      reason: `${expired.map((record) => record.id).join(", ")} expired while still being applicable`,
      affectedMemoryIds: disputedRecords.map((record) => record.id),
    }
  }

  // "Duplicate" requires identical role and an identical applicability
  // signature (same match mode, same set of conditions by kind/field/value)
  // -- not merely some condition sharing a string value, which would treat
  // unrelated records (e.g. two positions that both happen to mention
  // "phoenix" for different fields) as conflicting. Anything less than an
  // exact scope match stays "ambiguous" for a human to resolve, since
  // structural overlap alone doesn't establish that two records actually
  // conflict.
  const [first, ...rest] = disputedRecords
  const identicalScope =
    first !== undefined &&
    rest.every(
      (record) =>
        record.role === first.role &&
        applicabilitySignature(record.applicability) ===
          applicabilitySignature(first.applicability),
    )
  if (identicalScope) {
    return {
      rootCause: "duplicate_conflict",
      reason: `${disputedRecords.map((record) => record.id).join(", ")} share an identical role and applicability scope`,
      affectedMemoryIds: disputedRecords.map((record) => record.id),
    }
  }

  return {
    rootCause: "ambiguous",
    reason: "multiple disputed records do not share a deterministic conflict or expiry signal",
    affectedMemoryIds: disputedRecords.map((record) => record.id),
  }
}

function retireCandidate(records: InstitutionalMemory[]): InstitutionalMemory {
  const [oldest] = [...records].sort((a, b) =>
    a.review.reviewedAt.localeCompare(b.review.reviewedAt),
  )
  if (!oldest) throw new Error("retireCandidate requires at least one record")
  return oldest
}

/**
 * Produces the smallest mutation that addresses the diagnosed root cause.
 * Ambiguous corrections never produce a mutation -- they stay queued for a
 * human decision, per the issue's explicit requirement.
 */
export function proposeCandidateMutation(
  correction: CorrectionInput,
  diagnosis: CorrectionDiagnosis,
  existing: InstitutionalMemory[],
): CandidateMutation | undefined {
  switch (diagnosis.rootCause) {
    case "knowledge_gap": {
      const proposed: MemoryWrite = {
        title: `Correction: ${correction.correctionText.slice(0, 80)}`,
        content: correction.expectedOutcome,
        scope: { kind: "project", id: correction.context.projectId },
        type: "decision",
        provenance: [
          {
            source: {
              kind: "user",
              externalId: correction.actor,
              observedAt: correction.trace.timestamp,
            },
            capturedAt: new Date().toISOString(),
            original: true,
            note: correction.correctionText,
          },
        ],
      }
      return { kind: "create", proposed }
    }
    case "stale_position": {
      const target = existing.find((record) => record.id === diagnosis.affectedMemoryIds[0])
      if (!target) return undefined
      const refreshedReview = { reviewedAt: new Date().toISOString(), expiresAt: null }
      const provenance: MemoryWrite["provenance"] = [
        {
          source: {
            kind: "user",
            externalId: correction.actor,
            observedAt: correction.trace.timestamp,
          },
          capturedAt: new Date().toISOString(),
          original: true,
          note: correction.correctionText,
        },
      ]
      if (target.role === "position") {
        return {
          kind: "supersede",
          targetMemoryId: target.id,
          proposed: {
            title: `Correction: refreshed ${target.id}`,
            content: correction.expectedOutcome,
            scope: { kind: "project", id: correction.context.projectId },
            type: "decision",
            provenance,
            institutional: { ...target, review: refreshedReview },
          },
        }
      }
      return {
        kind: "supersede",
        targetMemoryId: target.id,
        proposed: {
          title: `Correction: refreshed ${target.id}`,
          content: procedureContent(target) ?? correction.expectedOutcome,
          scope: { kind: "project", id: correction.context.projectId },
          type: "procedure",
          provenance,
          institutional: { ...target, review: refreshedReview },
        },
      }
    }
    case "duplicate_conflict": {
      const records = diagnosis.affectedMemoryIds
        .map((id) => existing.find((record) => record.id === id))
        .filter(isDefined)
      if (records.length < 2) return undefined
      const target = retireCandidate(records)
      return {
        kind: "retire",
        targetMemoryId: target.id,
        note: `retired as the older of overlapping records: ${records.map((r) => r.id).join(", ")}`,
      }
    }
    case "procedure_fault": {
      const [targetMemoryId] = diagnosis.affectedMemoryIds
      return {
        kind: "route_adjustment",
        ...(targetMemoryId ? { targetMemoryId } : {}),
        note: diagnosis.reason,
      }
    }
    case "ambiguous":
    default:
      return undefined
  }
}

function institutionalReferences(memory: InstitutionalMemory): string[] {
  return memory.role === "position"
    ? (memory.dependsOnPositionIds ?? [])
    : [...(memory.positionIds ?? []), ...(memory.procedureIds ?? [])]
}

/**
 * Computes the #24 dependency-graph closure of records that reference the
 * mutation's target, so a reviewer can see blast radius before approving a
 * supersede/retire. `validateInstitutionalMemories` already rejects a
 * mutation that would leave a dangling reference; this exists for review
 * visibility into which records those references belong to, not safety.
 */
export function computeImpactedMemoryIds(
  mutation: CandidateMutation,
  existing: InstitutionalMemory[],
): string[] {
  if (mutation.kind === "create" || mutation.kind === "route_adjustment") return []
  const targetId = mutation.targetMemoryId
  return existing
    .filter(
      (record) => record.id !== targetId && institutionalReferences(record).includes(targetId),
    )
    .map((record) => record.id)
}

/**
 * Applies a candidate's mutation to an institutional corpus in memory,
 * without persisting anything -- used both by structural validation (check
 * the resulting set) and by a replay gate (run scenarios against the
 * resulting set before approval).
 */
export function applyMutationToInstitutionalSet(
  mutation: CandidateMutation,
  existing: InstitutionalWrite[],
): InstitutionalWrite[] {
  switch (mutation.kind) {
    case "route_adjustment":
      return existing
    case "create":
      return [...existing, mutation.proposed]
    case "retire":
      return existing.filter((entry) => entry.institutional?.id !== mutation.targetMemoryId)
    case "update":
    case "supersede": {
      const withoutTarget = existing.filter(
        (entry) => entry.institutional?.id !== mutation.targetMemoryId,
      )
      return [...withoutTarget, mutation.proposed]
    }
  }
}

export function validateCandidateStructure(
  mutation: CandidateMutation,
  correction: CorrectionInput,
  existingInstitutional: InstitutionalWrite[],
): StructuralValidationSummary {
  if (mutation.kind === "route_adjustment") return { valid: true, issues: [] }

  const issues: InstitutionalValidationIssue[] = []
  if (mutation.kind === "create" && mutation.proposed.scope.kind === "global") {
    issues.push({
      code: "invalid_applicability",
      id: mutation.proposed.title,
      message: "a project-scoped correction must not create a global-scope memory",
    })
  }

  const nextState = applyMutationToInstitutionalSet(mutation, existingInstitutional)
  const structural = validateInstitutionalMemories(nextState)
  return {
    valid: issues.length === 0 && structural.valid,
    issues: [...issues, ...structural.issues],
  }
}

export interface ApplyMutationResult {
  memoryId: string
}

/**
 * Applies an approved mutation to the owning provider and returns the
 * resulting memory id. Implementations are responsible for refreshing that
 * provider's retrieval state (e.g. calling `MemoryProvider.refresh()`) as
 * part of applying the mutation, so the approved change is immediately
 * visible to subsequent retrieval -- `CorrectionReviewQueue.approve` treats
 * this call as the single atomic apply step and does not refresh anything
 * itself. `context` is the correction's own context, so the implementation
 * can scope provider lookups the same way the original correction was.
 */
export type ApplyMutation = (
  mutation: CandidateMutation,
  context: MemoryContext,
) => Promise<ApplyMutationResult>

/**
 * A loader for the current institutional corpus, scoped to `context`. May
 * be synchronous (an in-memory fixture) or asynchronous (a live provider
 * query) -- `CorrectionReviewQueue` awaits it either way.
 */
export type InstitutionalLoader<T> = (context: MemoryContext) => T | Promise<T>

/**
 * Durable storage for correction candidates. `update` is the sole mutation
 * entry point and must be atomic per id: it loads the current row, applies
 * `mutate` to it, and persists the result as one unit, so a concurrent
 * `update` on the same id either fully precedes or fully follows this one --
 * never interleaves with it. A Postgres-backed implementation gets this for
 * free via `SELECT ... FOR UPDATE`; an in-memory implementation gets it for
 * free by keeping `mutate` synchronous, since JS never interleaves within a
 * single synchronous callback. `mutate` must therefore never itself await
 * anything -- all async work (loading the institutional corpus, running the
 * replay gate) happens before calling `update`, and `mutate` only re-checks
 * the freshest state and applies an already-computed transition.
 */
export interface CorrectionCandidateStore {
  insert(candidate: CorrectionCandidate): Promise<void>
  get(candidateId: string): Promise<CorrectionCandidate | undefined>
  list(filter?: { state?: CandidateLifecycleState }): Promise<CorrectionCandidate[]>
  update(
    candidateId: string,
    mutate: (candidate: CorrectionCandidate) => CorrectionCandidate,
  ): Promise<CorrectionCandidate>
}

const DEFAULT_MAX_CANDIDATES = 1_000

const TERMINAL_STATES: ReadonlySet<CandidateLifecycleState> = new Set(["applied", "rejected"])

/** Terminal states plus "applying": a candidate mid-approval must not be reopened by a concurrent reject/requestChanges/revalidation. */
const LOCKED_STATES: ReadonlySet<CandidateLifecycleState> = new Set([
  "applied",
  "rejected",
  "applying",
])

function assertTransitionAllowed(candidate: CorrectionCandidate, action: string): void {
  if (LOCKED_STATES.has(candidate.state)) {
    throw new Error(
      `candidate ${candidate.id} is in state "${candidate.state}" and cannot ${action}`,
    )
  }
}

/**
 * In-process, non-durable `CorrectionCandidateStore`. Suitable for tests and
 * for hosts that have not configured persistent storage; state is lost on
 * process exit and is not visible to other processes.
 */
export class InMemoryCorrectionCandidateStore implements CorrectionCandidateStore {
  private readonly candidates = new Map<string, CorrectionCandidate>()

  constructor(private readonly maxCandidates = DEFAULT_MAX_CANDIDATES) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- async so a synchronous throw becomes a rejected promise, not an escaping exception.
  async insert(candidate: CorrectionCandidate): Promise<void> {
    if (this.candidates.has(candidate.id)) {
      throw new Error(`a correction candidate with id ${candidate.id} already exists`)
    }
    if (this.candidates.size >= this.maxCandidates) {
      this.evictOldestTerminal()
      if (this.candidates.size >= this.maxCandidates) {
        throw new Error(
          `correction review queue is full (${this.maxCandidates} candidates); resolve pending reviews before submitting more`,
        )
      }
    }
    this.candidates.set(candidate.id, structuredClone(candidate))
  }

  get(candidateId: string): Promise<CorrectionCandidate | undefined> {
    const candidate = this.candidates.get(candidateId)
    return Promise.resolve(candidate ? structuredClone(candidate) : undefined)
  }

  list(filter?: { state?: CandidateLifecycleState }): Promise<CorrectionCandidate[]> {
    const all = [...this.candidates.values()]
    return Promise.resolve(
      (filter?.state ? all.filter((candidate) => candidate.state === filter.state) : all).map(
        (candidate) => structuredClone(candidate),
      ),
    )
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async so a synchronous throw (from `mutate` or an unknown id) becomes a rejected promise, not an escaping exception.
  async update(
    candidateId: string,
    mutate: (candidate: CorrectionCandidate) => CorrectionCandidate,
  ): Promise<CorrectionCandidate> {
    const current = this.candidates.get(candidateId)
    if (!current) throw new Error(`unknown correction candidate: ${candidateId}`)
    const updated = mutate(structuredClone(current))
    this.candidates.set(candidateId, updated)
    return structuredClone(updated)
  }

  /** Only removes a resolved (terminal) candidate, never one that is still under active review. */
  private evictOldestTerminal(): void {
    for (const [id, candidate] of this.candidates) {
      if (TERMINAL_STATES.has(candidate.state)) {
        this.candidates.delete(id)
        return
      }
    }
  }
}

function touch(
  candidate: CorrectionCandidate,
  entry: Omit<CandidateAuditEntry, "at">,
): CorrectionCandidate {
  const at = new Date().toISOString()
  return {
    ...candidate,
    updatedAt: at,
    audit: [...candidate.audit, { ...entry, at }],
  }
}

export class CorrectionReviewQueue {
  constructor(
    private readonly store: CorrectionCandidateStore,
    private readonly loadInstitutional: InstitutionalLoader<InstitutionalMemory[]>,
    private readonly loadInstitutionalWrites: InstitutionalLoader<InstitutionalWrite[]>,
    private readonly applyMutation: ApplyMutation,
    private readonly replayGate: ReplayGate,
  ) {}

  async submit(correction: CorrectionInput): Promise<CorrectionCandidate> {
    const now = new Date().toISOString()
    // Clone the input on ingestion: the caller's original CorrectionInput
    // object must not be able to change what this candidate diagnoses,
    // replays, or applies after submission.
    const storedCorrection = structuredClone(correction)
    const candidate: CorrectionCandidate = {
      id: storedCorrection.id ?? randomUUID(),
      state: "pending_validation",
      correction: storedCorrection,
      affectedMemoryIds: [],
      audit: [{ at: now, actor: storedCorrection.actor, event: "submitted" }],
      createdAt: now,
      updatedAt: now,
    }
    await this.store.insert(candidate)
    return candidate
  }

  get(candidateId: string): Promise<CorrectionCandidate | undefined> {
    return this.store.get(candidateId)
  }

  list(filter?: { state?: CandidateLifecycleState }): Promise<CorrectionCandidate[]> {
    return this.store.list(filter)
  }

  /**
   * Runs diagnosis, mutation proposal, structural validation, and the
   * replay gate. All of that work happens against a point-in-time read and
   * is not itself atomic with the write -- the final `store.update` re-runs
   * the terminal/locked-state check against the freshest row, so a
   * concurrent reject/approve that completed while this was computing
   * causes this call to abort instead of clobbering that decision.
   */
  async runValidation(candidateId: string): Promise<CorrectionCandidate> {
    const before = await this.store.get(candidateId)
    if (!before) throw new Error(`unknown correction candidate: ${candidateId}`)
    assertTransitionAllowed(before, "be revalidated")

    const existing = await this.loadInstitutional(before.correction.context)
    const diagnosis = diagnoseCorrection(before.correction, existing)

    if (diagnosis.rootCause === "ambiguous") {
      return this.store.update(candidateId, (candidate) => {
        assertTransitionAllowed(candidate, "be revalidated")
        let next: CorrectionCandidate = {
          ...candidate,
          rootCause: diagnosis.rootCause,
          rootCauseReason: diagnosis.reason,
          affectedMemoryIds: diagnosis.affectedMemoryIds,
          state: "needs_changes",
        }
        next = touch(next, {
          actor: "system",
          event: "diagnosed",
          detail: `${diagnosis.rootCause}: ${diagnosis.reason}`,
        })
        return touch(next, {
          actor: "system",
          event: "validation_failed",
          detail: "ambiguous corrections require a human decision and cannot be auto-classified",
        })
      })
    }

    const mutation = proposeCandidateMutation(before.correction, diagnosis, existing)
    const impactedMemoryIds = mutation ? computeImpactedMemoryIds(mutation, existing) : []
    const structural = mutation
      ? validateCandidateStructure(
          mutation,
          before.correction,
          await this.loadInstitutionalWrites(before.correction.context),
        )
      : undefined

    let replay: ReplayGateResult | undefined
    if (mutation && structural?.valid) {
      // Pass a plain object, not a live store-backed reference: the gate is
      // caller-supplied and must not be able to mutate queue state.
      replay = await this.replayGate.run({
        ...before,
        rootCause: diagnosis.rootCause,
        rootCauseReason: diagnosis.reason,
        affectedMemoryIds: diagnosis.affectedMemoryIds,
        impactedMemoryIds,
        mutation,
        structuralValidation: structural,
      })
    }

    return this.store.update(candidateId, (candidate) => {
      assertTransitionAllowed(candidate, "be revalidated")
      let next: CorrectionCandidate = {
        ...candidate,
        rootCause: diagnosis.rootCause,
        rootCauseReason: diagnosis.reason,
        affectedMemoryIds: diagnosis.affectedMemoryIds,
      }
      next = touch(next, {
        actor: "system",
        event: "diagnosed",
        detail: `${diagnosis.rootCause}: ${diagnosis.reason}`,
      })

      if (!mutation) {
        next.state = "needs_changes"
        return touch(next, {
          actor: "system",
          event: "validation_failed",
          detail: "no mutation could be derived for the diagnosed root cause",
        })
      }
      next = {
        ...next,
        mutation,
        impactedMemoryIds,
        ...(structural ? { structuralValidation: structural } : {}),
      }

      if (!structural?.valid) {
        next.state = "needs_changes"
        return touch(next, {
          actor: "system",
          event: "validation_failed",
          detail: (structural?.issues ?? []).map((issue) => `${issue.code}:${issue.id}`).join(", "),
        })
      }
      next = touch(next, {
        actor: "system",
        event: "validated",
        detail: "structural validation passed",
      })

      if (!replay) {
        // Unreachable in practice (replay only stays undefined when
        // structural validation failed, handled above), but keeps this
        // function total without a non-null assertion.
        next.state = "needs_changes"
        return touch(next, {
          actor: "system",
          event: "validation_failed",
          detail: "replay gate did not run",
        })
      }
      next = { ...next, replay }
      if (!replay.passed) {
        next.state = "needs_changes"
        return touch(next, {
          actor: "system",
          event: "replay_failed",
          detail: replay.failures.join(", "),
        })
      }
      next = touch(next, {
        actor: "system",
        event: "replay_passed",
        detail: `cases: ${replay.caseIds.join(", ")}`,
      })
      next.state = "validated"
      return next
    })
  }

  reject(candidateId: string, actor: string, reason: string): Promise<CorrectionCandidate> {
    return this.store.update(candidateId, (candidate) => {
      assertTransitionAllowed(candidate, "be rejected")
      const at = new Date().toISOString()
      let next: CorrectionCandidate = {
        ...candidate,
        state: "rejected",
        reviewerDecision: { actor, decision: "rejected", reason, at },
      }
      next = touch(next, { actor, event: "rejected", detail: reason })
      return next
    })
  }

  requestChanges(candidateId: string, actor: string, reason: string): Promise<CorrectionCandidate> {
    return this.store.update(candidateId, (candidate) => {
      assertTransitionAllowed(candidate, "have changes requested")
      const at = new Date().toISOString()
      let next: CorrectionCandidate = {
        ...candidate,
        state: "needs_changes",
        reviewerDecision: { actor, decision: "changes_requested", reason, at },
      }
      next = touch(next, { actor, event: "changes_requested", detail: reason })
      return next
    })
  }

  /**
   * Claims the candidate for approval (atomic; fails immediately if it is
   * not "validated"), applies its mutation outside the store lock since a
   * provider write may be slow, then finalizes to "applied". On apply
   * failure the claim is rolled back to "validated" so the candidate stays
   * retryable, with no misleading "approved" audit entry.
   */
  async approve(candidateId: string, actor: string): Promise<CorrectionCandidate> {
    const claimed = await this.store.update(candidateId, (candidate) => {
      if (candidate.state !== "validated" || !candidate.mutation) {
        throw new Error(
          `candidate ${candidateId} cannot be approved from state "${candidate.state}"; it must pass validation first`,
        )
      }
      return { ...candidate, state: "applying" }
    })
    const mutation = claimed.mutation
    if (!mutation) throw new Error(`candidate ${candidateId} was claimed without a mutation`)

    try {
      const result = await this.applyMutation(mutation, claimed.correction.context)
      return await this.store.update(candidateId, (candidate) => {
        const at = new Date().toISOString()
        let next: CorrectionCandidate = {
          ...candidate,
          state: "applied",
          reviewerDecision: { actor, decision: "approved", at },
          appliedMemoryId: result.memoryId,
        }
        next = touch(next, { actor, event: "approved" })
        return touch(next, { actor: "system", event: "applied", detail: result.memoryId })
      })
    } catch (error) {
      await this.store.update(candidateId, (candidate) =>
        candidate.state === "applying" ? { ...candidate, state: "validated" } : candidate,
      )
      throw error
    }
  }
}

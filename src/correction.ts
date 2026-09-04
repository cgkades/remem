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
  "pending_validation" | "validated" | "needs_changes" | "rejected" | "applied"

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

  const scopedTogether = disputedRecords.every((record) =>
    record.applicability.conditions.some((condition) =>
      disputedRecords.every((other) =>
        other.applicability.conditions.some(
          (otherCondition) => otherCondition.value === condition.value,
        ),
      ),
    ),
  )
  if (scopedTogether) {
    return {
      rootCause: "duplicate_conflict",
      reason: `${disputedRecords.map((record) => record.id).join(", ")} share overlapping applicability and conflict`,
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

function applyMutationToInstitutionalSet(
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
 * itself.
 */
export type ApplyMutation = (mutation: CandidateMutation) => Promise<ApplyMutationResult>

function clone(candidate: CorrectionCandidate): CorrectionCandidate {
  return structuredClone(candidate)
}

const DEFAULT_MAX_CANDIDATES = 1_000

export class CorrectionReviewQueue {
  private readonly candidates = new Map<string, CorrectionCandidate>()
  private readonly pending = new Set<string>()

  constructor(
    private readonly loadInstitutional: () => InstitutionalMemory[],
    private readonly loadInstitutionalWrites: () => InstitutionalWrite[],
    private readonly applyMutation: ApplyMutation,
    private readonly replayGate: ReplayGate,
    private readonly maxCandidates = DEFAULT_MAX_CANDIDATES,
  ) {}

  submit(correction: CorrectionInput): CorrectionCandidate {
    const now = new Date().toISOString()
    const candidate: CorrectionCandidate = {
      id: correction.id ?? randomUUID(),
      state: "pending_validation",
      correction,
      affectedMemoryIds: [],
      audit: [{ at: now, actor: correction.actor, event: "submitted" }],
      createdAt: now,
      updatedAt: now,
    }
    this.candidates.set(candidate.id, candidate)
    while (this.candidates.size > this.maxCandidates) {
      const oldest = this.candidates.keys().next().value
      if (!oldest) break
      this.candidates.delete(oldest)
    }
    return clone(candidate)
  }

  get(candidateId: string): CorrectionCandidate | undefined {
    const candidate = this.candidates.get(candidateId)
    return candidate ? clone(candidate) : undefined
  }

  list(filter?: { state?: CandidateLifecycleState }): CorrectionCandidate[] {
    const all = [...this.candidates.values()]
    return (filter?.state ? all.filter((candidate) => candidate.state === filter.state) : all).map(
      clone,
    )
  }

  private touch(candidate: CorrectionCandidate, entry: Omit<CandidateAuditEntry, "at">): void {
    const at = new Date().toISOString()
    candidate.audit.push({ ...entry, at })
    candidate.updatedAt = at
  }

  /** Looks up a candidate without checking the in-flight lock -- only safe to call from within `withLock`. */
  private lookup(candidateId: string): CorrectionCandidate {
    const candidate = this.candidates.get(candidateId)
    if (!candidate) throw new Error(`unknown correction candidate: ${candidateId}`)
    return candidate
  }

  private require(candidateId: string): CorrectionCandidate {
    if (this.pending.has(candidateId)) {
      throw new Error(`candidate ${candidateId} has a review operation already in progress`)
    }
    return this.lookup(candidateId)
  }

  /**
   * runValidation and approve both mutate the live candidate across an
   * `await`, which yields the event loop to any other call on the same
   * candidateId. Without this guard, an interleaved reject/requestChanges/
   * approve on the same id could silently overwrite a concurrent decision
   * once the first call resumes.
   */
  private async withLock<T>(candidateId: string, run: () => Promise<T>): Promise<T> {
    if (this.pending.has(candidateId)) {
      throw new Error(`candidate ${candidateId} has a review operation already in progress`)
    }
    this.pending.add(candidateId)
    try {
      return await run()
    } finally {
      this.pending.delete(candidateId)
    }
  }

  async runValidation(candidateId: string): Promise<CorrectionCandidate> {
    return this.withLock(candidateId, () => this.runValidationLocked(candidateId))
  }

  private async runValidationLocked(candidateId: string): Promise<CorrectionCandidate> {
    const candidate = this.lookup(candidateId)
    const existing = this.loadInstitutional()
    const diagnosis = diagnoseCorrection(candidate.correction, existing)
    candidate.rootCause = diagnosis.rootCause
    candidate.rootCauseReason = diagnosis.reason
    candidate.affectedMemoryIds = diagnosis.affectedMemoryIds
    this.touch(candidate, {
      actor: "system",
      event: "diagnosed",
      detail: `${diagnosis.rootCause}: ${diagnosis.reason}`,
    })

    if (diagnosis.rootCause === "ambiguous") {
      candidate.state = "needs_changes"
      this.touch(candidate, {
        actor: "system",
        event: "validation_failed",
        detail: "ambiguous corrections require a human decision and cannot be auto-classified",
      })
      return clone(candidate)
    }

    const mutation = proposeCandidateMutation(candidate.correction, diagnosis, existing)
    if (mutation) candidate.mutation = mutation
    if (!mutation) {
      candidate.state = "needs_changes"
      this.touch(candidate, {
        actor: "system",
        event: "validation_failed",
        detail: "no mutation could be derived for the diagnosed root cause",
      })
      return clone(candidate)
    }

    const structural = validateCandidateStructure(
      mutation,
      candidate.correction,
      this.loadInstitutionalWrites(),
    )
    candidate.structuralValidation = structural
    if (!structural.valid) {
      candidate.state = "needs_changes"
      this.touch(candidate, {
        actor: "system",
        event: "validation_failed",
        detail: structural.issues.map((issue) => `${issue.code}:${issue.id}`).join(", "),
      })
      return clone(candidate)
    }
    this.touch(candidate, {
      actor: "system",
      event: "validated",
      detail: "structural validation passed",
    })

    // Pass a clone: the gate is caller-supplied and must not be able to
    // mutate live candidate state out from under this method.
    const replay = await this.replayGate.run(clone(candidate))
    candidate.replay = replay
    if (!replay.passed) {
      candidate.state = "needs_changes"
      this.touch(candidate, {
        actor: "system",
        event: "replay_failed",
        detail: replay.failures.join(", "),
      })
      return clone(candidate)
    }
    this.touch(candidate, {
      actor: "system",
      event: "replay_passed",
      detail: `cases: ${replay.caseIds.join(", ")}`,
    })
    candidate.state = "validated"
    return clone(candidate)
  }

  reject(candidateId: string, actor: string, reason: string): CorrectionCandidate {
    const candidate = this.require(candidateId)
    candidate.state = "rejected"
    candidate.reviewerDecision = {
      actor,
      decision: "rejected",
      reason,
      at: new Date().toISOString(),
    }
    this.touch(candidate, { actor, event: "rejected", detail: reason })
    return clone(candidate)
  }

  requestChanges(candidateId: string, actor: string, reason: string): CorrectionCandidate {
    const candidate = this.require(candidateId)
    candidate.state = "needs_changes"
    candidate.reviewerDecision = {
      actor,
      decision: "changes_requested",
      reason,
      at: new Date().toISOString(),
    }
    this.touch(candidate, { actor, event: "changes_requested", detail: reason })
    return clone(candidate)
  }

  async approve(candidateId: string, actor: string): Promise<CorrectionCandidate> {
    return this.withLock(candidateId, () => this.approveLocked(candidateId, actor))
  }

  private async approveLocked(candidateId: string, actor: string): Promise<CorrectionCandidate> {
    const candidate = this.lookup(candidateId)
    if (candidate.state !== "validated" || !candidate.mutation) {
      throw new Error(
        `candidate ${candidateId} cannot be approved from state "${candidate.state}"; it must pass validation first`,
      )
    }
    // Apply first and only record the approval/applied audit trail once the
    // mutation has actually landed, so a failed apply leaves the candidate
    // in "validated" with no misleading "approved" entry to retry from.
    const result = await this.applyMutation(candidate.mutation)
    candidate.reviewerDecision = { actor, decision: "approved", at: new Date().toISOString() }
    candidate.appliedMemoryId = result.memoryId
    candidate.state = "applied"
    this.touch(candidate, { actor, event: "approved" })
    this.touch(candidate, { actor: "system", event: "applied", detail: result.memoryId })
    return clone(candidate)
  }
}

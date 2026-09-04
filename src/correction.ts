import { randomUUID } from "node:crypto"
import {
  institutionalReviewStatus,
  procedureContent,
  validateInstitutionalMemories,
  type InstitutionalValidationIssue,
} from "./institutional.js"
import type {
  ApplicabilityDecision,
  InstitutionalMemory,
  MemoryContext,
  MemoryTrace,
  MemoryWrite,
} from "./types.js"

type InstitutionalWrite = Pick<
  MemoryWrite,
  "title" | "content" | "scope" | "type" | "provenance" | "institutional"
>

export type CorrectionRootCause =
  "knowledge_gap" | "procedure_fault" | "duplicate_conflict" | "stale_position" | "ambiguous"

export type CandidateMutationKind =
  "create" | "update" | "supersede" | "retire" | "route_adjustment"

export interface CandidateMutation {
  kind: CandidateMutationKind
  targetMemoryId?: string
  proposed?: MemoryWrite
  note?: string
}

export type CandidateLifecycleState =
  | "draft"
  | "pending_validation"
  | "validated"
  | "needs_changes"
  | "rejected"
  | "approved"
  | "applied"

export interface CorrectionInput {
  id?: string
  sessionId: string
  prompt: string
  correctionText: string
  expectedOutcome: string
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
): { rootCause: CorrectionRootCause; reason: string; affectedMemoryIds: string[] } {
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
  diagnosis: ReturnType<typeof diagnoseCorrection>,
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
  if (mutation.kind === "route_adjustment") return existing
  if (mutation.kind === "create") {
    return mutation.proposed ? [...existing, mutation.proposed] : existing
  }
  if (mutation.kind === "retire") {
    return existing.filter((entry) => entry.institutional?.id !== mutation.targetMemoryId)
  }
  // update / supersede: replace the targeted entry with the proposed content.
  const withoutTarget = existing.filter(
    (entry) => entry.institutional?.id !== mutation.targetMemoryId,
  )
  return mutation.proposed ? [...withoutTarget, mutation.proposed] : existing
}

const GLOBAL_SCOPE_FOR_PROJECT_CORRECTION: InstitutionalValidationIssue = {
  code: "invalid_applicability",
  id: "scope",
  message: "a project-scoped correction must not create a global-scope memory",
}

export function validateCandidateStructure(
  mutation: CandidateMutation,
  correction: CorrectionInput,
  existingInstitutional: InstitutionalWrite[],
): StructuralValidationSummary {
  if (mutation.kind === "route_adjustment") return { valid: true, issues: [] }

  const issues: InstitutionalValidationIssue[] = []
  if (mutation.kind === "create" && mutation.proposed?.scope.kind === "global") {
    issues.push({ ...GLOBAL_SCOPE_FOR_PROJECT_CORRECTION, id: mutation.proposed.title })
  }

  const nextState = applyMutationToInstitutionalSet(mutation, existingInstitutional)
  const structural = validateInstitutionalMemories(nextState)
  return {
    valid: issues.length === 0 && structural.valid,
    issues: [...issues, ...structural.issues],
  }
}

export interface SubmitCorrectionResult {
  candidate: CorrectionCandidate
}

export interface ApplyMutationResult {
  memoryId: string
}

export type ApplyMutation = (mutation: CandidateMutation) => Promise<ApplyMutationResult>

function clone(candidate: CorrectionCandidate): CorrectionCandidate {
  return structuredClone(candidate)
}

export class CorrectionReviewQueue {
  private readonly candidates = new Map<string, CorrectionCandidate>()

  constructor(
    private readonly loadInstitutional: () => InstitutionalMemory[],
    private readonly loadInstitutionalWrites: () => InstitutionalWrite[],
    private readonly applyMutation: ApplyMutation,
    private readonly replayGate?: ReplayGate,
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

  private require(candidateId: string): CorrectionCandidate {
    const candidate = this.candidates.get(candidateId)
    if (!candidate) throw new Error(`unknown correction candidate: ${candidateId}`)
    return candidate
  }

  async runValidation(candidateId: string): Promise<CorrectionCandidate> {
    const candidate = this.require(candidateId)
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

    if (!this.replayGate) {
      throw new Error(
        "no replay gate configured: a targeted behavioral replay must run before a candidate can be approved",
      )
    }
    const replay = await this.replayGate.run(candidate)
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
    const candidate = this.require(candidateId)
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

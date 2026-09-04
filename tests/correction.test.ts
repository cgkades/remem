import { describe, expect, it } from "vitest"
import {
  CorrectionReviewQueue,
  diagnoseCorrection,
  proposeCandidateMutation,
  validateCandidateStructure,
  type CorrectionInput,
  type ReplayGate,
} from "../src/correction.js"
import type {
  InstitutionalPosition,
  InstitutionalProcedure,
  MemoryContext,
  MemoryTrace,
  MemoryWrite,
} from "../src/types.js"

const context: MemoryContext = {
  directory: "/repo",
  worktree: "/repo",
  projectId: "phoenix",
  sessionId: "session-1",
}

function baseTrace(overrides: Partial<MemoryTrace> = {}): MemoryTrace {
  return {
    sessionId: "session-1",
    timestamp: "2026-09-04T00:00:00.000Z",
    catalogEntries: 1,
    catalogMatches: [],
    shouldRetrieve: true,
    confidence: 0.9,
    topics: ["production rollout"],
    signals: [],
    providers: [],
    rawResults: 1,
    deduplicatedResults: 1,
    selectedResults: 1,
    catalogTokens: 10,
    recallTokens: 10,
    totalDurationMs: 5,
    diagnostics: [],
    ...overrides,
  }
}

function position(overrides: Partial<InstitutionalPosition> = {}): InstitutionalPosition {
  return {
    role: "position",
    id: "position.production-rollout",
    owner: "release-engineering",
    sourceRefs: ["policy://release/rollback-position"],
    boundaryConditions: ["Production changes only."],
    applicability: {
      match: "all",
      conditions: [{ id: "project", kind: "context", field: "projectId", value: "phoenix" }],
    },
    review: { reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2027-09-01T00:00:00.000Z" },
    ...overrides,
  }
}

function positionWrite(institutional: InstitutionalPosition): MemoryWrite {
  return {
    type: "decision",
    title: "Production rollout position",
    content: "Position: production rollouts require an approved rollback plan.",
    scope: { kind: "project", id: "phoenix" },
    provenance: [
      {
        source: { kind: "document", uri: "policy://release/rollback-position" },
        capturedAt: "2026-09-01T00:00:00.000Z",
        original: true,
      },
    ],
    institutional,
  }
}

function procedure(overrides: Partial<InstitutionalProcedure> = {}): InstitutionalProcedure {
  return {
    role: "procedure",
    id: "procedure.production-rollout",
    steps: [{ id: "step-1", instruction: "Collect rollback evidence before approving." }],
    positionIds: ["position.production-rollout"],
    requiredEvidence: ["rollback owner"],
    completionCriteria: ["rollback plan approved"],
    escalationConditions: ["missing rollback owner"],
    applicability: {
      match: "all",
      conditions: [{ id: "project", kind: "context", field: "projectId", value: "phoenix" }],
    },
    review: { reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2027-09-01T00:00:00.000Z" },
    ...overrides,
  }
}

function procedureWrite(institutional: InstitutionalProcedure): MemoryWrite {
  return {
    type: "procedure",
    title: "Production rollout procedure",
    content: institutional.steps
      .map((step, index) => `${index + 1}. ${step.instruction}`)
      .join("\n"),
    scope: { kind: "project", id: "phoenix" },
    provenance: [
      {
        source: { kind: "document", uri: "policy://release/rollback-procedure" },
        capturedAt: "2026-09-01T00:00:00.000Z",
        original: true,
      },
    ],
    institutional,
  }
}

function correction(overrides: Partial<CorrectionInput> = {}): CorrectionInput {
  return {
    sessionId: "session-1",
    prompt: "Can we skip the rollback plan for this hotfix?",
    correctionText: "The agent said rollback plans are optional; they are required for production.",
    expectedOutcome: "Production rollouts require an approved rollback plan.",
    actor: "reviewer@example.test",
    context,
    trace: baseTrace(),
    ...overrides,
  }
}

describe("diagnoseCorrection", () => {
  it("classifies a pure knowledge gap when nothing is disputed", () => {
    const result = diagnoseCorrection(correction(), [])
    expect(result.rootCause).toBe("knowledge_gap")
  })

  it("classifies a procedure/routing fault when approved material existed but was excluded", () => {
    const record = position()
    const trace = baseTrace({
      applicability: [
        {
          catalogEntryId: "production-position",
          institutionalId: record.id,
          applicable: false,
          reason: "context mismatch",
        },
      ],
    })
    const result = diagnoseCorrection(correction({ disputedMemoryIds: [record.id], trace }), [
      record,
    ])
    expect(result.rootCause).toBe("procedure_fault")
    expect(result.affectedMemoryIds).toEqual([record.id])
  })

  it("classifies a procedure/routing fault when approved material was never evaluated", () => {
    const record = position()
    const result = diagnoseCorrection(
      correction({ disputedMemoryIds: [record.id], trace: baseTrace({ applicability: [] }) }),
      [record],
    )
    expect(result.rootCause).toBe("procedure_fault")
  })

  it("classifies a stale position when the disputed record expired", () => {
    const record = position({
      review: { reviewedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-06-01T00:00:00.000Z" },
    })
    const trace = baseTrace({
      applicability: [
        {
          catalogEntryId: "production-position",
          institutionalId: record.id,
          applicable: true,
          reason: "matched",
        },
      ],
    })
    const result = diagnoseCorrection(correction({ disputedMemoryIds: [record.id], trace }), [
      record,
    ])
    expect(result.rootCause).toBe("stale_position")
  })

  it("classifies a duplicate/conflict when two disputed records share an identical applicability scope", () => {
    const a = position({ id: "position.a" })
    const b = position({ id: "position.b" })
    const result = diagnoseCorrection(correction({ disputedMemoryIds: [a.id, b.id] }), [a, b])
    expect(result.rootCause).toBe("duplicate_conflict")
    expect(result.affectedMemoryIds.sort()).toEqual([a.id, b.id].sort())
  })

  it("does not classify unrelated records as duplicate/conflict merely because a condition value matches", () => {
    const a = position({
      id: "position.a",
      applicability: {
        match: "all",
        conditions: [{ id: "project", kind: "context", field: "projectId", value: "phoenix" }],
      },
    })
    const b = position({
      id: "position.b",
      applicability: {
        match: "all",
        conditions: [{ id: "topic", kind: "topic", value: "phoenix" }],
      },
    })
    const result = diagnoseCorrection(correction({ disputedMemoryIds: [a.id, b.id] }), [a, b])
    expect(result.rootCause).toBe("ambiguous")
  })

  it("classifies ambiguous when disputed ids do not resolve to existing records", () => {
    const result = diagnoseCorrection(correction({ disputedMemoryIds: ["missing.id"] }), [])
    expect(result.rootCause).toBe("ambiguous")
  })

  it("classifies ambiguous when the record was current, applicable, and surfaced", () => {
    const record = position()
    const trace = baseTrace({
      applicability: [
        {
          catalogEntryId: "production-position",
          institutionalId: record.id,
          applicable: true,
          reason: "matched",
        },
      ],
    })
    const result = diagnoseCorrection(correction({ disputedMemoryIds: [record.id], trace }), [
      record,
    ])
    expect(result.rootCause).toBe("ambiguous")
  })
})

describe("proposeCandidateMutation", () => {
  it("proposes a create mutation for a knowledge gap", () => {
    const diagnosis = diagnoseCorrection(correction(), [])
    const mutation = proposeCandidateMutation(correction(), diagnosis, [])
    expect(mutation?.kind).toBe("create")
    if (mutation?.kind !== "create") throw new Error("expected a create mutation")
    expect(mutation.proposed.scope).toEqual({ kind: "project", id: "phoenix" })
  })

  it("proposes no mutation for an ambiguous correction", () => {
    const diagnosis = diagnoseCorrection(correction({ disputedMemoryIds: ["missing.id"] }), [])
    const mutation = proposeCandidateMutation(correction(), diagnosis, [])
    expect(mutation).toBeUndefined()
  })

  it("proposes retiring the older of two conflicting records", () => {
    const older = position({
      id: "position.older",
      review: { reviewedAt: "2020-01-01T00:00:00.000Z", expiresAt: null },
    })
    const newer = position({
      id: "position.newer",
      review: { reviewedAt: "2026-01-01T00:00:00.000Z", expiresAt: null },
    })
    const input = correction({ disputedMemoryIds: [older.id, newer.id] })
    const diagnosis = diagnoseCorrection(input, [older, newer])
    const mutation = proposeCandidateMutation(input, diagnosis, [older, newer])
    expect(mutation?.kind).toBe("retire")
    if (mutation?.kind !== "retire") throw new Error("expected a retire mutation")
    expect(mutation.targetMemoryId).toBe(older.id)
  })
})

describe("validateCandidateStructure", () => {
  it("rejects a create mutation that introduces a duplicate id", () => {
    const existing = position()
    const mutation = {
      kind: "create" as const,
      proposed: positionWrite(existing),
    }
    const result = validateCandidateStructure(mutation, correction(), [positionWrite(existing)])
    expect(result.valid).toBe(false)
    expect(result.issues.some((issue) => issue.code === "duplicate_id")).toBe(true)
  })

  it("rejects a create mutation targeting global scope", () => {
    const mutation = {
      kind: "create" as const,
      proposed: {
        title: "x",
        content: "y",
        scope: { kind: "global" as const },
        type: "decision" as const,
      },
    }
    const result = validateCandidateStructure(mutation, correction(), [])
    expect(result.valid).toBe(false)
  })

  it("accepts a valid retire mutation", () => {
    const record = position()
    const mutation = { kind: "retire" as const, targetMemoryId: record.id, note: "retired" }
    const result = validateCandidateStructure(mutation, correction(), [positionWrite(record)])
    expect(result.valid).toBe(true)
  })
})

const passingGate: ReplayGate = {
  run: () => Promise.resolve({ passed: true, caseIds: ["case-1"], failures: [] }),
}
const failingGate: ReplayGate = {
  run: () =>
    Promise.resolve({ passed: false, caseIds: ["case-1"], failures: ["outcome mismatch"] }),
}

function queue(replayGate: ReplayGate, existing: InstitutionalPosition[] = []) {
  const applied: unknown[] = []
  const q = new CorrectionReviewQueue(
    () => existing,
    () => existing.map(positionWrite),
    (mutation) => {
      applied.push(mutation)
      const memoryId = "targetMemoryId" in mutation ? mutation.targetMemoryId : undefined
      return Promise.resolve({ memoryId: memoryId ?? "new-memory-id" })
    },
    replayGate,
  )
  return { q, applied }
}

describe("CorrectionReviewQueue", () => {
  it("accepted: validates and approves a knowledge-gap candidate end to end", async () => {
    const { q, applied } = queue(passingGate)
    const candidate = q.submit(correction())
    const validated = await q.runValidation(candidate.id)
    expect(validated.state).toBe("validated")
    const applied2 = await q.approve(candidate.id, "reviewer@example.test")
    expect(applied2.state).toBe("applied")
    expect(applied2.appliedMemoryId).toBe("new-memory-id")
    expect(applied).toHaveLength(1)
    expect(applied2.audit.map((entry) => entry.event)).toEqual([
      "submitted",
      "diagnosed",
      "validated",
      "replay_passed",
      "approved",
      "applied",
    ])
  })

  it("rejected: a human can reject a validated candidate without applying it", async () => {
    const { q, applied } = queue(passingGate)
    const candidate = q.submit(correction())
    await q.runValidation(candidate.id)
    const rejected = q.reject(candidate.id, "reviewer@example.test", "not needed")
    expect(rejected.state).toBe("rejected")
    expect(applied).toHaveLength(0)
    await expect(q.approve(candidate.id, "reviewer@example.test")).rejects.toThrow(
      /cannot be approved from state "rejected"/,
    )
  })

  it("invalid: structural validation failure blocks approval", async () => {
    const record = position({
      review: { reviewedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-06-01T00:00:00.000Z" },
    })
    const { q, applied } = queue(passingGate, [record])
    const candidate = q.submit(
      correction({
        actor: "",
        disputedMemoryIds: [record.id],
        trace: baseTrace({
          applicability: [
            {
              catalogEntryId: "x",
              institutionalId: record.id,
              applicable: true,
              reason: "matched",
            },
          ],
        }),
      }),
    )
    const result = await q.runValidation(candidate.id)
    expect(result.rootCause).toBe("stale_position")
    expect(result.state).toBe("needs_changes")
    expect(result.structuralValidation?.valid).toBe(false)
    expect(
      result.structuralValidation?.issues.some((issue) => issue.code === "missing_provenance"),
    ).toBe(true)
    await expect(q.approve(candidate.id, "reviewer@example.test")).rejects.toThrow()
    expect(applied).toHaveLength(0)
  })

  it("stale: an expired position produces a supersede mutation and validates", async () => {
    const record = position({
      review: { reviewedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-06-01T00:00:00.000Z" },
    })
    const { q } = queue(passingGate, [record])
    const candidate = q.submit(
      correction({
        disputedMemoryIds: [record.id],
        trace: baseTrace({
          applicability: [
            {
              catalogEntryId: "x",
              institutionalId: record.id,
              applicable: true,
              reason: "matched",
            },
          ],
        }),
      }),
    )
    const result = await q.runValidation(candidate.id)
    expect(result.rootCause).toBe("stale_position")
    expect(result.mutation?.kind).toBe("supersede")
    expect(result.state).toBe("validated")
  })

  it("stale: an expired procedure supersedes using its ordered steps, not free text", async () => {
    const record = procedure({
      review: { reviewedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-06-01T00:00:00.000Z" },
    })
    const referencedPosition = position()
    const q = new CorrectionReviewQueue(
      () => [record, referencedPosition],
      () => [procedureWrite(record), positionWrite(referencedPosition)],
      (mutation) =>
        Promise.resolve({
          memoryId: "targetMemoryId" in mutation ? (mutation.targetMemoryId ?? "new-id") : "new-id",
        }),
      passingGate,
    )
    const candidate = q.submit(
      correction({
        disputedMemoryIds: [record.id],
        trace: baseTrace({
          applicability: [
            {
              catalogEntryId: "x",
              institutionalId: record.id,
              applicable: true,
              reason: "matched",
            },
          ],
        }),
      }),
    )
    const result = await q.runValidation(candidate.id)
    expect(result.rootCause).toBe("stale_position")
    expect(result.mutation?.kind).toBe("supersede")
    if (result.mutation?.kind !== "supersede") throw new Error("expected a supersede mutation")
    expect(result.mutation.proposed.content).toBe(
      record.steps.map((step, index) => `${index + 1}. ${step.instruction}`).join("\n"),
    )
    expect(result.state).toBe("validated")
  })

  it("conflicting: a duplicate/conflict candidate proposes retiring the older record", async () => {
    const older = position({
      id: "position.older",
      review: { reviewedAt: "2020-01-01T00:00:00.000Z", expiresAt: null },
    })
    const newer = position({
      id: "position.newer",
      review: { reviewedAt: "2026-01-01T00:00:00.000Z", expiresAt: null },
    })
    const { q } = queue(passingGate, [older, newer])
    const candidate = q.submit(correction({ disputedMemoryIds: [older.id, newer.id] }))
    const result = await q.runValidation(candidate.id)
    expect(result.rootCause).toBe("duplicate_conflict")
    expect(result.mutation?.kind).toBe("retire")
    if (result.mutation?.kind !== "retire") throw new Error("expected a retire mutation")
    expect(result.mutation.targetMemoryId).toBe(older.id)
    expect(result.state).toBe("validated")
  })

  it("replay-failed: a failing replay gate blocks approval", async () => {
    const { q } = queue(failingGate)
    const candidate = q.submit(correction())
    const result = await q.runValidation(candidate.id)
    expect(result.state).toBe("needs_changes")
    expect(result.replay?.passed).toBe(false)
    await expect(q.approve(candidate.id, "reviewer@example.test")).rejects.toThrow()
  })

  it("ambiguous: an unresolved ambiguity is queued for a human decision without a mutation", async () => {
    const { q } = queue(passingGate)
    const candidate = q.submit(correction({ disputedMemoryIds: ["missing.id"] }))
    const result = await q.runValidation(candidate.id)
    expect(result.rootCause).toBe("ambiguous")
    expect(result.mutation).toBeUndefined()
    expect(result.state).toBe("needs_changes")
    await expect(q.approve(candidate.id, "reviewer@example.test")).rejects.toThrow()
  })

  it("rejects a concurrent decision on a candidate that is mid-validation, preventing a lost update", async () => {
    let resolveGate: (() => void) | undefined
    const blockingGate: ReplayGate = {
      run: () =>
        new Promise((resolve) => {
          resolveGate = () => resolve({ passed: true, caseIds: [], failures: [] })
        }),
    }
    const { q } = queue(blockingGate)
    const candidate = q.submit(correction())
    const validation = q.runValidation(candidate.id)
    // While runValidation is awaiting the replay gate, a concurrent reject
    // must be refused rather than silently racing the eventual state write.
    expect(() => q.reject(candidate.id, "reviewer@example.test", "too fast")).toThrow(
      /already in progress/,
    )
    resolveGate?.()
    const result = await validation
    expect(result.state).toBe("validated")
  })

  it("requestChanges preserves the candidate and audit trail without mutating memory", async () => {
    const { q, applied } = queue(passingGate)
    const candidate = q.submit(correction())
    await q.runValidation(candidate.id)
    const changed = q.requestChanges(candidate.id, "reviewer@example.test", "need more evidence")
    expect(changed.state).toBe("needs_changes")
    expect(applied).toHaveLength(0)
    expect(changed.reviewerDecision?.decision).toBe("changes_requested")
  })

  it("leaves the candidate in a retryable state and records no false approval when applyMutation fails", async () => {
    const q = new CorrectionReviewQueue(
      () => [],
      () => [],
      () => Promise.reject(new Error("database unavailable")),
      passingGate,
    )
    const candidate = q.submit(correction())
    await q.runValidation(candidate.id)
    await expect(q.approve(candidate.id, "reviewer@example.test")).rejects.toThrow(
      "database unavailable",
    )
    const stored = q.get(candidate.id)
    expect(stored?.state).toBe("validated")
    expect(stored?.reviewerDecision).toBeUndefined()
    expect(stored?.audit.some((entry) => entry.event === "approved")).toBe(false)
  })

  it("returns defensive copies so callers cannot mutate queue-internal state", () => {
    const { q } = queue(passingGate)
    const candidate = q.submit(correction())
    candidate.state = "applied"
    candidate.audit.length = 0
    candidate.correction.actor = "attacker"
    const stored = q.get(candidate.id)
    expect(stored?.state).toBe("pending_validation")
    expect(stored?.audit).toHaveLength(1)
    expect(stored?.correction.actor).toBe("reviewer@example.test")
  })

  it("clones the correction on ingestion so mutating the caller's original object after submit has no effect", async () => {
    const { q } = queue(passingGate)
    const original = correction()
    const candidate = q.submit(original)
    original.actor = "attacker"
    original.correctionText = "attacker-controlled text"
    original.expectedOutcome = "attacker-controlled outcome"
    original.disputedMemoryIds = ["some.other.id"]

    const stored = q.get(candidate.id)
    expect(stored?.correction.actor).toBe("reviewer@example.test")
    expect(stored?.correction.correctionText).toBe(
      "The agent said rollback plans are optional; they are required for production.",
    )
    expect(stored?.correction.expectedOutcome).toBe(
      "Production rollouts require an approved rollback plan.",
    )
    expect(stored?.correction.disputedMemoryIds).toBeUndefined()

    const result = await q.runValidation(candidate.id)
    // Diagnosis must reflect the state at submission time (a knowledge gap
    // with no disputed ids), not the mutated disputedMemoryIds.
    expect(result.rootCause).toBe("knowledge_gap")
  })

  it("rejects a duplicate candidate id instead of silently overwriting the existing candidate", () => {
    const { q } = queue(passingGate)
    const first = q.submit(correction({ id: "fixed-id" }))
    expect(() => q.submit(correction({ id: "fixed-id" }))).toThrow(/already exists/)
    expect(q.get(first.id)?.audit).toHaveLength(1)
  })

  it("terminal states reject further transitions: revalidate, reject, and requestChanges after apply", async () => {
    const { q } = queue(passingGate)
    const candidate = q.submit(correction())
    await q.runValidation(candidate.id)
    const applied = await q.approve(candidate.id, "reviewer@example.test")
    expect(applied.state).toBe("applied")

    await expect(q.runValidation(candidate.id)).rejects.toThrow(/terminal state "applied"/)
    expect(() => q.reject(candidate.id, "reviewer@example.test", "too late")).toThrow(
      /terminal state "applied"/,
    )
    expect(() => q.requestChanges(candidate.id, "reviewer@example.test", "too late")).toThrow(
      /terminal state "applied"/,
    )

    // A second approve attempt must also fail, since state never left "applied".
    await expect(q.approve(candidate.id, "reviewer@example.test")).rejects.toThrow(
      /cannot be approved from state "applied"/,
    )
  })

  it("a rejected candidate cannot be reopened via reject, requestChanges, or revalidation", async () => {
    const { q } = queue(passingGate)
    const candidate = q.submit(correction())
    await q.runValidation(candidate.id)
    q.reject(candidate.id, "reviewer@example.test", "not needed")

    expect(() => q.reject(candidate.id, "reviewer@example.test", "again")).toThrow(
      /terminal state "rejected"/,
    )
    expect(() => q.requestChanges(candidate.id, "reviewer@example.test", "reopen")).toThrow(
      /terminal state "rejected"/,
    )
    await expect(q.runValidation(candidate.id)).rejects.toThrow(/terminal state "rejected"/)
  })

  it("evicts only resolved (terminal) candidates when at capacity, never one under active review", async () => {
    const q = new CorrectionReviewQueue(
      () => [],
      () => [],
      () => Promise.resolve({ memoryId: "new-id" }),
      passingGate,
      1,
    )
    const resolved = q.submit(correction({ id: "resolved" }))
    await q.runValidation(resolved.id)
    q.reject(resolved.id, "reviewer@example.test", "not needed")

    const next = q.submit(correction({ id: "next" }))
    expect(q.get(resolved.id)).toBeUndefined()
    expect(q.get(next.id)?.id).toBe("next")
  })

  it("refuses to submit when the queue is full of non-terminal candidates rather than evicting one", () => {
    const q = new CorrectionReviewQueue(
      () => [],
      () => [],
      () => Promise.resolve({ memoryId: "new-id" }),
      passingGate,
      1,
    )
    q.submit(correction({ id: "active" }))
    expect(() => q.submit(correction({ id: "overflow" }))).toThrow(/queue is full/)
  })

  it("computes the impacted-record closure for a retire mutation via #24 dependency references", async () => {
    const older = position({
      id: "position.older",
      review: { reviewedAt: "2020-01-01T00:00:00.000Z", expiresAt: null },
    })
    const newer = position({
      id: "position.newer",
      review: { reviewedAt: "2026-01-01T00:00:00.000Z", expiresAt: null },
    })
    const dependent = position({
      id: "position.dependent",
      dependsOnPositionIds: [older.id],
    })
    const q = new CorrectionReviewQueue(
      () => [older, newer, dependent],
      () => [positionWrite(older), positionWrite(newer), positionWrite(dependent)],
      () => Promise.resolve({ memoryId: "new-id" }),
      passingGate,
    )
    const candidate = q.submit(correction({ disputedMemoryIds: [older.id, newer.id] }))
    const result = await q.runValidation(candidate.id)
    expect(result.mutation?.kind).toBe("retire")
    expect(result.impactedMemoryIds).toEqual([dependent.id])
  })
})

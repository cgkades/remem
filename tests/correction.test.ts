import { describe, expect, it } from "vitest"
import {
  CorrectionReviewQueue,
  InMemoryCorrectionCandidateStore,
  applyMutationToInstitutionalSet,
  diagnoseCorrection,
  proposeCandidateMutation,
  validateCandidateStructure,
  type ApplyMutation,
  type CandidateMutation,
  type CorrectionCandidateStore,
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
    prompt: "Can we skip the rollback plan for this hotfix?",
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

  it("classifies ambiguous when only some disputed ids resolve to existing records", () => {
    const record = position()
    const result = diagnoseCorrection(
      correction({ disputedMemoryIds: [record.id, "missing.id"] }),
      [record],
    )
    expect(result.rootCause).toBe("ambiguous")
    expect(result.reason).toContain("missing.id")
    expect(result.affectedMemoryIds).toEqual([record.id])
  })

  it("classifies stale_position when multiple disputed records expired but do not share an identical scope", () => {
    const a = position({
      id: "position.a",
      review: { reviewedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-06-01T00:00:00.000Z" },
      applicability: {
        match: "all",
        conditions: [{ id: "project", kind: "context", field: "projectId", value: "phoenix" }],
      },
    })
    const b = position({
      id: "position.b",
      review: { reviewedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-06-01T00:00:00.000Z" },
      applicability: {
        match: "all",
        conditions: [{ id: "topic", kind: "topic", value: "unrelated" }],
      },
    })
    const result = diagnoseCorrection(correction({ disputedMemoryIds: [a.id, b.id] }), [a, b])
    expect(result.rootCause).toBe("stale_position")
    expect(result.affectedMemoryIds.sort()).toEqual([a.id, b.id].sort())
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

  it("proposes no mutation when a stale_position diagnosis's affected id no longer resolves to a record", () => {
    const diagnosis = {
      rootCause: "stale_position" as const,
      reason: "expired",
      affectedMemoryIds: ["position.missing"],
    }
    const mutation = proposeCandidateMutation(correction(), diagnosis, [])
    expect(mutation).toBeUndefined()
  })

  it("proposes no mutation when a duplicate_conflict diagnosis resolves to fewer than two records", () => {
    const only = position({ id: "position.only" })
    const diagnosis = {
      rootCause: "duplicate_conflict" as const,
      reason: "conflict",
      affectedMemoryIds: [only.id],
    }
    const mutation = proposeCandidateMutation(correction(), diagnosis, [only])
    expect(mutation).toBeUndefined()
  })

  it("proposes a route_adjustment with no target when a procedure_fault diagnosis has no affected memory id", () => {
    const diagnosis = {
      rootCause: "procedure_fault" as const,
      reason: "excluded",
      affectedMemoryIds: [],
    }
    const mutation = proposeCandidateMutation(correction(), diagnosis, [])
    expect(mutation?.kind).toBe("route_adjustment")
    if (mutation?.kind !== "route_adjustment") throw new Error("expected a route_adjustment")
    expect(mutation.targetMemoryId).toBeUndefined()
  })

  it("proposes a route_adjustment with a target when a procedure_fault diagnosis has an affected memory id", () => {
    const record = position()
    const diagnosis = {
      rootCause: "procedure_fault" as const,
      reason: "excluded",
      affectedMemoryIds: [record.id],
    }
    const mutation = proposeCandidateMutation(correction(), diagnosis, [record])
    expect(mutation?.kind).toBe("route_adjustment")
    if (mutation?.kind !== "route_adjustment") throw new Error("expected a route_adjustment")
    expect(mutation.targetMemoryId).toBe(record.id)
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

  it("always accepts a route_adjustment mutation -- it changes no memory content", () => {
    const mutation = { kind: "route_adjustment" as const, note: "fix the gate" }
    const result = validateCandidateStructure(mutation, correction(), [])
    expect(result).toEqual({ valid: true, issues: [] })
  })
})

describe("applyMutationToInstitutionalSet", () => {
  it("leaves the institutional set unchanged for a route_adjustment mutation", () => {
    const record = position()
    const existing = [positionWrite(record)]
    const mutation = { kind: "route_adjustment" as const, note: "fix the gate" }
    expect(applyMutationToInstitutionalSet(mutation, existing)).toBe(existing)
  })

  it("throws for an unrecognized mutation kind instead of silently ignoring it", () => {
    const malformed = { kind: "delete_forever", note: "n/a" } as unknown as CandidateMutation
    expect(() => applyMutationToInstitutionalSet(malformed, [])).toThrow(
      /unknown correction mutation kind/,
    )
  })
})

const passingGate: ReplayGate = {
  run: () => Promise.resolve({ passed: true, caseIds: ["case-1"], failures: [] }),
}
const failingGate: ReplayGate = {
  run: () =>
    Promise.resolve({ passed: false, caseIds: ["case-1"], failures: ["outcome mismatch"] }),
}

function recordingApplyMutation(): { applyMutation: ApplyMutation; applied: unknown[] } {
  const applied: unknown[] = []
  const applyMutation: ApplyMutation = (mutation) => {
    applied.push(mutation)
    const memoryId = "targetMemoryId" in mutation ? mutation.targetMemoryId : undefined
    return Promise.resolve({ memoryId: memoryId ?? "new-memory-id" })
  }
  return { applyMutation, applied }
}

function queue(
  replayGate: ReplayGate,
  existing: InstitutionalPosition[] = [],
  maxCandidates?: number,
) {
  const store = new InMemoryCorrectionCandidateStore(maxCandidates)
  const { applyMutation, applied } = recordingApplyMutation()
  const q = new CorrectionReviewQueue(
    store,
    () => existing,
    () => existing.map(positionWrite),
    applyMutation,
    replayGate,
  )
  return { q, store, applied }
}

describe("CorrectionReviewQueue", () => {
  it("accepted: validates and approves a knowledge-gap candidate end to end", async () => {
    const { q, applied } = queue(passingGate)
    const candidate = await q.submit(correction())
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
    const candidate = await q.submit(correction())
    await q.runValidation(candidate.id)
    const rejected = await q.reject(candidate.id, "reviewer@example.test", "not needed")
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
    const candidate = await q.submit(
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
    const candidate = await q.submit(
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
      new InMemoryCorrectionCandidateStore(),
      () => [record, referencedPosition],
      () => [procedureWrite(record), positionWrite(referencedPosition)],
      (mutation) =>
        Promise.resolve({
          memoryId: "targetMemoryId" in mutation ? (mutation.targetMemoryId ?? "new-id") : "new-id",
        }),
      passingGate,
    )
    const candidate = await q.submit(
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
    const candidate = await q.submit(correction({ disputedMemoryIds: [older.id, newer.id] }))
    const result = await q.runValidation(candidate.id)
    expect(result.rootCause).toBe("duplicate_conflict")
    expect(result.mutation?.kind).toBe("retire")
    if (result.mutation?.kind !== "retire") throw new Error("expected a retire mutation")
    expect(result.mutation.targetMemoryId).toBe(older.id)
    expect(result.state).toBe("validated")
  })

  it("replay-failed: a failing replay gate blocks approval", async () => {
    const { q } = queue(failingGate)
    const candidate = await q.submit(correction())
    const result = await q.runValidation(candidate.id)
    expect(result.state).toBe("needs_changes")
    expect(result.replay?.passed).toBe(false)
    await expect(q.approve(candidate.id, "reviewer@example.test")).rejects.toThrow()
  })

  it("ambiguous: an unresolved ambiguity is queued for a human decision without a mutation", async () => {
    const { q } = queue(passingGate)
    const candidate = await q.submit(correction({ disputedMemoryIds: ["missing.id"] }))
    const result = await q.runValidation(candidate.id)
    expect(result.rootCause).toBe("ambiguous")
    expect(result.mutation).toBeUndefined()
    expect(result.state).toBe("needs_changes")
    await expect(q.approve(candidate.id, "reviewer@example.test")).rejects.toThrow()
  })

  it("a decision made while validation is still awaiting the replay gate wins, and the stale validation aborts", async () => {
    let resolveGate: (() => void) | undefined
    const blockingGate: ReplayGate = {
      run: () =>
        new Promise((resolve) => {
          resolveGate = () => resolve({ passed: true, caseIds: [], failures: [] })
        }),
    }
    const { q } = queue(blockingGate)
    const candidate = await q.submit(correction())
    const validation = q.runValidation(candidate.id)
    // Wait until validation has actually reached the (blocking) replay gate
    // before deciding, so this exercises the intended race rather than
    // racing reject() against runValidation's own pre-replay bookkeeping.
    while (!resolveGate) await Promise.resolve()
    const rejected = await q.reject(candidate.id, "reviewer@example.test", "too fast")
    expect(rejected.state).toBe("rejected")
    resolveGate()
    // The in-flight validation must not clobber the rejection once the
    // gate finally resolves; it aborts because the row changed underneath
    // it (assertNotModifiedConcurrently fires before the terminal-state
    // check even gets a chance to name "rejected" specifically).
    await expect(validation).rejects.toThrow(/modified concurrently/)
    const stored = await q.get(candidate.id)
    expect(stored?.state).toBe("rejected")
  })

  it("requestChanges made while validation is still awaiting the replay gate wins, even though needs_changes is not a locked state", async () => {
    let resolveGate: (() => void) | undefined
    const blockingGate: ReplayGate = {
      run: () =>
        new Promise((resolve) => {
          resolveGate = () => resolve({ passed: true, caseIds: [], failures: [] })
        }),
    }
    const { q } = queue(blockingGate)
    const candidate = await q.submit(correction())
    const validation = q.runValidation(candidate.id)
    // Wait until validation has actually reached the (blocking) replay gate,
    // so this exercises the race against the finalize write, not against
    // runValidation's own pre-replay bookkeeping.
    while (!resolveGate) await Promise.resolve()
    const changed = await q.requestChanges(candidate.id, "reviewer@example.test", "too fast")
    expect(changed.state).toBe("needs_changes")
    resolveGate()
    // needs_changes is a legitimate state to start revalidation from (that's
    // how a fixed-up correction gets re-checked), so assertTransitionAllowed
    // alone would let the stale finalize proceed and silently overwrite the
    // reviewer's decision. It must instead abort because the row changed
    // since this computation started.
    await expect(validation).rejects.toThrow(/modified concurrently/)
    const stored = await q.get(candidate.id)
    expect(stored?.state).toBe("needs_changes")
    expect(stored?.reviewerDecision?.decision).toBe("changes_requested")
    expect(stored?.reviewerDecision?.reason).toBe("too fast")
  })

  it("requestChanges made while an ambiguous diagnosis is still loading institutional memory also wins", async () => {
    let resolveLoad: (() => void) | undefined
    const store = new InMemoryCorrectionCandidateStore()
    const q = new CorrectionReviewQueue(
      store,
      () =>
        new Promise((resolve) => {
          resolveLoad = () => resolve([])
        }),
      () => [],
      () => Promise.resolve({ memoryId: "new-memory-id" }),
      passingGate,
    )
    const candidate = await q.submit(correction({ disputedMemoryIds: ["missing.id"] }))
    const validation = q.runValidation(candidate.id)
    while (!resolveLoad) await Promise.resolve()
    const changed = await q.requestChanges(candidate.id, "reviewer@example.test", "too fast")
    expect(changed.state).toBe("needs_changes")
    resolveLoad()
    await expect(validation).rejects.toThrow(/modified concurrently/)
    const stored = await store.get(candidate.id)
    expect(stored?.reviewerDecision?.reason).toBe("too fast")
  })

  it("requestChanges preserves the candidate and audit trail without mutating memory", async () => {
    const { q, applied } = queue(passingGate)
    const candidate = await q.submit(correction())
    await q.runValidation(candidate.id)
    const changed = await q.requestChanges(
      candidate.id,
      "reviewer@example.test",
      "need more evidence",
    )
    expect(changed.state).toBe("needs_changes")
    expect(applied).toHaveLength(0)
    expect(changed.reviewerDecision?.decision).toBe("changes_requested")
  })

  it("leaves the candidate in a retryable state and records no false approval when applyMutation fails", async () => {
    const q = new CorrectionReviewQueue(
      new InMemoryCorrectionCandidateStore(),
      () => [],
      () => [],
      () => Promise.reject(new Error("database unavailable")),
      passingGate,
    )
    const candidate = await q.submit(correction())
    const validated = await q.runValidation(candidate.id)
    await expect(q.approve(candidate.id, "reviewer@example.test")).rejects.toThrow(
      "database unavailable",
    )
    const stored = await q.get(candidate.id)
    expect(stored?.state).toBe("validated")
    expect(stored?.reviewerDecision).toBeUndefined()
    expect(stored?.audit.some((entry) => entry.event === "approved")).toBe(false)
    // Reverting from "applying" back to "validated" is still a write and
    // must still bump revision, even though it isn't its own audit entry --
    // otherwise a concurrent runValidation snapshotting "before" the claim
    // could pass assertNotModifiedConcurrently against a candidate that
    // actually changed twice (validated -> applying -> validated) in between.
    // Two writes happened: the "applying" claim, then the revert.
    expect(stored?.revision).toBe(validated.revision + 2)
  })

  it("does not revert to validated when applyMutation succeeds but finalizing the approval fails, to avoid a double-apply on retry", async () => {
    const inner = new InMemoryCorrectionCandidateStore()
    let updateCalls = 0
    const store: CorrectionCandidateStore = {
      insert: (candidate) => inner.insert(candidate),
      get: (id) => inner.get(id),
      list: (filter) => inner.list(filter),
      update: (id, mutate) => {
        updateCalls += 1
        // Call order for this test: (1) runValidation's finalize to
        // "validated", (2) approve()'s atomic claim to "applying", (3)
        // approve()'s finalize to "applied" -- which is the one we fail.
        if (updateCalls === 3) return Promise.reject(new Error("store unavailable"))
        return inner.update(id, mutate)
      },
    }
    const q = new CorrectionReviewQueue(
      store,
      () => [],
      () => [],
      () => Promise.resolve({ memoryId: "new-memory-id" }),
      passingGate,
    )
    const candidate = await q.submit(correction())
    await q.runValidation(candidate.id)
    await expect(q.approve(candidate.id, "reviewer@example.test")).rejects.toThrow(
      /mutation applied as memory new-memory-id but recording the approval failed/,
    )
    const stored = await inner.get(candidate.id)
    expect(stored?.state).toBe("applying")
    expect(stored?.appliedMemoryId).toBeUndefined()
  })

  it("recoverStuckApplying resolves a stuck candidate to validated or applied", async () => {
    const inner = new InMemoryCorrectionCandidateStore()
    const store: CorrectionCandidateStore = {
      insert: (candidate) => inner.insert(candidate),
      get: (id) => inner.get(id),
      list: (filter) => inner.list(filter),
      update: (id, mutate) => inner.update(id, mutate),
    }
    const q = new CorrectionReviewQueue(
      store,
      () => [],
      () => [],
      () => Promise.resolve({ memoryId: "new-memory-id" }),
      passingGate,
    )
    const submitted = await q.submit(correction())
    await q.runValidation(submitted.id)
    // Force the candidate into "applying" directly on the underlying store,
    // simulating a crash between approve()'s claim and its finalize step.
    await inner.update(submitted.id, (candidate) => ({ ...candidate, state: "applying" }))

    await expect(q.approve(submitted.id, "reviewer@example.test")).rejects.toThrow(
      /cannot be approved from state "applying"/,
    )

    const recoveredToValidated = await q.recoverStuckApplying(
      submitted.id,
      "operator@example.test",
      "validated",
      "confirmed via provider logs that the write never landed",
    )
    expect(recoveredToValidated.state).toBe("validated")
    const reApproved = await q.approve(submitted.id, "reviewer@example.test")
    expect(reApproved.state).toBe("applied")
  })

  it("recoverStuckApplying records a confirmed-applied outcome without re-invoking applyMutation", async () => {
    const { applyMutation, applied } = recordingApplyMutation()
    const inner = new InMemoryCorrectionCandidateStore()
    const store: CorrectionCandidateStore = {
      insert: (candidate) => inner.insert(candidate),
      get: (id) => inner.get(id),
      list: (filter) => inner.list(filter),
      update: (id, mutate) => inner.update(id, mutate),
    }
    const q = new CorrectionReviewQueue(
      store,
      () => [],
      () => [],
      applyMutation,
      passingGate,
    )
    const submitted = await q.submit(correction())
    await q.runValidation(submitted.id)
    await inner.update(submitted.id, (candidate) => ({ ...candidate, state: "applying" }))

    const recovered = await q.recoverStuckApplying(
      submitted.id,
      "operator@example.test",
      "applied",
      "confirmed via provider logs that the write landed as memory-123",
      "memory-123",
    )
    expect(recovered.state).toBe("applied")
    expect(recovered.appliedMemoryId).toBe("memory-123")
    expect(applied).toHaveLength(0)
  })

  it("recoverStuckApplying refuses to act on a candidate that is not stuck", async () => {
    const { q } = queue(passingGate)
    const candidate = await q.submit(correction())
    await expect(
      q.recoverStuckApplying(candidate.id, "operator@example.test", "validated", "not stuck"),
    ).rejects.toThrow(/not "applying"; there is nothing to recover/)
  })

  it("recoverStuckApplying requires appliedMemoryId when recording outcome 'applied'", async () => {
    const inner = new InMemoryCorrectionCandidateStore()
    const store: CorrectionCandidateStore = {
      insert: (candidate) => inner.insert(candidate),
      get: (id) => inner.get(id),
      list: (filter) => inner.list(filter),
      update: (id, mutate) => inner.update(id, mutate),
    }
    const q = new CorrectionReviewQueue(
      store,
      () => [],
      () => [],
      () => Promise.resolve({ memoryId: "new-memory-id" }),
      passingGate,
    )
    const submitted = await q.submit(correction())
    await q.runValidation(submitted.id)
    await inner.update(submitted.id, (candidate) => ({ ...candidate, state: "applying" }))

    await expect(
      q.recoverStuckApplying(
        submitted.id,
        "operator@example.test",
        "applied",
        "confirmed via provider logs that the write landed",
      ),
    ).rejects.toThrow(/requires appliedMemoryId when outcome is "applied"/)
    // The state must be left untouched by the rejected call.
    expect((await inner.get(submitted.id))?.state).toBe("applying")
  })

  it("approve's finalize step refuses to overwrite a candidate recovered concurrently while the mutation was applying", async () => {
    const inner = new InMemoryCorrectionCandidateStore()
    let releaseApply: (() => void) | undefined
    const applyGate = new Promise<void>((resolve) => {
      releaseApply = resolve
    })
    const store: CorrectionCandidateStore = {
      insert: (candidate) => inner.insert(candidate),
      get: (id) => inner.get(id),
      list: (filter) => inner.list(filter),
      update: (id, mutate) => inner.update(id, mutate),
    }
    const q = new CorrectionReviewQueue(
      store,
      () => [],
      () => [],
      async () => {
        await applyGate
        return { memoryId: "new-memory-id" }
      },
      passingGate,
    )
    const submitted = await q.submit(correction())
    await q.runValidation(submitted.id)

    const approvePromise = q.approve(submitted.id, "reviewer@example.test")
    // Simulate an operator concurrently recovering the candidate (e.g. after
    // an operational timeout) while approve()'s applyMutation is still in
    // flight, moving it out of "applying" before approve() can finalize.
    await inner.update(submitted.id, (candidate) => ({ ...candidate, state: "validated" }))
    releaseApply?.()

    await expect(approvePromise).rejects.toThrow(/is in state "validated", not "applying"/)
    expect((await inner.get(submitted.id))?.state).toBe("validated")
  })

  it("returns defensive copies so callers cannot mutate queue-internal state", async () => {
    const { q } = queue(passingGate)
    const candidate = await q.submit(correction())
    candidate.state = "applied"
    candidate.audit.length = 0
    candidate.correction.actor = "attacker"
    const stored = await q.get(candidate.id)
    expect(stored?.state).toBe("pending_validation")
    expect(stored?.audit).toHaveLength(1)
    expect(stored?.correction.actor).toBe("reviewer@example.test")
  })

  it("bumps revision on every touch, distinct from updatedAt", async () => {
    const { q } = queue(passingGate)
    const submitted = await q.submit(correction())
    expect(submitted.revision).toBe(1)
    const validated = await q.runValidation(submitted.id)
    expect(validated.revision).toBeGreaterThan(submitted.revision)
    const approved = await q.approve(submitted.id, "reviewer@example.test")
    expect(approved.revision).toBeGreaterThan(validated.revision)
  })

  it("clones the correction on ingestion so mutating the caller's original object after submit has no effect", async () => {
    const { q } = queue(passingGate)
    const original = correction()
    const candidate = await q.submit(original)
    original.actor = "attacker"
    original.correctionText = "attacker-controlled text"
    original.expectedOutcome = "attacker-controlled outcome"
    original.disputedMemoryIds = ["some.other.id"]

    const stored = await q.get(candidate.id)
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

  it("runValidation rejects an unknown candidate id", async () => {
    const { q } = queue(passingGate)
    await expect(q.runValidation("does-not-exist")).rejects.toThrow(
      /unknown correction candidate: does-not-exist/,
    )
  })

  it("approve rejects an unknown candidate id", async () => {
    const { q } = queue(passingGate)
    await expect(q.approve("does-not-exist", "reviewer@example.test")).rejects.toThrow(
      /unknown correction candidate: does-not-exist/,
    )
  })

  it("list filters candidates by state", async () => {
    const { q } = queue(passingGate)
    const pending = await q.submit(correction({ id: "pending-1" }))
    const validated = await q.submit(correction({ id: "validated-1" }))
    await q.runValidation(validated.id)

    expect((await q.list({ state: "pending_validation" })).map((c) => c.id)).toEqual([pending.id])
    expect((await q.list({ state: "validated" })).map((c) => c.id)).toEqual([validated.id])
    expect((await q.list()).map((c) => c.id).sort()).toEqual([pending.id, validated.id].sort())
  })

  it("rejects a duplicate candidate id instead of silently overwriting the existing candidate", async () => {
    const { q } = queue(passingGate)
    const first = await q.submit(correction({ id: "fixed-id" }))
    await expect(q.submit(correction({ id: "fixed-id" }))).rejects.toThrow(/already exists/)
    expect((await q.get(first.id))?.audit).toHaveLength(1)
  })

  it("rejects oversized correctionText/expectedOutcome/actor before persisting, regardless of caller (tool schema is not the only enforcement point)", async () => {
    const { q } = queue(passingGate)
    await expect(q.submit(correction({ correctionText: "x".repeat(8_001) }))).rejects.toThrow(
      /correctionText must be at most 8000 characters/,
    )
    await expect(q.submit(correction({ expectedOutcome: "x".repeat(8_001) }))).rejects.toThrow(
      /expectedOutcome must be at most 8000 characters/,
    )
    await expect(q.submit(correction({ actor: "x".repeat(256) }))).rejects.toThrow(
      /actor must be at most 255 characters/,
    )
  })

  it("rejects too many or too-long disputedMemoryIds", async () => {
    const { q } = queue(passingGate)
    await expect(
      q.submit(correction({ disputedMemoryIds: Array.from({ length: 101 }, (_, i) => `id-${i}`) })),
    ).rejects.toThrow(/disputedMemoryIds must have at most 100 entries/)
    await expect(q.submit(correction({ disputedMemoryIds: ["x".repeat(513)] }))).rejects.toThrow(
      /each correction.disputedMemoryIds entry must be at most 512 characters/,
    )
  })

  it("rejects too many or too-long evidence entries", async () => {
    const { q } = queue(passingGate)
    await expect(
      q.submit(correction({ evidence: Array.from({ length: 101 }, (_, i) => `e-${i}`) })),
    ).rejects.toThrow(/evidence must have at most 100 entries/)
    await expect(q.submit(correction({ evidence: ["x".repeat(2_001)] }))).rejects.toThrow(
      /each correction.evidence entry must be at most 2000 characters/,
    )
  })

  it("rejects an oversized prompt before persisting", async () => {
    const { q } = queue(passingGate)
    await expect(q.submit(correction({ prompt: "x".repeat(8_001) }))).rejects.toThrow(
      /prompt must be at most 8000 characters/,
    )
  })

  it("accepts correctionText/expectedOutcome/actor/prompt/disputedMemoryIds/evidence exactly at their bounds", async () => {
    const { q } = queue(passingGate)
    const candidate = await q.submit(
      correction({
        correctionText: "x".repeat(8_000),
        expectedOutcome: "x".repeat(8_000),
        actor: "x".repeat(255),
        prompt: "x".repeat(8_000),
        disputedMemoryIds: Array.from({ length: 100 }, () => "x".repeat(512)),
        evidence: Array.from({ length: 100 }, () => "x".repeat(2_000)),
      }),
    )
    expect(candidate.correction.correctionText).toHaveLength(8_000)
    expect(candidate.correction.expectedOutcome).toHaveLength(8_000)
    expect(candidate.correction.actor).toHaveLength(255)
    expect(candidate.correction.prompt).toHaveLength(8_000)
    expect(candidate.correction.disputedMemoryIds).toHaveLength(100)
    expect(candidate.correction.evidence).toHaveLength(100)
  })

  it("terminal states reject further transitions: revalidate, reject, and requestChanges after apply", async () => {
    const { q } = queue(passingGate)
    const candidate = await q.submit(correction())
    await q.runValidation(candidate.id)
    const applied = await q.approve(candidate.id, "reviewer@example.test")
    expect(applied.state).toBe("applied")

    await expect(q.runValidation(candidate.id)).rejects.toThrow(/state "applied"/)
    await expect(q.reject(candidate.id, "reviewer@example.test", "too late")).rejects.toThrow(
      /state "applied"/,
    )
    await expect(
      q.requestChanges(candidate.id, "reviewer@example.test", "too late"),
    ).rejects.toThrow(/state "applied"/)

    // A second approve attempt must also fail, since state never left "applied".
    await expect(q.approve(candidate.id, "reviewer@example.test")).rejects.toThrow(
      /cannot be approved from state "applied"/,
    )
  })

  it("a rejected candidate cannot be reopened via reject, requestChanges, or revalidation", async () => {
    const { q } = queue(passingGate)
    const candidate = await q.submit(correction())
    await q.runValidation(candidate.id)
    await q.reject(candidate.id, "reviewer@example.test", "not needed")

    await expect(q.reject(candidate.id, "reviewer@example.test", "again")).rejects.toThrow(
      /state "rejected"/,
    )
    await expect(q.requestChanges(candidate.id, "reviewer@example.test", "reopen")).rejects.toThrow(
      /state "rejected"/,
    )
    await expect(q.runValidation(candidate.id)).rejects.toThrow(/state "rejected"/)
  })

  it("evicts only resolved (terminal) candidates when at capacity, never one under active review", async () => {
    const { q } = queue(passingGate, [], 1)
    const resolved = await q.submit(correction({ id: "resolved" }))
    await q.runValidation(resolved.id)
    await q.reject(resolved.id, "reviewer@example.test", "not needed")

    const next = await q.submit(correction({ id: "next" }))
    expect(await q.get(resolved.id)).toBeUndefined()
    expect((await q.get(next.id))?.id).toBe("next")
  })

  it("refuses to submit when the queue is full of non-terminal candidates rather than evicting one", async () => {
    const { q } = queue(passingGate, [], 1)
    await q.submit(correction({ id: "active" }))
    await expect(q.submit(correction({ id: "overflow" }))).rejects.toThrow(/queue is full/)
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
      new InMemoryCorrectionCandidateStore(),
      () => [older, newer, dependent],
      () => [positionWrite(older), positionWrite(newer), positionWrite(dependent)],
      () => Promise.resolve({ memoryId: "new-id" }),
      passingGate,
    )
    const candidate = await q.submit(correction({ disputedMemoryIds: [older.id, newer.id] }))
    const result = await q.runValidation(candidate.id)
    expect(result.mutation?.kind).toBe("retire")
    expect(result.impactedMemoryIds).toEqual([dependent.id])
  })
})

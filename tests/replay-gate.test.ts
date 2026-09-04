import { describe, expect, it } from "vitest"
import type { CorrectionCandidate, CorrectionInput } from "../src/correction.js"
import { TargetedReplayGate } from "../src/replay-gate.js"
import type { InstitutionalPosition } from "../src/types.js"
import type { MemoryContext, MemoryTrace, MemoryWrite } from "../src/types.js"
import { testConfig } from "./helpers.js"

const context: MemoryContext = {
  directory: "/repo",
  worktree: "/repo",
  projectId: "phoenix",
  sessionId: "session-1",
}

const trace: MemoryTrace = {
  sessionId: "session-1",
  prompt: "Can we skip the rollback plan requirement for this hotfix?",
  timestamp: "2026-09-04T00:00:00.000Z",
  catalogEntries: 0,
  catalogMatches: [],
  shouldRetrieve: false,
  confidence: 0,
  topics: [],
  signals: [],
  providers: [],
  rawResults: 0,
  deduplicatedResults: 0,
  selectedResults: 0,
  catalogTokens: 0,
  recallTokens: 0,
  totalDurationMs: 0,
  diagnostics: [],
}

function position(): InstitutionalPosition {
  return {
    role: "position",
    id: "position.rollback-requirement",
    owner: "release-engineering",
    sourceRefs: ["policy://release/rollback-position"],
    boundaryConditions: ["Production changes only."],
    applicability: {
      match: "all",
      conditions: [{ id: "project", kind: "context", field: "projectId", value: "phoenix" }],
    },
    review: { reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2027-09-01T00:00:00.000Z" },
  }
}

function candidate(overrides: Partial<CorrectionCandidate> = {}): CorrectionCandidate {
  const correction: CorrectionInput = {
    sessionId: "session-1",
    prompt: "Can we skip the rollback plan requirement for this hotfix?",
    correctionText: "Rollback plans are required for production.",
    expectedOutcome: "rollback plan requirement",
    actor: "reviewer@example.test",
    context,
    trace,
  }
  const now = new Date().toISOString()
  return {
    id: "candidate-1",
    state: "validated",
    correction,
    affectedMemoryIds: [],
    audit: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function proposedWrite(): MemoryWrite {
  return {
    title: "rollback plan requirement",
    content: "Production rollouts require an approved rollback plan.",
    scope: { kind: "project", id: "phoenix" },
    type: "decision",
    institutional: position(),
  }
}

const config = testConfig()

describe("TargetedReplayGate", () => {
  it("passes when the created content now surfaces for the correction's own prompt", async () => {
    const gate = new TargetedReplayGate(
      config,
      () => [],
      () => Promise.resolve([]),
    )
    const result = await gate.run(
      candidate({ mutation: { kind: "create", proposed: proposedWrite() } }),
    )
    expect(result.passed).toBe(true)
    expect(result.caseIds).toEqual(["candidate-1"])
    expect(result.failures).toEqual([])
  })

  it("fails when the mutation does not make the expected outcome surface for the prompt", async () => {
    const gate = new TargetedReplayGate(
      config,
      () => [],
      () => Promise.resolve([]),
    )
    const unrelated = candidate({
      mutation: {
        kind: "create",
        proposed: {
          title: "unrelated topic",
          content: "Nothing about rollbacks here.",
          scope: { kind: "project", id: "phoenix" },
          type: "decision",
        },
      },
    })
    const result = await gate.run(unrelated)
    expect(result.passed).toBe(false)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toContain("candidate-1")
  })

  it("returns a failure without running anything when the candidate has no mutation", async () => {
    const gate = new TargetedReplayGate(
      config,
      () => [],
      () => Promise.resolve([]),
    )
    const result = await gate.run(candidate())
    expect(result.passed).toBe(false)
    expect(result.failures).toEqual(["no mutation to replay"])
  })

  it("also replays every prior applied candidate's own scenario as a regression check", async () => {
    const priorApplied = candidate({
      id: "prior-applied",
      state: "applied",
      correction: {
        ...candidate().correction,
        prompt: "What's the rollback plan requirement for hotfixes?",
        expectedOutcome: "rollback plan requirement",
      },
    })
    const gate = new TargetedReplayGate(
      config,
      () => [],
      () => Promise.resolve([priorApplied]),
    )
    const result = await gate.run(
      candidate({ mutation: { kind: "create", proposed: proposedWrite() } }),
    )
    expect(result.passed).toBe(true)
    expect(result.caseIds).toEqual(["candidate-1", "prior-applied"])
  })

  it("loads each regression scenario's own corpus, so a prior candidate in a different project is unaffected by this candidate's mutation and evaluated against its own institutional memory", async () => {
    const mercuryContext: MemoryContext = {
      directory: "/repo-mercury",
      worktree: "/repo-mercury",
      projectId: "mercury",
      sessionId: "session-mercury",
    }
    const mercuryRecord: MemoryWrite = {
      title: "mercury deployment window",
      content: "Mercury deployments only run during the Tuesday maintenance window.",
      scope: { kind: "project", id: "mercury" },
      type: "decision",
    }
    // Context-aware loader: each project has its own, disjoint corpus. The
    // old (buggy) implementation loaded this once using the candidate's own
    // (phoenix) context and reused it for every scenario, so the mercury
    // scenario would never see mercuryRecord at all.
    const loadInstitutionalWrites = (ctx: MemoryContext) =>
      ctx.projectId === "mercury" ? [mercuryRecord] : []

    const priorAppliedInMercury = candidate({
      id: "prior-applied-mercury",
      state: "applied",
      correction: {
        ...candidate().correction,
        context: mercuryContext,
        prompt: "What's the mercury deployment window?",
        expectedOutcome: "Tuesday maintenance window",
      },
    })
    const gate = new TargetedReplayGate(config, loadInstitutionalWrites, () =>
      Promise.resolve([priorAppliedInMercury]),
    )
    const result = await gate.run(
      candidate({ mutation: { kind: "create", proposed: proposedWrite() } }),
    )
    expect(result.passed).toBe(true)
    expect(result.caseIds).toEqual(["candidate-1", "prior-applied-mercury"])
  })
})

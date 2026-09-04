import { describe, expect, it } from "vitest"
import { institutionalApplies, validateInstitutionalMemories } from "../src/institutional.js"
import type {
  ApplicabilityCondition,
  InstitutionalPosition,
  InstitutionalProcedure,
  MemoryContext,
  MemoryWrite,
} from "../src/types.js"

const asOf = new Date("2026-09-03T12:00:00.000Z")
const scope = { kind: "project" as const, id: "remem" }

function positionMetadata(): InstitutionalPosition {
  return {
    role: "position",
    id: "position.production-rollback",
    owner: "release-engineering",
    sourceRefs: ["change-policy-v3"],
    boundaryConditions: ["Emergency remediation may use an approved break-glass procedure."],
    applicability: {
      match: "all",
      conditions: [{ id: "project", kind: "context", field: "projectId", value: "remem" }],
    },
    review: { reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2027-09-01T00:00:00.000Z" },
  }
}

function position(overrides: Partial<MemoryWrite> = {}): MemoryWrite {
  return {
    type: "decision",
    title: "Production changes require a rollback plan",
    content: "Every production change needs a tested rollback plan.",
    scope,
    provenance: [
      {
        source: { kind: "document", uri: "https://example.test/change-policy" },
        capturedAt: "2026-09-01T00:00:00.000Z",
        original: true,
      },
    ],
    institutional: positionMetadata(),
    ...overrides,
  }
}

function procedureMetadata(): InstitutionalProcedure {
  const steps = [
    { id: "draft", instruction: "Draft the rollout and rollback plan." },
    { id: "review", instruction: "Collect the required approval evidence." },
  ]
  return {
    role: "procedure",
    id: "procedure.production-change",
    steps,
    positionIds: ["position.production-rollback"],
    requiredEvidence: ["Approved rollout plan"],
    completionCriteria: ["Rollback plan is tested."],
    escalationConditions: ["Escalate when rollback cannot be tested."],
    applicability: {
      match: "all",
      conditions: [{ id: "project", kind: "context", field: "projectId", value: "remem" }],
    },
    review: { reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: null },
  }
}

function procedure(overrides: Partial<MemoryWrite> = {}): MemoryWrite {
  return {
    type: "procedure",
    title: "Prepare a production change",
    content: "1. Draft the rollout and rollback plan.\n2. Collect the required approval evidence.",
    scope,
    institutional: procedureMetadata(),
    ...overrides,
  }
}

describe("institutional memory validation", () => {
  it("accepts complete curated positions and fact-free procedures", () => {
    expect(validateInstitutionalMemories([position(), procedure()], { asOf })).toEqual({
      valid: true,
      issues: [],
    })
  })

  it("rejects malformed curated metadata instead of treating it as generic memory", () => {
    const incomplete = position({
      provenance: [],
      institutional: {
        ...positionMetadata(),
        owner: "",
        authority: "",
        sourceRefs: [],
        boundaryConditions: [],
        applicability: { match: "all", conditions: [] },
      },
    })

    expect(
      validateInstitutionalMemories([incomplete], { asOf }).issues.map(({ code }) => code),
    ).toEqual(
      expect.arrayContaining([
        "missing_authority",
        "missing_provenance",
        "missing_source_ref",
        "invalid_applicability",
        "invalid_position",
      ]),
    )
  })

  it("rejects duplicate IDs, unresolved references, and dependency cycles", () => {
    const dependent = position({
      institutional: {
        ...positionMetadata(),
        id: "position.dependent",
        dependsOnPositionIds: ["position.cycle"],
      },
    })
    const cycle = position({
      institutional: {
        ...positionMetadata(),
        id: "position.cycle",
        dependsOnPositionIds: ["position.dependent"],
      },
    })
    const missing = procedure({
      institutional: { ...procedureMetadata(), positionIds: ["position.unknown"] },
    })
    const duplicate = position()

    expect(
      validateInstitutionalMemories([dependent, cycle, missing, duplicate, position()], {
        asOf,
      }).issues.map(({ code }) => code),
    ).toEqual(expect.arrayContaining(["dependency_cycle", "missing_reference", "duplicate_id"]))
  })

  it("deterministically rejects unreviewed or expired positions and procedures that append position facts", () => {
    const unreviewed = position({
      institutional: {
        ...positionMetadata(),
        review: { reviewedAt: "", expiresAt: null },
      },
    })
    const expired = position({
      institutional: {
        ...positionMetadata(),
        review: { reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-02T00:00:00.000Z" },
      },
    })
    const copiedFacts = procedure({
      content:
        "1. Draft the rollout and rollback plan.\n2. Collect the required approval evidence.\nThe rollback plan is mandatory.",
    })

    const result = validateInstitutionalMemories([unreviewed, expired, copiedFacts, position()], {
      asOf,
    })
    // This is a counterfactual gate: bypassing validation would make both assertions fail.
    expect(result.valid).toBe(false)
    expect(result.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["invalid_review", "expired", "invalid_procedure"]),
    )
  })

  it("leaves existing generic memories outside the curated contract", () => {
    expect(
      validateInstitutionalMemories(
        [
          {
            type: "semantic",
            title: "General project note",
            content: "This remains ordinary memory.",
            scope,
          },
        ],
        { asOf },
      ),
    ).toEqual({ valid: true, issues: [] })
  })
})

const testContext: MemoryContext = {
  directory: "/repo",
  worktree: "/repo",
  projectId: "remem",
  sessionId: "session-1",
}

function topicMemory(
  conditions: ApplicabilityCondition[],
  match: "all" | "any" = "all",
): InstitutionalPosition {
  return {
    role: "position",
    id: "position.topic-gated",
    owner: "release-engineering",
    sourceRefs: ["policy"],
    boundaryConditions: ["Applies only within the matched topic."],
    applicability: { match, conditions },
    review: { reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: null },
  }
}

function topicCondition(value: string): ApplicabilityCondition {
  return { id: "topic", kind: "topic", value }
}

describe("institutionalApplies -- topic condition matching", () => {
  it("matches a single-word topic present in the prompt", () => {
    const memory = topicMemory([topicCondition("rollout")])
    expect(institutionalApplies(memory, testContext, "Can we skip the rollout checklist?")).toBe(
      true,
    )
  })

  it("does not match a single-word topic absent from the prompt", () => {
    const memory = topicMemory([topicCondition("rollout")])
    expect(institutionalApplies(memory, testContext, "Explain a Python list comprehension")).toBe(
      false,
    )
  })

  it("matches a multi-word topic present as a phrase in the prompt", () => {
    const memory = topicMemory([topicCondition("production rollout")])
    expect(
      institutionalApplies(
        memory,
        testContext,
        "Can we skip the production rollout rollback plan?",
      ),
    ).toBe(true)
  })

  it("does not match a multi-word topic when the words are not adjacent, in order", () => {
    const memory = topicMemory([topicCondition("production rollout")])
    expect(
      institutionalApplies(memory, testContext, "The rollout of the production database is done"),
    ).toBe(false)
  })

  it("does not match a multi-word topic split across unrelated sentences", () => {
    const memory = topicMemory([topicCondition("production rollout")])
    expect(
      institutionalApplies(
        memory,
        testContext,
        "We finished the production migration. The rollout is next week.",
      ),
    ).toBe(false)
  })

  it("is case-insensitive", () => {
    const memory = topicMemory([topicCondition("Production Rollout")])
    expect(
      institutionalApplies(memory, testContext, "PRODUCTION ROLLOUT is scheduled for Friday"),
    ).toBe(true)
  })

  it("is punctuation-insensitive", () => {
    const memory = topicMemory([topicCondition("production rollout")])
    expect(institutionalApplies(memory, testContext, "production-rollout: is it approved?")).toBe(
      true,
    )
  })

  it("does not match a topic as a partial word within a longer word", () => {
    const memory = topicMemory([topicCondition("cat")])
    expect(
      institutionalApplies(memory, testContext, "Please categorize this concatenated string"),
    ).toBe(false)
  })

  it("does not match an empty prompt", () => {
    const memory = topicMemory([topicCondition("rollout")])
    expect(institutionalApplies(memory, testContext, "")).toBe(false)
  })

  it("does not match when no prompt is supplied at all", () => {
    const memory = topicMemory([topicCondition("rollout")])
    expect(institutionalApplies(memory, testContext, undefined)).toBe(false)
  })

  it("requires every condition under 'all'", () => {
    const memory = topicMemory(
      [
        topicCondition("production rollout"),
        { id: "project", kind: "context", field: "projectId", value: "remem" },
      ],
      "all",
    )
    expect(institutionalApplies(memory, testContext, "production rollout is scheduled")).toBe(true)
    expect(
      institutionalApplies(
        { ...memory, applicability: memory.applicability },
        { ...testContext, projectId: "other" },
        "production rollout is scheduled",
      ),
    ).toBe(false)
  })

  it("requires only one condition under 'any'", () => {
    const memory = topicMemory(
      [
        topicCondition("production rollout"),
        { id: "project", kind: "context", field: "projectId", value: "remem" },
      ],
      "any",
    )
    // Topic phrase absent, but the context condition matches.
    expect(institutionalApplies(memory, testContext, "unrelated prompt")).toBe(true)
    // Neither condition matches.
    expect(
      institutionalApplies({ ...memory }, { ...testContext, projectId: "other" }, "unrelated"),
    ).toBe(false)
  })
})

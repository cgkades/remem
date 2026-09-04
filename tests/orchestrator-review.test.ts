import { describe, expect, it } from "vitest"
import {
  CorrectionReviewQueue,
  InMemoryCorrectionCandidateStore,
  type ReplayGate,
} from "../src/correction.js"
import { RememOrchestrator } from "../src/orchestrator.js"
import { MarkdownMemoryProvider } from "../src/providers/markdown.js"
import { fixtureDirectory, memoryContext, testConfig } from "./helpers.js"

const passingGate: ReplayGate = {
  run: () => Promise.resolve({ passed: true, caseIds: [], failures: [] }),
}

function correction() {
  return {
    sessionId: memoryContext.sessionId ?? "session-1",
    prompt: "Can we skip the rollback plan?",
    correctionText: "Rollback plans are required.",
    expectedOutcome: "Production rollouts require an approved rollback plan.",
    actor: "reviewer@example.test",
    context: memoryContext,
    trace: {
      sessionId: memoryContext.sessionId ?? "session-1",
      timestamp: new Date().toISOString(),
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
    },
  }
}

function createOrchestrator(reviewQueue?: CorrectionReviewQueue) {
  const config = testConfig({
    budgets: { catalogTokens: 600, recallTokens: 1_400, perProviderTokens: 900 },
  })
  const providerConfig = {
    type: "markdown" as const,
    id: "fixtures",
    paths: [fixtureDirectory],
    exclude: ["**/.git/**"],
    scope: "workspace" as const,
    maxFileBytes: 256 * 1024,
    maxFiles: 100,
  }
  return new RememOrchestrator(
    [new MarkdownMemoryProvider(providerConfig, [fixtureDirectory])],
    config,
    undefined,
    reviewQueue ? { reviewQueue } : {},
  )
}

describe("RememOrchestrator correction review surface", () => {
  it("reports unavailable when no review queue is configured", async () => {
    const orchestrator = createOrchestrator()
    expect(await orchestrator.submitCorrection(correction())).toEqual({ status: "unavailable" })
    expect(await orchestrator.reviewCandidates()).toEqual({ status: "unavailable" })
    expect(await orchestrator.explainCorrectionCandidate("missing")).toEqual({
      status: "unavailable",
    })
  })

  it("exposes read-only submit/list/explain against an injected review queue", async () => {
    const reviewQueue = new CorrectionReviewQueue(
      new InMemoryCorrectionCandidateStore(),
      () => [],
      () => [],
      () => Promise.resolve({ memoryId: "new-id" }),
      passingGate,
    )
    const orchestrator = createOrchestrator(reviewQueue)
    const submitted = await orchestrator.submitCorrection(correction())
    if ("status" in submitted) throw new Error("expected a candidate")
    await reviewQueue.runValidation(submitted.id)

    const listed = await orchestrator.reviewCandidates()
    expect(Array.isArray(listed)).toBe(true)
    if (!Array.isArray(listed)) throw new Error("expected a candidate list")
    expect(listed).toHaveLength(1)
    expect(listed[0]?.state).toBe("validated")

    const explained = await orchestrator.explainCorrectionCandidate(submitted.id)
    if ("status" in explained) throw new Error("expected a candidate")
    expect(explained.id).toBe(submitted.id)

    expect(await orchestrator.explainCorrectionCandidate("missing")).toEqual({
      status: "not-found",
    })
    expect((orchestrator as unknown as Record<string, unknown>).approve).toBeUndefined()
  })
})

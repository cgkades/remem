import { describe, expect, it, vi } from "vitest"

const targetedReplayGateSpy = vi.fn()

vi.mock("../src/replay-gate.js", () => ({
  TargetedReplayGate: class {
    constructor(...args: unknown[]) {
      targetedReplayGateSpy(...args)
    }
  },
}))

import { createCorrectionReviewQueue } from "../src/correction-wiring.js"
import { InMemoryCorrectionCandidateStore, type CorrectionCandidate } from "../src/correction.js"
import type { OrchestratorConfig } from "../src/config.js"

const config: OrchestratorConfig = {
  budgets: { catalogTokens: 100, recallTokens: 100, perProviderTokens: 50 },
  planner: { minimumConfidence: 0, maxTopics: 5 },
  providerTimeoutMs: 1_000,
  maxResults: 5,
  debug: false,
}

describe("createCorrectionReviewQueue", () => {
  it("wires the replay gate's applied-candidate loader to the queue it forward-references", async () => {
    const store = new InMemoryCorrectionCandidateStore()
    const queue = createCorrectionReviewQueue(store, [], config)

    expect(targetedReplayGateSpy).toHaveBeenCalledOnce()
    const listPriorApplied = targetedReplayGateSpy.mock.calls[0]?.[2] as
      (() => Promise<CorrectionCandidate[]>) | undefined
    expect(listPriorApplied).toBeTypeOf("function")

    // The gate is constructed before `queue` is assigned (a deliberate
    // forward reference -- see createCorrectionReviewQueue's comment).
    // Calling the loader here, after construction, must resolve against the
    // real queue rather than throwing or returning a stale/undefined value.
    await expect(listPriorApplied?.()).resolves.toEqual([])

    const applied: CorrectionCandidate = {
      id: "candidate-1",
      state: "applied",
      correction: {
        sessionId: "session-1",
        prompt: "p",
        correctionText: "c",
        expectedOutcome: "e",
        actor: "reviewer@example.test",
        context: { directory: "/repo", worktree: "/repo", projectId: "phoenix", sessionId: "s" },
        trace: {
          sessionId: "session-1",
          prompt: "p",
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
        },
      },
      affectedMemoryIds: [],
      audit: [],
      createdAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-04T00:00:00.000Z",
    }
    await store.insert(applied)
    await expect(listPriorApplied?.()).resolves.toEqual([applied])
    expect(queue).toBeDefined()
  })
})

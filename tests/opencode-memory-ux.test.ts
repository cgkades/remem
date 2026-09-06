import { describe, expect, it } from "vitest"
import {
  CaptureCoordinator,
  type CaptureExplanation,
  type UserPromptCapture,
} from "../src/capture.js"
import type { CaptureConfig } from "../src/config.js"
import { formatMemoryExplain } from "../src/hosts/opencode/memory-ux.js"
import { RememOrchestrator } from "../src/orchestrator.js"
import type { CandidateMemory, ObservationStore, SessionObservation } from "../src/observation.js"
import { MarkdownMemoryProvider } from "../src/providers/markdown.js"
import type { MemoryTrace, RememLogger } from "../src/types.js"
import { fixtureDirectory, memoryContext, testConfig } from "./helpers.js"

const captureConfig: CaptureConfig = {
  enabled: true,
  autoPromote: false,
  queueLimit: 4,
  maxInputCharacters: 400,
  maxCandidateCharacters: 200,
  timeoutMs: 100,
}

const logger: RememLogger = { log: () => undefined }

class RecordingStore implements ObservationStore {
  readonly persisted: Array<{ observation: SessionObservation; candidate: CandidateMemory }> = []

  persistCandidate(observed: SessionObservation, candidate: CandidateMemory): Promise<void> {
    this.persisted.push({ observation: observed, candidate })
    return Promise.resolve()
  }

  candidateStatus() {
    return Promise.resolve({
      pending: 0,
      approved: 0,
      consolidating: 0,
      rejected: 0,
      promoted: 0,
      expired: 0,
    })
  }
}

function markdownProvider(): MarkdownMemoryProvider {
  return new MarkdownMemoryProvider(
    {
      type: "markdown",
      id: "fixtures",
      paths: [fixtureDirectory],
      exclude: [],
      scope: "workspace",
      maxFileBytes: 256 * 1024,
      maxFiles: 100,
    },
    [fixtureDirectory],
  )
}

function captureInput(text: string, sessionId = "session"): UserPromptCapture {
  return {
    host: "opencode-v2",
    context: { ...memoryContext, sessionId },
    sessionId,
    messageId: "message",
    text,
  }
}

function emptyTrace(overrides: Partial<MemoryTrace> = {}): MemoryTrace {
  return {
    sessionId: "session-test",
    prompt: "secret API_KEY=super-secret-value should not leak",
    timestamp: "2026-09-05T00:00:00.000Z",
    catalogEntries: 0,
    catalogMatches: [{ id: "mem-1", title: "Project Phoenix", score: 0.9 }],
    shouldRetrieve: true,
    confidence: 0.9,
    topics: ["Project Phoenix"],
    signals: [],
    providers: [],
    rawResults: 0,
    deduplicatedResults: 0,
    selectedResults: 0,
    catalogTokens: 0,
    recallTokens: 0,
    totalDurationMs: 0,
    diagnostics: ["provider failed with API_KEY=super-secret-value"],
    ...overrides,
  }
}

describe("formatMemoryExplain", () => {
  it("diagnoses capture exclusion without memory bodies", () => {
    const capture: CaptureExplanation = {
      outcome: "excluded",
      reason: "not a durable statement",
    }
    const explained = formatMemoryExplain({ status: "no-trace" }, capture)
    expect(explained.miss).toBe("capture_exclusion")
    expect(explained.summary).toContain("not a durable statement")
    expect(JSON.stringify(explained)).not.toContain("<memory-context>")
  })

  it("diagnoses no matching memory, scope mismatch, and ranking decisions", () => {
    expect(formatMemoryExplain(emptyTrace({ rawResults: 0, selectedResults: 0 })).miss).toBe(
      "no_matching_memory",
    )
    expect(
      formatMemoryExplain(
        emptyTrace({
          selectedResults: 0,
          applicability: [
            {
              catalogEntryId: "entry",
              institutionalId: "inst",
              applicable: false,
              reason: "failed deterministic gate project",
            },
          ],
        }),
      ).miss,
    ).toBe("scope_mismatch")
    expect(formatMemoryExplain(emptyTrace({ rawResults: 3, selectedResults: 0 })).miss).toBe(
      "ranking_decision",
    )
    expect(
      formatMemoryExplain(
        emptyTrace({
          rawResults: 2,
          selectedResults: 0,
          applicability: [
            {
              catalogEntryId: "entry",
              institutionalId: "inst",
              applicable: false,
              reason: "failed deterministic gate project",
            },
          ],
        }),
      ).miss,
    ).toBe("ranking_decision")
  })

  it("redacts credentials and omits the original prompt from diagnostics", () => {
    const explained = formatMemoryExplain(emptyTrace())
    const serialized = JSON.stringify(explained)
    expect(serialized).not.toContain("super-secret-value")
    expect(serialized).not.toContain("secret API_KEY")
    expect(explained.retrieval.diagnostics.join(" ")).toContain("[redacted]")
  })

  it("caps diagnostic length at 160 characters", () => {
    const explained = formatMemoryExplain(
      emptyTrace({
        diagnostics: [`provider failed ${"x".repeat(200)}`],
      }),
    )
    expect(explained.retrieval.diagnostics[0]?.length).toBeLessThanOrEqual(160)
    expect(explained.retrieval.diagnostics[0]?.endsWith("...")).toBe(true)
  })
})

describe("OpenCode memory discoverability", () => {
  it("saves a direct remember request through the capture pipeline", async () => {
    const store = new RecordingStore()
    const coordinator = new CaptureCoordinator(store, captureConfig, logger)

    coordinator.enqueue(captureInput("Remember that Atlas uses PostgreSQL for durable memory."))
    await coordinator.idle()

    expect(store.persisted).toHaveLength(1)
    expect(
      formatMemoryExplain({ status: "no-trace" }, coordinator.explain("session")),
    ).toMatchObject({
      miss: "none",
      capture: { outcome: "pending" },
    })
  })

  it("finds a stored item with an explicit search after automatic recall", async () => {
    const orchestrator = new RememOrchestrator([markdownProvider()], testConfig())
    const recalled = await orchestrator.processPrompt(
      "Let's continue the Phoenix database work.",
      memoryContext,
    )
    expect(recalled.memoryText).toContain("use logical replication")

    const searched = await orchestrator.search("Phoenix database", memoryContext)
    expect(searched.text).toContain("use logical replication")
    expect(formatMemoryExplain(orchestrator.explain(memoryContext.sessionId)).miss).toBe("none")
  })

  it("isolates session-scoped memory from another session", async () => {
    const orchestrator = new RememOrchestrator([markdownProvider()], testConfig())
    const owner = await orchestrator.search("private rollout code", {
      ...memoryContext,
      sessionId: "session-owner",
    })
    const stranger = await orchestrator.search("private rollout code", {
      ...memoryContext,
      sessionId: "session-other",
    })

    expect(owner.text).toContain("cobalt-seven")
    expect(stranger.text).not.toContain("cobalt-seven")
  })

  it("diagnoses a ranking miss when recall finds results but the budget omits them", async () => {
    const orchestrator = new RememOrchestrator(
      [markdownProvider()],
      testConfig({
        budgets: { catalogTokens: 2_000, recallTokens: 8, perProviderTokens: 8 },
      }),
    )
    await orchestrator.processPrompt("Let's continue the Phoenix database work.", memoryContext)
    const explained = formatMemoryExplain(orchestrator.explain(memoryContext.sessionId))
    expect(explained.miss).toBe("ranking_decision")
    expect(JSON.stringify(explained)).not.toContain("use logical replication")
  })
})

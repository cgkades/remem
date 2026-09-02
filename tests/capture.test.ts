import { describe, expect, it } from "vitest"
import {
  CaptureCoordinator,
  DeterministicCandidateExtractor,
  type UserPromptCapture,
} from "../src/capture.js"
import type { CaptureConfig } from "../src/config.js"
import type { CandidateMemory, ObservationStore, SessionObservation } from "../src/observation.js"
import { containsSensitiveCredential, redactSensitiveText } from "../src/sensitive-data.js"
import type { MemoryContext, RememLogger } from "../src/types.js"

const config: CaptureConfig = {
  enabled: true,
  queueLimit: 2,
  maxInputCharacters: 200,
  maxCandidateCharacters: 120,
  timeoutMs: 100,
}

const context: MemoryContext = {
  directory: "/project",
  worktree: "/project",
  projectId: "project",
  sessionId: "session",
}

function observation(
  text: string,
  kind: SessionObservation["kind"] = "decision",
): SessionObservation {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind,
    context,
    occurredAt: "2026-09-02T12:00:00.000Z",
    source: "remem://opencode-v2/sessions/session/messages/message",
    payload: { host: "opencode-v2", messageId: "message", text },
  }
}

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

const logger: RememLogger = { log: () => undefined }

function input(text: string): UserPromptCapture {
  return { host: "opencode-v2", context, sessionId: "session", messageId: "message", text }
}

describe("DeterministicCandidateExtractor", () => {
  it("extracts explicit user corrections and decisions with message provenance", async () => {
    const extractor = new DeterministicCandidateExtractor(config)
    const correction = await extractor.extract([
      observation("Correction: use logical replication, not pg_dump.", "user-correction"),
    ])
    const decision = await extractor.extract([
      observation("We decided to use logical replication for Phoenix."),
    ])

    expect(correction[0]).toMatchObject({ status: "pending", confidence: 0.95 })
    expect(correction[0]?.memory.provenance?.[0]?.source).toMatchObject({
      kind: "user",
      externalId: "message",
    })
    expect(decision[0]).toMatchObject({ status: "pending", memory: { type: "decision" } })
  })

  it("rejects chitchat, quoted/tool data, secrets, and oversized input", async () => {
    const extractor = new DeterministicCandidateExtractor(config)
    const samples = [
      observation("Thanks, that helps."),
      observation("Actually, can you explain database replication?"),
      observation("What architecture should this service use?"),
      observation("> Decision: use logical replication."),
      observation("Decision: API_KEY=super-secret-value"),
      observation("Decision: use token ghp_abcdefghijklmnopqrstuvwxyz1234567890"),
      observation("Decision: use AKIAIOSFODNN7EXAMPLE for the deploy role."),
      observation("Decision: pass Bearer AbCdEf0123456789ZYXWVUTSRQPO987654."),
      observation("Decision: -----BEGIN OPENSSH PRIVATE KEY-----"),
      observation("Decision: use pV7mQ2xK9rT4nL8cF1wH6bC0eJ5sD3yZqA."),
      observation(`Decision: ${"x".repeat(250)}`),
    ]

    await expect(
      Promise.all(samples.map((sample) => extractor.extract([sample]))),
    ).resolves.toEqual([[], [], [], [], [], [], [], [], [], [], []])
  })

  it("detects and redacts reusable credential patterns", () => {
    const secret = "Authorization: Bearer AbCdEf0123456789ZYXWVUTSRQPO987654"

    expect(containsSensitiveCredential(secret)).toBe(true)
    expect(redactSensitiveText(secret)).toBe("Authorization: [redacted]")
    expect(containsSensitiveCredential("Use the standard credential provider chain.")).toBe(false)
  })
})

describe("CaptureCoordinator", () => {
  it("persists one pending candidate asynchronously with session and message provenance", async () => {
    const store = new RecordingStore()
    const coordinator = new CaptureCoordinator(store, config, logger)

    coordinator.enqueue(input("We decided to use logical replication for Phoenix."))
    await coordinator.idle()

    expect(store.persisted).toHaveLength(1)
    expect(store.persisted[0]?.observation).toMatchObject({
      kind: "decision",
      context: { sessionId: "session", projectId: "project" },
      payload: { host: "opencode-v2", messageId: "message" },
    })
    expect(store.persisted[0]?.candidate.status).toBe("pending")
  })

  it("contains persistence failures so prompt capture remains fail-open", async () => {
    const failed: ObservationStore = {
      persistCandidate: () => Promise.reject(new Error("database unavailable")),
      candidateStatus: () =>
        Promise.resolve({
          pending: 0,
          approved: 0,
          consolidating: 0,
          rejected: 0,
          promoted: 0,
          expired: 0,
        }),
    }
    const coordinator = new CaptureCoordinator(failed, config, logger)

    expect(() =>
      coordinator.enqueue(input("Decision: use a fail-open capture path.")),
    ).not.toThrow()
    await expect(coordinator.idle()).resolves.toBeUndefined()
  })
})

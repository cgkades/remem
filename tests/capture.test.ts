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
  autoPromote: false,
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
    const labelledDecision = await extractor.extract([
      observation("Decision: use logical replication for Phoenix."),
    ])
    const directRemember = await extractor.extract([
      observation("Remember that Atlas uses PostgreSQL for durable memory."),
    ])
    const implicitDecision = await extractor.extract([
      observation("Going forward, switch Atlas deployments to the staging bastion."),
    ])
    const projectFact = await extractor.extract([
      observation("The release manifest is located in infra/release/manifest.yaml."),
    ])
    const projectState = await extractor.extract([observation("The migration task is complete.")])
    const directPreference = await extractor.extract([
      observation("Remember that I prefer PostgreSQL for durable memory."),
    ])
    const directDecision = await extractor.extract([
      observation("Remember that we decided to use logical replication."),
    ])

    expect(correction[0]).toMatchObject({ status: "pending", confidence: 0.95 })
    expect(correction[0]?.memory.provenance?.[0]?.source).toMatchObject({
      kind: "user",
      externalId: "message",
    })
    expect(decision[0]).toMatchObject({ status: "pending", memory: { type: "decision" } })
    expect(labelledDecision[0]).toMatchObject({ status: "pending", memory: { type: "decision" } })
    expect(directRemember[0]).toMatchObject({
      confidence: 0.98,
      reasons: ["explicit remember request: durable project fact"],
      memory: { type: "semantic" },
    })
    expect(directRemember[0]?.memory.title).toMatch(/^Project fact:/u)
    expect(implicitDecision[0]).toMatchObject({ reasons: ["implicit decision"] })
    expect(projectFact[0]).toMatchObject({
      reasons: ["durable project fact"],
      memory: { type: "semantic" },
    })
    expect(projectFact[0]?.memory.title).toMatch(/^Project fact:/u)
    expect(projectState[0]).toMatchObject({
      reasons: ["project state"],
      memory: { type: "task" },
    })
    expect(projectState[0]?.memory.title).toMatch(/^Project task:/u)
    expect(directPreference[0]).toMatchObject({
      reasons: ["explicit remember request: durable preference"],
      memory: { type: "preference" },
    })
    expect(directPreference[0]?.memory.title).toMatch(/^User preference:/u)
    expect(directDecision[0]).toMatchObject({
      reasons: ["explicit remember request: implicit decision"],
      memory: { type: "decision" },
    })
    expect(directDecision[0]?.memory.title).toMatch(/^Explicit decision:/u)
  })

  it("allows a custom capture policy without making one mandatory", async () => {
    const extractor = new DeterministicCandidateExtractor(config, {
      classify: () => ({ kind: "task-resolved", confidence: 0.91, reason: "local policy" }),
    })

    const candidates = await extractor.extract([observation("A normally ignored statement.")])

    expect(candidates[0]).toMatchObject({
      confidence: 0.91,
      reasons: ["local policy"],
      memory: { type: "task" },
    })
  })

  it("rejects chitchat, quoted/tool data, secrets, and oversized input", async () => {
    const extractor = new DeterministicCandidateExtractor(config)
    const samples = [
      observation("Thanks, that helps."),
      observation("Actually, can you explain database replication?"),
      observation("What architecture should this service use?"),
      observation("> Decision: use logical replication."),
      observation("Decision: API_KEY=super-secret-value"),
      observation('Decision: {"api_key":"abc123"}'),
      observation("Decision: api token is abc123"),
      observation("Decision: the password is hunter2"),
      observation("Decision: pass=hunter2"),
      observation("Decision: use token ghp_abcdefghijklmnopqrstuvwxyz1234567890"),
      observation("Decision: use AKIAIOSFODNN7EXAMPLE for the deploy role."),
      observation("Decision: pass Bearer AbCdEf0123456789ZYXWVUTSRQPO987654."),
      observation("Decision: Authorization: Basic YWxpY2U6cEBzc3cwcmQ="),
      observation("Decision: -----BEGIN OPENSSH PRIVATE KEY-----"),
      observation("Decision: use pV7mQ2xK9rT4nL8cF1wH6bC0eJ5sD3yZqA."),
      observation("Decision: use postgres://admin:password@db.example/remem"),
      observation(`Decision: ${"x".repeat(250)}`),
    ]

    await expect(
      Promise.all(samples.map((sample) => extractor.extract([sample]))),
    ).resolves.toEqual([[], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], []])
  })

  it("does not attribute reported quoted speech to the user", async () => {
    const extractor = new DeterministicCandidateExtractor(config)

    await expect(
      extractor.extract([observation('Alice said "we decided to use Kafka" yesterday.')]),
    ).resolves.toEqual([])
    await expect(
      extractor.extract([observation("The runbook reported ‘we will use Kafka’.")]),
    ).resolves.toEqual([])
    await expect(
      extractor.extract([observation('Decision: use the "Kafka" cluster.')]),
    ).resolves.toHaveLength(1)
  })

  it("detects and redacts reusable credential patterns", () => {
    const secret = "Authorization: Bearer AbCdEf0123456789ZYXWVUTSRQPO987654"

    expect(containsSensitiveCredential(secret)).toBe(true)
    expect(redactSensitiveText(secret)).toBe("Authorization: [redacted]")
    expect(containsSensitiveCredential("Authorization: Basic YWxpY2U6cEBzc3cwcmQ=")).toBe(true)
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
    expect(coordinator.explain("session")).toMatchObject({
      outcome: "pending",
      kind: "decision",
      reason: "implicit decision",
    })
  })
  it("reports why an ineligible statement was excluded", () => {
    const coordinator = new CaptureCoordinator(new RecordingStore(), config, logger)

    coordinator.enqueue(input("Can you explain database replication?"))

    expect(coordinator.explain("session")).toEqual({
      outcome: "excluded",
      reason: "not a durable statement",
    })
  })

  it("keeps the newest prompt explanation when earlier capture processing finishes", async () => {
    let release: (() => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const delayed: ObservationStore = {
      persistCandidate: () => {
        markStarted?.()
        return new Promise<void>((resolve) => {
          release = resolve
        })
      },
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
    const coordinator = new CaptureCoordinator(delayed, config, logger)

    coordinator.enqueue(input("Decision: process this first."))
    await started
    coordinator.enqueue(input("Can you explain database replication?"))
    release?.()
    await coordinator.idle()

    expect(coordinator.explain("session")).toEqual({
      outcome: "excluded",
      reason: "not a durable statement",
    })
  })

  it("bounds retained explanations across sessions", () => {
    const coordinator = new CaptureCoordinator(new RecordingStore(), config, logger)

    for (let index = 0; index <= 100; index++) {
      coordinator.enqueue({
        ...input("Thanks, that helps."),
        sessionId: `session-${index}`,
        messageId: `message-${index}`,
      })
    }

    expect(coordinator.explain("session-0")).toEqual({ outcome: "idle" })
    expect(coordinator.explain("session-100")).toEqual({
      outcome: "excluded",
      reason: "not a durable statement",
    })
  })

  it("promotes screened captures without creating a review candidate in automatic mode", async () => {
    const store = new RecordingStore()
    const promoted: CandidateMemory[] = []
    const coordinator = new CaptureCoordinator(
      store,
      { ...config, autoPromote: true },
      logger,
      (candidate) => {
        promoted.push(candidate)
        return Promise.resolve()
      },
    )

    coordinator.enqueue(input("We decided to use automatic capture for Phoenix."))
    await coordinator.idle()

    expect(promoted).toHaveLength(1)
    expect(promoted[0]?.status).toBe("approved")
    expect(store.persisted).toHaveLength(0)
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

  it("bounds a stalled persistence call and passes cancellation to the store", async () => {
    let signal: AbortSignal | undefined
    const stalled: ObservationStore = {
      persistCandidate: (_observation, _candidate, options) => {
        signal = options?.signal
        return new Promise(() => undefined)
      },
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
    const coordinator = new CaptureCoordinator(stalled, { ...config, timeoutMs: 10 }, logger)

    coordinator.enqueue(input("Decision: bound stalled capture persistence."))
    await expect(coordinator.idle()).resolves.toBeUndefined()
    expect(signal?.aborted).toBe(true)
  })

  it("drains queued observations during disposal", async () => {
    const store = new RecordingStore()
    const coordinator = new CaptureCoordinator(store, config, logger)

    coordinator.enqueue(input("Decision: preserve the first queued capture."))
    coordinator.enqueue({
      ...input("Decision: preserve the second queued capture."),
      messageId: "message-2",
    })
    await coordinator.dispose()

    expect(store.persisted).toHaveLength(2)
  })
})

import { describe, expect, it, vi } from "vitest"
import { EvidenceCaptureCoordinator } from "../src/evidence-capture.js"
import type { EpisodicStore } from "../src/observation.js"
import {
  DEFAULT_EVIDENCE_ADMISSION_CONFIG,
  type EvidenceEnvelope,
  type RawEvidenceCandidate,
} from "../src/observation-admission.js"

const authority = { providerId: "local", host: "opencode-v2", projectId: "phoenix" }
const context = {
  directory: "/phoenix",
  worktree: "/phoenix",
  projectId: "phoenix",
  sessionId: "session-a",
}

function candidate(overrides: Partial<RawEvidenceCandidate> = {}): RawEvidenceCandidate {
  return {
    ...authority,
    context,
    messageId: "message-1",
    role: "user",
    origin: "direct-user",
    kind: "turn-completed",
    occurredAt: "2026-10-08T12:00:00.000Z",
    payload: { text: "Could the Phoenix problem be a connection pool timeout?" },
    ...overrides,
  }
}

function fixture(timeoutMs = 100) {
  const records = new Map<string, EvidenceEnvelope>()
  const store = {
    readEvidence: vi.fn<EpisodicStore["readEvidence"]>((_provider, id) =>
      Promise.resolve(records.get(id)),
    ),
    appendEvidence: vi.fn<EpisodicStore["appendEvidence"]>((envelope) => {
      const existing = records.get(envelope.id)
      if (existing) {
        return Promise.resolve({
          id: envelope.id,
          outcome: existing.contentHash === envelope.contentHash ? "duplicate" : "collision",
        })
      }
      records.set(envelope.id, envelope)
      return Promise.resolve({ id: envelope.id, outcome: "appended" })
    }),
  } satisfies EpisodicStore
  const log = vi.fn()
  const persisted = vi.fn()
  const coordinator = new EvidenceCaptureCoordinator(
    store,
    authority,
    { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true, maxQueuedEvents: 1 },
    timeoutMs,
    { log },
    persisted,
  )
  return { coordinator, store, records, log, persisted }
}

describe("host-neutral evidence capture", () => {
  it.each([
    "/var/folders/p3/mzsq4vpd5wd26sfz20wjw7y00000gn/T/remem-opencode-v2-e2e-tTMSWY/learning/hooks",
    "/Users/test/.copilot/session-state/ccce9ac1-dc38-44db-93b9-ba8b7df648b4/files/remem/learning",
  ])("admits real host paths without ignoring credential-shaped components: %s", async (path) => {
    const { coordinator, records } = fixture()
    coordinator.enqueue(candidate({ context: { ...context, directory: path, worktree: path } }))
    await coordinator.idle()
    expect(records.size).toBe(1)
    coordinator.enqueue(
      candidate({
        messageId: "unsafe-path",
        context: { ...context, directory: "/repo/ghp_123456789012345678901234567890123456" },
      }),
    )
    await coordinator.idle()
    expect(records.size).toBe(1)
  })

  it("rejects an unlabeled high-entropy credential in a context path", async () => {
    const { coordinator, records, persisted } = fixture()
    coordinator.enqueue(
      candidate({
        context: { ...context, directory: "/repo/aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY" },
      }),
    )
    await coordinator.idle()
    expect(records.size).toBe(0)
    expect(persisted).not.toHaveBeenCalled()
  })

  it("persists zero-candidate evidence and deduplicates callback delivery across restarts", async () => {
    const { coordinator, store, records, persisted } = fixture()
    coordinator.enqueue(candidate())
    await coordinator.idle()
    coordinator.enqueue(candidate({ occurredAt: "2026-10-08T13:00:00.000Z" }))
    await coordinator.idle()
    await coordinator.dispose()
    const restarted = new EvidenceCaptureCoordinator(
      store,
      authority,
      { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
      100,
      { log: vi.fn() },
    )
    restarted.enqueue(candidate({ occurredAt: "2026-10-08T14:00:00.000Z" }))
    await restarted.dispose()
    expect(records.size).toBe(1)
    expect([...records.values()][0]?.occurredAt).toBe("2026-10-08T12:00:00.000Z")
    expect(persisted).toHaveBeenCalledTimes(2)
  })

  it("rejects changed content under an existing identity without authorizing capture", async () => {
    const { coordinator, records, persisted, log } = fixture()
    coordinator.enqueue(candidate())
    await coordinator.idle()
    coordinator.enqueue(candidate({ payload: { text: "Actually, Phoenix is fixed." } }))
    await coordinator.idle()
    expect(records.size).toBe(1)
    expect(persisted).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(
      "warn",
      "evidence.capture_gap",
      expect.objectContaining({ reason: "collision", count: 1 }),
    )
  })

  it("fails closed when a stored replay timestamp cannot be re-admitted", async () => {
    const { coordinator, store, records, persisted, log } = fixture()
    coordinator.enqueue(candidate())
    await coordinator.idle()
    const existing = [...records.values()][0]
    expect(existing).toBeDefined()
    if (!existing) throw new Error("expected stored evidence")
    store.readEvidence.mockResolvedValueOnce({ ...existing, occurredAt: "not-a-timestamp" })
    coordinator.enqueue(candidate({ occurredAt: "2026-10-08T13:00:00.000Z" }))
    await coordinator.idle()
    expect(store.appendEvidence).toHaveBeenCalledTimes(1)
    expect(persisted).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(
      "warn",
      "evidence.capture_gap",
      expect.objectContaining({ reason: "malformed-envelope" }),
    )
  })

  it.each([
    { origin: "unknown" as const },
    { context: { ...context, projectId: "unrelated" } },
    { messageId: undefined },
    { payload: { text: "password=supersecretvalue123" } },
    { payload: { text: "safe", metadata: { nested: { password: "supersecretvalue123" } } } },
    {
      payload: {
        text: "safe",
        metadata: { nested: { token: "ghp_123456789012345678901234567890123456" } },
      },
    },
  ])("rejects unsafe, unsupported or foreign evidence: %j", async (overrides) => {
    const { coordinator, records, persisted, log } = fixture()
    const input = candidate()
    if ("messageId" in overrides) delete input.messageId
    else Object.assign(input, overrides)
    coordinator.enqueue(input)
    await coordinator.idle()
    expect(records.size).toBe(0)
    expect(persisted).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalled()
    expect(JSON.stringify(log.mock.calls)).not.toContain("supersecret")
    expect(JSON.stringify(log.mock.calls)).not.toContain("ghp_")
  })

  it("fails open for storage outages but never starts semantic capture", async () => {
    const { coordinator, store, persisted, log } = fixture()
    vi.mocked(store.appendEvidence).mockRejectedValue(new Error("secret provider details"))
    coordinator.enqueue(candidate())
    await expect(coordinator.dispose()).resolves.toBeUndefined()
    expect(persisted).not.toHaveBeenCalled()
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret provider details")
  })

  it("does not replay forgotten evidence", async () => {
    const { coordinator, store, persisted } = fixture()
    vi.mocked(store.appendEvidence).mockResolvedValue({ id: "forgotten", outcome: "forgotten" })
    coordinator.enqueue(candidate())
    await coordinator.idle()
    expect(persisted).not.toHaveBeenCalled()
  })

  it("recovers an interrupted post-append callback on host re-delivery without duplicating evidence", async () => {
    const { coordinator, store, records, persisted } = fixture()
    vi.mocked(store.appendEvidence).mockImplementationOnce((envelope) => {
      records.set(envelope.id, envelope)
      return Promise.reject(new Error("interrupted after durable commit"))
    })
    coordinator.enqueue(candidate())
    await coordinator.idle()
    expect(records.size).toBe(1)
    expect(persisted).not.toHaveBeenCalled()
    coordinator.enqueue(candidate({ occurredAt: "2026-10-08T13:00:00.000Z" }))
    await coordinator.idle()
    expect(records.size).toBe(1)
    expect(persisted).toHaveBeenCalledTimes(1)
  })

  it("bounds queued work and shutdown even when the provider ignores cancellation", async () => {
    const { coordinator, store, persisted, log } = fixture(15)
    vi.mocked(store.readEvidence).mockImplementation(() => new Promise(() => undefined))
    coordinator.enqueue(candidate())
    coordinator.enqueue(candidate({ messageId: "message-2" }))
    coordinator.enqueue(candidate({ messageId: "message-3" }))
    await coordinator.dispose()
    coordinator.enqueue(candidate({ messageId: "after-shutdown" }))
    expect(persisted).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(
      "warn",
      "evidence.capture_gap",
      expect.objectContaining({ reason: "queue-full" }),
    )
    expect(store.appendEvidence).not.toHaveBeenCalled()
  })
})

import { describe, expect, it, vi } from "vitest"
import { EvidenceCaptureCoordinator } from "../src/evidence-capture.js"
import { parseConfig } from "../src/config.js"
import { DEFAULT_EVIDENCE_ADMISSION_CONFIG } from "../src/observation-admission.js"
import { V2EvidenceAdapter } from "../src/hosts/opencode/evidence.js"
const context = { directory: "/repo", worktree: "/repo", projectId: "project", sessionId: "a" }
function fixture(enabled = true, timeout = 100) {
  const store = {
    readEvidence: vi.fn(() => Promise.resolve(undefined)),
    appendEvidence: vi.fn(() => Promise.resolve({ id: "unused", outcome: "appended" as const })),
    persistCandidate: vi.fn(),
    candidateStatus: vi.fn(),
    claimEvidenceExtraction: vi.fn(() => Promise.resolve([])),
    finishEvidenceExtraction: vi.fn(() => Promise.resolve(true)),
    reflectionStatus: vi.fn(),
  }
  const log = vi.fn()
  const coordinator = new EvidenceCaptureCoordinator(
    store,
    { providerId: "local", host: "opencode-v2", projectId: "project" },
    { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
    timeout,
    { log },
    undefined,
    { ...parseConfig({}).config.capture, enabled },
  )
  return { store, log, coordinator }
}
describe("reflection host lifecycle", () => {
  it("does not query retained sources when the capture mode is disabled", async () => {
    const f = fixture(false)
    expect(await f.coordinator.reflect(context)).toEqual({ selected: 0, processed: 0, failed: 0 })
    await f.coordinator.dispose()
    expect(f.store.claimEvidenceExtraction).not.toHaveBeenCalled()
  })
  it("times out a stalled claim, cancels authorization and keeps diagnostics body-free", async () => {
    const f = fixture()
    let signal: AbortSignal | undefined
    f.store.claimEvidenceExtraction.mockImplementation((...args: unknown[]) => {
      signal = args[4] as AbortSignal
      return new Promise(() => undefined)
    })
    const started = performance.now()
    const report = await f.coordinator.reflect(context)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(report.failed).toBe(1)
    expect(signal?.aborted).toBe(true)
    expect(f.store.persistCandidate).not.toHaveBeenCalled()
    expect(JSON.stringify(f.log.mock.calls)).not.toContain("/repo")
    await f.coordinator.dispose()
  })
  it("session end attempts one bounded reflection and rejects later host input", async () => {
    const f = fixture()
    const adapter = new V2EvidenceAdapter(f.coordinator, "local", context)
    adapter.prompt({
      sessionID: "a",
      messageID: "one",
      prompt: { text: "Investigate the worker." },
    })
    await f.coordinator.idle()
    await f.coordinator.dispose()
    expect(f.store.claimEvidenceExtraction).toHaveBeenCalledTimes(1)
    adapter.prompt({ sessionID: "a", messageID: "two", prompt: { text: "Late worker input." } })
    expect(f.store.appendEvidence).toHaveBeenCalledTimes(1)
  })
  it("deduplicates active attempts and respects explicit cancellation before claiming", async () => {
    const f = fixture()
    const stopped = new AbortController()
    stopped.abort()
    expect(() => f.coordinator.reflect(context, stopped.signal)).toThrow()
    expect(f.store.claimEvidenceExtraction).not.toHaveBeenCalled()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    f.store.claimEvidenceExtraction.mockImplementation(async () => {
      await blocked
      return []
    })
    const a = f.coordinator.reflect(context),
      b = f.coordinator.reflect(context)
    expect(a).toBe(b)
    release()
    await a
    expect(f.store.claimEvidenceExtraction).toHaveBeenCalledTimes(1)
  })
})

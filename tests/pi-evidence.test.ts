import { describe, expect, it, vi } from "vitest"
import { PiEvidenceAdapter } from "../src/hosts/pi/evidence.js"
import type { EvidenceCaptureCoordinator } from "../src/evidence-capture.js"
import {
  admitEvidence,
  DEFAULT_EVIDENCE_ADMISSION_CONFIG,
  type RawEvidenceCandidate,
} from "../src/observation-admission.js"
import { verifiedProcedureFromEvidence, PI_FILE_RECOVERY_RULE } from "../src/verified-procedure.js"
import { piContext, piEvidence } from "./fixtures/learning/pi-file-recovery.js"
function fixture() {
  const enqueue = vi.fn<(candidate: RawEvidenceCandidate) => string | undefined>()
  const adapter = new PiEvidenceAdapter(
    { enqueue } as unknown as EvidenceCaptureCoordinator,
    "pi-loop",
    piContext,
  )
  return { adapter, enqueue }
}
describe("Pi native evidence", () => {
  it("binds interactive input to exact completed user content and derives replay-stable identity", () => {
    const { adapter, enqueue } = fixture()
    const msg = {
      role: "user",
      content: [{ type: "text", text: "Aurora worker uses files." }],
      timestamp: 1234,
    }
    adapter.input("Aurora worker uses files.", "interactive")
    adapter.messageEnded(msg, "session")
    adapter.input("Aurora worker uses files.", "interactive")
    adapter.messageEnded(msg, "session")
    expect(enqueue.mock.calls[0]?.[0]).toEqual(enqueue.mock.calls[1]?.[0])
    for (const source of ["rpc", "extension"]) {
      adapter.input("Aurora worker uses files.", source)
      adapter.messageEnded(msg, "session")
    }
    adapter.input("Aurora worker uses files.", "interactive")
    adapter.messageEnded({ ...msg, content: "modified input" }, "session")
    adapter.input("Aurora worker uses files.", "interactive")
    adapter.messageEnded({ ...msg, timestamp: 1e30 }, "session")
    expect(enqueue).toHaveBeenCalledTimes(2)
  })
  it("pairs starts and ends without inventing shell exit codes; preserves nested credential screening", () => {
    const { adapter, enqueue } = fixture()
    adapter.turnStarted(1, 1234)
    const input = { command: "test -f state.txt", nested: { password: "fixture-secret" } }
    adapter.toolStarted("call", "bash", input)
    input.command = "changed"
    adapter.toolEnded(
      "call",
      "bash",
      { content: [{ type: "text", text: "done" }], details: {} },
      false,
      "session",
    )
    const raw = enqueue.mock.calls[0]![0]
    expect(raw.payload.metadata).toMatchObject({
      input: { command: "test -f state.txt" },
      status: "completed",
      result: {},
    })
    expect(raw.payload.metadata).not.toHaveProperty("exit")
    expect(
      admitEvidence(
        raw,
        { providerId: "pi-loop", host: "pi", projectId: piContext.projectId },
        { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
      ),
    ).toMatchObject({ outcome: "rejected", reason: "unscreenable-content" })
    adapter.toolEnded("call", "bash", { content: [] }, false, "session")
    expect(enqueue).toHaveBeenCalledTimes(1)
  })
  it("bounds pending calls and argument snapshots, excludes memory tools and consumes mismatched completions", () => {
    const { adapter, enqueue } = fixture()
    adapter.turnStarted(1, 1234)
    let getters = 0
    adapter.toolStarted("getter", "read", {
      get path() {
        getters++
        return "file"
      },
    })
    adapter.toolStarted("large", "write", { content: "x".repeat(40_001) })
    adapter.toolStarted("memory", "memory_status", {})
    for (let i = 0; i < 35; i++) adapter.toolStarted(String(i), "read", { path: "file" })
    for (const id of [
      "getter",
      "large",
      "memory",
      ...Array.from({ length: 35 }, (_, i) => String(i)),
    ])
      adapter.toolEnded(id, "read", { content: [] }, false, "session")
    expect(getters).toBe(0)
    expect(enqueue).toHaveBeenCalledTimes(32)
    adapter.toolStarted("wrong", "read", { path: "file" })
    adapter.toolEnded("wrong", "write", { content: [] }, false, "session")
    adapter.toolStarted("late", "read", { path: "file" })
    adapter.dispose()
    adapter.toolEnded("late", "read", { content: [] }, false, "session")
    expect(enqueue).toHaveBeenCalledTimes(32)
  })
  it("proves only bounded read/write/identical read recovery with distinct native turns", () => {
    const evidence = piEvidence()
    const episode = verifiedProcedureFromEvidence(evidence, piContext)
    expect(episode?.verification?.rule).toBe(PI_FILE_RECOVERY_RULE)
    expect(JSON.stringify(episode)).not.toMatch(/root cause|exit 0/)
  })
  it.each([
    "same-turn",
    "content-mismatch",
    "truncated",
    "foreign",
    "unsafe-path",
    "absolute",
    "bash",
  ])("refuses unsupported %s sequence", (negative) => {
    const evidence = piEvidence()
    const source = evidence[negative === "foreign" ? 2 : 3]!
    if (negative === "same-turn") source.turnId = evidence[2]!.turnId!
    if (negative === "content-mismatch") source.payload.text = "different contents"
    if (negative === "truncated")
      source.payload.metadata!.result = { truncation: { truncated: true } }
    if (negative === "foreign") source.context = { ...source.context, projectId: "other" }
    if (negative === "unsafe-path") source.payload.metadata!.input = { path: "production.key" }
    if (negative === "absolute") source.payload.metadata!.input = { path: "/repo/file" }
    if (negative === "bash") source.payload.metadata!.tool = "bash"
    const admitted = admitEvidence(
      source,
      { providerId: source.providerId, host: "pi", projectId: source.context.projectId },
      { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
    )
    if (admitted.outcome === "admitted")
      evidence[negative === "foreign" ? 2 : 3] = admitted.envelope
    expect(verifiedProcedureFromEvidence(evidence, piContext)).toBeUndefined()
  })
})

import { describe, expect, it, vi } from "vitest"
import {
  EvidenceCaptureCoordinator,
  createEvidenceCaptureCoordinator,
} from "../src/evidence-capture.js"
import { parseConfig } from "../src/config.js"
import { V2EvidenceAdapter } from "../src/hosts/opencode/evidence.js"
import {
  DEFAULT_EVIDENCE_ADMISSION_CONFIG,
  admitEvidence,
  type EvidenceEnvelope,
} from "../src/observation-admission.js"
import type { EpisodicStore, EpisodicAppendResult } from "../src/observation.js"

const location = { directory: "/repo", worktree: "/repo", projectId: "phoenix" }
const authority = { providerId: "local", projectId: "phoenix", host: "opencode-v2" }

function fixture(options: { limit?: number; timeout?: number } = {}) {
  const records = new Map<string, EvidenceEnvelope>()
  const readEvidence = vi.fn(
    (_provider: string, id: string): Promise<EvidenceEnvelope | undefined> =>
      Promise.resolve(records.get(id)),
  )
  const appendEvidence = vi.fn((envelope: EvidenceEnvelope): Promise<EpisodicAppendResult> => {
    const existing = records.get(envelope.id)
    if (existing)
      return Promise.resolve({
        id: envelope.id,
        outcome: existing.contentHash === envelope.contentHash ? "duplicate" : "collision",
      })
    records.set(envelope.id, envelope)
    return Promise.resolve({ id: envelope.id, outcome: "appended" })
  })
  const store: EpisodicStore = { readEvidence, appendEvidence }
  const log = vi.fn()
  const onPersisted = vi.fn<(envelope: EvidenceEnvelope) => void>()
  const coordinator = new EvidenceCaptureCoordinator(
    store,
    authority,
    {
      ...DEFAULT_EVIDENCE_ADMISSION_CONFIG,
      enabled: true,
      maxQueuedEvents: options.limit ?? 32,
    },
    options.timeout ?? 100,
    { log },
    onPersisted,
  )
  const adapter = new V2EvidenceAdapter(coordinator, "local", location)
  return { records, store, readEvidence, appendEvidence, log, onPersisted, coordinator, adapter }
}

const prompt = {
  sessionID: "session-a",
  messageID: "user-1",
  prompt: { text: "Investigate the Phoenix worker failure." },
}
const tool = {
  sessionID: "session-a",
  messageID: "assistant-1",
  id: "call-1",
  tool: "read",
  input: { path: "src/worker.ts" },
  status: "completed" as const,
  result: { content: "Phoenix worker loads its checkpoint from ./state.json." },
}

describe("host evidence capture", () => {
  it("preserves native shell exit and timeout data without treating completed callbacks as task success", async () => {
    const f = fixture()
    for (const [index, result] of [{ exit: 7 }, { exit: 0 }, { timeout: true }].entries()) {
      f.adapter.tool({
        ...tool,
        tool: "shell",
        id: `shell-${index}`,
        input: { command: "npm test" },
        result: { content: "Native process result", metadata: result },
      })
    }
    await f.coordinator.idle()
    expect([...f.records.values()].map((record) => record.payload.metadata?.result)).toEqual([
      { exit: 7 },
      { exit: 0 },
      { timeout: true },
    ])
    expect(
      [...f.records.values()].every(
        (record) =>
          record.role === "tool" &&
          record.kind === "tool-result" &&
          record.payload.metadata?.status === "completed",
      ),
    ).toBe(true)
  })

  it("reports an unavailable enabled evidence store without failing host initialization", () => {
    const log = vi.fn()
    const config = parseConfig({ evidenceAdmission: { enabled: true } }).config
    expect(createEvidenceCaptureCoordinator([], config, authority, { log })).toBeUndefined()
    expect(log).toHaveBeenCalledWith(
      "warn",
      "evidence.capture_gap",
      expect.objectContaining({ reason: "no-primary-episodic-store" }),
    )
  })

  it("does not authorize downstream capture until evidence has persisted", async () => {
    const f = fixture()
    let release: () => void = () => undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    f.readEvidence.mockImplementationOnce(async () => {
      await blocked
      return undefined
    })
    f.adapter.prompt(prompt)
    expect(f.onPersisted).not.toHaveBeenCalled()
    release()
    await f.coordinator.idle()
    expect(f.onPersisted).toHaveBeenCalledExactlyOnceWith([...f.records.values()][0])
  })

  it("recovers interrupted downstream capture on evidence re-delivery", async () => {
    const f = fixture()
    f.onPersisted.mockImplementationOnce(() => {
      throw new Error("fixture downstream interruption")
    })
    f.adapter.prompt(prompt)
    await f.coordinator.idle()
    f.adapter.prompt(prompt)
    await f.coordinator.idle()
    expect(f.records.size).toBe(1)
    expect(f.onPersisted).toHaveBeenCalledTimes(2)
    expect(f.onPersisted.mock.calls[1]?.[0]).toEqual([...f.records.values()][0])
    expect(JSON.stringify(f.log.mock.calls)).not.toContain("fixture downstream interruption")
  })

  it("does not authorize capture when a stored replay timestamp is invalid", async () => {
    const f = fixture()
    f.adapter.prompt(prompt)
    await f.coordinator.idle()
    const row = [...f.records.values()][0]
    if (!row) throw new Error("missing fixture evidence")
    f.records.set(row.id, { ...row, occurredAt: "invalid" })
    f.onPersisted.mockClear()
    f.appendEvidence.mockClear()
    f.adapter.prompt(prompt)
    await f.coordinator.idle()
    expect(f.onPersisted).not.toHaveBeenCalled()
    expect(f.appendEvidence).not.toHaveBeenCalled()
    expect(f.log).toHaveBeenCalledWith(
      "warn",
      "evidence.capture_gap",
      expect.objectContaining({ reason: "replay-rejected" }),
    )
  })

  it("persists ordinary input and tool evidence without semantic significance or candidate promotion", async () => {
    const f = fixture()
    f.adapter.prompt(prompt)
    f.adapter.tool(tool)
    await f.coordinator.idle()
    const rows = [...f.records.values()]
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ role: "user", origin: "direct-user", messageId: "user-1" })
    expect(rows[1]).toMatchObject({
      role: "tool",
      origin: "host-observed",
      turnId: "assistant-1",
      messageId: "call-1",
    })
    expect(rows[1]?.payload.text).toBe(tool.result.content)
    expect(rows.every((row) => row.context.projectId === "phoenix")).toBe(true)
    await f.coordinator.dispose()
  })

  it("replays duplicate callbacks and restarts without changing their first timestamp", async () => {
    const f = fixture()
    f.adapter.tool(tool)
    await f.coordinator.idle()
    const first = [...f.records.values()][0]
    await new Promise((resolve) => setTimeout(resolve, 5))
    f.adapter.tool(tool)
    await f.coordinator.idle()
    const restarted = new EvidenceCaptureCoordinator(
      f.store,
      authority,
      { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
      100,
      { log: f.log },
    )
    new V2EvidenceAdapter(restarted, "local", location).tool(tool)
    await restarted.idle()
    expect(f.records.size).toBe(1)
    expect([...f.records.values()][0]).toEqual(first)
    expect(f.log).not.toHaveBeenCalled()
    await restarted.dispose()
    await f.coordinator.dispose()
  })

  it("keeps different tool calls within one assistant message distinct", async () => {
    const f = fixture()
    f.adapter.tool(tool)
    f.adapter.tool({ ...tool, id: "call-2" })
    await f.coordinator.idle()
    expect(f.records.size).toBe(2)
  })

  it("deduplicates concurrent first delivery with a different ingestion clock", async () => {
    const f = fixture()
    f.appendEvidence.mockImplementationOnce((envelope) => {
      const winner = admitEvidence(
        { ...envelope, occurredAt: "2026-10-01T00:00:00.000Z" },
        authority,
        { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
      )
      if (winner.outcome !== "admitted") throw new Error("invalid fixture")
      f.records.set(winner.envelope.id, winner.envelope)
      return Promise.resolve({ id: envelope.id, outcome: "collision" })
    })
    f.adapter.tool(tool)
    await f.coordinator.idle()
    expect(f.records.size).toBe(1)
    expect(f.appendEvidence).toHaveBeenCalledTimes(2)
    expect([...f.records.values()][0]?.occurredAt).toBe("2026-10-01T00:00:00.000Z")
    expect(f.onPersisted).toHaveBeenCalledExactlyOnceWith([...f.records.values()][0])
    expect(f.log).not.toHaveBeenCalled()
  })

  it("normalizes native workspace wrappers while still rejecting credentials", async () => {
    const f = fixture()
    const directory = "/workspace/scratch/34d27914feff/remem/tests/fixtures/memory"
    const adapter = new V2EvidenceAdapter(f.coordinator, "local", {
      ...location,
      directory,
      worktree: directory,
    })
    adapter.tool({
      ...tool,
      input: { path: `${directory}/checkpoint.txt` },
      result: { content: `File ${directory}/checkpoint.txt: safe output` },
    })
    adapter.tool({
      ...tool,
      id: "secret",
      result: { content: `File ${directory}/checkpoint.txt: password=supersecret` },
    })
    await f.coordinator.idle()
    expect(f.records.size).toBe(1)
    expect([...f.records.values()][0]?.payload).toMatchObject({
      text: "File ./checkpoint.txt: safe output",
      metadata: { input: { path: "./checkpoint.txt" } },
    })
    expect(JSON.stringify([...f.records.values()])).not.toContain("supersecret")
  })

  it("rejects a changed callback with the same identity without rewriting evidence", async () => {
    const f = fixture()
    f.adapter.tool(tool)
    await f.coordinator.idle()
    f.adapter.tool({ ...tool, result: { content: "Different evidence" } })
    await f.coordinator.idle()
    expect([...f.records.values()][0]?.payload.text).toBe(tool.result.content)
    expect(f.onPersisted).toHaveBeenCalledTimes(1)
    expect(f.log).toHaveBeenCalledWith(
      "warn",
      "evidence.capture_gap",
      expect.objectContaining({ reason: "collision" }),
    )
  })

  it.each([
    { ...tool, result: { content: "password=supersecret" } },
    { ...tool, input: { path: "src/worker.ts", extra: { nested: "api_key=supersecret" } } },
    { ...tool, input: { nested: { password: "ordinary-secret" } } },
    {
      ...tool,
      result: { content: "safe output", metadata: { nested: { token: "password=supersecret" } } },
    },
  ])("rejects secrets before writes and emits only content-free diagnostics", async (event) => {
    const f = fixture()
    expect(() => f.adapter.tool(event)).not.toThrow()
    await f.coordinator.idle()
    expect(f.appendEvidence).not.toHaveBeenCalled()
    expect(f.onPersisted).not.toHaveBeenCalled()
    expect(JSON.stringify(f.log.mock.calls)).not.toContain("supersecret")
  })

  it("excludes memory tool output and metadata-bearing programmatic prompts", async () => {
    const f = fixture()
    f.adapter.tool({ ...tool, tool: "memory_search" })
    f.adapter.prompt({ ...prompt, metadata: { source: "extension" } })
    await f.coordinator.idle()
    expect(f.records.size).toBe(0)
  })

  it("retains failed operations as evidence without reclassifying them as successful procedures", async () => {
    const f = fixture()
    f.adapter.tool({ ...tool, status: "error", error: { message: "checkpoint not found" } })
    await f.coordinator.idle()
    expect([...f.records.values()][0]).toMatchObject({
      role: "tool",
      kind: "tool-result",
      payload: { text: "checkpoint not found", metadata: { status: "error" } },
    })
  })

  it("does not infer a process exit code or successful fix from completed tool status", async () => {
    const f = fixture()
    f.adapter.tool({
      ...tool,
      tool: "bash",
      input: { command: "node verify.js" },
      result: { content: "Tests failed", metadata: { exit: 1 } },
    })
    await f.coordinator.idle()
    expect([...f.records.values()][0]?.payload.metadata).toEqual({
      tool: "bash",
      status: "completed",
      input: { command: "node verify.js" },
      result: { exit: 1 },
    })
  })

  it("fails closed for foreign scope and missing call identity while the host stays usable", async () => {
    const f = fixture()
    new V2EvidenceAdapter(f.coordinator, "local", { ...location, projectId: "foreign" }).tool(tool)
    f.adapter.tool({ ...tool, id: "" })
    await f.coordinator.idle()
    expect(f.records.size).toBe(0)
  })

  it("bounds queue pressure and drains accepted events", async () => {
    const f = fixture({ limit: 1 })
    let release: () => void = () => undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(f.readEvidence).mockImplementationOnce(async () => {
      await blocked
      return undefined
    })
    f.adapter.tool(tool)
    f.adapter.tool({ ...tool, id: "call-2" })
    f.adapter.tool({ ...tool, id: "call-3" })
    release()
    await f.coordinator.idle()
    expect(f.records.size).toBe(2)
    expect(f.log).toHaveBeenCalledWith(
      "warn",
      "evidence.capture_gap",
      expect.objectContaining({ reason: "queue-full" }),
    )
  })

  it("keeps provider failure fail-open and processes the next event", async () => {
    const f = fixture()
    vi.mocked(f.appendEvidence).mockRejectedValueOnce(new Error("secret provider body"))
    f.adapter.tool(tool)
    f.adapter.tool({ ...tool, id: "call-2" })
    await f.coordinator.idle()
    expect(f.records.size).toBe(1)
    expect(f.onPersisted).toHaveBeenCalledExactlyOnceWith([...f.records.values()][0])
    expect(JSON.stringify(f.log.mock.calls)).not.toContain("secret provider body")
  })

  it("does not restore forgotten evidence", async () => {
    const f = fixture()
    vi.mocked(f.appendEvidence).mockResolvedValueOnce({
      id: "tombstone",
      outcome: "forgotten",
    })
    f.adapter.tool(tool)
    await f.coordinator.idle()
    expect(f.records.size).toBe(0)
    expect(f.onPersisted).not.toHaveBeenCalled()
    expect(f.log).toHaveBeenCalledWith(
      "warn",
      "evidence.capture_gap",
      expect.objectContaining({ reason: "forgotten" }),
    )
  })

  it("shutdown is bounded and rejects later capture", async () => {
    const f = fixture({ timeout: 10 })
    vi.mocked(f.readEvidence).mockImplementation(() => new Promise(() => undefined))
    f.adapter.tool(tool)
    await f.coordinator.dispose()
    f.adapter.tool({ ...tool, id: "late-call" })
    expect(f.records.size).toBe(0)
    expect(f.onPersisted).not.toHaveBeenCalled()
    expect(f.log).toHaveBeenCalled()
  })
})

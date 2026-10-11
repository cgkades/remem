import { randomUUID } from "node:crypto"
import { Pool, type PoolClient } from "pg"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { DeterministicCandidateExtractor } from "../src/capture.js"
import { parseConfig } from "../src/config.js"
import { DeterministicConsolidationPipeline } from "../src/consolidation.js"
import { EvidenceCaptureCoordinator } from "../src/evidence-capture.js"
import { admitEvidence, DEFAULT_EVIDENCE_ADMISSION_CONFIG } from "../src/observation-admission.js"
import type { SessionObservation } from "../src/observation.js"
import { PostgresMemoryProvider } from "../src/providers/postgres.js"
import { runMigrations } from "../src/storage/migrations.js"

const databaseUrl = process.env.REMEM_TEST_DATABASE_URL
const integration = databaseUrl ? describe.sequential : describe.skip
const context = {
  projectId: "diagnostic-project",
  sessionId: "session-a",
  directory: "/repo",
  worktree: "/repo",
}
const config = {
  type: "postgres" as const,
  id: "diagnostic-provider",
  primary: true,
  connectionString: databaseUrl ?? "",
  maxConnections: 4,
  catalogLimit: 100,
}
integration("durable scoped learning diagnostics", () => {
  const pool = new Pool({ connectionString: databaseUrl })
  const store = new PostgresMemoryProvider(config, { pool })
  beforeEach(async () => {
    await pool.query("DROP SCHEMA IF EXISTS remem CASCADE")
    await runMigrations(pool)
  })
  afterAll(async () => {
    await pool.end()
  })
  async function input(text: string, scope = context) {
    const result = admitEvidence(
      {
        providerId: config.id,
        host: "opencode-v2",
        context: scope,
        messageId: randomUUID(),
        role: "user",
        origin: "direct-user",
        kind: "turn-completed",
        occurredAt: new Date().toISOString(),
        payload: { text },
      },
      { providerId: config.id, host: "opencode-v2", projectId: scope.projectId },
      { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
    )
    if (result.outcome !== "admitted") throw new Error("bad fixture")
    await store.appendEvidence(result.envelope)
    const extractor = new DeterministicCandidateExtractor(parseConfig({}).config.capture)
    const observation: SessionObservation = {
      id: randomUUID(),
      kind: extractor.classify(text)!.kind,
      context: scope,
      occurredAt: result.envelope.occurredAt,
      source: "remem://opencode-v2/diagnostic",
      payload: {
        host: "opencode-v2",
        messageId: result.envelope.messageId,
        text,
        evidenceRefs: [{ providerId: config.id, eventId: result.envelope.id }],
      },
    }
    return {
      observation,
      candidate: (await extractor.extract([observation]))[0]!,
      evidence: result.envelope,
    }
  }
  const options = { autoApprove: true, applyLearningPolicy: true }
  it("explains all policy outcomes after recreation without storing rejected bodies or losing confidence", async () => {
    for (const [text, override] of [
      ["Phoenix worker uses local checkpoints.", undefined],
      ["We decided to use shared files for production Phoenix.", undefined],
      ["Other worker uses local files.", "Unverified root cause: provider outage."],
      ["Another worker uses local files.", "password=fixture-secret"],
    ] as const) {
      const f = await input(text)
      if (override) f.candidate.memory.content = override
      const receipt = await store.persistCandidate(f.observation, f.candidate, options)
      if (receipt?.status === "approved")
        await new DeterministicConsolidationPipeline(store).consolidate([
          { ...f.candidate, status: "approved" },
        ])
    }
    const restarted = new PostgresMemoryProvider(config, { pool })
    const result = await restarted.learningHistory(
      { ...context, sessionId: "fresh-session" },
      { limit: 20 },
    )
    expect(result.entries).toHaveLength(4)
    expect(new Set(result.entries.map((e) => e.policyOutcome))).toEqual(
      new Set(["auto-promote", "require-review", "episodic-only", "reject"]),
    )
    expect(
      result.entries.every(
        (e) => e.audit.length > 0 && e.extractorVersion && e.confidence !== undefined,
      ),
    ).toBe(true)
    expect(result.entries.find((e) => e.policyOutcome === "auto-promote")?.memoryId).toBeDefined()
    expect(JSON.stringify(result)).not.toMatch(/fixture-secret|local checkpoints|provider outage/u)
    const persisted = await pool.query("SELECT * FROM remem.candidate_lineage")
    expect(JSON.stringify(persisted.rows)).not.toContain("fixture-secret")
  })
  it("bounds and isolates history and counters by provider/project, including no-context reads", async () => {
    for (let i = 0; i < 7; i++) {
      const f = await input(`Component ${i} uses local files.`)
      await store.persistCandidate(f.observation, f.candidate, options)
    }
    const f = await input("Foreign component uses files.", { ...context, projectId: "foreign" })
    await store.persistCandidate(f.observation, f.candidate, options)
    await store.recordCaptureGap(context, { host: "pi", reason: "queue-full", count: 2 })
    await store.recordCaptureGap(
      { ...context, projectId: "foreign" },
      { host: "pi", reason: "queue-full", count: 3 },
    )
    const result = await store.learningHistory(context, { limit: 2 })
    expect(result.entries).toHaveLength(2)
    expect(result.limited).toBe(true)
    expect(result.gaps.map((g) => g.count)).toEqual([2])
    expect((await store.learningHistory(context, { limit: 1e6 })).entries).toHaveLength(7)
    expect(await store.learningHistory({ ...context, projectId: "" })).toEqual({
      entries: [],
      gaps: [],
      limited: false,
    })
    const other = new PostgresMemoryProvider({ ...config, id: "different-provider" }, { pool })
    expect(await other.learningHistory(context)).toEqual({ entries: [], gaps: [], limited: false })
  })
  it("keeps body-free audit and confidence after explicit evidence forgetting and shows unavailable sources", async () => {
    const f = await input("Forget worker uses isolated files.")
    await store.persistCandidate(f.observation, f.candidate, options)
    const preview = await store.previewForget(config.id, f.evidence.id, context.projectId)
    expect(preview).toBeDefined()
    await store.confirmForget(preview!.id)
    const result = await new PostgresMemoryProvider(config, { pool }).learningHistory(context)
    expect(result.entries[0]).toMatchObject({
      state: "forgotten",
      availableObservationIds: [],
      confidence: f.candidate.confidence,
    })
    expect(result.entries[0]?.observationIds).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain("isolated files")
  })
  it("records rejected source gaps before any semantic write and never persists unsafe text", async () => {
    const coordinator = new EvidenceCaptureCoordinator(
      store,
      { providerId: config.id, host: "opencode-v2", projectId: context.projectId },
      { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
      1000,
      { log: () => {} },
    )
    for (let i = 0; i < 3; i++)
      coordinator.enqueue({
        providerId: config.id,
        host: "opencode-v2",
        context,
        messageId: `secret-${i}`,
        role: "user",
        origin: "direct-user",
        kind: "turn-completed",
        occurredAt: new Date().toISOString(),
        payload: { text: "password=fixture-secret" },
      })
    await coordinator.idle()
    await coordinator.dispose()
    const history = await store.learningHistory(context)
    expect(history.gaps).toMatchObject([{ reason: "unscreenable-content", count: 3 }])
    expect(history.entries).toHaveLength(0)
    expect(
      (await pool.query<{ n: number }>("SELECT count(*)::integer AS n FROM remem.session_events"))
        .rows[0]?.n,
    ).toBe(0)
    expect(
      JSON.stringify((await pool.query("SELECT * FROM remem.learning_capture_gaps")).rows),
    ).not.toContain("fixture-secret")
  })
  it("expires counters, resets stale totals and rejects invalid/cancelled telemetry", async () => {
    await store.recordCaptureGap(context, { host: "pi", reason: "queue-full", count: 2 })
    await pool.query("UPDATE remem.learning_capture_gaps SET updated_at=now()-interval '31 days'")
    expect((await store.learningHistory(context)).gaps).toHaveLength(0)
    await store.recordCaptureGap(context, { host: "pi", reason: "queue-full", count: 1 })
    expect((await store.learningHistory(context)).gaps[0]?.count).toBe(1)
    await expect(
      store.recordCaptureGap(context, { host: "pi", reason: "queue-full", count: NaN }),
    ).rejects.toThrow()
    const controller = new AbortController()
    controller.abort()
    await expect(store.learningHistory(context, { signal: controller.signal })).rejects.toThrow()
    await expect(
      store.recordCaptureGap(
        context,
        { host: "pi", reason: "queue-full", count: 1 },
        controller.signal,
      ),
    ).rejects.toThrow()
    expect((await store.learningHistory(context)).gaps[0]?.count).toBe(1)
  })
  it("rolls back a counter when cancellation arrives after SQL and before commit", async () => {
    const client = await pool.connect()
    const controller = new AbortController()
    const original = client.query.bind(client)
    const querySpy = vi
      .spyOn(
        client as unknown as { query(text: string, values?: unknown[]): Promise<unknown> },
        "query",
      )
      .mockImplementation(async (text, values) => {
        const result = await original(text, values)
        if (text.startsWith("INSERT INTO remem.learning_capture_gaps")) controller.abort()
        return result
      })
    const connectSpy = vi
      .spyOn(pool as unknown as { connect(): Promise<PoolClient> }, "connect")
      .mockResolvedValueOnce(client)
    try {
      await expect(
        store.recordCaptureGap(
          context,
          { host: "pi", reason: "queue-full", count: 1 },
          controller.signal,
        ),
      ).rejects.toThrow()
    } finally {
      querySpy.mockRestore()
      connectSpy.mockRestore()
    }
    expect((await store.learningHistory(context)).gaps).toHaveLength(0)
  })
})

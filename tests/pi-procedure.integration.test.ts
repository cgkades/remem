import { Pool } from "pg"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { PostgresMemoryProvider } from "../src/providers/postgres.js"
import { runMigrations } from "../src/storage/migrations.js"
import { verifiedProcedureFromEvidence } from "../src/verified-procedure.js"
import { observationFromResolvedTask, extractProcedureCandidate } from "../src/procedure.js"
import { parseConfig } from "../src/config.js"
import { DeterministicConsolidationPipeline } from "../src/consolidation.js"
import { piContext, piEvidence } from "./fixtures/learning/pi-file-recovery.js"
const url = process.env.REMEM_TEST_DATABASE_URL
const integration = url ? describe.sequential : describe.skip
integration("Pi canonical procedure lifecycle", () => {
  const pool = new Pool({ connectionString: url })
  const config = {
    type: "postgres" as const,
    id: "pi-loop",
    connectionString: url ?? "",
    primary: true,
    maxConnections: 4,
    catalogLimit: 100,
  }
  const store = new PostgresMemoryProvider(config, { pool })
  beforeEach(async () => {
    await pool.query("DROP SCHEMA IF EXISTS remem CASCADE")
    await runMigrations(pool)
  })
  afterAll(async () => {
    await pool.end()
  })
  async function fixture() {
    const sources = piEvidence()
    for (const source of sources) await store.appendEvidence(source)
    const window = await store.readProcedureEvidenceWindow(config.id, sources[3]!.id, piContext)
    const episode = verifiedProcedureFromEvidence(window, piContext)!
    const observation = observationFromResolvedTask(episode)!
    const candidate = extractProcedureCandidate(observation, parseConfig({}).config.capture)!
    return { sources, observation, candidate }
  }
  it("reconstructs after restart, authorizes only exact host proof, recovers once and isolates fresh-session recall", async () => {
    const f = await fixture()
    const forged = structuredClone(f.candidate)
    forged.memory.content = "Root cause was a network outage."
    await expect(
      store.persistCandidate(f.observation, forged, {
        autoApprove: true,
        applyLearningPolicy: true,
      }),
    ).rejects.toThrow("does not verify")
    expect(
      await store.persistCandidate(f.observation, f.candidate, {
        autoApprove: true,
        applyLearningPolicy: true,
      }),
    ).toMatchObject({
      status: "approved",
      decision: { rule: "pi-file-recovery-v1", version: "scoped-evidence-learning-v3" },
    })
    const restarted = new PostgresMemoryProvider(config, { pool })
    await Promise.all([
      restarted.recoverLearningCandidates(piContext),
      restarted.recoverLearningCandidates(piContext),
    ])
    expect((await store.candidateLineage(f.candidate.id, piContext))?.state).toBe("promoted")
    expect((await store.recoverLearningCandidates(piContext)).selected).toBe(0)
    const recall = await restarted.search({
      query: "Aurora checkpoint",
      topics: [],
      maxTokens: 4000,
      reason: "test",
      signal: new AbortController().signal,
      context: { ...piContext, sessionId: "fresh-b" },
      limit: 5,
    })
    expect(recall.some((r) => r.record.content.includes("identical native read"))).toBe(true)
    expect(
      await restarted.search({
        query: "Aurora checkpoint",
        topics: [],
        maxTokens: 4000,
        reason: "test",
        signal: new AbortController().signal,
        context: { ...piContext, projectId: "foreign" },
        limit: 5,
      }),
    ).toHaveLength(0)
    expect(
      (await pool.query("SELECT id FROM remem.memories WHERE type='procedure'")).rowCount,
    ).toBe(1)
  })
  it("rechecks forget, replay and cancellation before promotion", async () => {
    const f = await fixture()
    await store.persistCandidate(f.observation, f.candidate, {
      autoApprove: true,
      applyLearningPolicy: true,
    })
    const controller = new AbortController()
    controller.abort()
    await expect(
      store.recoverLearningCandidates(piContext, { signal: controller.signal }),
    ).rejects.toThrow()
    expect((await store.candidateLineage(f.candidate.id, piContext))?.state).toBe("approved")
    const preview = await store.previewForget(config.id, f.sources[0]!.id, piContext.projectId)
    await store.confirmForget(preview!.id)
    expect(await store.appendEvidence(f.sources[0]!)).toMatchObject({ outcome: "forgotten" })
    await store.recoverLearningCandidates(piContext)
    expect(
      (await pool.query("SELECT id FROM remem.memories WHERE type='procedure'")).rowCount,
    ).toBe(0)
  })
  it("returns an approval to review when conflicting file recovery appears before commit", async () => {
    const f = await fixture()
    await store.persistCandidate(f.observation, f.candidate, {
      autoApprove: true,
      applyLearningPolicy: true,
    })
    const prior = await store.write({
      type: "procedure",
      title: "Prior file recovery",
      content: "Prior recovery requires different contents.",
      scope: { kind: "project", id: piContext.projectId },
      metadata: { learningKey: "file-contents:aurora-checkpoint.txt" },
    })
    const pipeline = new DeterministicConsolidationPipeline(store)
    expect((await pipeline.consolidate([{ ...f.candidate, status: "approved" }]))[0]?.status).toBe(
      "pending",
    )
    expect((await store.candidateLineage(f.candidate.id, piContext))?.policyReason).toBe(
      "conflicting-current-knowledge",
    )
    expect((await store.get(prior.id, piContext))?.content).toBe(
      "Prior recovery requires different contents.",
    )
  })

  it("keeps automatic-disabled procedures pending, and bounds failed promotion recovery", async () => {
    const f = await fixture()
    expect(
      await store.persistCandidate(f.observation, f.candidate, {
        autoApprove: false,
        applyLearningPolicy: true,
      }),
    ).toMatchObject({ status: "pending" })
    expect((await store.recoverLearningCandidates(piContext)).selected).toBe(0)
    const pipeline = new DeterministicConsolidationPipeline(store)
    const failure = vi
      .spyOn(store, "withCandidateTransaction")
      .mockRejectedValue(new Error("fixture outage"))
    try {
      expect(
        (await pipeline.consolidate([{ ...f.candidate, status: "approved" }]))[0]?.status,
      ).toBe("approved")
    } finally {
      failure.mockRestore()
    }
    expect((await store.candidateLineage(f.candidate.id, piContext))?.state).toBe("pending")
  })
})

import { Pool } from "pg"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { PostgresMemoryProvider } from "../src/providers/postgres.js"
import { runMigrations } from "../src/storage/migrations.js"
import { modelProposalCandidate } from "../src/model-proposal.js"
import { DeterministicConsolidationPipeline } from "../src/consolidation.js"
import { piContext, piEvidence } from "./fixtures/learning/pi-file-recovery.js"
const url = process.env.REMEM_TEST_DATABASE_URL,
  integration = url ? describe.sequential : describe.skip
const identity = "sha256:" + "a".repeat(64)
integration("server validation of local model quotations", () => {
  const pool = new Pool({ connectionString: url }),
    config = {
      type: "postgres" as const,
      id: "pi-loop",
      primary: true,
      connectionString: url ?? "",
      maxConnections: 4,
      catalogLimit: 100,
    }
  const store = new PostgresMemoryProvider(config, { pool }),
    pipeline = new DeterministicConsolidationPipeline(store)
  beforeEach(async () => {
    await pool.query("DROP SCHEMA IF EXISTS remem CASCADE")
    await runMigrations(pool)
  })
  afterAll(async () => {
    await pool.end()
  })
  async function fixture(content = "checkpoint ready\n") {
    const evidence = piEvidence()
    for (const e of evidence) await store.appendEvidence(e)
    return {
      ...modelProposalCandidate({ content, sourceIds: ["3"], confidence: 1 }, evidence, identity),
      evidence,
    }
  }
  it("requires review even at confidence one and autoApprove true; reviewed recall remains attributed after restart", async () => {
    const f = await fixture()
    expect(
      await store.persistCandidate(f.observation, f.candidate, {
        applyLearningPolicy: true,
        autoApprove: true,
      }),
    ).toMatchObject({
      status: "pending",
      decision: { outcome: "require-review", reason: "model-source-selection-requires-review" },
    })
    expect((await pipeline.consolidate([{ ...f.candidate, status: "approved" }]))[0]?.status).toBe(
      "approved",
    )
    expect((await pool.query("SELECT id FROM remem.memories")).rowCount).toBe(0)
    await store.reviewCandidate(f.candidate.id, "approved")
    expect((await pipeline.consolidate([{ ...f.candidate, status: "approved" }]))[0]?.status).toBe(
      "promoted",
    )
    const restarted = new PostgresMemoryProvider(config, { pool })
    const lineage = await restarted.candidateLineage(f.candidate.id, {
      ...piContext,
      sessionId: "fresh",
    })
    expect(lineage?.state).toBe("promoted")
    const rows = await pool.query<{ content: string }>("SELECT content FROM remem.memories")
    expect(rows.rows[0]?.content).toBe(f.candidate.memory.content)
  })
  it("keeps unsupported causal conclusions episodic-only without storing candidate bodies", async () => {
    const f = await fixture("An upstream DNS failure caused the missing checkpoint.")
    expect(
      await store.persistCandidate(f.observation, f.candidate, {
        applyLearningPolicy: true,
        autoApprove: true,
      }),
    ).toMatchObject({ status: "rejected", decision: { outcome: "episodic-only" } })
    expect((await pool.query("SELECT id FROM remem.candidate_memories")).rowCount).toBe(0)
    expect((await pool.query("SELECT id FROM remem.memories")).rowCount).toBe(0)
    expect(
      JSON.stringify((await pool.query("SELECT * FROM remem.candidate_lineage")).rows),
    ).not.toContain("DNS")
  })
  it("rejects altered, foreign or forgotten evidence and cannot recreate a forgotten proposal", async () => {
    const f = await fixture(),
      altered = structuredClone(f.candidate)
    altered.memory.content = "Credential policy is approved."
    await expect(
      store.persistCandidate(f.observation, altered, { applyLearningPolicy: true }),
    ).rejects.toThrow()
    await expect(
      store.persistCandidate(
        { ...f.observation, context: { ...piContext, projectId: "foreign" } },
        f.candidate,
        { applyLearningPolicy: true },
      ),
    ).rejects.toThrow()
    await store.persistCandidate(f.observation, f.candidate, { applyLearningPolicy: true })
    const preview = await store.previewForget(config.id, f.evidence[3]!.id, piContext.projectId)
    await store.confirmForget(preview!.id)
    await expect(
      store.persistCandidate(f.observation, f.candidate, { applyLearningPolicy: true }),
    ).rejects.toThrow()
    expect((await pool.query("SELECT id FROM remem.memories")).rowCount).toBe(0)
  })
  it("replays unchanged pending proposals idempotently and cancels before durable mutations", async () => {
    const f = await fixture(),
      controller = new AbortController()
    controller.abort()
    await expect(
      store.persistCandidate(f.observation, f.candidate, {
        applyLearningPolicy: true,
        signal: controller.signal,
      }),
    ).rejects.toThrow()
    expect((await pool.query("SELECT id FROM remem.candidate_memories")).rowCount).toBe(0)
    await store.persistCandidate(f.observation, f.candidate, { applyLearningPolicy: true })
    const lineage = await store.candidateLineage(f.candidate.id, piContext)
    await store.persistCandidate(f.observation, f.candidate, { applyLearningPolicy: true })
    expect(await store.candidateLineage(f.candidate.id, piContext)).toEqual(lineage)
    expect(await store.readModelEvidenceWindow({ ...piContext, projectId: "foreign" })).toEqual([])
    await expect(store.readModelEvidenceWindow(piContext, controller.signal)).rejects.toThrow()
  })
})

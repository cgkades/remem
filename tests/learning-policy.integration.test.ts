import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DeterministicCandidateExtractor } from "../src/capture.js"
import { parseConfig } from "../src/config.js"
import {
  DeterministicConsolidationPipeline,
  PostgresConsolidationRunner,
} from "../src/consolidation.js"
import { admitEvidence, DEFAULT_EVIDENCE_ADMISSION_CONFIG } from "../src/observation-admission.js"
import type { SessionObservation } from "../src/observation.js"
import { PostgresMemoryProvider } from "../src/providers/postgres.js"
import { runMigrations } from "../src/storage/migrations.js"

const databaseUrl = process.env.REMEM_TEST_DATABASE_URL
const integration = databaseUrl ? describe.sequential : describe.skip
const context = {
  directory: "/repo",
  worktree: "/repo",
  projectId: "policy-project",
  sessionId: "policy-session",
}
const config = {
  type: "postgres" as const,
  id: "policy-store",
  connectionString: databaseUrl ?? "",
  primary: true,
  maxConnections: 4,
  catalogLimit: 100,
}
const options = { applyLearningPolicy: true, autoApprove: true }

integration("server learning authorization and audit", () => {
  const pool = new Pool({ connectionString: databaseUrl })
  const store = new PostgresMemoryProvider(config, { pool })
  const pipeline = new DeterministicConsolidationPipeline(store)
  beforeAll(async () => {
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
      source: "remem://opencode-v2/sessions/policy-session",
      payload: {
        host: "opencode-v2",
        messageId: result.envelope.messageId,
        text,
        evidenceRefs: [{ providerId: config.id, eventId: result.envelope.id }],
      },
    }
    const candidates = await extractor.extract([observation])
    return { observation, candidate: candidates[0]!, candidates, evidence: result.envelope }
  }

  it("automatically promotes original supported assertions with durable policy snapshots", async () => {
    const f = await input(
      "Phoenix worker uses local checkpoint files. We decided to use isolated directories for Phoenix.",
    )
    expect(f.candidates).toHaveLength(2)
    for (const candidate of f.candidates) {
      const receipt = await store.persistCandidate(f.observation, candidate, options)
      expect(receipt).toMatchObject({
        status: "approved",
        decision: { outcome: "auto-promote", rule: "original-user-assertion-v1" },
      })
      const saved = await pool.query<{ metadata: { memory: { summary: string } } }>(
        "SELECT metadata FROM remem.candidate_memories WHERE id=$1",
        [candidate.id],
      )
      expect(saved.rows[0]?.metadata.memory.summary).toBe(candidate.memory.summary)
      expect((await pipeline.consolidate([{ ...candidate, status: "approved" }]))[0]?.status).toBe(
        "promoted",
      )
      const lineage = await store.candidateLineage(candidate.id, context)
      expect(lineage).toMatchObject({
        state: "promoted",
        policyVersion: "scoped-evidence-learning-v1",
        policyOutcome: "auto-promote",
      })
      const audit = await pool.query<{ policy_version: string; policy_outcome: string }>(
        "SELECT policy_version,policy_outcome FROM remem.candidate_lineage_audit WHERE candidate_id=$1 ORDER BY revision",
        [candidate.id],
      )
      expect(audit.rows).toHaveLength(2)
      expect(
        audit.rows.every(
          (row) =>
            row.policy_version === "scoped-evidence-learning-v1" &&
            row.policy_outcome === "auto-promote",
        ),
      ).toBe(true)
    }
  })

  it("preserves human review for corrections and high-impact original-user statements", async () => {
    for (const text of [
      "Actually, Phoenix worker uses shared checkpoint files.",
      "We decided to use shared files for production Phoenix.",
    ]) {
      const f = await input(text)
      expect(await store.persistCandidate(f.observation, f.candidate, options)).toMatchObject({
        status: "pending",
        decision: { outcome: "require-review" },
      })
      expect(
        (await pipeline.consolidate([{ ...f.candidate, status: "approved" }]))[0]?.status,
      ).toBe("approved")
      expect((await store.candidateLineage(f.candidate.id, context))?.state).toBe("pending")
    }
  })

  it("retains only body-free rejected/episodic-only decisions for forged candidates without deleting source evidence", async () => {
    for (const [content, outcome] of [
      ["Unsupported root cause: network outage.", "episodic-only"],
      ["password=fixture-secret", "reject"],
    ]) {
      const f = await input("Forged worker uses local files.")
      f.candidate.memory.content = content!
      expect(await store.persistCandidate(f.observation, f.candidate, options)).toMatchObject({
        status: "rejected",
        decision: { outcome },
      })
      expect((await store.candidateLineage(f.candidate.id, context))?.policyOutcome).toBe(outcome)
      expect(
        (await pool.query("SELECT id FROM remem.candidate_memories WHERE id=$1", [f.candidate.id]))
          .rowCount,
      ).toBe(0)
      expect(await store.readEvidence(config.id, f.evidence.id, context)).toBeDefined()
      const durable = await pool.query(
        "SELECT * FROM remem.candidate_lineage WHERE candidate_id=$1",
        [f.candidate.id],
      )
      expect(JSON.stringify(durable.rows)).not.toContain(content)
    }
  })

  it("returns a formerly authorized candidate to review when conflicting knowledge appears before commit", async () => {
    const f = await input("Conflict worker uses local files.")
    expect(await store.persistCandidate(f.observation, f.candidate, options)).toMatchObject({
      status: "approved",
    })
    const existing = await store.write({
      type: "semantic",
      title: "Conflict worker",
      content: "Conflict worker uses remote files.",
      scope: { kind: "project", id: context.projectId },
    })
    const result = await pipeline.consolidate([{ ...f.candidate, status: "approved" }])
    expect(result[0]?.status).toBe("pending")
    expect(await store.candidateLineage(f.candidate.id, context)).toMatchObject({
      state: "pending",
      policyOutcome: "require-review",
      policyReason: "conflicting-current-knowledge",
    })
    expect((await store.get(existing.id, context))?.content).toBe(
      "Conflict worker uses remote files.",
    )
  })

  it("rechecks the automatic-learning age boundary at promotion", async () => {
    const f = await input("Expiry worker uses local files.")
    await store.persistCandidate(f.observation, f.candidate, options)
    const future = Date.now() + 48 * 60 * 60 * 1000
    const clock = vi.spyOn(Date, "now").mockReturnValue(future)
    try {
      expect(
        (await pipeline.consolidate([{ ...f.candidate, status: "approved" }]))[0]?.status,
      ).toBe("pending")
    } finally {
      clock.mockRestore()
    }
    expect((await store.candidateLineage(f.candidate.id, context))?.policyReason).toBe(
      "evidence-outside-automatic-learning-window",
    )
  })

  it("recovers an approved policy receipt interrupted before semantic consolidation", async () => {
    const f = await input("Recovery worker uses isolated local files.")
    await store.persistCandidate(f.observation, f.candidate, options)
    const runner = new PostgresConsolidationRunner(pool, pipeline, 5, 15 * 60_000, config.id)
    const result = await runner.run()
    expect(result.promoted).toBe(1)
    const lineage = await store.candidateLineage(f.candidate.id, context)
    expect(lineage).toMatchObject({ state: "promoted", policyOutcome: "auto-promote" })
    expect((await runner.run()).promoted).toBe(0)
    expect(await store.candidateLineage(f.candidate.id, context)).toEqual(lineage)
  })

  it("recovers only current-project canonical policy approvals, concurrently and without replay mutation", async () => {
    const f = await input("Startup worker uses isolated local files.")
    const foreign = await input("Foreign startup worker uses isolated local files.", {
      ...context,
      projectId: "foreign-project",
    })
    const pending = await input("Actually, startup worker uses shared files.")
    for (const item of [f, foreign, pending])
      await store.persistCandidate(item.observation, item.candidate, options)
    const runs = await Promise.all([
      store.recoverLearningCandidates(context),
      store.recoverLearningCandidates(context),
    ])
    expect(runs.every((run) => run.failed === 0)).toBe(true)
    expect((await store.candidateLineage(f.candidate.id, context))?.state).toBe("promoted")
    expect(
      (await store.candidateLineage(foreign.candidate.id, foreign.observation.context))?.state,
    ).toBe("approved")
    expect((await store.candidateLineage(pending.candidate.id, context))?.state).toBe("pending")
    const lineage = await store.candidateLineage(f.candidate.id, context)
    expect((await store.recoverLearningCandidates(context)).selected).toBe(0)
    expect(await store.candidateLineage(f.candidate.id, context)).toEqual(lineage)
  })

  it("never recovers a legacy approval or an aborted recovery request", async () => {
    const f = await input("Legacy startup worker uses local files.")
    await store.persistCandidate(f.observation, f.candidate, { autoApprove: true })
    expect((await store.recoverLearningCandidates(context)).selected).toBe(0)
    expect((await store.candidateLineage(f.candidate.id, context))?.state).toBe("approved")
    const current = await input("Cancelled startup worker uses local files.")
    await store.persistCandidate(current.observation, current.candidate, options)
    const controller = new AbortController()
    controller.abort()
    await expect(
      store.recoverLearningCandidates(context, { signal: controller.signal }),
    ).rejects.toThrow()
    expect((await store.candidateLineage(current.candidate.id, context))?.state).toBe("approved")
  })
})

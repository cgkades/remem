import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DeterministicCandidateExtractor } from "../src/capture.js"
import { DeterministicConsolidationPipeline } from "../src/consolidation.js"
import { parseConfig } from "../src/config.js"
import {
  admitEvidence,
  DEFAULT_EVIDENCE_ADMISSION_CONFIG,
  type EvidenceEnvelope,
} from "../src/observation-admission.js"
import type { SessionObservation } from "../src/observation.js"
import { PostgresMemoryProvider } from "../src/providers/postgres.js"
import { runMigrations } from "../src/storage/migrations.js"

const databaseUrl = process.env.REMEM_TEST_DATABASE_URL
const integration = databaseUrl ? describe.sequential : describe.skip
const context = {
  directory: "/repo",
  worktree: "/repo",
  projectId: "canonical-project",
  sessionId: "session-a",
}
const config = {
  type: "postgres" as const,
  id: "canonical",
  connectionString: databaseUrl ?? "",
  primary: true,
  maxConnections: 4,
  catalogLimit: 100,
}
const text = "Phoenix worker uses cwd-relative checkpoint paths."

function envelope(overrides: Partial<EvidenceEnvelope> = {}): EvidenceEnvelope {
  const raw = {
    providerId: config.id,
    host: "opencode-v2",
    context,
    messageId: randomUUID(),
    role: "user" as const,
    origin: "direct-user" as const,
    kind: "turn-completed" as const,
    occurredAt: new Date().toISOString(),
    payload: { text },
    ...overrides,
  }
  const result = admitEvidence(
    raw,
    { providerId: raw.providerId, host: raw.host, projectId: raw.context.projectId },
    { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
  )
  if (result.outcome !== "admitted") throw new Error("fixture admission failed")
  return result.envelope
}

async function capture(evidence: EvidenceEnvelope[]) {
  const observation: SessionObservation = {
    id: randomUUID(),
    kind: "fact-discovered",
    context,
    occurredAt: new Date().toISOString(),
    source: "remem://opencode-v2/sessions/session-a",
    payload: {
      host: "opencode-v2",
      text,
      messageId: randomUUID(),
      evidenceRefs: evidence.map((e) => ({ providerId: e.providerId, eventId: e.id })),
    },
  }
  const [candidate] = await new DeterministicCandidateExtractor(
    parseConfig({}).config.capture,
  ).extract([observation], new AbortController().signal)
  if (!candidate) throw new Error("fixture extraction failed")
  return { observation, candidate }
}

integration("canonical candidate evidence", () => {
  const pool = new Pool({ connectionString: databaseUrl })
  const store = new PostgresMemoryProvider(config, { pool })
  beforeAll(async () => {
    await pool.query("DROP SCHEMA IF EXISTS remem CASCADE")
    await runMigrations(pool)
  })
  afterAll(async () => {
    await pool.end()
  })

  async function expectNoCapture(input: Awaited<ReturnType<typeof capture>>) {
    expect(
      (
        await pool.query("SELECT id FROM remem.candidate_memories WHERE id=$1", [
          input.candidate.id,
        ])
      ).rowCount,
    ).toBe(0)
    expect(
      (await pool.query("SELECT id FROM remem.session_events WHERE id=$1", [input.observation.id]))
        .rowCount,
    ).toBe(0)
    expect(await store.candidateLineage(input.candidate.id, context)).toBeUndefined()
  }

  it("uses the canonical source row and ledger IDs rather than duplicating legacy observations", async () => {
    const source = envelope()
    await store.appendEvidence(source)
    const input = await capture([source])
    await store.persistCandidate(input.observation, input.candidate, { autoApprove: true })
    const result = await pool.query<{
      id: string
      session_event_id: string
      metadata: { observationIds: string[] }
    }>(
      `SELECT e.id,c.session_event_id,c.metadata FROM remem.candidate_memories c
       JOIN remem.session_events e ON e.evidence_id=$2 WHERE c.id=$1`,
      [input.candidate.id, source.id],
    )
    const row = result.rows[0]!
    expect(row.session_event_id).toBe(row.id)
    expect(row.metadata.observationIds).toEqual([row.id])
    expect(
      (await store.candidateLineage(input.candidate.id, context))?.availableObservationIds,
    ).toEqual([row.id])
    expect(
      (await pool.query("SELECT id FROM remem.session_events WHERE id=$1", [input.observation.id]))
        .rowCount,
    ).toBe(0)
    const pipeline = new DeterministicConsolidationPipeline(store)
    expect(
      (await pipeline.consolidate([{ ...input.candidate, status: "approved" }]))[0]?.status,
    ).toBe("promoted")
    const before = await store.candidateLineage(input.candidate.id, context)
    await store.persistCandidate(input.observation, input.candidate, { autoApprove: true })
    expect(await store.candidateLineage(input.candidate.id, context)).toEqual(before)
  })

  it("fails closed for absent, foreign provider/project/session/host and malformed references", async () => {
    const cases = [
      envelope(),
      envelope({ providerId: "foreign" }),
      envelope({ context: { ...context, projectId: "foreign" } }),
      envelope({ context: { ...context, sessionId: "foreign" } }),
      envelope({ host: "pi" }),
    ]
    for (const [index, source] of cases.entries()) {
      if (index !== 0) await store.appendEvidence(source)
      const input = await capture([source])
      await expect(
        store.persistCandidate(input.observation, input.candidate, { autoApprove: true }),
      ).rejects.toThrow("candidate evidence")
      await expectNoCapture(input)
    }
    const source = envelope()
    await store.appendEvidence(source)
    for (const refs of [
      [],
      true,
      [{ providerId: config.id, eventId: "not-an-id" }],
      Array.from({ length: 17 }, () => ({ providerId: config.id, eventId: source.id })),
    ]) {
      const input = await capture([source])
      input.observation.payload.evidenceRefs = refs
      await expect(store.persistCandidate(input.observation, input.candidate)).rejects.toThrow(
        "candidate evidence",
      )
      await expectNoCapture(input)
    }
  })

  it("can refresh a pending legacy capture with canonical links using its expected revision", async () => {
    const source = envelope()
    await store.appendEvidence(source)
    const input = await capture([source])
    const legacy = structuredClone(input)
    delete legacy.observation.payload.evidenceRefs
    delete legacy.candidate.memory.provenance![0]!.source.metadata!.evidenceRefs
    await store.persistCandidate(legacy.observation, legacy.candidate)
    await expect(store.persistCandidate(input.observation, input.candidate)).rejects.toThrow(
      "revision conflict",
    )
    await store.persistCandidate(input.observation, input.candidate, { expectedRevision: 0 })
    const lineage = await store.candidateLineage(input.candidate.id, context)
    expect(lineage?.revision).toBe(1)
    expect(lineage?.observationIds).not.toContain(input.observation.id)
    expect(lineage?.availableObservationIds).toEqual(lineage?.observationIds)
  })

  it("rejects changed or compacted source bodies and unsupported user authority", async () => {
    const source = envelope()
    await store.appendEvidence(source)
    const corrupted = await capture([source])
    await pool.query(
      "UPDATE remem.session_events SET safe_text='Compacted unrelated body' WHERE evidence_id=$1",
      [source.id],
    )
    await expect(
      store.persistCandidate(corrupted.observation, corrupted.candidate),
    ).rejects.toThrow("candidate evidence")
    await expectNoCapture(corrupted)
    const tool = envelope({
      role: "tool",
      origin: "host-observed",
      kind: "tool-result",
      payload: { text, metadata: { tool: "read", status: "completed" } },
    })
    await store.appendEvidence(tool)
    const unsupported = await capture([tool])
    await expect(
      store.persistCandidate(unsupported.observation, unsupported.candidate),
    ).rejects.toThrow("does not support")
    await expectNoCapture(unsupported)
    const valid = envelope()
    await store.appendEvidence(valid)
    const different = await capture([valid])
    different.observation.payload.text = "Unrelated original assertion."
    await expect(
      store.persistCandidate(different.observation, different.candidate),
    ).rejects.toThrow("does not support")
    await expectNoCapture(different)
  })

  it("rejects mismatched provenance instead of attaching a decorative evidence reference", async () => {
    const source = envelope()
    await store.appendEvidence(source)
    const input = await capture([source])
    input.candidate.memory.provenance![0]!.source.metadata!.evidenceRefs = [
      { providerId: config.id, eventId: envelope().id },
    ]
    await expect(store.persistCandidate(input.observation, input.candidate)).rejects.toThrow(
      "candidate evidence",
    )
    await expectNoCapture(input)
  })

  it("does not promote a captured candidate whose supporting evidence vanished before commit", async () => {
    const source = envelope()
    await store.appendEvidence(source)
    const input = await capture([source])
    await store.persistCandidate(input.observation, input.candidate, { autoApprove: true })
    const before = await store.candidateLineage(input.candidate.id, context)
    await pool.query("DELETE FROM remem.session_events WHERE evidence_id=$1", [source.id])
    const result = (
      await new DeterministicConsolidationPipeline(store).consolidate([
        { ...input.candidate, status: "approved" },
      ])
    )[0]
    expect(result?.status).toBe("approved")
    expect(result?.reasons.join(" ")).toContain("candidate evidence is unavailable")
    const after = await store.candidateLineage(input.candidate.id, context)
    expect(after?.state).toBe("approved")
    expect(after?.revision).toBe(before?.revision)
    expect(after?.memoryId).toBeUndefined()
  })

  it("forgets a secondary supporting source with preview confirmation while preserving semantic memory", async () => {
    const sources = [envelope(), envelope()]
    for (const source of sources) await store.appendEvidence(source)
    const input = await capture(sources)
    await store.persistCandidate(input.observation, input.candidate, { autoApprove: true })
    await new DeterministicConsolidationPipeline(store).consolidate([
      { ...input.candidate, status: "approved" },
    ])
    const before = await store.candidateLineage(input.candidate.id, context)
    expect(before?.observationIds).toHaveLength(2)
    const preview = await store.previewForget(config.id, sources[1]!.id, context.projectId)
    expect(preview?.candidateCount).toBe(1)
    expect(preview?.semanticMemoryCount).toBe(0)
    await store.confirmForget(preview!.id)
    const after = await store.candidateLineage(input.candidate.id, context)
    expect(after?.state).toBe("forgotten")
    expect(after?.availableObservationIds).toHaveLength(1)
    expect(after?.observationIds).toEqual(before?.observationIds)
    expect((await store.get(before!.memoryId!, context))?.content).toBe(text)
    await expect(
      store.persistCandidate(input.observation, input.candidate, { autoApprove: true }),
    ).rejects.toThrow("candidate evidence")
    expect(
      (
        await pool.query("SELECT id FROM remem.candidate_memories WHERE id=$1", [
          input.candidate.id,
        ])
      ).rowCount,
    ).toBe(0)
  })

  it("invalidates an old preview when a secondary evidence association is captured", async () => {
    const sources = [envelope(), envelope()]
    for (const source of sources) await store.appendEvidence(source)
    const preview = await store.previewForget(config.id, sources[1]!.id, context.projectId)
    expect(preview?.candidateCount).toBe(0)
    const input = await capture(sources)
    await store.persistCandidate(input.observation, input.candidate)
    await expect(store.confirmForget(preview!.id)).rejects.toThrow("preview changed")
    expect(await store.readEvidence(config.id, sources[1]!.id, context)).toBeDefined()
    expect((await store.candidateLineage(input.candidate.id, context))?.state).toBe("pending")
  })
})

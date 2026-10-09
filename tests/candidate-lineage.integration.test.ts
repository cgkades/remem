import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  DeterministicConsolidationPipeline,
  PostgresConsolidationRunner,
} from "../src/consolidation.js"
import { PostgresMemoryProvider } from "../src/providers/postgres.js"
import { runMigrations } from "../src/storage/migrations.js"
import { LocalHashEmbeddingModel } from "../src/storage/embedding.js"
import { admitEvidence, DEFAULT_EVIDENCE_ADMISSION_CONFIG } from "../src/observation-admission.js"
import type { CandidateMemory, SessionObservation } from "../src/observation.js"

const databaseUrl = process.env.REMEM_TEST_DATABASE_URL
const integration = databaseUrl ? describe.sequential : describe.skip
const context = {
  directory: "/repo",
  worktree: "/repo",
  projectId: "lineage",
  sessionId: "session-a",
}
const config = {
  type: "postgres" as const,
  id: "lineage",
  connectionString: databaseUrl ?? "",
  primary: true,
  maxConnections: 8,
  catalogLimit: 100,
}
function candidate(title = `Checkpoint ${randomUUID()}`): CandidateMemory {
  return {
    id: randomUUID(),
    observationIds: [],
    status: "approved",
    confidence: 0.9,
    reasons: ["fixture"],
    memory: {
      title,
      content: "Checkpoint paths are relative to the workspace.",
      type: "semantic",
      scope: { kind: "project", id: context.projectId },
    },
  }
}
function observation(): SessionObservation {
  return {
    id: randomUUID(),
    context,
    kind: "fact-discovered",
    occurredAt: "2026-10-01T12:00:00.000Z",
    source: "remem://opencode-v2/sessions/session-a",
    payload: { host: "opencode-v2" },
  }
}
function memoryId(result: CandidateMemory | undefined): string {
  const data = result?.memory.metadata?.consolidation
  if (!data || typeof data !== "object" || !("memoryId" in data))
    throw new Error("missing promoted identity")
  return String(data.memoryId)
}

integration("durable managed candidate lineage", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 })
  const provider = () => new PostgresMemoryProvider(config, { pool })
  const legacyFirst = randomUUID()
  const legacyMiddle = randomUUID()
  const legacyLast = randomUUID()
  const legacyObservation = randomUUID()
  beforeAll(async () => {
    await pool.query("DROP SCHEMA IF EXISTS remem CASCADE")
    const directory = await mkdtemp(path.join(os.tmpdir(), "remem-old-lineage-"))
    try {
      for (const file of await readdir("migrations")) {
        if (/^00(?:0[1-9]|1[0-2])_.*\.sql$/u.test(file))
          await copyFile(path.join("migrations", file), path.join(directory, file))
      }
      await runMigrations(pool, directory)
      await provider().write({
        ...candidate("Retained legacy fixture").memory,
        metadata: { consolidation: { candidateId: legacyFirst, lastCandidateId: legacyLast } },
      })
      await pool.query(
        `INSERT INTO remem.session_events (id,session_id,project_id,kind,occurred_at,payload)
        VALUES ($1,$2,$3,'fact-discovered',now(),'{}')`,
        [legacyObservation, context.sessionId, context.projectId],
      )
      await pool.query(
        `INSERT INTO remem.candidate_memories
        (id,session_event_id,type,title,content,scope_kind,scope_id,confidence,status,metadata)
        VALUES ($1,$2,'semantic','Legacy capture','Legacy body','project',$3,0.9,'promoted',$4)`,
        [legacyFirst, legacyObservation, context.projectId, { providerId: config.id }],
      )
      await runMigrations(pool)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  afterAll(async () => {
    await pool.end()
  })

  it("migrates retained legacy associations without inventing lost intermediate merges", async () => {
    const first = await provider().candidateLineage(legacyFirst, context)
    const last = await provider().candidateLineage(legacyLast, context)
    expect(first).toMatchObject({ state: "promoted" })
    expect(last?.memoryId).toBe(first?.memoryId)
    expect(first?.audit.some((row) => row.action === "legacy-retained-association")).toBe(true)
    expect(first?.observationIds).toEqual([legacyObservation])
    expect(await provider().candidateLineage(legacyMiddle, context)).toBeUndefined()
  })

  it("retains every merged candidate across restart, manual edit, supersession and deletion", async () => {
    const store = provider()
    const pipeline = new DeterministicConsolidationPipeline(store)
    const first = candidate()
    const inputs = [first, { ...first, id: randomUUID() }, { ...first, id: randomUUID() }]
    const results = await pipeline.consolidate(inputs)
    expect(results.map((r) => r.status)).toEqual(["promoted", "promoted", "promoted"])
    const id = memoryId(results[0])
    expect(results.map(memoryId)).toEqual([id, id, id])
    await store.update(
      id,
      { ...first.memory, content: "Human-reviewed richer explanation." },
      { context },
    )
    const restarted = new DeterministicConsolidationPipeline(provider())
    const replay = await restarted.consolidate(inputs)
    expect(replay.every((r) => r.memory.content === "Human-reviewed richer explanation.")).toBe(
      true,
    )
    const replacement = await store.supersede(
      id,
      { ...first.memory, content: "Current replacement." },
      { context },
    )
    await restarted.consolidate(inputs)
    expect((await store.get(id, context))?.freshness).toBe("superseded")
    expect((await store.get(replacement.id, context))?.content).toBe("Current replacement.")
    await store.delete(id, context)
    const retired = await restarted.consolidate(inputs)
    expect(retired.every((r) => r.status === "expired")).toBe(true)
    expect(await store.get(id, context)).toBeUndefined()
    for (const input of inputs) {
      const ledger = await store.candidateLineage(input.id, context)
      expect(ledger).toMatchObject({ state: "expired", memoryId: id })
      expect(ledger?.audit.some((row) => row.action === "memory-deleted")).toBe(true)
      expect(JSON.stringify(ledger)).not.toContain("Human-reviewed")
      expect(
        await store.candidateLineage(input.id, { ...context, projectId: "foreign" }),
      ).toBeUndefined()
    }
  })

  it("reuses provenance IDs only for the same source identity and provider", async () => {
    const store = provider()
    const written = await store.write(candidate("Source identity fixture").memory)
    const source = (await store.get(written.id, context))?.provenance?.[0]?.source
    if (!source?.id) throw new Error("missing durable source identity")
    const provenance = [{ source, capturedAt: "2026-10-01T12:00:00.000Z", original: true }]
    await expect(store.write({ ...candidate().memory, provenance })).resolves.toBeDefined()
    await expect(
      store.write({
        ...candidate().memory,
        provenance: [{ ...provenance[0]!, source: { ...source, uri: "remem://forged-source" } }],
      }),
    ).rejects.toThrow("source identity")
    const foreign = new PostgresMemoryProvider(
      { ...config, id: "foreign-source-provider" },
      { pool },
    )
    await expect(foreign.write({ ...candidate().memory, provenance })).rejects.toThrow(
      "source identity",
    )
  })

  it("serializes concurrent first delivery across independent providers", async () => {
    const input = candidate()
    const results = await Promise.all(
      [provider(), provider()].map((store) =>
        new DeterministicConsolidationPipeline(store).consolidate([input]),
      ),
    )
    expect(results.map((r) => r[0]?.status)).toEqual(["promoted", "promoted"])
    expect(memoryId(results[0]?.[0])).toBe(memoryId(results[1]?.[0]))
    expect(
      (await pool.query("SELECT id FROM remem.memories WHERE title=$1", [input.memory.title]))
        .rowCount,
    ).toBe(1)
    const ledger = await provider().candidateLineage(input.id, context)
    expect(ledger?.audit.filter((row) => row.state === "promoted")).toHaveLength(1)
  })

  it("rolls back semantic state, projections and audit if finalization fails", async () => {
    const input = candidate()
    // A database fault after writeWithClient has inserted memory, catalog and
    // embedding rows, but before the association finalizes, models interruption.
    await pool.query(`CREATE FUNCTION remem.test_lineage_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.candidate_id='${input.id}'::uuid AND NEW.state='promoted' THEN
        RAISE EXCEPTION 'injected finalization failure'; END IF; RETURN NEW; END $$`)
    await pool.query(
      "CREATE TRIGGER test_lineage_fault BEFORE UPDATE ON remem.candidate_lineage FOR EACH ROW EXECUTE FUNCTION remem.test_lineage_fault()",
    )
    const pipeline = new DeterministicConsolidationPipeline(provider())
    try {
      expect((await pipeline.consolidate([input]))[0]?.status).toBe("approved")
      expect(
        (await pool.query("SELECT id FROM remem.memories WHERE title=$1", [input.memory.title]))
          .rowCount,
      ).toBe(0)
      expect(
        (
          await pool.query("SELECT id FROM remem.catalog_entries WHERE title=$1", [
            input.memory.title,
          ])
        ).rowCount,
      ).toBe(0)
      expect(await provider().candidateLineage(input.id, context)).toBeUndefined()
      expect(
        (
          await pool.query("SELECT id FROM remem.candidate_lineage_audit WHERE candidate_id=$1", [
            input.id,
          ])
        ).rowCount,
      ).toBe(0)
    } finally {
      await pool.query("DROP TRIGGER test_lineage_fault ON remem.candidate_lineage")
      await pool.query("DROP FUNCTION remem.test_lineage_fault()")
    }
    expect((await pipeline.consolidate([input]))[0]?.status).toBe("promoted")
  })

  it("retains committed promotion when the batch runner is interrupted after commit", async () => {
    const store = provider()
    const event = observation()
    const input = { ...candidate(), status: "pending" as const, observationIds: [event.id] }
    await store.persistCandidate(event, input, { autoApprove: true })
    const pipeline = new DeterministicConsolidationPipeline(store)
    const runner = new PostgresConsolidationRunner(
      pool,
      {
        consolidate: async (items) => {
          await pipeline.consolidate(items)
          throw new Error("interrupted after commit")
        },
      },
      50,
      1,
      config.id,
    )
    expect((await runner.run()).status).toBe("failed")
    expect((await store.candidateLineage(input.id, context))?.state).toBe("promoted")
    expect((await store.consolidateCandidates()).candidates).toBe(0)
    expect((await pipeline.consolidate([{ ...input, status: "approved" }]))[0]?.reasons).toContain(
      "reused processed candidate",
    )
  })

  it("requires pending revision matches and one review winner; rejects forged approval", async () => {
    const store = provider()
    const event = observation()
    const input = { ...candidate(), status: "pending" as const, observationIds: [event.id] }
    await store.persistCandidate(event, input)
    const pipeline = new DeterministicConsolidationPipeline(store)
    expect((await pipeline.consolidate([{ ...input, status: "approved" }]))[0]?.status).toBe(
      "approved",
    )
    expect(
      (await pool.query("SELECT id FROM remem.memories WHERE title=$1", [input.memory.title]))
        .rowCount,
    ).toBe(0)
    const changed = { ...input, memory: { ...input.memory, content: "Updated extraction." } }
    await expect(store.persistCandidate(event, changed)).rejects.toThrow("revision conflict")
    await store.persistCandidate(event, changed, { expectedRevision: 0 })
    await expect(store.reviewCandidate(input.id, "approved", 0)).rejects.toThrow(
      "revision conflict",
    )
    const reviews = await Promise.allSettled([
      store.reviewCandidate(input.id, "rejected", 1),
      provider().reviewCandidate(input.id, "rejected", 1),
    ])
    expect(reviews.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    await store.persistCandidate(event, input, { autoApprove: true })
    expect((await pipeline.consolidate([{ ...input, status: "approved" }]))[0]?.status).toBe(
      "rejected",
    )
    expect((await store.candidateLineage(input.id, context))?.state).toBe("rejected")
  })

  it("uses the reviewed durable body instead of a caller's replacement text", async () => {
    const store = provider()
    const event = observation()
    const input = { ...candidate(), status: "pending" as const, observationIds: [event.id] }
    await store.persistCandidate(event, input)
    await store.reviewCandidate(input.id, "approved", 0)
    const forged = {
      ...input,
      status: "approved" as const,
      memory: { ...input.memory, content: "Caller supplied unsupported replacement." },
    }
    const result = (await new DeterministicConsolidationPipeline(store).consolidate([forged]))[0]
    expect(result?.status).toBe("promoted")
    expect((await store.get(memoryId(result), context))?.content).toBe(input.memory.content)
  })

  it("retains a body-free expired decision and suppresses later approval replay", async () => {
    const store = provider()
    const event = observation()
    const input = { ...candidate(), status: "pending" as const, observationIds: [event.id] }
    await store.persistCandidate(event, input)
    await pool.query("UPDATE remem.candidate_memories SET status='expired' WHERE id=$1", [input.id])
    await store.persistCandidate(event, input, { autoApprove: true })
    expect(
      (
        await new DeterministicConsolidationPipeline(store).consolidate([
          { ...input, status: "approved" },
        ])
      )[0]?.status,
    ).toBe("expired")
    expect((await store.candidateLineage(input.id, context))?.audit[0]?.action).toBe(
      "candidate-expired",
    )
  })

  it("replans a serialization conflict without overwriting a concurrent manual edit", async () => {
    const store = provider()
    const input = candidate()
    const [first] = await new DeterministicConsolidationPipeline(store).consolidate([input])
    const id = memoryId(first)
    const model = new LocalHashEmbeddingModel()
    let reached: () => void = () => undefined
    let release: () => void = () => undefined
    const waiting = new Promise<void>((resolve) => {
      reached = resolve
    })
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    let armed = true
    const racing = new PostgresMemoryProvider(config, {
      pool,
      embeddingModel: {
        id: model.id,
        dimensions: model.dimensions,
        embed: async (text, signal) => {
          if (armed) {
            armed = false
            reached()
            await barrier
          }
          return model.embed(text, signal)
        },
      },
    })
    const work = new DeterministicConsolidationPipeline(racing).consolidate([
      { ...input, id: randomUUID() },
    ])
    await waiting
    try {
      await store.update(
        id,
        { ...input.memory, content: "Manual correction survives concurrency." },
        { context },
      )
    } finally {
      release()
    }
    expect((await work)[0]?.status).toBe("promoted")
    expect((await store.get(id, context))?.content).toBe("Manual correction survives concurrency.")
  })

  it("keeps missing evidence explicit and forgotten candidate replay inert without deleting independent support", async () => {
    const store = provider()
    const first = candidate()
    const inputs: CandidateMemory[] = []
    const evidenceIds: string[] = []
    for (let n = 0; n < 2; n++) {
      const admitted = admitEvidence(
        {
          providerId: config.id,
          host: "opencode-v2",
          context,
          messageId: `source-${n}`,
          occurredAt: "2026-10-01T12:00:00.000Z",
          role: "user",
          origin: "direct-user",
          kind: "turn-completed",
          payload: { text: first.memory.content },
        },
        { providerId: config.id, host: "opencode-v2", projectId: context.projectId },
        { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
      )
      if (admitted.outcome !== "admitted") throw new Error("fixture admission failed")
      evidenceIds.push(admitted.envelope.id)
      await store.appendEvidence(admitted.envelope)
      const row = await pool.query<{ id: string }>(
        "SELECT id FROM remem.session_events WHERE evidence_id=$1",
        [admitted.envelope.id],
      )
      const event = { ...observation(), id: row.rows[0]?.id ?? "" }
      const input = {
        ...first,
        id: randomUUID(),
        status: "pending" as const,
        observationIds: [event.id],
      }
      await store.persistCandidate(event, input, { autoApprove: true })
      inputs.push({ ...input, status: "approved" })
    }
    const pipeline = new DeterministicConsolidationPipeline(store)
    const results = await pipeline.consolidate(inputs)
    const id = memoryId(results[0])
    expect(memoryId(results[1])).toBe(id)
    const preview = await store.previewForget(config.id, evidenceIds[0] ?? "", context.projectId)
    await store.confirmForget(preview?.id ?? "")
    expect((await pipeline.consolidate(inputs))[0]?.status).toBe("expired")
    expect((await store.candidateLineage(inputs[0]?.id ?? "", context))?.state).toBe("forgotten")
    expect((await store.candidateLineage(inputs[1]?.id ?? "", context))?.state).toBe("promoted")
    await pool.query("DELETE FROM remem.session_events WHERE evidence_id=$1", [evidenceIds[1]])
    const ledger = await store.candidateLineage(inputs[1]?.id ?? "", context)
    expect(ledger?.availableObservationIds).toEqual([])
    expect(ledger?.observationIds).toHaveLength(1)
    expect((await store.get(id, context))?.content).toBe(first.memory.content)
  })
})

import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Pool } from "pg"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { DeterministicCandidateExtractor } from "../src/capture.js"
import { DeterministicConsolidationPipeline } from "../src/consolidation.js"
import { parseConfig } from "../src/config.js"
import { admitEvidence, DEFAULT_EVIDENCE_ADMISSION_CONFIG } from "../src/observation-admission.js"
import { PostgresMemoryProvider } from "../src/providers/postgres.js"
import { runMigrations } from "../src/storage/migrations.js"
import type { SessionObservation } from "../src/observation.js"
import { runCli } from "../src/cli/index.js"
import { rememPaths } from "../src/storage/paths.js"
import { writeAppConfig } from "../src/storage/config-file.js"
import { historicalRecall } from "../src/historical-recall.js"

const url = process.env.REMEM_TEST_DATABASE_URL
const integration = url ? describe.sequential : describe.skip
const context = {
  directory: "/repo",
  worktree: "/repo",
  projectId: "semantic-forget",
  sessionId: "a",
}
const config = {
  type: "postgres" as const,
  id: "semantic-forget",
  connectionString: url ?? "",
  primary: true,
  maxConnections: 4,
  catalogLimit: 100,
}
const text = "Phoenix worker uses cwd-relative checkpoint paths."
integration("explicit semantic memory forgetting", () => {
  const pool = new Pool({ connectionString: url })
  const store = new PostgresMemoryProvider(config, { pool })
  beforeEach(async () => {
    await pool.query("DROP SCHEMA IF EXISTS remem CASCADE")
    await runMigrations(pool)
  })
  afterAll(async () => {
    await pool.end()
  })
  async function fixture() {
    const messageId = randomUUID()
    const result = admitEvidence(
      {
        providerId: config.id,
        host: "opencode-v2",
        context,
        messageId,
        role: "user",
        origin: "direct-user",
        kind: "turn-completed",
        occurredAt: new Date().toISOString(),
        payload: { text },
      },
      { providerId: config.id, host: "opencode-v2", projectId: context.projectId },
      { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
    )
    if (result.outcome !== "admitted") throw new Error("fixture admission")
    const evidence = result.envelope
    await store.appendEvidence(evidence)
    const observation: SessionObservation = {
      id: randomUUID(),
      kind: "fact-discovered",
      context,
      occurredAt: evidence.occurredAt,
      source: `remem://opencode-v2/sessions/a/messages/${messageId}`,
      payload: {
        host: "opencode-v2",
        messageId,
        text,
        evidenceRefs: [{ providerId: config.id, eventId: evidence.id }],
      },
    }
    const [candidate] = await new DeterministicCandidateExtractor(
      parseConfig({}).config.capture,
    ).extract([observation])
    if (!candidate) throw new Error("fixture extraction")
    await store.persistCandidate(observation, candidate, {
      applyLearningPolicy: true,
      autoApprove: false,
    })
    await store.reviewCandidate(candidate.id, "approved")
    await new DeterministicConsolidationPipeline(store).consolidate([
      { ...candidate, status: "approved" },
    ])
    const lineage = await store.candidateLineage(candidate.id, context)
    if (!lineage?.memoryId) throw new Error("fixture promotion")
    return { evidence, observation, candidate, memoryId: lineage.memoryId }
  }
  async function count(table: string) {
    return (await pool.query<{ n: number }>(`SELECT count(*)::int n FROM remem.${table}`)).rows[0]!
      .n
  }
  it("previews without bodies, confirms all disclosed private copies and rejects fresh semantic/historical recall and replay", async () => {
    const f = await fixture()
    await pool.query(
      `INSERT INTO remem.embedding_reindex_stage(memory_id,fingerprint,model,dimensions,source_version,embedding,catalog_embedding)
      SELECT m.id,'pending-fixture',v.model,v.dimensions,m.updated_at,v.embedding,v.embedding FROM remem.memories m JOIN remem.memory_embeddings v ON v.memory_id=m.id WHERE m.id=$1`,
      [f.memoryId],
    )
    const preview = await store.previewSemanticForget(config.id, f.memoryId, context.projectId)
    expect(preview).toMatchObject({
      target: "semantic-memory",
      semanticMemoryCount: 1,
      candidateCount: 1,
      sourceCount: 1,
      retainedSharedSourceCount: 0,
      evidenceCount: 1,
      retainedEvidenceCount: 0,
      embeddingCount: 2,
      catalogCount: 1,
    })
    expect(JSON.stringify(preview)).not.toContain(text)
    expect(
      JSON.stringify((await pool.query("SELECT * FROM remem.semantic_forget_previews")).rows),
    ).not.toContain(text)
    expect(await count("memories")).toBe(1)
    expect(await store.confirmSemanticForget(preview!.id)).toMatchObject({
      memoriesDeleted: 1,
      candidatesDeleted: 1,
      sourcesDeleted: 1,
      evidenceDeleted: 1,
    })
    for (const table of [
      "memories",
      "candidate_memories",
      "memory_embeddings",
      "embedding_reindex_stage",
      "catalog_entries",
      "memory_aliases",
      "memory_provenance",
      "sources",
      "session_events",
    ])
      expect(await count(table)).toBe(0)
    expect((await store.candidateLineage(f.candidate.id, context))?.state).toBe("forgotten")
    expect(
      JSON.stringify((await pool.query("SELECT * FROM remem.candidate_lineage_audit")).rows),
    ).not.toContain(text)
    const fresh = { ...context, sessionId: "b" }
    expect(
      await store.search({
        query: "Phoenix checkpoint",
        topics: [],
        maxTokens: 2000,
        reason: "fresh rejection",
        context: fresh,
        signal: new AbortController().signal,
        limit: 5,
      }),
    ).toHaveLength(0)
    expect(
      (await historicalRecall([store], "Phoenix checkpoint", fresh, 1000)).selectedResults,
    ).toBe(0)
    expect(await store.appendEvidence(f.evidence)).toMatchObject({ outcome: "forgotten" })
    await expect(
      store.persistCandidate(f.observation, f.candidate, { autoApprove: true }),
    ).rejects.toThrow()
    await expect(
      store.write({
        id: f.memoryId,
        type: "semantic",
        title: "Phoenix",
        content: text,
        scope: { kind: "project", id: context.projectId },
      }),
    ).rejects.toThrow("explicitly forgotten")
    expect(await count("memories")).toBe(0)
    await expect(
      pool.query(
        `INSERT INTO remem.memories(id,provider_id,type,title,content,scope_kind,scope_id)
      VALUES($1,$2,'semantic','Legacy replay',$3,'project',$4)`,
        [f.memoryId, config.id, text, context.projectId],
      ),
    ).rejects.toThrow("explicitly forgotten")
    await expect(
      pool.query(
        `INSERT INTO remem.candidate_memories(id,type,title,content,scope_kind,scope_id,metadata)
      VALUES($1,'semantic','Legacy replay',$2,'project',$3,$4::jsonb)`,
        [f.candidate.id, text, context.projectId, JSON.stringify({ providerId: config.id })],
      ),
    ).rejects.toThrow("explicitly forgotten")
    await expect(
      store.write({
        type: "semantic",
        title: "Old claim replay",
        content: text,
        scope: { kind: "project", id: context.projectId },
        metadata: { consolidation: { candidateId: f.candidate.id } },
      }),
    ).rejects.toThrow("explicitly forgotten")
    await expect(store.confirmSemanticForget(preview!.id)).rejects.toThrow("unavailable")
  })
  it("rejects foreign providers/projects and keeps episode confirmation separate from semantic deletion", async () => {
    const f = await fixture()
    expect(await store.previewSemanticForget(config.id, f.memoryId, "foreign")).toBeUndefined()
    expect(
      await store.previewSemanticForget("foreign", f.memoryId, context.projectId),
    ).toBeUndefined()
    const semantic = await store.previewSemanticForget(config.id, f.memoryId, context.projectId)
    const other = new PostgresMemoryProvider({ ...config, id: "other" }, { pool })
    await expect(other.confirmSemanticForget(semantic!.id)).rejects.toThrow("unavailable")
    const episode = await store.previewForget(config.id, f.evidence.id, context.projectId)
    expect(episode?.semanticMemoryCount).toBe(0)
    await store.confirmForget(episode!.id)
    expect((await store.get(f.memoryId, context))?.content).toBe(text)
    await expect(store.confirmForget(semantic!.id)).rejects.toThrow("unavailable")
  })
  it("invalidates previews on changed body, aliases, sharing or canonical source associations", async () => {
    const f = await fixture()
    const preview = await store.previewSemanticForget(config.id, f.memoryId, context.projectId)
    await pool.query("INSERT INTO remem.memory_aliases(memory_id,alias) VALUES($1,'new alias')", [
      f.memoryId,
    ])
    await expect(store.confirmSemanticForget(preview!.id)).rejects.toThrow("preview changed")
    const revised = await store.previewSemanticForget(config.id, f.memoryId, context.projectId)
    await store.update(f.memoryId, {
      type: "semantic",
      title: "Current Phoenix",
      content: "Phoenix worker uses isolated checkpoint directories.",
      scope: { kind: "project", id: context.projectId },
    })
    await expect(store.confirmSemanticForget(revised!.id)).rejects.toThrow("preview changed")
    expect(await count("memories")).toBe(1)
  })
  it("preserves independently supported memory and shared provenance/evidence while disclosing their retention", async () => {
    const f = await fixture()
    const source = (await pool.query<{ id: string }>("SELECT id FROM remem.sources")).rows[0]!
    const stale = await store.previewSemanticForget(config.id, f.memoryId, context.projectId)
    const independent = await store.write({
      type: "decision",
      title: "Independent decision",
      content: "We decided to keep the independent rollout audit.",
      scope: { kind: "project", id: context.projectId },
    })
    await pool.query(
      "INSERT INTO remem.memory_provenance(id,memory_id,source_id,captured_at,original) VALUES($1,$2,$3,now(),true)",
      [randomUUID(), independent.id, source.id],
    )
    await expect(store.confirmSemanticForget(stale!.id)).rejects.toThrow("preview changed")
    const preview = await store.previewSemanticForget(config.id, f.memoryId, context.projectId)
    expect(preview).toMatchObject({
      sourceCount: 0,
      retainedSharedSourceCount: 1,
      evidenceCount: 0,
      retainedEvidenceCount: 1,
    })
    expect(await store.confirmSemanticForget(preview!.id)).toMatchObject({
      memoriesDeleted: 1,
      sourcesDeleted: 0,
      evidenceDeleted: 0,
    })
    expect((await store.get(independent.id, context))?.content).toContain(
      "independent rollout audit",
    )
    expect(await count("sources")).toBe(1)
    expect(await store.readEvidence(config.id, f.evidence.id, context)).toBeDefined()
  })
  it("serializes competing confirmations and candidate replay without resurrection", async () => {
    const f = await fixture()
    const preview = await store.previewSemanticForget(config.id, f.memoryId, context.projectId)
    const results = await Promise.allSettled([
      store.confirmSemanticForget(preview!.id),
      new PostgresMemoryProvider(config, { pool }).confirmSemanticForget(preview!.id),
      new DeterministicConsolidationPipeline(store).consolidate([
        { ...f.candidate, status: "approved" },
      ]),
    ])
    expect(results.slice(0, 2).filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(await count("memories")).toBe(0)
    expect((await store.candidateLineage(f.candidate.id, context))?.state).toBe("forgotten")
  })
  it("rolls back deletion/tombstones on failure and cancellation, preserving a usable preview", async () => {
    const f = await fixture()
    const preview = await store.previewSemanticForget(config.id, f.memoryId, context.projectId)
    await pool.query(
      "CREATE FUNCTION remem.reject_semantic_forget() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$",
    )
    await pool.query(
      "CREATE TRIGGER reject_semantic_forget BEFORE DELETE ON remem.memories FOR EACH ROW EXECUTE FUNCTION remem.reject_semantic_forget()",
    )
    await expect(store.confirmSemanticForget(preview!.id)).rejects.toThrow("fixture rollback")
    expect(await count("forget_tombstones")).toBe(0)
    expect(await count("candidate_memories")).toBe(1)
    expect(await count("session_events")).toBe(1)
    await pool.query("DROP TRIGGER reject_semantic_forget ON remem.memories")
    const stopped = new AbortController()
    stopped.abort()
    await expect(store.confirmSemanticForget(preview!.id, stopped.signal)).rejects.toThrow()
    await pool.query(
      "CREATE FUNCTION remem.pause_semantic_forget() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.1); RETURN OLD; END $$",
    )
    await pool.query(
      "CREATE TRIGGER pause_semantic_forget BEFORE DELETE ON remem.memories FOR EACH ROW EXECUTE FUNCTION remem.pause_semantic_forget()",
    )
    const active = new AbortController()
    const timer = setTimeout(() => active.abort(), 50)
    try {
      await expect(store.confirmSemanticForget(preview!.id, active.signal)).rejects.toThrow()
    } finally {
      clearTimeout(timer)
    }
    expect(await count("forget_tombstones")).toBe(0)
    expect(await count("memories")).toBe(1)
    await pool.query("DROP TRIGGER pause_semantic_forget ON remem.memories")
    expect((await store.confirmSemanticForget(preview!.id)).memoriesDeleted).toBe(1)
  })
  it("expires a preview and rejects unbounded association growth without destructive fallback", async () => {
    const f = await fixture()
    const preview = await store.previewSemanticForget(config.id, f.memoryId, context.projectId)
    await pool.query(
      "UPDATE remem.semantic_forget_previews SET created_at=now()-interval '20 minutes',expires_at=now()-interval '1 minute' WHERE id=$1",
      [preview!.id],
    )
    await expect(store.confirmSemanticForget(preview!.id)).rejects.toThrow("unavailable or expired")
    await pool.query(
      "INSERT INTO remem.memory_aliases(memory_id,alias) SELECT $1,'bounded-alias-'||n FROM generate_series(1,1001) n",
      [f.memoryId],
    )
    await expect(
      store.previewSemanticForget(config.id, f.memoryId, context.projectId),
    ).rejects.toThrow("bounded preview")
    expect(await count("memories")).toBe(1)
    expect(await count("forget_tombstones")).toBe(0)
  })
  it("requires a renewed preview after supersession and preserves the current successor", async () => {
    const f = await fixture()
    const stale = await store.previewSemanticForget(config.id, f.memoryId, context.projectId)
    const successor = await store.supersede(f.memoryId, {
      type: "semantic",
      title: "Current Phoenix",
      content: "Phoenix worker uses isolated checkpoint directories.",
      scope: { kind: "project", id: context.projectId },
    })
    await expect(store.confirmSemanticForget(stale!.id)).rejects.toThrow("preview changed")
    const renewed = await store.previewSemanticForget(config.id, f.memoryId, context.projectId)
    await store.confirmSemanticForget(renewed!.id)
    expect(await store.get(f.memoryId, context)).toBeUndefined()
    expect((await store.get(successor.id, context))?.content).toContain(
      "isolated checkpoint directories",
    )
    expect(await count("memories")).toBe(1)
  })
  it("keeps explicit semantic tombstones across a real pg_dump/pg_restore into this database", async () => {
    const f = await fixture()
    const directory = await mkdtemp(path.join(os.tmpdir(), "remem-semantic-restore-"))
    const paths = rememPaths({
      REMEM_CONFIG_DIR: path.join(directory, "config"),
      REMEM_DATA_DIR: path.join(directory, "data"),
    })
    const backup = path.join(directory, "before-forget.dump")
    const errors: string[] = []
    try {
      await writeAppConfig(
        {
          version: 1,
          storage: { mode: "external", connectionString: url! },
          providers: [config],
          embedding: { provider: "local-hash", model: "remem-local-hash-v1", dimensions: 384 },
        },
        paths,
      )
      expect(
        await runCli(["backup", "--output", backup], {
          paths,
          stdout: () => undefined,
          stderr: (line) => errors.push(line),
        }),
      ).toBe(0)
      const preview = await store.previewSemanticForget(config.id, f.memoryId, context.projectId)
      await store.confirmSemanticForget(preview!.id)
      expect(
        await runCli(["restore", backup, "--confirm"], {
          paths,
          stdout: () => undefined,
          stderr: (line) => errors.push(line),
        }),
      ).toBe(0)
      expect(await count("memories")).toBe(0)
      expect(await count("candidate_memories")).toBe(0)
      expect(await count("session_events")).toBe(0)
      expect(await count("sources")).toBe(0)
      expect(await store.appendEvidence(f.evidence)).toMatchObject({ outcome: "forgotten" })
      expect(JSON.stringify(errors)).not.toContain(text)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30000)
})

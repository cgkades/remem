import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { beforeAll, afterAll, describe, expect, it } from "vitest"
import { PostgresMemoryProvider } from "../src/providers/postgres.js"
import { LocalHashEmbeddingModel } from "../src/storage/embedding.js"
import { modelFingerprint } from "../src/storage/embedding-space.js"
import { PostgresReembedRunner } from "../src/reembedding.js"
import { runMigrations } from "../src/storage/migrations.js"
import type { EmbeddingModel } from "../src/types.js"
const integration = process.env.REMEM_TEST_DATABASE_URL ? describe.sequential : describe.skip
integration("embedding fingerprint cutover on real PostgreSQL", () => {
  const pool = new Pool({ connectionString: process.env.REMEM_TEST_DATABASE_URL })
  const context = { directory: "/fp", worktree: "/fp", projectId: "fp", sessionId: "fresh" }
  const vector = Array.from<number>({ length: 384 }).fill(0)
  vector[0] = 1
  const space = new LocalHashEmbeddingModel().space
  function model(asset: string): EmbeddingModel {
    return {
      id: "same-label",
      dimensions: 384,
      space: { ...space, asset },
      embed: () => Promise.resolve(vector),
    }
  }
  function provider(embeddingModel: EmbeddingModel, id = "fingerprint") {
    return new PostgresMemoryProvider(
      {
        type: "postgres",
        id,
        primary: true,
        connectionString: process.env.REMEM_TEST_DATABASE_URL!,
        maxConnections: 2,
        catalogLimit: 100,
      },
      { pool, embeddingModel },
    )
  }
  const search = (p: PostgresMemoryProvider, query: string) =>
    p.search({
      query,
      topics: [],
      context,
      limit: 10,
      maxTokens: 1000,
      reason: "fingerprint verification",
      signal: new AbortController().signal,
    })
  beforeAll(async () => {
    await pool.query<Record<string, string | number | null>>("DROP SCHEMA IF EXISTS remem CASCADE")
    await runMigrations(pool)
  })
  afterAll(async () => pool.end())
  it("excludes same-label/dimension cross-generation vectors, preserves lexical recall and atomically promotes complete stages", async () => {
    const old = provider(model("revision-one"))
    const targetModel = model("revision-two")
    const target = provider(targetModel)
    const ids = []
    for (let i = 0; i < 3; i++)
      ids.push(
        (
          await old.write({
            title: "Unique source " + i,
            content: "Retained document " + i,
            type: "semantic",
            scope: { kind: "project", id: "fp" },
          })
        ).id,
      )
    expect((await search(old, "unrelatedlexeme")).length).toBe(3)
    expect(await search(target, "unrelatedlexeme")).toHaveLength(0)
    expect((await search(target, "Unique source")).length).toBe(3)
    expect(
      (await target.catalog(context, new AbortController().signal)).every(
        (entry) => !entry.embedding,
      ),
    ).toBe(true)
    const batch = await target.reembedStale(2)
    expect(batch.coverage).toMatchObject({
      total: 3,
      compatible: 0,
      staged: 2,
      pending: 1,
      cutover: "building",
    })
    expect(await search(target, "unrelatedlexeme")).toHaveLength(0)
    expect((await search(old, "unrelatedlexeme")).length).toBe(3)
    const finish = await target.reembedStale(2)
    expect(finish.coverage).toMatchObject({
      total: 3,
      compatible: 3,
      pending: 0,
      cutover: "completed",
    })
    expect((await search(target, "unrelatedlexeme")).length).toBe(3)
    expect(await search(old, "unrelatedlexeme")).toHaveLength(0)
    expect(
      (await target.catalog(context, new AbortController().signal)).every(
        (entry) => entry.embeddingFingerprint === modelFingerprint(targetModel),
      ),
    ).toBe(true)
  })
  it("rebuilds unknown legacy fingerprints and missing vectors from retained source, scoped to its provider", async () => {
    const p = provider(model("revision-two"))
    const foreign = provider(model("other"), "other-provider")
    const foreignId = (
      await foreign.write({
        title: "Foreign embedding",
        content: "Foreign source",
        type: "semantic",
        scope: { kind: "project", id: "foreign" },
      })
    ).id
    await pool.query<Record<string, string | number | null>>(
      "UPDATE remem.memory_embeddings SET fingerprint=NULL WHERE memory_id=$1",
      [foreignId],
    )
    const record = await p.write({
      title: "Recovery source",
      content: "Retained content",
      type: "semantic",
      scope: { kind: "project", id: "fp" },
    })
    await pool.query<Record<string, string | number | null>>(
      "DELETE FROM remem.memory_embeddings WHERE memory_id=$1",
      [record.id],
    )
    await pool.query<Record<string, string | number | null>>(
      "UPDATE remem.catalog_entries SET embedding_fingerprint=NULL WHERE memory_id=$1",
      [record.id],
    )
    expect(
      (await search(p, "Recovery source")).some((result) => result.record.id === record.id),
    ).toBe(true)
    const result = await p.reembedStale(100)
    expect(result.coverage.cutover).toBe("completed")
    expect(
      (
        await pool.query<Record<string, string | number | null>>(
          "SELECT fingerprint FROM remem.memory_embeddings WHERE memory_id=$1",
          [foreignId],
        )
      ).rows[0]?.fingerprint,
    ).toBeNull()
    expect(
      (
        await pool.query<Record<string, string | number | null>>(
          "SELECT fingerprint FROM remem.memory_embeddings WHERE memory_id=$1",
          [record.id],
        )
      ).rows[0]?.fingerprint,
    ).toBe(modelFingerprint(model("revision-two")))
  })
  it("uses distinct query/document encoders and rejects a query-instruction change", async () => {
    let queryCalls = 0
    let documentCalls = 0
    const m: EmbeddingModel = {
      ...model("asym"),
      space: {
        ...space,
        asset: "asym",
        query: { mode: "query", instruction: "search: " },
        document: { mode: "document", instruction: "passage: " },
      },
      embed: () => Promise.reject(new Error("wrong encoder")),
      embedQuery: () => {
        queryCalls++
        return Promise.resolve(vector)
      },
      embedDocument: () => {
        documentCalls++
        return Promise.resolve(vector)
      },
    }
    const p = provider(m, "asym")
    await p.write({
      title: "Asymmetric record",
      content: "Safe retained source",
      type: "semantic",
      scope: { kind: "project", id: "fp" },
    })
    expect(await search(p, "anotherlexeme")).toHaveLength(1)
    expect(queryCalls).toBe(1)
    expect(documentCalls).toBe(2)
    const changed = provider(
      { ...m, space: { ...m.space!, query: { mode: "query", instruction: "changed: " } } },
      "asym",
    )
    expect(await search(changed, "anotherlexeme")).toHaveLength(0)
  })
  it("recovers interrupted claims and invalidates a stage when retained source changes", async () => {
    const p = provider(model("recovery-target"), "recovery")
    const old = provider(model("recovery-old"), "recovery")
    const a = await old.write({
      title: "Recovery A",
      content: "Old source A",
      type: "semantic",
      scope: { kind: "project", id: "fp" },
    })
    const b = await old.write({
      title: "Recovery B",
      content: "Old source B",
      type: "semantic",
      scope: { kind: "project", id: "fp" },
    })
    await p.reembedStale(1)
    await pool.query<Record<string, string | number | null>>(
      "UPDATE remem.memories SET content='Changed retained source',updated_at=now() WHERE id=$1",
      [a.id],
    )
    const run = randomUUID()
    await pool.query<Record<string, string | number | null>>(
      "INSERT INTO remem.consolidation_records(id,kind,status,input_memory_ids,started_at) VALUES($1,'embedding-reembed','started',$2,now()-interval '20 minutes')",
      [run, [b.id]],
    )
    await pool.query<Record<string, string | number | null>>(
      "UPDATE remem.memory_embeddings SET reembed_claim_id=$1 WHERE memory_id=$2",
      [run, b.id],
    )
    const seen: string[] = []
    const runner = new PostgresReembedRunner(
      pool,
      (text) => {
        seen.push(text)
        return Promise.resolve(vector)
      },
      {
        providerId: "recovery",
        fingerprint: modelFingerprint(model("recovery-target"))!,
        modelId: "same-label",
        dimensions: 384,
        batchSize: 100,
      },
    )
    const result = await runner.run()
    expect(result.coverage.cutover).toBe("completed")
    expect(seen.some((text) => text.includes("Changed retained source"))).toBe(true)
    expect(
      (
        await pool.query<Record<string, string | number | null>>(
          "SELECT status FROM remem.consolidation_records WHERE id=$1",
          [run],
        )
      ).rows[0]?.status,
    ).toBe("failed")
    expect(
      (
        await pool.query<Record<string, string | number | null>>(
          "SELECT count(*)::int AS n FROM remem.memory_embeddings WHERE reembed_claim_id IS NOT NULL",
        )
      ).rows[0]?.n,
    ).toBe(0)
  })
  it("cancels without promoting an incomplete generation and retries safely after inference failure", async () => {
    const old = provider(model("cancel-old"), "cancel")
    await old.write({
      title: "Cancellation record",
      content: "Retained source",
      type: "semantic",
      scope: { kind: "project", id: "fp" },
    })
    const abort = new AbortController()
    const runner = new PostgresReembedRunner(
      pool,
      () => {
        abort.abort()
        return Promise.resolve(vector)
      },
      {
        providerId: "cancel",
        fingerprint: modelFingerprint(model("cancel-new"))!,
        modelId: "same-label",
        dimensions: 384,
      },
    )
    await expect(runner.run(abort.signal)).rejects.toThrow()
    expect(
      (
        await pool.query<Record<string, string | number | null>>(
          "SELECT fingerprint FROM remem.memory_embeddings me JOIN remem.memories m ON m.id=me.memory_id WHERE m.provider_id='cancel'",
        )
      ).rows[0]?.fingerprint,
    ).toBe(modelFingerprint(model("cancel-old")))
    const bad = provider(
      {
        ...model("cancel-new"),
        embed: () => Promise.reject(new Error("unavailable")),
      },
      "cancel",
    )
    const failed = await bad.reembedStale()
    expect(failed.status).toBe("failed")
    expect(failed.coverage.cutover).toBe("building")
    expect(await search(bad, "Cancellation record")).toHaveLength(1)
    expect((await provider(model("cancel-new"), "cancel").reembedStale()).coverage.cutover).toBe(
      "completed",
    )
  })
  it("rolls back a failed cutover and resumes ready stages without rerunning inference", async () => {
    const old = provider(model("cutover-old"), "cutover-failure")
    const targetModel = model("cutover-new")
    const target = provider(targetModel, "cutover-failure")
    const record = await old.write({
      title: "Cutover source",
      content: "Retained document",
      type: "semantic",
      scope: { kind: "project", id: "fp" },
    })
    await pool.query(
      `CREATE FUNCTION remem.reject_test_cutover() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected cutover interruption'; END $$`,
    )
    await pool.query(
      `CREATE TRIGGER reject_test_cutover BEFORE UPDATE ON remem.memory_embeddings FOR EACH ROW WHEN (OLD.memory_id='${record.id}'::uuid AND OLD.fingerprint IS DISTINCT FROM NEW.fingerprint) EXECUTE FUNCTION remem.reject_test_cutover()`,
    )
    try {
      await expect(target.reembedStale()).rejects.toThrow("cutover interruption")
      expect(
        (
          await pool.query<{ fingerprint: string }>(
            "SELECT fingerprint FROM remem.memory_embeddings WHERE memory_id=$1",
            [record.id],
          )
        ).rows[0]?.fingerprint,
      ).toBe(modelFingerprint(model("cutover-old")))
      expect(
        (
          await pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM remem.embedding_reindex_stage WHERE memory_id=$1",
            [record.id],
          )
        ).rows[0]?.n,
      ).toBe(1)
    } finally {
      await pool.query("DROP TRIGGER reject_test_cutover ON remem.memory_embeddings")
      await pool.query("DROP FUNCTION remem.reject_test_cutover()")
    }
    const retry = new PostgresReembedRunner(
      pool,
      () => Promise.reject(new Error("must reuse stage")),
      {
        providerId: "cutover-failure",
        fingerprint: modelFingerprint(targetModel)!,
        modelId: targetModel.id,
        dimensions: 384,
      },
    )
    const result = await retry.run()
    expect(result.claimed).toBe(0)
    expect(result.coverage).toMatchObject({ total: 1, compatible: 1, cutover: "completed" })
  })
  it("retains lexical source writes when optional vector storage rejects the insert", async () => {
    const p = provider(model("storage-target"), "storage-failure")
    await pool.query(`CREATE FUNCTION remem.reject_test_vector() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF EXISTS(SELECT 1 FROM remem.memories WHERE id=NEW.memory_id AND provider_id='storage-failure') THEN RAISE EXCEPTION 'vector storage unavailable'; END IF; RETURN NEW; END $$`)
    await pool.query(
      "CREATE TRIGGER reject_test_vector BEFORE INSERT ON remem.memory_embeddings FOR EACH ROW EXECUTE FUNCTION remem.reject_test_vector()",
    )
    let record
    try {
      record = await p.write({
        title: "Lexical retained source",
        content: "Survives optional vector storage failure",
        type: "semantic",
        scope: { kind: "project", id: "fp" },
      })
      expect(
        (await search(p, "Lexical retained source")).map((result) => result.record.id),
      ).toContain(record.id)
      expect(
        (
          await pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM remem.memory_embeddings WHERE memory_id=$1",
            [record.id],
          )
        ).rows[0]?.n,
      ).toBe(0)
    } finally {
      await pool.query("DROP TRIGGER reject_test_vector ON remem.memory_embeddings")
      await pool.query("DROP FUNCTION remem.reject_test_vector()")
    }
    expect((await p.reembedStale()).coverage).toMatchObject({
      total: 1,
      compatible: 1,
      cutover: "completed",
    })
  })
})

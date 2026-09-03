import { randomUUID } from "node:crypto"
import { appendFile, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  DeterministicConsolidationPipeline,
  PostgresConsolidationRunner,
} from "../src/consolidation.js"
import { PostgresMemoryProvider } from "../src/providers/postgres.js"
import { runCli } from "../src/cli/index.js"
import { runDoctor } from "../src/cli/doctor.js"
import type { CandidateMemory, SessionObservation } from "../src/observation.js"
import { LocalHashEmbeddingModel } from "../src/storage/embedding.js"
import { writeAppConfig, type RememAppConfig } from "../src/storage/config-file.js"
import { MigrationIntegrityError, runMigrations } from "../src/storage/migrations.js"
import { rememPaths } from "../src/storage/paths.js"
import type { EmbeddingModel, MemoryContext, MemorySearchRequest } from "../src/types.js"

const databaseUrl = process.env.REMEM_TEST_DATABASE_URL
const integration = databaseUrl ? describe.sequential : describe.skip

integration("PostgreSQL managed provider", () => {
  const pool = new Pool({ connectionString: databaseUrl })
  const context: MemoryContext = {
    directory: "/workspace/phoenix",
    worktree: "/workspace/phoenix",
    projectId: "phoenix",
    sessionId: "session-1",
  }

  function request(query: string): MemorySearchRequest {
    return {
      query,
      topics: [],
      context,
      limit: 10,
      maxTokens: 2_000,
      reason: "integration test",
      signal: new AbortController().signal,
    }
  }

  beforeAll(async () => {
    await pool.query("DROP SCHEMA IF EXISTS remem CASCADE")
  })

  afterAll(async () => {
    await pool.end()
  })

  it("applies a clean install, upgrade, and repeated migration safely", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "remem-migrations-"))
    try {
      await copyFile(
        path.join(process.cwd(), "migrations/0001_initial_schema.sql"),
        path.join(directory, "0001_initial_schema.sql"),
      )
      const initial = await runMigrations(pool, directory)
      expect(initial).toMatchObject({ applied: [1], currentVersion: 1 })

      const firstMemory = randomUUID()
      const secondMemory = randomUUID()
      const sharedEntity = randomUUID()
      await pool.query(
        "INSERT INTO remem.providers (id, kind, name) VALUES ('upgrade-provider', 'postgres', 'Upgrade fixture')",
      )
      await pool.query(
        `INSERT INTO remem.memories
          (id, provider_id, type, title, content, scope_kind, scope_id)
         VALUES
          ($1, 'upgrade-provider', 'semantic', 'First', 'First body', 'project', 'first-project'),
          ($2, 'upgrade-provider', 'semantic', 'Second', 'Second body', 'project', 'second-project')`,
        [firstMemory, secondMemory],
      )
      await pool.query(
        "INSERT INTO remem.entities (id, name, type, metadata) VALUES ($1, 'Shared name', 'service', '{\"legacy\":true}')",
        [sharedEntity],
      )
      await pool.query(
        "INSERT INTO remem.memory_entities (memory_id, entity_id) VALUES ($1,$3),($2,$3)",
        [firstMemory, secondMemory, sharedEntity],
      )
      await pool.query(
        `INSERT INTO remem.catalog_entries
          (id, provider_id, memory_id, title, scope_kind, scope_id)
         VALUES ($1, 'upgrade-provider', $2, 'First', 'project', 'first-project')`,
        [randomUUID(), firstMemory],
      )

      const upgraded = await runMigrations(pool)
      expect(upgraded).toMatchObject({ applied: [2, 3, 4, 5, 6], currentVersion: 6 })
      expect(
        (
          await pool.query<{ count: string }>(
            "SELECT count(*) FROM remem.entities WHERE name = 'Shared name'",
          )
        ).rows[0]?.count,
      ).toBe("2")
      expect(
        (
          await pool.query<{ embedding_dimensions: number | null }>(
            "SELECT embedding_dimensions FROM remem.catalog_entries WHERE memory_id = $1",
            [firstMemory],
          )
        ).rows[0]?.embedding_dimensions,
      ).toBeNull()

      const repeated = await runMigrations(pool)
      expect(repeated).toMatchObject({ applied: [], currentVersion: 6 })

      await copyFile(
        path.join(process.cwd(), "migrations/0002_consolidation_observation.sql"),
        path.join(directory, "0002_consolidation_observation.sql"),
      )
      await appendFile(
        path.join(directory, "0001_initial_schema.sql"),
        "\n-- changed after apply\n",
      )
      await expect(runMigrations(pool, directory)).rejects.toBeInstanceOf(MigrationIntegrityError)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("supports CRUD, scope filtering, provenance, FTS, vector search, and supersession", async () => {
    const provider = new PostgresMemoryProvider(
      {
        type: "postgres",
        id: "remem-local",
        connectionString: databaseUrl ?? "",
        primary: true,
        maxConnections: 2,
        catalogLimit: 100,
      },
      { pool },
    )
    const memory = await provider.write(
      {
        type: "decision",
        title: "Bedrock Claude credential passthrough failure",
        content:
          "The AWS authentication failure was fixed by forwarding the credential provider chain into Bedrock.",
        summary: "Bedrock authentication uses credential-provider passthrough.",
        scope: { kind: "project", id: "phoenix" },
        importance: 0.9,
        aliases: ["AWS auth thing"],
        tags: ["bedrock", "authentication"],
        entities: [
          {
            name: "Amazon Bedrock",
            type: "service",
            aliases: ["Bedrock"],
            metadata: { visibility: "phoenix" },
          },
        ],
        provenance: [
          {
            source: { kind: "session", uri: "session://phoenix/decision" },
            capturedAt: "2026-08-31T12:00:00.000Z",
            original: true,
          },
        ],
      },
      { context, actor: "integration-test", reason: "verified decision" },
    )
    await provider.write({
      type: "preference",
      title: "Prefer concise changelogs",
      content: "Keep changelog entries concise.",
      scope: { kind: "global" },
      tags: ["preference"],
    })
    await provider.write({
      type: "decision",
      title: "Foreign project secret",
      content: "This must not cross project scope.",
      scope: { kind: "project", id: "other-project" },
      entities: [
        {
          name: "Amazon Bedrock",
          type: "service",
          metadata: { visibility: "other-project-secret" },
        },
      ],
    })

    const lexical = await provider.search(request("credential passthrough"))
    expect(lexical[0]?.record.id).toBe(memory.id)
    expect(lexical[0]?.reasons).toContain("PostgreSQL full-text match")

    const semantic = await provider.search(request("How are Amazon credentials passed to Claude?"))
    expect(semantic[0]?.record.id).toBe(memory.id)
    expect(semantic[0]?.reasons).toContain("pgvector semantic match")

    const scoped = await provider.search(request("foreign project secret"))
    expect(scoped).toEqual([])

    const retrieved = await provider.get(memory.id, context)
    expect(retrieved?.provenance?.[0]?.source.uri).toBe("session://phoenix/decision")
    expect(retrieved?.entities?.[0]?.name).toBe("Amazon Bedrock")
    expect(retrieved?.entities?.[0]?.metadata).toEqual({ visibility: "phoenix" })

    const catalogRow = await pool.query<{ id: string }>(
      "SELECT id FROM remem.catalog_entries WHERE memory_id = $1",
      [memory.id],
    )
    const catalogId = catalogRow.rows[0]?.id
    expect(catalogId).toBeDefined()
    const childCatalogId = randomUUID()
    await pool.query(
      `INSERT INTO remem.catalog_entries
        (id, provider_id, parent_id, title, scope_kind, scope_id)
       VALUES ($1, 'remem-local', $2, 'Child topic', 'project', 'phoenix')`,
      [childCatalogId, catalogId],
    )

    const updated = await provider.update(memory.id, {
      type: "decision",
      title: memory.title,
      content: `${memory.content} The chain is resolved lazily.`,
      summary: "Bedrock authentication uses credential-provider passthrough.",
      scope: memory.scope,
      aliases: ["AWS auth thing"],
      tags: ["bedrock", "authentication"],
      provenance: [
        {
          source: { kind: "session", uri: "session://phoenix/decision" },
          capturedAt: "2026-08-31T12:00:00.000Z",
          original: true,
        },
      ],
    })
    expect(updated.id).toBe(memory.id)
    expect(updated.createdAt).toBe(memory.createdAt)
    expect(
      (
        await pool.query<{ parent_id: string }>(
          "SELECT parent_id FROM remem.catalog_entries WHERE id = $1",
          [childCatalogId],
        )
      ).rows[0]?.parent_id,
    ).toBe(catalogId)

    const replacement = await provider.supersede(memory.id, {
      type: "decision",
      title: "Bedrock identity token exchange",
      content: "The current implementation exchanges a workload identity token.",
      scope: { kind: "project", id: "phoenix" },
      provenance: [
        {
          source: { kind: "session", uri: "session://phoenix/replacement" },
          capturedAt: "2026-09-01T12:00:00.000Z",
          original: true,
        },
      ],
    })
    expect((await provider.get(memory.id, context))?.freshness).toBe("superseded")
    const stale = await provider.write({
      type: "decision",
      title: "Stale Bedrock migration note",
      content: "The legacy credential flow used static access keys.",
      scope: { kind: "project", id: "phoenix" },
      freshness: "stale",
      importance: 0.8,
    })
    const catalog = await provider.catalog(context, new AbortController().signal)
    expect(catalog.map((entry) => entry.id)).not.toContain(memory.id)
    expect(catalog.map((entry) => entry.id)).toContain(replacement.id)
    expect(catalog).toContainEqual(expect.objectContaining({ id: stale.id, importance: 0.4 }))
    await expect(
      provider.update(memory.id, {
        type: "decision",
        title: "Invalid historical edit",
        content: "Superseded history must remain immutable.",
        scope: { kind: "project", id: "phoenix" },
      }),
    ).rejects.toThrow("superseded memories cannot be updated")

    const otherProvider = new PostgresMemoryProvider(
      {
        type: "postgres",
        id: "other-provider",
        connectionString: databaseUrl ?? "",
        primary: false,
        maxConnections: 2,
        catalogLimit: 100,
      },
      { pool },
    )
    const otherMemory = await otherProvider.write({
      type: "decision",
      title: "Other provider decision",
      content: "This record belongs to another provider.",
      scope: { kind: "project", id: "phoenix" },
    })
    await expect(
      provider.supersede(otherMemory.id, {
        type: "decision",
        title: "Invalid cross-provider replacement",
        content: "Must not be written.",
        scope: { kind: "project", id: "phoenix" },
      }),
    ).rejects.toThrow("memory not found")

    await provider.delete(replacement.id, context)
    expect(await provider.get(replacement.id, context)).toBeUndefined()
    expect((await provider.health()).status).toBe("healthy")
  })

  it("keeps lexical writes available when embedding generation fails", async () => {
    const unavailableEmbedding: EmbeddingModel = {
      id: "unavailable",
      dimensions: 384,
      embed: () => Promise.reject(new Error("embedding unavailable")),
    }
    const provider = new PostgresMemoryProvider(
      {
        type: "postgres",
        id: "remem-local",
        connectionString: databaseUrl ?? "",
        primary: true,
        maxConnections: 2,
        catalogLimit: 100,
      },
      { pool, embeddingModel: unavailableEmbedding },
    )
    await provider.write({
      type: "procedure",
      title: "Rollback checklist",
      content: "Drain traffic before database rollback.",
      scope: { kind: "project", id: "phoenix" },
    })

    expect((await provider.search(request("rollback checklist")))[0]?.record.title).toBe(
      "Rollback checklist",
    )
  })

  it("rejects an embedding model with the wrong dimensions", () => {
    const badModel: EmbeddingModel = {
      id: "fake-768",
      dimensions: 768,
      embed: () => Promise.resolve(new Array<number>(768).fill(0)),
    }
    expect(
      () =>
        new PostgresMemoryProvider(
          {
            type: "postgres",
            id: "x",
            connectionString: databaseUrl ?? "",
            primary: true,
            maxConnections: 1,
            catalogLimit: 10,
          },
          { embeddingModel: badModel },
        ),
    ).toThrow(/384-dimensional/)
  })

  it("records the configured embedding model in embedding_settings on construction", async () => {
    const recordingModel: EmbeddingModel = {
      id: "recorded-model-v1",
      dimensions: 384,
      embed: () => Promise.resolve(new Array<number>(384).fill(0)),
    }
    const provider = new PostgresMemoryProvider(
      {
        type: "postgres",
        id: "remem-local",
        connectionString: databaseUrl ?? "",
        primary: true,
        maxConnections: 1,
        catalogLimit: 10,
      },
      { pool, embeddingModel: recordingModel },
    )
    try {
      let row: { model: string; dimensions: number } | undefined
      for (let attempt = 0; attempt < 20 && !row; attempt++) {
        const result = await pool.query<{ model: string; dimensions: number }>(
          "SELECT model, dimensions FROM remem.embedding_settings WHERE id = true",
        )
        row = result.rows[0]
        if (!row || row.model !== recordingModel.id) {
          row = undefined
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }
      expect(row).toEqual({ model: recordingModel.id, dimensions: recordingModel.dimensions })
    } finally {
      await provider.close()
    }
  })

  it("claims approved candidates, records the run, and safely skips a repeated run", async () => {
    const provider = new PostgresMemoryProvider(
      {
        type: "postgres",
        id: "remem-local",
        connectionString: databaseUrl ?? "",
        primary: true,
        maxConnections: 2,
        catalogLimit: 100,
      },
      { pool },
    )
    const firstCandidate = randomUUID()
    const secondCandidate = randomUUID()
    await pool.query(
      `INSERT INTO remem.candidate_memories
        (id, type, title, content, scope_kind, scope_id, confidence, status, metadata)
       VALUES
        ($1, 'preference', 'Prefer concise release notes', 'Keep release notes concise and focused.', 'project', 'phoenix', 0.9, 'approved', '{}'::jsonb),
        ($2, 'preference', 'Prefer concise release notes', 'Keep release notes concise and focused.', 'project', 'phoenix', 0.9, 'approved', '{}'::jsonb)`,
      [firstCandidate, secondCandidate],
    )
    const runner = new PostgresConsolidationRunner(
      pool,
      new DeterministicConsolidationPipeline(provider),
    )

    const firstRun = await runner.run()
    const repeatedRun = await runner.run()

    expect(firstRun).toMatchObject({ status: "completed", candidates: 2, promoted: 2 })
    expect(firstRun.outputMemoryIds).toHaveLength(1)
    expect(repeatedRun).toMatchObject({ status: "completed", candidates: 0 })
    expect(
      (
        await pool.query<{ count: string }>(
          "SELECT count(*) FROM remem.candidate_memories WHERE id = ANY($1) AND status = 'promoted'",
          [[firstCandidate, secondCandidate]],
        )
      ).rows[0]?.count,
    ).toBe("2")
    expect(
      (
        await pool.query<{ status: string; output_memory_ids: string[] }>(
          "SELECT status, output_memory_ids FROM remem.consolidation_records WHERE id = $1",
          [firstRun.id],
        )
      ).rows[0],
    ).toMatchObject({ status: "completed", output_memory_ids: firstRun.outputMemoryIds })
  })

  it("recovers an interrupted claim before reclaiming and promoting its candidate", async () => {
    const provider = new PostgresMemoryProvider(
      {
        type: "postgres",
        id: "remem-local",
        connectionString: databaseUrl ?? "",
        primary: true,
        maxConnections: 2,
        catalogLimit: 100,
      },
      { pool },
    )
    const candidateId = randomUUID()
    const interruptedRunId = randomUUID()
    const title = "Recovered interrupted consolidation candidate"
    await pool.query(
      `INSERT INTO remem.candidate_memories
        (id, type, title, content, scope_kind, scope_id, confidence, status, metadata)
       VALUES ($1, 'procedure', $2, 'This candidate was claimed before the process crashed.', 'project', 'phoenix', 0.9, 'consolidating', '{}'::jsonb)`,
      [candidateId, title],
    )
    await pool.query(
      `INSERT INTO remem.consolidation_records
        (id, kind, status, input_memory_ids, started_at)
       VALUES ($1, 'candidate-consolidation', 'started', $2, now() - interval '1 hour')`,
      [interruptedRunId, [candidateId]],
    )
    const runner = new PostgresConsolidationRunner(
      pool,
      new DeterministicConsolidationPipeline(provider),
      50,
      1,
    )

    const recoveredRun = await runner.run()
    const repeatedRun = await runner.run()

    expect(recoveredRun).toMatchObject({ status: "completed", candidates: 1, promoted: 1 })
    expect(repeatedRun).toMatchObject({ status: "completed", candidates: 0 })
    expect(
      (
        await pool.query<{ status: string }>(
          "SELECT status FROM remem.consolidation_records WHERE id = $1",
          [interruptedRunId],
        )
      ).rows[0]?.status,
    ).toBe("failed")
    expect(
      (
        await pool.query<{ status: string }>(
          "SELECT status FROM remem.candidate_memories WHERE id = $1",
          [candidateId],
        )
      ).rows[0]?.status,
    ).toBe("promoted")
    expect(
      (
        await pool.query<{ count: string }>(
          "SELECT count(*) FROM remem.memories WHERE provider_id = 'remem-local' AND title = $1",
          [title],
        )
      ).rows[0]?.count,
    ).toBe("1")
  })

  it("persists a captured observation and pending candidate atomically with body-free status", async () => {
    const provider = new PostgresMemoryProvider(
      {
        type: "postgres",
        id: "remem-local",
        connectionString: databaseUrl ?? "",
        primary: true,
        maxConnections: 2,
        catalogLimit: 100,
      },
      { pool },
    )
    const observation: SessionObservation = {
      id: randomUUID(),
      kind: "decision",
      context,
      occurredAt: "2026-09-02T12:00:00.000Z",
      source: "remem://opencode-v2/sessions/session-1/messages/message-1",
      payload: {
        host: "opencode-v2",
        messageId: "message-1",
        text: "We decided to use blue-green deploys.",
      },
    }
    const candidate: CandidateMemory = {
      id: randomUUID(),
      observationIds: [observation.id],
      memory: {
        title: "Explicit decision: blue-green deploys",
        content: "We decided to use blue-green deploys.",
        type: "decision",
        scope: { kind: "project", id: "phoenix" },
        provenance: [
          {
            source: { kind: "user", uri: observation.source, externalId: "message-1" },
            capturedAt: observation.occurredAt,
            original: true,
          },
        ],
      },
      confidence: 0.9,
      status: "pending",
      reasons: ["explicit decision"],
    }

    await provider.persistCandidate(observation, candidate)
    await provider.persistCandidate(observation, candidate)

    expect(await provider.candidateStatus(context)).toMatchObject({ pending: 1 })
    const persisted = (
      await pool.query<{ payload: Record<string, unknown>; metadata: Record<string, unknown> }>(
        `SELECT e.payload, c.metadata
           FROM remem.session_events e
           JOIN remem.candidate_memories c ON c.session_event_id = e.id
           WHERE c.id = $1`,
        [candidate.id],
      )
    ).rows[0]
    expect(persisted).toMatchObject({
      payload: { host: "opencode-v2", messageId: "message-1" },
      metadata: { providerId: "remem-local", reasons: ["explicit decision"] },
    })
    expect(persisted?.payload).not.toHaveProperty("text")
    expect(
      (persisted?.metadata.memory as Record<string, unknown> | undefined)?.content,
    ).toBeUndefined()
    expect(
      (persisted?.metadata.memory as Record<string, unknown> | undefined)?.summary,
    ).toBeUndefined()
    expect(
      (
        await pool.query<{ count: string }>(
          "SELECT count(*) FROM remem.candidate_memories WHERE id = $1",
          [candidate.id],
        )
      ).rows[0]?.count,
    ).toBe("1")
    expect(await provider.listCandidates("pending")).toContainEqual(
      expect.objectContaining({
        id: candidate.id,
        title: candidate.memory.title,
        content: candidate.memory.content,
      }),
    )
    const otherProviderCandidate = randomUUID()
    await pool.query(
      `INSERT INTO remem.candidate_memories
        (id, type, title, content, scope_kind, scope_id, confidence, status, metadata)
       VALUES ($1, 'decision', 'Other provider decision', 'This must not be promoted here.', 'project', 'phoenix', 0.9, 'approved', $2::jsonb)`,
      [otherProviderCandidate, JSON.stringify({ providerId: "other-provider" })],
    )
    await provider.reviewCandidate(candidate.id, "approved")
    expect(await provider.candidateStatus(context)).toMatchObject({ approved: 1, pending: 0 })
    expect(await provider.consolidateCandidates()).toMatchObject({ candidates: 1, promoted: 1 })
    expect(
      (
        await pool.query<{ status: string }>(
          "SELECT status FROM remem.candidate_memories WHERE id = $1",
          [otherProviderCandidate],
        )
      ).rows[0]?.status,
    ).toBe("approved")
  })

  it("reports database, migration, provider, filesystem, and embedding health", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remem-doctor-"))
    const paths = rememPaths({
      REMEM_CONFIG_DIR: path.join(root, "config"),
      REMEM_DATA_DIR: path.join(root, "data"),
    })
    const config: RememAppConfig = {
      version: 1,
      storage: { mode: "external", connectionString: databaseUrl ?? "" },
      providers: [
        {
          type: "postgres",
          id: "remem-local",
          connectionString: databaseUrl ?? "",
          primary: true,
          maxConnections: 2,
          catalogLimit: 100,
        },
      ],
      embedding: { provider: "local-hash", model: "remem-local-hash-v1", dimensions: 384 },
    }
    try {
      await mkdir(paths.dataDir, { recursive: true, mode: 0o700 })
      await writeAppConfig(config, paths)
      const report = await runDoctor(config, paths, {
        run: () => Promise.resolve({ stdout: "", stderr: "" }),
      })
      expect(report.healthy).toBe(true)
      expect(report.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "PostgreSQL connectivity", status: "ok" }),
          expect.objectContaining({ name: "schema migrations", status: "ok" }),
          expect.objectContaining({ name: "provider remem-local", status: "ok" }),
          expect.objectContaining({ name: "embedding configuration", status: "ok" }),
        ]),
      )
      const migration = await pool.query<{ checksum: string }>(
        "SELECT checksum FROM remem.schema_migrations WHERE version = 1",
      )
      const checksum = migration.rows[0]?.checksum
      if (!checksum) throw new Error("missing migration checksum")
      await pool.query("UPDATE remem.schema_migrations SET checksum = 'drifted' WHERE version = 1")
      try {
        const drifted = await runDoctor(config, paths, {
          run: () => Promise.resolve({ stdout: "", stderr: "" }),
        })
        expect(drifted.healthy).toBe(false)
        expect(drifted.checks).toContainEqual(
          expect.objectContaining({ name: "schema migrations", status: "error" }),
        )
      } finally {
        await pool.query("UPDATE remem.schema_migrations SET checksum = $1 WHERE version = 1", [
          checksum,
        ])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("creates the embedding_settings singleton table", async () => {
    const result = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'remem' AND table_name = 'embedding_settings'",
    )
    const columns = result.rows.map((row: { column_name: string }) => row.column_name)
    expect(columns).toEqual(expect.arrayContaining(["id", "model", "dimensions", "updated_at"]))
  })

  it("creates durable re-embedding claim columns", async () => {
    const result = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'remem' AND table_name = 'memory_embeddings'",
    )
    const columns = result.rows.map((row: { column_name: string }) => row.column_name)
    expect(columns).toContain("reembed_claim_id")
  })

  it("reembeds a memory stored under a different model id", async () => {
    const provider = new PostgresMemoryProvider(
      {
        type: "postgres",
        id: "reembed-test",
        connectionString: databaseUrl ?? "",
        primary: true,
        maxConnections: 2,
        catalogLimit: 10,
      },
      { pool },
    )
    const written = await provider.write({
      title: "Reembed target",
      content: "Bedrock Claude credential passthrough failure",
      scope: { kind: "workspace", id: "phoenix" },
      type: "decision",
    })
    await pool.query(
      "UPDATE remem.memory_embeddings SET model = 'stale-model' WHERE memory_id = $1",
      [written.id],
    )
    const result = await provider.reembedStale(10)
    expect(result.status).toBe("completed")
    expect(result.reembedded).toBeGreaterThanOrEqual(1)
    const row = await pool.query<{ model: string }>(
      "SELECT model FROM remem.memory_embeddings WHERE memory_id = $1",
      [written.id],
    )
    expect(row.rows[0]?.model).toBe("remem-local-hash-v1")
  })

  it("runs a manual reembed via the CLI", async () => {
    const seedProvider = new PostgresMemoryProvider(
      {
        type: "postgres",
        id: "reembed-cli-seed",
        connectionString: databaseUrl ?? "",
        primary: true,
        maxConnections: 2,
        catalogLimit: 10,
      },
      { pool },
    )
    const written = await seedProvider.write({
      title: "Reembed CLI target",
      content: "Manual reembed CLI wiring check",
      scope: { kind: "workspace", id: "phoenix" },
      type: "decision",
    })
    await pool.query(
      "UPDATE remem.memory_embeddings SET model = 'stale-model' WHERE memory_id = $1",
      [written.id],
    )

    const root = await mkdtemp(path.join(os.tmpdir(), "remem-reembed-cli-"))
    const paths = rememPaths({
      REMEM_CONFIG_DIR: path.join(root, "config"),
      REMEM_DATA_DIR: path.join(root, "data"),
    })
    const config: RememAppConfig = {
      version: 1,
      storage: { mode: "external", connectionString: databaseUrl ?? "" },
      providers: [
        {
          type: "postgres",
          id: "remem-local",
          connectionString: databaseUrl ?? "",
          primary: true,
          maxConnections: 2,
          catalogLimit: 100,
        },
      ],
      embedding: { provider: "local-hash", model: "remem-local-hash-v1", dimensions: 384 },
    }
    try {
      await mkdir(paths.dataDir, { recursive: true, mode: 0o700 })
      await writeAppConfig(config, paths)

      const lines: string[] = []
      const exitCode = await runCli(["reembed", "--batch-size", "5"], {
        paths,
        stdout: (line) => lines.push(line),
      })

      expect(exitCode).toBe(0)
      const output = JSON.parse(lines.join("\n")) as { status: string; reembedded: number }
      expect(output.status).toBe("completed")
      expect(output.reembedded).toBeGreaterThanOrEqual(1)

      const row = await pool.query<{ model: string }>(
        "SELECT model FROM remem.memory_embeddings WHERE memory_id = $1",
        [written.id],
      )
      expect(row.rows[0]?.model).toBe("remem-local-hash-v1")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("respects the configured neural backend when reembedding via the CLI, instead of always using hash", async () => {
    // Regression test: `reembed` used to always construct its provider via
    // primaryPostgresProvider(), which intentionally defaults to
    // LocalHashEmbeddingModel for candidates/review/consolidate. Reembed was
    // added to that same dispatch bucket without threading the configured
    // embedding model through, so it silently overwrote neural embeddings
    // with hash vectors regardless of `config.embedding.provider`.
    const seedProvider = new PostgresMemoryProvider(
      {
        type: "postgres",
        id: "reembed-neural-seed",
        connectionString: databaseUrl ?? "",
        primary: true,
        maxConnections: 2,
        catalogLimit: 10,
      },
      { pool },
    )
    const written = await seedProvider.write({
      title: "Reembed neural CLI target",
      content: "Manual reembed CLI must honor the configured neural backend",
      scope: { kind: "workspace", id: "phoenix" },
      type: "decision",
    })
    await pool.query(
      "UPDATE remem.memory_embeddings SET model = 'stale-model' WHERE memory_id = $1",
      [written.id],
    )

    const root = await mkdtemp(path.join(os.tmpdir(), "remem-reembed-neural-cli-"))
    const paths = rememPaths({
      REMEM_CONFIG_DIR: path.join(root, "config"),
      REMEM_DATA_DIR: path.join(root, "data"),
    })
    const config: RememAppConfig = {
      version: 1,
      storage: { mode: "external", connectionString: databaseUrl ?? "" },
      providers: [
        {
          type: "postgres",
          id: "remem-local",
          connectionString: databaseUrl ?? "",
          primary: true,
          maxConnections: 2,
          catalogLimit: 100,
        },
      ],
      embedding: { provider: "neural", model: "bge-small-en-v1.5", dimensions: 384 },
    }
    try {
      await mkdir(paths.dataDir, { recursive: true, mode: 0o700 })
      await writeAppConfig(config, paths)

      const lines: string[] = []
      // Large batch size: this describe.sequential suite shares one Postgres
      // instance across many tests, so other stale rows may sort ahead of
      // ours by updated_at. A small batch could exhaust its capacity on
      // unrelated rows before reaching the one this test actually seeded.
      const exitCode = await runCli(["reembed", "--batch-size", "1000"], {
        paths,
        stdout: (line) => lines.push(line),
      })

      expect(exitCode).toBe(0)
      const output = JSON.parse(lines.join("\n")) as { status: string; reembedded: number }
      expect(output.status).toBe("completed")
      expect(output.reembedded).toBeGreaterThanOrEqual(1)

      const row = await pool.query<{ model: string }>(
        "SELECT model FROM remem.memory_embeddings WHERE memory_id = $1",
        [written.id],
      )
      // Must be the real neural model id, not "remem-local-hash-v1" — the
      // latter would mean reembed silently ignored the configured neural
      // backend, exactly the bug this test guards against.
      expect(row.rows[0]?.model).toBe("bge-small-en-v1.5")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reports a re-embed backlog in doctor output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remem-doctor-backlog-"))
    const paths = rememPaths({
      REMEM_CONFIG_DIR: path.join(root, "config"),
      REMEM_DATA_DIR: path.join(root, "data"),
    })
    const config: RememAppConfig = {
      version: 1,
      storage: { mode: "external", connectionString: databaseUrl ?? "" },
      providers: [],
      embedding: { provider: "local-hash", model: "remem-local-hash-v1", dimensions: 384 },
    }
    const original = (
      await pool.query<{ memory_id: string; model: string }>(
        "SELECT memory_id, model FROM remem.memory_embeddings",
      )
    ).rows
    try {
      await mkdir(paths.dataDir, { recursive: true, mode: 0o700 })
      await writeAppConfig(config, paths)
      await pool.query("UPDATE remem.memory_embeddings SET model = 'stale-model'")

      const report = await runDoctor(config, paths, {
        run: () => Promise.resolve({ stdout: "", stderr: "" }),
      })
      const check = report.checks.find((c) => c.name === "embedding backlog")
      expect(check?.status).toBe("warn")
      expect(check?.detail).toMatch(/\d+ memor(y|ies) pending re-embedding/)
    } finally {
      for (const row of original) {
        await pool.query("UPDATE remem.memory_embeddings SET model = $2 WHERE memory_id = $1", [
          row.memory_id,
          row.model,
        ])
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  it("does not report a backlog when neural embedding falls back to hash", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remem-doctor-fallback-"))
    const paths = rememPaths({
      REMEM_CONFIG_DIR: path.join(root, "config"),
      REMEM_DATA_DIR: path.join(root, "data"),
    })
    const config: RememAppConfig = {
      version: 1,
      storage: { mode: "external", connectionString: databaseUrl ?? "" },
      providers: [],
      embedding: { provider: "neural", model: "bge-small-en-v1.5", dimensions: 384 },
    }
    const originalEmbeddings = (
      await pool.query<{ memory_id: string; model: string }>(
        "SELECT memory_id, model FROM remem.memory_embeddings",
      )
    ).rows
    const originalSettings = (
      await pool.query<{ model: string; dimensions: number; updated_at: string }>(
        "SELECT model, dimensions, updated_at FROM remem.embedding_settings WHERE id = true",
      )
    ).rows[0]
    try {
      await mkdir(paths.dataDir, { recursive: true, mode: 0o700 })
      await writeAppConfig(config, paths)
      await pool.query("UPDATE remem.memory_embeddings SET model = 'remem-local-hash-v1'")
      await pool.query(
        `INSERT INTO remem.embedding_settings (id, model, dimensions)
           VALUES (true, 'remem-local-hash-v1', 384)
         ON CONFLICT (id) DO UPDATE SET model = excluded.model, dimensions = excluded.dimensions`,
      )

      const report = await runDoctor(
        config,
        paths,
        { run: () => Promise.resolve({ stdout: "", stderr: "" }) },
        { embeddingModel: new LocalHashEmbeddingModel() },
      )
      expect(report.checks.find((c) => c.name === "embedding backlog")).toMatchObject({
        status: "ok",
      })
      expect(report.checks.find((c) => c.name === "embedding settings persistence")).toMatchObject({
        status: "ok",
      })
      expect(report.checks.find((c) => c.name === "embedding configuration")).toMatchObject({
        status: "warn",
      })
    } finally {
      for (const row of originalEmbeddings) {
        await pool.query("UPDATE remem.memory_embeddings SET model = $2 WHERE memory_id = $1", [
          row.memory_id,
          row.model,
        ])
      }
      await pool.query("DELETE FROM remem.embedding_settings WHERE id = true")
      if (originalSettings) {
        await pool.query(
          "INSERT INTO remem.embedding_settings (id, model, dimensions, updated_at) VALUES (true, $1, $2, $3)",
          [originalSettings.model, originalSettings.dimensions, originalSettings.updated_at],
        )
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reports the embedding_settings record health in doctor output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remem-doctor-settings-"))
    const paths = rememPaths({
      REMEM_CONFIG_DIR: path.join(root, "config"),
      REMEM_DATA_DIR: path.join(root, "data"),
    })
    const config: RememAppConfig = {
      version: 1,
      storage: { mode: "external", connectionString: databaseUrl ?? "" },
      providers: [],
      embedding: { provider: "local-hash", model: "remem-local-hash-v1", dimensions: 384 },
    }
    const original = (
      await pool.query<{ model: string; dimensions: number; updated_at: string }>(
        "SELECT model, dimensions, updated_at FROM remem.embedding_settings WHERE id = true",
      )
    ).rows[0]
    try {
      await mkdir(paths.dataDir, { recursive: true, mode: 0o700 })
      await writeAppConfig(config, paths)

      await pool.query(
        `INSERT INTO remem.embedding_settings (id, model, dimensions)
           VALUES (true, $1, $2)
         ON CONFLICT (id) DO UPDATE SET model = excluded.model, dimensions = excluded.dimensions`,
        [config.embedding.model, config.embedding.dimensions],
      )
      const matching = await runDoctor(config, paths, {
        run: () => Promise.resolve({ stdout: "", stderr: "" }),
      })
      expect(
        matching.checks.find((c) => c.name === "embedding settings persistence"),
      ).toMatchObject({
        status: "ok",
      })

      await pool.query(
        `INSERT INTO remem.embedding_settings (id, model, dimensions)
           VALUES (true, $1, $2)
         ON CONFLICT (id) DO UPDATE SET model = excluded.model, dimensions = excluded.dimensions`,
        ["stale-recorded-model", 384],
      )
      const mismatched = await runDoctor(config, paths, {
        run: () => Promise.resolve({ stdout: "", stderr: "" }),
      })
      const mismatchCheck = mismatched.checks.find(
        (c) => c.name === "embedding settings persistence",
      )
      expect(mismatchCheck?.status).toBe("warn")
      expect(mismatchCheck?.detail).toContain("stale-recorded-model")
      expect(mismatchCheck?.detail).toContain(config.embedding.model)

      await pool.query("DELETE FROM remem.embedding_settings WHERE id = true")
      const missing = await runDoctor(config, paths, {
        run: () => Promise.resolve({ stdout: "", stderr: "" }),
      })
      expect(missing.checks.find((c) => c.name === "embedding settings persistence")).toMatchObject(
        {
          status: "warn",
        },
      )
    } finally {
      await pool.query("DELETE FROM remem.embedding_settings WHERE id = true")
      if (original) {
        await pool.query(
          "INSERT INTO remem.embedding_settings (id, model, dimensions, updated_at) VALUES (true, $1, $2, $3)",
          [original.model, original.dimensions, original.updated_at],
        )
      }
      await rm(root, { recursive: true, force: true })
    }
  })
})

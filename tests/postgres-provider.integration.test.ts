import { createHash, randomUUID } from "node:crypto"
import { appendFile, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createCaptureCoordinator } from "../src/capture.js"
import {
  DeterministicConsolidationPipeline,
  PostgresConsolidationRunner,
} from "../src/consolidation.js"
import { PostgresMemoryProvider } from "../src/providers/postgres.js"
import { FORGET_RESTORE_ADVISORY_LOCK } from "../src/forget.js"
import { runCli } from "../src/cli/index.js"
import { runDoctor } from "../src/cli/doctor.js"
import { RememOrchestrator } from "../src/orchestrator.js"
import type { CandidateMemory, SessionObservation } from "../src/observation.js"
import {
  admitEvidence,
  DEFAULT_EVIDENCE_ADMISSION_CONFIG,
  type AdmissionAuthority,
  type RawEvidenceCandidate,
} from "../src/observation-admission.js"
import { LocalHashEmbeddingModel } from "../src/storage/embedding.js"
import { writeAppConfig, type RememAppConfig } from "../src/storage/config-file.js"
import { MigrationIntegrityError, runMigrations } from "../src/storage/migrations.js"
import { rememPaths } from "../src/storage/paths.js"
import type { EmbeddingModel, MemoryContext, MemorySearchRequest } from "../src/types.js"
import { testConfig } from "./helpers.js"

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
      expect(upgraded).toMatchObject({
        applied: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        currentVersion: 11,
      })
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
      expect(repeated).toMatchObject({ applied: [], currentVersion: 11 })

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

  it("returns a descriptor without an embedding when embedding generation fails, instead of throwing", async () => {
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

    const descriptor = await provider.descriptor()
    expect(descriptor.id).toBe("remem-local")
    expect(descriptor.embedding).toBeUndefined()
  })

  it("persists curated metadata through records and catalog entries", async () => {
    const provider = new PostgresMemoryProvider(
      {
        type: "postgres",
        id: "institutional-provider",
        connectionString: databaseUrl ?? "",
        primary: true,
        maxConnections: 2,
        catalogLimit: 100,
      },
      { pool },
    )
    const institutional = {
      role: "position" as const,
      id: "position.production-rollback",
      owner: "release-engineering",
      sourceRefs: ["change-policy-v3"],
      boundaryConditions: ["Production changes only."],
      applicability: {
        match: "all" as const,
        conditions: [
          {
            id: "project",
            kind: "context" as const,
            field: "projectId" as const,
            value: "phoenix",
          },
        ],
      },
      review: { reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: null },
    }
    const written = await provider.write({
      type: "decision",
      title: "Production rollback policy",
      content: "Production changes require a rollback plan.",
      scope: { kind: "project", id: "phoenix" },
      institutional,
    })

    expect(written.institutional).toEqual(institutional)
    expect((await provider.get(written.id, context))?.institutional).toEqual(institutional)
    expect(await provider.catalog(context, new AbortController().signal)).toContainEqual(
      expect.objectContaining({ id: written.id, institutional }),
    )
    expect(
      (
        await pool.query<{ metadata: { institutional?: unknown } }>(
          "SELECT metadata FROM remem.memories WHERE id = $1",
          [written.id],
        )
      ).rows[0]?.metadata.institutional,
    ).toEqual(institutional)

    const forged = await provider.write({
      type: "semantic",
      title: "Ordinary metadata must remain ordinary",
      content: "Untrusted JSON cannot become an institutional memory.",
      scope: { kind: "project", id: "phoenix" },
      metadata: { institutional: { role: "position", id: "forged" } },
    })
    expect((await provider.get(forged.id, context))?.institutional).toBeUndefined()
    expect(
      (await provider.catalog(context, new AbortController().signal)).find(
        ({ id }) => id === forged.id,
      ),
    ).not.toHaveProperty("institutional")

    await expect(
      provider.write({
        type: "decision",
        title: "Invalid institutional review",
        content: "Invalid review dates are rejected before persistence.",
        scope: { kind: "project", id: "phoenix" },
        institutional: {
          role: "position",
          id: "position.invalid-review",
          owner: "release-engineering",
          sourceRefs: ["policy://release/invalid"],
          boundaryConditions: ["Replay only."],
          applicability: { match: "all", conditions: [] },
          review: { reviewedAt: "invalid", expiresAt: null },
        },
      }),
    ).rejects.toThrow("invalid review timestamp")
  })

  it("routes persisted curated entries through production catalog, retrieval, and trace paths", async () => {
    const provider = new PostgresMemoryProvider(
      {
        type: "postgres",
        id: "institutional-replay-provider",
        connectionString: databaseUrl ?? "",
        primary: true,
        maxConnections: 2,
        catalogLimit: 100,
      },
      { pool },
    )
    const position = await provider.write({
      type: "decision",
      title: "Release rollback position",
      aliases: ["release rollback guidance"],
      content: "A production release requires rollback evidence.",
      source: "policy://release/rollback-position",
      scope: { kind: "project", id: "phoenix" },
      institutional: {
        role: "position",
        id: "position.release-rollback",
        owner: "release-engineering",
        sourceRefs: ["policy://release/rollback-position"],
        boundaryConditions: ["Production release only."],
        applicability: {
          match: "all",
          conditions: [{ id: "topic", kind: "topic", value: "release" }],
        },
        review: { reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: null },
      },
    })
    const procedure = await provider.write({
      type: "procedure",
      title: "Release rollback procedure",
      aliases: ["release rollback guidance"],
      content: "1. Confirm rollback evidence.\n2. Escalate when evidence is missing.",
      source: "policy://release/rollback-procedure",
      scope: { kind: "project", id: "phoenix" },
      institutional: {
        role: "procedure",
        id: "procedure.release-rollback",
        steps: [
          { id: "confirm", instruction: "Confirm rollback evidence." },
          { id: "escalate", instruction: "Escalate when evidence is missing." },
        ],
        positionIds: ["position.release-rollback"],
        requiredEvidence: ["rollback evidence"],
        completionCriteria: ["evidence confirmed"],
        escalationConditions: ["evidence missing"],
        applicability: {
          match: "all",
          conditions: [{ id: "topic", kind: "topic", value: "release" }],
        },
        review: { reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: null },
      },
    })

    const injection = await new RememOrchestrator(
      [provider],
      testConfig({
        semantic: { enabled: false, minimumSimilarity: 0.55, deterministicHighConfidence: 0.82 },
      }),
    ).processPrompt("What is the release rollback guidance?", context)

    expect(injection.memoryText).toContain(position.content)
    expect(injection.memoryText).toContain(procedure.content.replace("\n", " "))
    expect(injection.memoryText).toContain("policy://release/rollback-position")
    expect(injection.memoryText).toContain("policy://release/rollback-procedure")
    expect(injection.trace.applicability).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ institutionalId: "position.release-rollback", applicable: true }),
        expect.objectContaining({
          institutionalId: "procedure.release-rollback",
          applicable: true,
        }),
      ]),
    )
    expect(injection.trace.providers).toEqual([
      expect.objectContaining({ providerId: "institutional-replay-provider", status: "ok" }),
    ])
  })

  it("keeps expired persisted guidance out of catalog injection and continuity recall", async () => {
    const provider = new PostgresMemoryProvider(
      {
        type: "postgres",
        id: "expired-institutional-replay-provider",
        connectionString: databaseUrl ?? "",
        primary: true,
        maxConnections: 2,
        catalogLimit: 100,
      },
      { pool },
    )
    const expired = await provider.write({
      type: "decision",
      title: "Expired release rollback position",
      aliases: ["expired release rollback guidance"],
      content: "Expired release rollback guidance must not be injected.",
      source: "policy://release/expired-rollback",
      scope: { kind: "project", id: "phoenix" },
      institutional: {
        role: "position",
        id: "position.expired-release-rollback",
        owner: "release-engineering",
        sourceRefs: ["policy://release/expired-rollback"],
        boundaryConditions: ["Historical release policy only."],
        applicability: {
          match: "all",
          conditions: [{ id: "topic", kind: "topic", value: "expired" }],
        },
        review: { reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z" },
      },
    })
    await pool.query(
      `UPDATE remem.memories
       SET metadata = jsonb_set(metadata, '{institutional,review,expiresAt}', '"2025-01-01T00:00:00.000Z"')
       WHERE id = $1`,
      [expired.id],
    )

    const orchestrator = new RememOrchestrator(
      [provider],
      testConfig({
        semantic: { enabled: false, minimumSimilarity: 0.55, deterministicHighConfidence: 0.82 },
      }),
    )
    const injection = await orchestrator.processPrompt(
      "Continue the expired release rollback guidance.",
      context,
    )
    const compaction = await orchestrator.compactionContext(context)

    expect(injection.text).not.toContain("Expired release rollback position")
    expect(compaction).not.toContain("Expired release rollback position")
    expect(injection.memoryText).toBe("")
    expect(injection.trace.selectedResults).toBe(0)
    expect(injection.trace.applicability).toContainEqual(
      expect.objectContaining({
        institutionalId: "position.expired-release-rollback",
        applicable: false,
        reason: "institutional review expired",
      }),
    )
    expect(injection.trace.providers).toEqual([
      expect.objectContaining({
        providerId: "expired-institutional-replay-provider",
        resultCount: 0,
      }),
    ])
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

  it("learns multiple user statements and recalls them in a fresh session without manual curation", async () => {
    const providerConfig = {
      type: "postgres" as const,
      id: "learning-loop",
      connectionString: databaseUrl ?? "",
      primary: true,
      maxConnections: 2,
      catalogLimit: 100,
    }
    const base = testConfig()
    const config = testConfig({
      providers: [providerConfig],
      capture: { ...base.capture, enabled: true, autoPromote: true },
    })
    const sessionA = {
      directory: "/workspace/orion",
      worktree: "/workspace/orion",
      projectId: "learning-loop",
      sessionId: "learning-session-a",
    }
    const statements = [
      "Orion uses PostgreSQL for durable memory.",
      "We decided to use logical replication for Orion.",
      "The Orion rollout is blocked on a restore drill.",
    ]
    const prompt = `Can you check this? ${statements.join(" ")}`
    const providerA = new PostgresMemoryProvider(providerConfig)
    const capture = createCaptureCoordinator([providerA], config, { log: () => undefined })
    expect(capture).toBeDefined()
    try {
      const input = {
        host: "opencode-v2" as const,
        context: sessionA,
        sessionId: sessionA.sessionId,
        messageId: "learning-message-a",
        text: prompt,
      }
      capture?.enqueue(input)
      await capture?.idle()
      expect(capture?.explain(sessionA.sessionId)).toMatchObject({ outcome: "promoted" })
      // Re-delivery must not create extra semantic memories.
      capture?.enqueue(input)
      await capture?.idle()
      expect(capture?.explain(sessionA.sessionId)).toMatchObject({ outcome: "promoted" })
    } finally {
      await capture?.dispose()
      await providerA.dispose()
    }

    // New provider, database connections, and orchestrator: no Session A process-local state.
    const providerB = new PostgresMemoryProvider(providerConfig)
    const orchestrator = new RememOrchestrator([providerB], config)
    const sessionB = { ...sessionA, sessionId: "learning-session-b" }
    try {
      const persisted = await pool.query<{ content: string }>(
        "SELECT content FROM remem.memories WHERE provider_id = $1 AND scope_id = $2",
        [providerConfig.id, sessionA.projectId],
      )
      expect(persisted.rows.map((row) => row.content).sort()).toEqual([...statements].sort())

      const continuityPrompt =
        "Continue Orion durable memory, logical replication, and the blocked rollout restore drill."
      const injection = await orchestrator.processPrompt(continuityPrompt, sessionB)
      expect(injection.plan.shouldRetrieve).toBe(true)
      expect(injection.memoryText, JSON.stringify(injection.trace)).not.toBe("")
      for (const statement of statements) expect(injection.memoryText).toContain(statement)
      expect(injection.memoryText).not.toContain("Can you check this?")
      expect(injection.trace.recallTokens).toBeLessThanOrEqual(config.budgets.recallTokens)

      const records = await providerB.search({ ...request("Orion"), context: sessionB })
      expect(records).toHaveLength(3)
      for (const { record } of records) {
        expect(record.provenance?.[0]?.source).toMatchObject({
          kind: "user",
          externalId: "learning-message-a",
          metadata: { sessionId: sessionA.sessionId },
        })
        const span = record.metadata?.capture as { statementStart: number; statementEnd: number }
        expect(prompt.slice(span.statementStart, span.statementEnd)).toBe(record.content)
      }

      const unrelated = await new RememOrchestrator([providerB], config).processPrompt(
        "Explain a Python list comprehension.",
        { ...sessionB, sessionId: "learning-unrelated" },
      )
      expect(unrelated.trace.selectedResults).toBe(0)
      expect(unrelated.memoryText).toBe("")

      const foreign = await new RememOrchestrator([providerB], config).processPrompt(
        continuityPrompt,
        { ...sessionB, projectId: "other-project", sessionId: "learning-foreign" },
      )
      expect(foreign.trace.selectedResults).toBe(0)
      expect(foreign.memoryText).toBe("")
    } finally {
      await providerB.dispose()
    }
  })

  it("recalls a learned fact/decision/blocker from a short continuity prompt via anchor routing (TASK-004/005/006)", async () => {
    const providerConfig = {
      type: "postgres" as const,
      id: "learning-loop-anchor",
      connectionString: databaseUrl ?? "",
      primary: true,
      maxConnections: 2,
      catalogLimit: 100,
    }
    const base = testConfig()
    const config = testConfig({
      providers: [providerConfig],
      capture: { ...base.capture, enabled: true, autoPromote: true },
    })
    const sessionA = {
      directory: "/workspace/orion-anchor",
      worktree: "/workspace/orion-anchor",
      projectId: "learning-loop-anchor",
      sessionId: "anchor-session-a",
    }
    const statements = [
      "Orion uses PostgreSQL for durable memory.",
      "We decided to use logical replication for Orion.",
      "The Orion rollout is blocked on a restore drill.",
    ]
    const prompt = `Can you check this? ${statements.join(" ")}`
    const providerA = new PostgresMemoryProvider(providerConfig)
    const capture = createCaptureCoordinator([providerA], config, { log: () => undefined })
    try {
      capture?.enqueue({
        host: "opencode-v2" as const,
        context: sessionA,
        sessionId: sessionA.sessionId,
        messageId: "anchor-message-a",
        text: prompt,
      })
      await capture?.idle()
      expect(capture?.explain(sessionA.sessionId)).toMatchObject({ outcome: "promoted" })
    } finally {
      await capture?.dispose()
      await providerA.dispose()
    }

    // A fresh provider, connection pool, and orchestrator: no Session A process-local
    // state. No manual memory writes, approval, or preseeded catalog aliases.
    const providerB = new PostgresMemoryProvider(providerConfig)
    const sessionB = { ...sessionA, sessionId: "anchor-session-b" }
    try {
      // Exactly the short continuity prompt from TASK-004; the long topic-rich
      // continuity prompt is covered by the "learns multiple user statements" case
      // above and must keep passing unchanged.
      const shortContinuityPrompt = "Let's continue the Orion work."
      const injection = await new RememOrchestrator([providerB], config).processPrompt(
        shortContinuityPrompt,
        sessionB,
      )

      expect(injection.plan.shouldRetrieve).toBe(true)
      // Positively pin that the *deterministic anchor path* (not the
      // orchestrator's independent semantic-recognition fallback, which
      // also attempts on this same low-confidence deterministic plan and
      // could otherwise coincidentally produce a passing recall on its
      // own) is what produced this recall. Confirmed empirically: without
      // this assertion, a regression that silently broke anchor routing
      // could go undetected if the semantic layer happened to compensate.
      expect(injection.plan.signals).toContain("anchor-routed continuity fallback")
      expect(injection.trace.recognitionStage).toBe("deterministic")
      expect(injection.memoryText, JSON.stringify(injection.trace)).not.toBe("")
      for (const statement of statements) expect(injection.memoryText).toContain(statement)
      expect(injection.memoryText).not.toContain("Can you check this?")
      expect(injection.trace.recallTokens).toBeLessThanOrEqual(config.budgets.recallTokens)

      const records = await providerB.search({
        ...request("orion"),
        context: sessionB,
      })
      expect(records).toHaveLength(3)
      for (const { record } of records) {
        expect(record.provenance?.[0]?.source).toMatchObject({
          kind: "user",
          externalId: "anchor-message-a",
          metadata: { sessionId: sessionA.sessionId },
        })
      }

      // TASK-006 negative control: the identical successful prompt in a foreign
      // project must inject zero detailed memory.
      const foreign = await new RememOrchestrator([providerB], config).processPrompt(
        shortContinuityPrompt,
        { ...sessionB, projectId: "other-anchor-project", sessionId: "anchor-foreign" },
      )
      expect(foreign.trace.selectedResults).toBe(0)
      expect(foreign.memoryText).toBe("")

      // TASK-006 negative control: an unrelated prompt in a fresh same-project
      // session must inject zero detailed memory.
      const unrelated = await new RememOrchestrator([providerB], config).processPrompt(
        "Explain a Python list comprehension.",
        { ...sessionB, sessionId: "anchor-unrelated" },
      )
      expect(unrelated.trace.selectedResults).toBe(0)
      expect(unrelated.memoryText).toBe("")

      // TASK-006: a bare "continue the work" prompt must not gain a new anchor
      // route just because catalog entries exist for this project.
      const bareContinuity = await new RememOrchestrator([providerB], config).processPrompt(
        "continue the work",
        { ...sessionB, sessionId: "anchor-bare-continuity" },
      )
      expect(bareContinuity.trace.selectedResults).toBe(0)
      expect(bareContinuity.memoryText).toBe("")
    } finally {
      await providerB.dispose()
    }
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

    const updatedCandidate: CandidateMemory = {
      ...candidate,
      memory: {
        ...candidate.memory,
        title: "Explicit decision: use blue-green deploys",
        content: "Use blue-green deploys.",
      },
      reasons: ["updated extraction"],
    }
    await provider.persistCandidate(observation, updatedCandidate)
    await expect(
      provider.persistCandidate(
        {
          ...observation,
          context: { ...observation.context, sessionId: "foreign-session" },
        },
        {
          ...updatedCandidate,
          memory: {
            ...updatedCandidate.memory,
            title: "Cross-session replacement",
            content: "This must not replace the original session candidate.",
          },
        },
      ),
    ).rejects.toThrow("captured observation id belongs to another context")

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
      metadata: { providerId: "remem-local", reasons: ["updated extraction"] },
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
        title: updatedCandidate.memory.title,
        content: updatedCandidate.memory.content,
      }),
    )
    const foreignPendingCandidate = randomUUID()
    await pool.query(
      `INSERT INTO remem.candidate_memories
        (id, session_event_id, type, title, content, scope_kind, scope_id, confidence, status, metadata)
       VALUES ($1, $2, 'decision', 'Foreign pending decision', 'Do not replace this.', 'project', 'phoenix', 0.9, 'pending', $3::jsonb)`,
      [
        foreignPendingCandidate,
        observation.id,
        JSON.stringify({ providerId: "other-provider", reasons: ["foreign candidate"] }),
      ],
    )
    await expect(
      provider.persistCandidate(observation, {
        ...updatedCandidate,
        id: foreignPendingCandidate,
        memory: {
          ...updatedCandidate.memory,
          title: "Attempted replacement",
          content: "This must not replace the foreign candidate.",
        },
      }),
    ).rejects.toThrow("captured candidate id belongs to another context")
    expect(
      (
        await pool.query<{ content: string; provider_id: string }>(
          `SELECT content, metadata->>'providerId' AS provider_id
           FROM remem.candidate_memories WHERE id = $1`,
          [foreignPendingCandidate],
        )
      ).rows[0],
    ).toEqual({ content: "Do not replace this.", provider_id: "other-provider" })
    const otherProviderCandidate = randomUUID()
    await pool.query(
      `INSERT INTO remem.candidate_memories
        (id, type, title, content, scope_kind, scope_id, confidence, status, metadata)
       VALUES ($1, 'decision', 'Other provider decision', 'This must not be promoted here.', 'project', 'phoenix', 0.9, 'approved', $2::jsonb)`,
      [otherProviderCandidate, JSON.stringify({ providerId: "other-provider" })],
    )
    await provider.reviewCandidate(candidate.id, "approved")
    await provider.persistCandidate(observation, {
      ...updatedCandidate,
      memory: { ...updatedCandidate.memory, content: "Do not overwrite reviewed content." },
    })
    expect(
      (
        await pool.query<{ content: string }>(
          "SELECT content FROM remem.candidate_memories WHERE id = $1",
          [candidate.id],
        )
      ).rows[0]?.content,
    ).toBe(updatedCandidate.memory.content)
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

  it("reuses processed identities without rewriting or reviving promoted memories", async () => {
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
    const legacy: CandidateMemory = {
      id: candidateId,
      observationIds: [],
      confidence: 0.98,
      status: "approved",
      reasons: ["legacy extraction"],
      memory: {
        title: "Project fact: Remember that Atlas uses SQLite.",
        content: "Remember that Atlas uses SQLite.",
        type: "semantic",
        scope: { kind: "project", id: "candidate-upgrade" },
        provenance: [
          {
            source: { kind: "user", externalId: "candidate-upgrade-message" },
            capturedAt: "2026-09-02T12:00:00.000Z",
            original: true,
          },
        ],
      },
    }
    const pipeline = new DeterministicConsolidationPipeline(provider)
    const first = await pipeline.consolidate([legacy])
    await expect(
      provider.findByConsolidationCandidateId(candidateId, {
        kind: "project",
        id: "other-project",
      }),
    ).resolves.toBeUndefined()
    const current: CandidateMemory = {
      ...legacy,
      reasons: ["current extraction"],
      memory: {
        ...legacy.memory,
        title: "Project fact: Atlas uses SQLite.",
        content: "Atlas uses SQLite.",
        metadata: {
          capture: { extractorVersion: "deterministic-spans-v1" },
        },
      },
    }

    const repeated = await pipeline.consolidate([current])
    const consolidation = repeated[0]?.memory.metadata?.consolidation as
      { memoryId?: string } | undefined
    const record = consolidation?.memoryId
      ? await provider.get(consolidation.memoryId, {
          ...context,
          projectId: "candidate-upgrade",
        })
      : undefined

    expect(first[0]?.status).toBe("promoted")
    expect(repeated[0]?.reasons).toContain("reused processed candidate")
    expect(record).toMatchObject({
      title: legacy.memory.title,
      content: legacy.memory.content,
      metadata: {
        consolidation: { candidateId },
      },
    })
    expect(
      (
        await pool.query<{ count: string }>(
          `SELECT count(*) FROM remem.memories
           WHERE provider_id = $1
             AND (
               metadata->'consolidation'->>'candidateId' = $2 OR
               metadata->'consolidation'->>'lastCandidateId' = $2
             )`,
          [provider.id, candidateId],
        )
      ).rows[0]?.count,
    ).toBe("1")

    if (!record) throw new Error("promoted memory missing")
    const edited = await provider.update(record.id, {
      ...legacy.memory,
      title: "Reviewed Atlas storage",
      content: "Atlas uses PostgreSQL after review.",
      type: "decision",
      metadata: record.metadata ?? {},
      tags: ["human-reviewed"],
    })
    const savedEdit = await provider.get(edited.id, { ...context, projectId: "candidate-upgrade" })
    expect((await pipeline.consolidate([current]))[0]?.reasons).toContain(
      "reused processed candidate",
    )
    expect(await provider.get(edited.id, { ...context, projectId: "candidate-upgrade" })).toEqual(
      savedEdit,
    )

    const successor = await provider.supersede(edited.id, {
      ...legacy.memory,
      title: "Current Atlas storage",
      content: "Atlas uses PostgreSQL with encrypted storage.",
      metadata: { consolidation: { candidateId: randomUUID(), action: "supersedes" } },
    })
    const savedSuccessor = await provider.get(successor.id, {
      ...context,
      projectId: "candidate-upgrade",
    })
    await expect(
      provider.findByConsolidationCandidateId(candidateId, legacy.memory.scope),
    ).resolves.toMatchObject({
      id: record.id,
      freshness: "superseded",
    })
    expect((await pipeline.consolidate([legacy]))[0]?.reasons).toContain(
      "reused processed candidate",
    )
    expect(
      await provider.get(successor.id, { ...context, projectId: "candidate-upgrade" }),
    ).toEqual(savedSuccessor)
    expect(
      (
        await pool.query<{ count: string }>(
          "SELECT count(*) FROM remem.memories WHERE provider_id = $1 AND scope_id = $2",
          [provider.id, "candidate-upgrade"],
        )
      ).rows[0]?.count,
    ).toBe("2")
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

  it("respects batchSize/LIMIT instead of reembedding every stale row in one run", async () => {
    const provider = new PostgresMemoryProvider(
      {
        type: "postgres",
        id: "reembed-batch-test",
        connectionString: databaseUrl ?? "",
        primary: true,
        maxConnections: 2,
        catalogLimit: 10,
      },
      { pool },
    )
    // Drain any backlog left by earlier tests in this shared-schema
    // sequential suite first, so the batch-size assertions below only ever
    // see the three rows this test controls.
    const drain = await provider.reembedStale(10_000)
    expect(drain.status).not.toBe("failed")

    const ids = await Promise.all(
      ["oldest", "middle", "newest"].map(
        async (label) =>
          (
            await provider.write({
              title: `Reembed batch target (${label})`,
              content: `Batch-size regression content for the ${label} row.`,
              scope: { kind: "workspace", id: "phoenix" },
              type: "decision",
            })
          ).id,
      ),
    )
    try {
      // Force a deterministic claim order (oldest updated_at first, matching
      // claimStaleRows' `ORDER BY me.updated_at`) so which two of the three
      // rows get claimed by a batch size of 2 is not left to chance.
      await pool.query(
        `UPDATE remem.memory_embeddings
           SET model = 'stale-batch-test', updated_at = now() - ($2 * interval '1 hour')
         WHERE memory_id = $1`,
        [ids[0], 3],
      )
      await pool.query(
        `UPDATE remem.memory_embeddings
           SET model = 'stale-batch-test', updated_at = now() - ($2 * interval '1 hour')
         WHERE memory_id = $1`,
        [ids[1], 2],
      )
      await pool.query(
        `UPDATE remem.memory_embeddings
           SET model = 'stale-batch-test', updated_at = now() - ($2 * interval '1 hour')
         WHERE memory_id = $1`,
        [ids[2], 1],
      )

      const firstBatch = await provider.reembedStale(2)
      expect(firstBatch.status).toBe("completed")
      expect(firstBatch.claimed).toBe(2)
      expect(firstBatch.reembedded).toBe(2)

      const modelsAfterFirstBatch = await pool.query<{ memory_id: string; model: string }>(
        "SELECT memory_id, model FROM remem.memory_embeddings WHERE memory_id = ANY($1)",
        [ids],
      )
      const modelById = new Map(modelsAfterFirstBatch.rows.map((row) => [row.memory_id, row.model]))
      // The two oldest rows (by the updated_at we set above) must have been
      // claimed; the newest must still be waiting. A regression that dropped
      // the LIMIT clause would instead reembed all three in the first batch.
      expect(modelById.get(ids[0]!)).toBe("remem-local-hash-v1")
      expect(modelById.get(ids[1]!)).toBe("remem-local-hash-v1")
      expect(modelById.get(ids[2]!)).toBe("stale-batch-test")

      const secondBatch = await provider.reembedStale(2)
      expect(secondBatch.status).toBe("completed")
      expect(secondBatch.claimed).toBe(1)
      expect(secondBatch.reembedded).toBe(1)
      const finalRow = await pool.query<{ model: string }>(
        "SELECT model FROM remem.memory_embeddings WHERE memory_id = $1",
        [ids[2]],
      )
      expect(finalRow.rows[0]?.model).toBe("remem-local-hash-v1")
    } finally {
      // Defensive: if an assertion above threw before the second batch ran,
      // don't leave any of these three rows behind at the 'stale-batch-test'
      // marker for later tests in this shared, sequential-suite schema.
      await provider.reembedStale(10_000)
    }
  })

  it("recovers an interrupted reembed claim before reclaiming and completing it", async () => {
    const provider = new PostgresMemoryProvider(
      {
        type: "postgres",
        id: "reembed-recovery-test",
        connectionString: databaseUrl ?? "",
        primary: true,
        maxConnections: 2,
        catalogLimit: 10,
      },
      { pool },
    )
    const written = await provider.write({
      title: "Reembed recovery target",
      content: "This row's claim was interrupted before the process crashed.",
      scope: { kind: "workspace", id: "phoenix" },
      type: "decision",
    })
    const interruptedRunId = randomUUID()
    await pool.query(
      "UPDATE remem.memory_embeddings SET model = 'stale-recovery-test', reembed_claim_id = $2 WHERE memory_id = $1",
      [written.id, interruptedRunId],
    )
    await pool.query(
      `INSERT INTO remem.consolidation_records
        (id, kind, status, input_memory_ids, started_at)
       VALUES ($1, 'embedding-reembed', 'started', $2, now() - interval '1 hour')`,
      [interruptedRunId, [written.id]],
    )

    try {
      const recoveredRun = await provider.reembedStale(1_000)

      expect(recoveredRun.status).toBe("completed")
      expect(
        (
          await pool.query<{ status: string }>(
            "SELECT status FROM remem.consolidation_records WHERE id = $1",
            [interruptedRunId],
          )
        ).rows[0]?.status,
      ).toBe("failed")
      const row = await pool.query<{ model: string; reembed_claim_id: string | null }>(
        "SELECT model, reembed_claim_id FROM remem.memory_embeddings WHERE memory_id = $1",
        [written.id],
      )
      // The interrupted claim must be released (not left dangling, which would
      // make the row permanently unclaimable) and the row actually reembedded
      // in this same run.
      expect(row.rows[0]?.reembed_claim_id).toBeNull()
      expect(row.rows[0]?.model).toBe("remem-local-hash-v1")
    } finally {
      // Defensive: if an assertion above threw before reembedStale ran (or
      // before it finished), don't leave this row's claim dangling or its
      // model at the transient marker for later tests in this shared,
      // sequential-suite schema.
      await pool.query(
        "UPDATE remem.memory_embeddings SET reembed_claim_id = NULL WHERE memory_id = $1",
        [written.id],
      )
      await provider.reembedStale(10_000)
    }
  })

  it("records a failed run instead of a false completion when every reembed attempt errors", async () => {
    const seedProvider = new PostgresMemoryProvider(
      {
        type: "postgres",
        id: "reembed-failure-seed",
        connectionString: databaseUrl ?? "",
        primary: true,
        maxConnections: 2,
        catalogLimit: 10,
      },
      { pool },
    )
    const written = await seedProvider.write({
      title: "Reembed failure target",
      content: "This row must remain untouched when reembedding fails.",
      scope: { kind: "workspace", id: "phoenix" },
      type: "decision",
    })
    const originalModel = (
      await pool.query<{ model: string }>(
        "SELECT model FROM remem.memory_embeddings WHERE memory_id = $1",
        [written.id],
      )
    ).rows[0]?.model
    await pool.query(
      "UPDATE remem.memory_embeddings SET model = 'stale-failure-test' WHERE memory_id = $1",
      [written.id],
    )

    const failingEmbedding: EmbeddingModel = {
      id: "always-fails-integration-test-marker",
      dimensions: 384,
      embed: () => Promise.reject(new Error("embedding backend unavailable")),
    }
    const failingProvider = new PostgresMemoryProvider(
      {
        type: "postgres",
        id: "reembed-failure-runner",
        connectionString: databaseUrl ?? "",
        primary: true,
        maxConnections: 2,
        catalogLimit: 10,
      },
      { pool, embeddingModel: failingEmbedding },
    )
    try {
      // A large batch: every row not already at "always-fails-integration-test-marker"
      // looks stale to this runner, so this must cover the whole current
      // backlog to guarantee our row is included regardless of what else is
      // in the shared schema at this point in the suite.
      const result = await failingProvider.reembedStale(10_000)

      expect(result.status).toBe("failed")
      expect(result.reembedded).toBe(0)
      expect(result.errors.length).toBeGreaterThan(0)
      const row = await pool.query<{ model: string; reembed_claim_id: string | null }>(
        "SELECT model, reembed_claim_id FROM remem.memory_embeddings WHERE memory_id = $1",
        [written.id],
      )
      // Nothing was actually overwritten, and the claim was released rather
      // than left dangling.
      expect(row.rows[0]?.model).toBe("stale-failure-test")
      expect(row.rows[0]?.reembed_claim_id).toBeNull()
      const runRecord = await pool.query<{ status: string }>(
        "SELECT status FROM remem.consolidation_records WHERE id = $1",
        [result.id],
      )
      expect(runRecord.rows[0]?.status).toBe("failed")
    } finally {
      // Restore the row to a healthy state so it doesn't linger as permanent
      // backlog noise for the rest of this sequential suite, even if an
      // assertion above threw first.
      await pool.query(
        "UPDATE remem.memory_embeddings SET model = $2, reembed_claim_id = NULL WHERE memory_id = $1",
        [written.id, originalModel],
      )
    }
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
    // Snapshot every row's model BEFORE marking ours stale, so `finally`
    // restores this row to its natural freshly-written state, and every
    // other row in this shared schema to whatever it was before this test
    // touched it -- not to whatever transient marker this test happened to
    // set.
    const originalEmbeddings = (
      await pool.query<{ memory_id: string; model: string }>(
        "SELECT memory_id, model FROM remem.memory_embeddings",
      )
    ).rows
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
      for (const original of originalEmbeddings) {
        await pool.query("UPDATE remem.memory_embeddings SET model = $2 WHERE memory_id = $1", [
          original.memory_id,
          original.model,
        ])
      }
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

  it("surfaces capacity/compaction-level status via doctor for every provider/project with evidence (TASK-012/TASK-060)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remem-doctor-capacity-"))
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
    const projectId = "doctor-capacity-project"
    const provider = new PostgresMemoryProvider({
      type: "postgres",
      id: "doctor-capacity-provider",
      connectionString: databaseUrl ?? "",
      primary: true,
      maxConnections: 2,
      catalogLimit: 100,
    })
    try {
      await mkdir(paths.dataDir, { recursive: true, mode: 0o700 })
      await writeAppConfig(config, paths)

      const admitted = admitEvidence(
        {
          providerId: "doctor-capacity-provider",
          host: "opencode-v2",
          context: {
            directory: "/workspace/doctor-capacity",
            worktree: "/workspace/doctor-capacity",
            projectId,
            sessionId: "doctor-capacity-session",
          },
          turnId: "d1",
          messageId: "d1-message",
          role: "user",
          origin: "direct-user",
          kind: "turn-completed",
          occurredAt: "2026-09-16T00:00:00.000Z",
          payload: {
            text: "We decided something worth remembering for the doctor capacity check.",
          },
        },
        { providerId: "doctor-capacity-provider", host: "opencode-v2", projectId },
        { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
      )
      if (admitted.outcome !== "admitted") throw new Error("seed admission failed")
      await provider.appendEvidence(admitted.envelope)

      const report = await runDoctor(config, paths, {
        run: () => Promise.resolve({ stdout: "", stderr: "" }),
      })
      const check = report.checks.find(
        (c) => c.name === `capacity doctor-capacity-provider/${projectId}`,
      )
      expect(check).toBeDefined()
      expect(check?.status).toBe("ok")
      expect(check?.detail).toMatch(/compaction level: conservative/)
    } finally {
      await provider.dispose()
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

  it("uses the active embedding model when constructing doctor providers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remem-doctor-provider-model-"))
    const paths = rememPaths({
      REMEM_CONFIG_DIR: path.join(root, "config"),
      REMEM_DATA_DIR: path.join(root, "data"),
    })
    const embeddingModel: EmbeddingModel = {
      id: "doctor-active-model",
      dimensions: 384,
      embed: () => Promise.resolve(new Array(384).fill(0)),
    }
    const config: RememAppConfig = {
      version: 1,
      storage: { mode: "external", connectionString: databaseUrl ?? "" },
      providers: [
        {
          type: "postgres",
          id: "doctor-provider-model",
          connectionString: databaseUrl ?? "",
          primary: true,
          maxConnections: 2,
          catalogLimit: 10,
        },
      ],
      embedding: { provider: "neural", model: "bge-small-en-v1.5", dimensions: 384 },
    }
    const originalSettings = (
      await pool.query<{ model: string; dimensions: number; updated_at: string }>(
        "SELECT model, dimensions, updated_at FROM remem.embedding_settings WHERE id = true",
      )
    ).rows[0]
    try {
      await mkdir(paths.dataDir, { recursive: true, mode: 0o700 })
      await writeAppConfig(config, paths)
      await pool.query("DELETE FROM remem.embedding_settings WHERE id = true")

      await runDoctor(
        config,
        paths,
        { run: () => Promise.resolve({ stdout: "", stderr: "" }) },
        { embeddingModel },
      )

      let recorded: { model: string; dimensions: number } | undefined
      for (let attempt = 0; attempt < 10; attempt++) {
        recorded = (
          await pool.query<{ model: string; dimensions: number }>(
            "SELECT model, dimensions FROM remem.embedding_settings WHERE id = true",
          )
        ).rows[0]
        if (recorded?.model === embeddingModel.id) break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(recorded).toMatchObject({
        model: embeddingModel.id,
        dimensions: embeddingModel.dimensions,
      })
    } finally {
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

  describe("episodic evidence: appendEvidence/readEvidence (TASK-010)", () => {
    const episodicProviderConfig = {
      type: "postgres" as const,
      id: "episodic-provider-a",
      connectionString: databaseUrl ?? "",
      primary: true,
      maxConnections: 2,
      catalogLimit: 100,
    }
    const episodicContext: MemoryContext = {
      directory: "/workspace/episodic",
      worktree: "/workspace/episodic",
      projectId: "episodic-project",
      sessionId: "episodic-session-a",
    }
    const authority: AdmissionAuthority = {
      providerId: "episodic-provider-a",
      host: "opencode-v2",
      projectId: "episodic-project",
    }
    const enabledConfig = { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true }

    function candidate(overrides: Partial<RawEvidenceCandidate> = {}): RawEvidenceCandidate {
      return {
        providerId: "episodic-provider-a",
        host: "opencode-v2",
        context: episodicContext,
        turnId: "turn-episodic-1",
        messageId: "message-episodic-1",
        role: "user",
        origin: "direct-user",
        kind: "turn-completed",
        occurredAt: "2026-09-16T00:00:00.000Z",
        payload: { text: "We decided to use logical replication for Orion." },
        ...overrides,
      }
    }

    it("appends a fresh admitted envelope and reads it back unchanged", async () => {
      const provider = new PostgresMemoryProvider(episodicProviderConfig)
      try {
        const admitted = admitEvidence(candidate(), authority, enabledConfig)
        expect(admitted.outcome).toBe("admitted")
        if (admitted.outcome !== "admitted") return

        const result = await provider.appendEvidence(admitted.envelope)
        expect(result).toEqual({ outcome: "appended", id: admitted.envelope.id })

        const readBack = await provider.readEvidence(
          "episodic-provider-a",
          admitted.envelope.id,
          episodicContext,
        )
        expect(readBack).toMatchObject({
          id: admitted.envelope.id,
          providerId: "episodic-provider-a",
          host: "opencode-v2",
          role: "user",
          origin: "direct-user",
          kind: "turn-completed",
          payload: { text: "We decided to use logical replication for Orion." },
          contentHash: admitted.envelope.contentHash,
        })
        expect(readBack?.context.projectId).toBe("episodic-project")
        expect(readBack?.context.sessionId).toBe("episodic-session-a")
      } finally {
        await provider.dispose()
      }
    })

    it("round-trips payload.metadata, not just payload.text", async () => {
      const provider = new PostgresMemoryProvider(episodicProviderConfig)
      try {
        const admitted = admitEvidence(
          candidate({
            turnId: "turn-episodic-metadata",
            role: "tool",
            kind: "tool-result",
            payload: { metadata: { exitCode: 0, files: ["src/foo.ts", "src/bar.ts"] } },
          }),
          authority,
          enabledConfig,
        )
        expect(admitted.outcome).toBe("admitted")
        if (admitted.outcome !== "admitted") return

        await provider.appendEvidence(admitted.envelope)
        const readBack = await provider.readEvidence(
          "episodic-provider-a",
          admitted.envelope.id,
          episodicContext,
        )
        expect(readBack?.payload).toEqual({
          metadata: { exitCode: 0, files: ["src/foo.ts", "src/bar.ts"] },
        })
      } finally {
        await provider.dispose()
      }
    })

    it("reads back an envelope with no metadata (text-only) without a stray empty metadata object", async () => {
      const provider = new PostgresMemoryProvider(episodicProviderConfig)
      try {
        const admitted = admitEvidence(
          candidate({ turnId: "turn-episodic-no-metadata" }),
          authority,
          enabledConfig,
        )
        expect(admitted.outcome).toBe("admitted")
        if (admitted.outcome !== "admitted") return

        await provider.appendEvidence(admitted.envelope)
        const readBack = await provider.readEvidence(
          "episodic-provider-a",
          admitted.envelope.id,
          episodicContext,
        )
        expect(readBack?.payload).toEqual({
          text: "We decided to use logical replication for Orion.",
        })
        expect(readBack?.payload).not.toHaveProperty("metadata")
      } finally {
        await provider.dispose()
      }
    })

    it("treats an exact repeated append as an idempotent no-op (duplicate)", async () => {
      const provider = new PostgresMemoryProvider(episodicProviderConfig)
      try {
        const admitted = admitEvidence(
          candidate({ turnId: "turn-episodic-dup" }),
          authority,
          enabledConfig,
        )
        expect(admitted.outcome).toBe("admitted")
        if (admitted.outcome !== "admitted") return

        const first = await provider.appendEvidence(admitted.envelope)
        expect(first.outcome).toBe("appended")
        const second = await provider.appendEvidence(admitted.envelope)
        expect(second).toEqual({ outcome: "duplicate", id: admitted.envelope.id })

        const count = await pool.query<{ count: string }>(
          "SELECT count(*) FROM remem.session_events WHERE provider_id = $1 AND evidence_id = $2",
          ["episodic-provider-a", admitted.envelope.id],
        )
        expect(count.rows[0]?.count).toBe("1")
      } finally {
        await provider.dispose()
      }
    })

    it("rejects a same-identity/different-content append as a collision, without modifying the first record", async () => {
      const provider = new PostgresMemoryProvider(episodicProviderConfig)
      try {
        const first = admitEvidence(
          candidate({ turnId: "turn-episodic-collide" }),
          authority,
          enabledConfig,
        )
        expect(first.outcome).toBe("admitted")
        if (first.outcome !== "admitted") return
        await provider.appendEvidence(first.envelope)

        // Same identity (same turnId -> same derived id), different content:
        // construct a second envelope sharing the first's id/context but a
        // different contentHash, simulating what would happen if two
        // genuinely different pieces of evidence collided on identity.
        const collidingEnvelope = {
          ...first.envelope,
          contentHash: `${first.envelope.contentHash.slice(0, -1)}${first.envelope.contentHash.endsWith("0") ? "1" : "0"}`,
        }
        const result = await provider.appendEvidence(collidingEnvelope)
        expect(result).toEqual({ outcome: "collision", id: first.envelope.id })

        // The first record must be unmodified: still the original content hash.
        const stored = await pool.query<{ content_hash: string; safe_text: string }>(
          "SELECT content_hash, safe_text FROM remem.session_events WHERE provider_id = $1 AND evidence_id = $2",
          ["episodic-provider-a", first.envelope.id],
        )
        expect(stored.rows[0]?.content_hash).toBe(first.envelope.contentHash)
        expect(stored.rows[0]?.safe_text).toBe(first.envelope.payload.text)
      } finally {
        await provider.dispose()
      }
    })

    it("scopes identity by provider: the same evidence_id under a different provider is not a collision", async () => {
      const providerA = new PostgresMemoryProvider(episodicProviderConfig)
      const providerB = new PostgresMemoryProvider({
        ...episodicProviderConfig,
        id: "episodic-provider-b",
      })
      try {
        const admitted = admitEvidence(
          candidate({ turnId: "turn-episodic-cross-provider" }),
          authority,
          enabledConfig,
        )
        expect(admitted.outcome).toBe("admitted")
        if (admitted.outcome !== "admitted") return

        const resultA = await providerA.appendEvidence(admitted.envelope)
        expect(resultA.outcome).toBe("appended")

        // Same evidence_id, but under a different provider_id: must succeed
        // independently, not be treated as a collision or duplicate of A's row.
        const resultB = await providerB.appendEvidence({
          ...admitted.envelope,
          providerId: "episodic-provider-b",
        })
        expect(resultB.outcome).toBe("appended")

        const count = await pool.query<{ count: string }>(
          "SELECT count(*) FROM remem.session_events WHERE evidence_id = $1",
          [admitted.envelope.id],
        )
        expect(count.rows[0]?.count).toBe("2")
      } finally {
        await providerA.dispose()
        await providerB.dispose()
      }
    })

    it("scopes identity by project too: the same provider/evidence_id under a different project succeeds independently, not a collision", async () => {
      const provider = new PostgresMemoryProvider(episodicProviderConfig)
      try {
        const admitted = admitEvidence(
          candidate({ turnId: "turn-episodic-cross-project" }),
          authority,
          enabledConfig,
        )
        expect(admitted.outcome).toBe("admitted")
        if (admitted.outcome !== "admitted") return
        await provider.appendEvidence(admitted.envelope)

        // The unique index is (provider_id, project_id, evidence_id) --
        // project_id is included as defense-in-depth (see
        // migrations/0008_episodic_evidence.sql) so DB-level identity
        // scoping does not depend entirely on deriveEvidenceId
        // (observation-admission.ts) continuing to fold projectId into the
        // hash. Same provider_id and (artificially) the same evidence_id,
        // but a genuinely different project: this must succeed
        // independently, exactly like the cross-provider case above, not
        // be treated as identity contention across an unrelated project.
        const otherProjectEnvelope = {
          ...admitted.envelope,
          context: { ...admitted.envelope.context, projectId: "other-episodic-project" },
        }
        const result = await provider.appendEvidence(otherProjectEnvelope)
        expect(result.outcome).toBe("appended")

        const count = await pool.query<{ count: string }>(
          "SELECT count(*) FROM remem.session_events WHERE provider_id = $1 AND evidence_id = $2",
          ["episodic-provider-a", admitted.envelope.id],
        )
        expect(count.rows[0]?.count).toBe("2")
      } finally {
        await provider.dispose()
      }
    })

    it("readEvidence returns undefined (non-disclosing) for a foreign project, not evidence about it", async () => {
      const provider = new PostgresMemoryProvider(episodicProviderConfig)
      try {
        const admitted = admitEvidence(
          candidate({ turnId: "turn-episodic-foreign-read" }),
          authority,
          enabledConfig,
        )
        expect(admitted.outcome).toBe("admitted")
        if (admitted.outcome !== "admitted") return
        await provider.appendEvidence(admitted.envelope)

        const readFromForeignProject = await provider.readEvidence(
          "episodic-provider-a",
          admitted.envelope.id,
          { ...episodicContext, projectId: "other-episodic-project" },
        )
        expect(readFromForeignProject).toBeUndefined()
      } finally {
        await provider.dispose()
      }
    })

    it("readEvidence returns undefined for an unknown evidence id", async () => {
      const provider = new PostgresMemoryProvider(episodicProviderConfig)
      try {
        const readUnknown = await provider.readEvidence(
          "episodic-provider-a",
          "0".repeat(64),
          episodicContext,
        )
        expect(readUnknown).toBeUndefined()
      } finally {
        await provider.dispose()
      }
    })

    it("appendEvidence requires a session id, matching the legacy persistCandidate requirement", async () => {
      const provider = new PostgresMemoryProvider(episodicProviderConfig)
      try {
        const admitted = admitEvidence(
          candidate({ turnId: "turn-episodic-no-session" }),
          authority,
          enabledConfig,
        )
        expect(admitted.outcome).toBe("admitted")
        if (admitted.outcome !== "admitted") return

        const envelopeWithoutSession = {
          ...admitted.envelope,
          context: {
            directory: admitted.envelope.context.directory,
            worktree: admitted.envelope.context.worktree,
            projectId: admitted.envelope.context.projectId,
          },
        }
        await expect(provider.appendEvidence(envelopeWithoutSession)).rejects.toThrow(
          "episodic evidence requires a session id",
        )
      } finally {
        await provider.dispose()
      }
    })

    it("rejects an invalid role/origin/kind defensively, rather than letting an unhandled Postgres CHECK-violation exception through", async () => {
      // admitEvidence already validates these before a real EvidenceEnvelope
      // is ever constructed; this test simulates a caller that bypasses
      // admission entirely (a manually-constructed object at a JS/TS
      // boundary, where compile-time types are erased at runtime) to prove
      // appendEvidence's own defensive check runs before the query, not
      // relying solely on the database's CHECK constraint to fail closed.
      const provider = new PostgresMemoryProvider(episodicProviderConfig)
      try {
        const admitted = admitEvidence(
          candidate({ turnId: "turn-episodic-invalid-role" }),
          authority,
          enabledConfig,
        )
        expect(admitted.outcome).toBe("admitted")
        if (admitted.outcome !== "admitted") return

        const invalidRole = {
          ...admitted.envelope,
          role: "narrator" as unknown as typeof admitted.envelope.role,
        }
        await expect(provider.appendEvidence(invalidRole)).rejects.toThrow("invalid evidence role")

        const invalidOrigin = {
          ...admitted.envelope,
          origin: "made-up" as unknown as typeof admitted.envelope.origin,
        }
        await expect(provider.appendEvidence(invalidOrigin)).rejects.toThrow(
          "invalid evidence origin",
        )

        const invalidKind = {
          ...admitted.envelope,
          kind: "semantic-fact" as unknown as typeof admitted.envelope.kind,
        }
        await expect(provider.appendEvidence(invalidKind)).rejects.toThrow("invalid evidence kind")

        // None of the rejected attempts should have written a row.
        const count = await pool.query<{ count: string }>(
          "SELECT count(*) FROM remem.session_events WHERE provider_id = $1 AND evidence_id = $2",
          ["episodic-provider-a", admitted.envelope.id],
        )
        expect(count.rows[0]?.count).toBe("0")
      } finally {
        await provider.dispose()
      }
    })

    it("mixed table: a legacy row (no evidence_id) and a new evidence row coexist in the same project, and each path's queries correctly exclude the other's row", async () => {
      const providerConfig = {
        type: "postgres" as const,
        id: "legacy-coexistence-provider",
        connectionString: databaseUrl ?? "",
        primary: true,
        maxConnections: 2,
        catalogLimit: 100,
      }
      const provider = new PostgresMemoryProvider(providerConfig)
      const legacyContext: MemoryContext = {
        directory: "/workspace/legacy-coexist",
        worktree: "/workspace/legacy-coexist",
        projectId: "legacy-coexistence-project",
        sessionId: "legacy-coexistence-session",
      }
      const observation: SessionObservation = {
        id: randomUUID(),
        kind: "decision",
        context: legacyContext,
        occurredAt: "2026-09-16T00:00:00.000Z",
        source:
          "remem://opencode-v2/sessions/legacy-coexistence-session/messages/legacy-coexist-message",
        payload: {
          host: "opencode-v2",
          messageId: "legacy-coexist-message",
          text: "We decided that the legacy capture path still works as before.",
        },
      }
      const legacyCandidate: CandidateMemory = {
        id: randomUUID(),
        observationIds: [observation.id],
        memory: {
          title: "Explicit decision: legacy capture path",
          content: "We decided that the legacy capture path still works as before.",
          type: "decision",
          scope: { kind: "project", id: legacyContext.projectId },
          provenance: [
            {
              source: {
                kind: "user",
                uri: observation.source,
                externalId: "legacy-coexist-message",
              },
              capturedAt: observation.occurredAt,
              original: true,
            },
          ],
        },
        confidence: 0.9,
        status: "pending",
        reasons: ["explicit decision"],
      }
      try {
        // Exercises the same remem.session_events write path
        // createCaptureCoordinator's legacy capture flow uses, directly --
        // this is the exact pattern the pre-existing "persists a captured
        // observation and pending candidate atomically" test above uses.
        await provider.persistCandidate(observation, legacyCandidate)

        // Now append a *new* evidence row into the same project (and same
        // provider), so both row shapes genuinely coexist in one query
        // scope, not just in two separately-tested scenarios.
        const mixedAuthority: AdmissionAuthority = {
          providerId: "legacy-coexistence-provider",
          host: "opencode-v2",
          projectId: legacyContext.projectId,
        }
        const admitted = admitEvidence(
          {
            providerId: "legacy-coexistence-provider",
            host: "opencode-v2",
            context: legacyContext,
            turnId: "turn-legacy-coexist-evidence",
            messageId: "legacy-coexist-evidence-message",
            role: "user",
            origin: "direct-user",
            kind: "turn-completed",
            occurredAt: "2026-09-16T00:00:00.000Z",
            payload: { text: "A distinct evidence-admission statement in the same project." },
          },
          mixedAuthority,
          enabledConfig,
        )
        expect(admitted.outcome).toBe("admitted")
        if (admitted.outcome !== "admitted") return
        const appendResult = await provider.appendEvidence(admitted.envelope)
        expect(appendResult.outcome).toBe("appended")

        // readEvidence's `evidence_id IS NOT NULL` guard must exclude the
        // legacy row -- there is exactly one evidence row to find, and it
        // must be the new one, not the legacy one.
        const readBack = await provider.readEvidence(
          "legacy-coexistence-provider",
          admitted.envelope.id,
          legacyContext,
        )
        expect(readBack?.id).toBe(admitted.envelope.id)

        // candidateStatus's metadata->>'providerId' scoping must exclude
        // the evidence row (which has no candidate_memories row at all) --
        // the pending count must reflect only the legacy candidate.
        const summary = await provider.candidateStatus(legacyContext)
        expect(summary.pending).toBe(1)

        // Directly confirm both row shapes exist, distinguished correctly.
        const rows = await pool.query<{ evidence_id: string | null; provider_id: string | null }>(
          "SELECT evidence_id, provider_id FROM remem.session_events WHERE project_id = $1 ORDER BY evidence_id NULLS FIRST",
          [legacyContext.projectId],
        )
        expect(rows.rows).toHaveLength(2)
        expect(rows.rows[0]).toMatchObject({ evidence_id: null, provider_id: null })
        expect(rows.rows[1]).toMatchObject({
          evidence_id: admitted.envelope.id,
          provider_id: "legacy-coexistence-provider",
        })
      } finally {
        await provider.dispose()
      }
    })
  })

  describe("episodic evidence: searchEpisodes (TASK-011)", () => {
    const searchProviderConfig = {
      type: "postgres" as const,
      id: "episodic-search-provider",
      connectionString: databaseUrl ?? "",
      primary: true,
      maxConnections: 2,
      catalogLimit: 100,
    }
    const enabledConfig = { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true }

    function contextFor(sessionId: string, projectId = "episodic-search-project"): MemoryContext {
      return {
        directory: "/workspace/episodic-search",
        worktree: "/workspace/episodic-search",
        projectId,
        sessionId,
      }
    }

    async function seed(
      provider: PostgresMemoryProvider,
      sessionId: string,
      turns: {
        turnId: string
        text: string
        occurredAt: string
        role?: "user" | "assistant" | "tool"
      }[],
      projectId = "episodic-search-project",
    ) {
      const authority: AdmissionAuthority = {
        providerId: "episodic-search-provider",
        host: "opencode-v2",
        projectId,
      }
      for (const turn of turns) {
        const admitted = admitEvidence(
          {
            providerId: "episodic-search-provider",
            host: "opencode-v2",
            context: contextFor(sessionId, projectId),
            turnId: turn.turnId,
            messageId: `${turn.turnId}-message`,
            role: turn.role ?? "user",
            origin: "direct-user",
            kind: "turn-completed",
            occurredAt: turn.occurredAt,
            payload: { text: turn.text },
          },
          authority,
          enabledConfig,
        )
        if (admitted.outcome !== "admitted")
          throw new Error(`seed admission failed: ${admitted.outcome}`)
        const result = await provider.appendEvidence(admitted.envelope)
        if (result.outcome !== "appended") throw new Error(`seed append failed: ${result.outcome}`)
      }
    }

    it("finds a matching event and includes its preceding and following neighbor", async () => {
      const provider = new PostgresMemoryProvider(searchProviderConfig)
      try {
        const sessionId = "search-neighbors-session"
        const projectId = "search-neighbors-project"
        await seed(
          provider,
          sessionId,
          [
            {
              turnId: "t1",
              text: "We started planning the Orion migration rollout.",
              occurredAt: "2026-09-16T00:00:00.000Z",
            },
            {
              turnId: "t2",
              text: "We decided to use logical replication for the cutover.",
              occurredAt: "2026-09-16T00:01:00.000Z",
            },
            {
              turnId: "t3",
              text: "The migration finished without incident.",
              occurredAt: "2026-09-16T00:02:00.000Z",
            },
          ],
          projectId,
        )

        const result = await provider.searchEpisodes(
          "episodic-search-provider",
          "logical replication",
          contextFor(sessionId, projectId),
        )
        expect(result.budgetExhausted).toBe(false)
        expect(result.matches).toHaveLength(1)
        const match = result.matches[0]
        expect(match?.envelope.turnId).toBe("t2")
        expect(match?.truncated).toBe(false)
        expect(match?.neighbors).toHaveLength(2)
        const preceding = match?.neighbors.find((neighbor) => neighbor.position === "preceding")
        const following = match?.neighbors.find((neighbor) => neighbor.position === "following")
        expect(preceding?.envelope.turnId).toBe("t1")
        expect(following?.envelope.turnId).toBe("t3")
      } finally {
        await provider.dispose()
      }
    })

    it("a neighbor that never matched the query is still found -- neighbors are computed over the whole session, not just matched rows", async () => {
      const provider = new PostgresMemoryProvider(searchProviderConfig)
      try {
        const sessionId = "search-neighbor-unrelated-session"
        const projectId = "search-neighbor-unrelated-project"
        await seed(
          provider,
          sessionId,
          [
            {
              turnId: "u1",
              text: "Completely unrelated small talk about the weather.",
              occurredAt: "2026-09-16T00:00:00.000Z",
            },
            {
              turnId: "u2",
              text: "We decided to adopt trunk-based development.",
              occurredAt: "2026-09-16T00:01:00.000Z",
            },
          ],
          projectId,
        )

        const result = await provider.searchEpisodes(
          "episodic-search-provider",
          "trunk-based development",
          contextFor(sessionId, projectId),
        )
        expect(result.matches).toHaveLength(1)
        expect(result.matches[0]?.neighbors).toHaveLength(1)
        expect(result.matches[0]?.neighbors[0]?.position).toBe("preceding")
        expect(result.matches[0]?.neighbors[0]?.envelope.turnId).toBe("u1")
      } finally {
        await provider.dispose()
      }
    })

    it("has no preceding neighbor for the first event and no following neighbor for the last", async () => {
      const provider = new PostgresMemoryProvider(searchProviderConfig)
      try {
        const sessionId = "search-edge-neighbors-session"
        const projectId = "search-edge-neighbors-project"
        await seed(
          provider,
          sessionId,
          [
            {
              turnId: "e1",
              text: "We decided the deployment window opens at midnight.",
              occurredAt: "2026-09-16T00:00:00.000Z",
            },
          ],
          projectId,
        )

        const result = await provider.searchEpisodes(
          "episodic-search-provider",
          "deployment window",
          contextFor(sessionId, projectId),
        )
        expect(result.matches).toHaveLength(1)
        expect(result.matches[0]?.neighbors).toEqual([])
      } finally {
        await provider.dispose()
      }
    })

    it("ranks and clamps to the requested limit, most relevant first", async () => {
      const provider = new PostgresMemoryProvider(searchProviderConfig)
      try {
        const sessionId = "search-rank-limit-session"
        const projectId = "search-rank-limit-project"
        await seed(
          provider,
          sessionId,
          [
            {
              turnId: "r1",
              text: "We decided to use PostgreSQL for the rollout database.",
              occurredAt: "2026-09-16T00:00:00.000Z",
            },
            {
              turnId: "r2",
              text: "PostgreSQL PostgreSQL rollout rollout rollout, the rollout is the main topic here.",
              occurredAt: "2026-09-16T00:01:00.000Z",
            },
            {
              turnId: "r3",
              text: "Completely unrelated note about lunch.",
              occurredAt: "2026-09-16T00:02:00.000Z",
            },
          ],
          projectId,
        )

        const result = await provider.searchEpisodes(
          "episodic-search-provider",
          "rollout",
          contextFor(sessionId, projectId),
          { limit: 1 },
        )
        expect(result.matches).toHaveLength(1)
        // r2 repeats "rollout" far more densely, so it must rank first.
        expect(result.matches[0]?.envelope.turnId).toBe("r2")
      } finally {
        await provider.dispose()
      }
    })

    it("a caller-supplied limit/maxOutputTokens above the hard ceiling is clamped, never honored as-is", async () => {
      const provider = new PostgresMemoryProvider(searchProviderConfig)
      try {
        const sessionId = "search-clamp-session"
        const projectId = "search-clamp-project"
        await seed(
          provider,
          sessionId,
          Array.from({ length: 15 }, (_, index) => ({
            turnId: `c${index}`,
            text: `We decided option ${index} for the clamp test scenario.`,
            occurredAt: `2026-09-16T00:${String(index).padStart(2, "0")}:00.000Z`,
          })),
          projectId,
        )

        const result = await provider.searchEpisodes(
          "episodic-search-provider",
          "decided option",
          contextFor(sessionId, projectId),
          { limit: 9999, maxOutputTokens: 9_999_999 },
        )
        expect(result.matches.length).toBeLessThanOrEqual(10)
      } finally {
        await provider.dispose()
      }
    })

    it("the maxOutputTokens ceiling is actually enforced, not merely the limit -- a caller requesting far more tokens than the ceiling still gets budgetExhausted", async () => {
      const provider = new PostgresMemoryProvider(searchProviderConfig)
      try {
        const sessionId = "search-token-ceiling-session"
        const projectId = "search-token-ceiling-project"
        // Ten reasonably-sized matches, each carrying enough fixed envelope
        // overhead (identity fields, hashes) plus text that their combined
        // cost is well beyond EPISODIC_SEARCH_MAX_OUTPUT_TOKENS (2000) --
        // if maxOutputTokens were *not* clamped down from the caller's
        // 9,999,999 request to the 2000 ceiling, every one of these ten
        // would fit and budgetExhausted would be false.
        await seed(
          provider,
          sessionId,
          Array.from({ length: 10 }, (_, index) => ({
            turnId: `k${index}`,
            text: `We decided token-ceiling option ${index}: ${"padding text to add bulk ".repeat(10)}`,
            occurredAt: `2026-09-16T00:${String(index).padStart(2, "0")}:00.000Z`,
          })),
          projectId,
        )

        const result = await provider.searchEpisodes(
          "episodic-search-provider",
          "decided token-ceiling option",
          contextFor(sessionId, projectId),
          { maxOutputTokens: 9_999_999 },
        )
        expect(result.budgetExhausted).toBe(true)
        expect(result.matches.length).toBeLessThan(10)
      } finally {
        await provider.dispose()
      }
    })

    it("performs no role/origin trust filtering -- matches across different roles are all findable and each carries its own label", async () => {
      const provider = new PostgresMemoryProvider(searchProviderConfig)
      try {
        const projectId = "search-labeled-project"
        // A naive implementation might filter to only "trusted" roles/origins
        // (e.g. direct-user turns) -- these three deliberately span every
        // role, so the test fails if any role is silently excluded. Each
        // uses its own session id so no cross-match neighbor expansion
        // competes for the output-token budget -- this test is about role
        // diversity, not neighbor/budget interaction (covered separately).
        await seed(
          provider,
          "search-labeled-session-l1",
          [
            {
              turnId: "l1",
              text: "Attempted approach: caching layer v1, abandoned after review.",
              occurredAt: "2026-09-16T00:00:00.000Z",
              role: "assistant",
            },
          ],
          projectId,
        )
        await seed(
          provider,
          "search-labeled-session-l2",
          [
            {
              turnId: "l2",
              text: "Attempted approach: caching layer v2, still under evaluation.",
              occurredAt: "2026-09-16T00:01:00.000Z",
              role: "user",
            },
          ],
          projectId,
        )
        await seed(
          provider,
          "search-labeled-session-l3",
          [
            {
              turnId: "l3",
              text: "Attempted approach: caching layer v3, failed load test.",
              occurredAt: "2026-09-16T00:02:00.000Z",
              role: "tool",
            },
          ],
          projectId,
        )

        const result = await provider.searchEpisodes(
          "episodic-search-provider",
          "caching layer attempted approach",
          contextFor("search-labeled-session-l2", projectId),
        )
        expect(result.matches).toHaveLength(3)
        const byTurnId = new Map(
          result.matches.map((match) => [match.envelope.turnId, match.envelope]),
        )
        expect(byTurnId.get("l1")?.role).toBe("assistant")
        expect(byTurnId.get("l2")?.role).toBe("user")
        expect(byTurnId.get("l3")?.role).toBe("tool")
        for (const envelope of byTurnId.values()) {
          expect(envelope.origin).toBe("direct-user")
        }
      } finally {
        await provider.dispose()
      }
    })

    it("scopes strictly by project -- a matching event in another project is never returned", async () => {
      const provider = new PostgresMemoryProvider(searchProviderConfig)
      try {
        const sessionId = "search-scope-session"
        const projectId = "search-scope-project"
        await seed(
          provider,
          sessionId,
          [
            {
              turnId: "s1",
              text: "We decided a project-scoped secret rotation policy.",
              occurredAt: "2026-09-16T00:00:00.000Z",
            },
          ],
          "search-scope-other-project",
        )

        const result = await provider.searchEpisodes(
          "episodic-search-provider",
          "secret rotation policy",
          contextFor(sessionId, projectId),
        )
        expect(result.matches).toHaveLength(0)
      } finally {
        await provider.dispose()
      }
    })

    it("a session id shared across two projects never leaks a neighbor from the other project", async () => {
      const provider = new PostgresMemoryProvider(searchProviderConfig)
      try {
        // Deliberately reuse the *same* session id across two different
        // projects -- session ids are not guaranteed globally unique across
        // projects in general, so neighbor computation must be scoped by
        // project (and provider), not by session id alone.
        const sharedSessionId = "search-cross-project-shared-session"
        const projectA = "search-cross-project-a"
        const projectB = "search-cross-project-b"

        await seed(
          provider,
          sharedSessionId,
          [
            {
              turnId: "b-other",
              text: "An event in project B, timed to sort adjacent to project A's event.",
              occurredAt: "2026-09-16T00:00:30.000Z",
            },
          ],
          projectB,
        )
        await seed(
          provider,
          sharedSessionId,
          [
            {
              turnId: "a-match",
              text: "We decided the cross-project neighbor isolation policy.",
              occurredAt: "2026-09-16T00:01:00.000Z",
            },
          ],
          projectA,
        )

        const result = await provider.searchEpisodes(
          "episodic-search-provider",
          "cross-project neighbor isolation",
          contextFor(sharedSessionId, projectA),
        )
        expect(result.matches).toHaveLength(1)
        expect(result.matches[0]?.envelope.turnId).toBe("a-match")
        // Project B's event sorts immediately before project A's by
        // occurred_at within the shared session id -- if neighbor
        // computation were not scoped by project, it would appear here as
        // a "preceding" neighbor.
        expect(result.matches[0]?.neighbors).toEqual([])
      } finally {
        await provider.dispose()
      }
    })

    it("truncates an oversized match's text to fit a small output-token budget and reports budgetExhausted", async () => {
      const provider = new PostgresMemoryProvider(searchProviderConfig)
      try {
        const sessionId = "search-budget-session"
        const projectId = "search-budget-project"
        const longText = `We decided ${"a very long repeated justification clause ".repeat(50)}for the budget test.`
        await seed(
          provider,
          sessionId,
          [{ turnId: "b1", text: longText, occurredAt: "2026-09-16T00:00:00.000Z" }],
          projectId,
        )

        const result = await provider.searchEpisodes(
          "episodic-search-provider",
          "decided",
          contextFor(sessionId, projectId),
          { maxOutputTokens: 700 },
        )
        expect(result.matches).toHaveLength(1)
        expect(result.matches[0]?.truncated).toBe(true)
        expect(result.matches[0]?.envelope.payload.text?.length ?? 0).toBeLessThan(longText.length)
      } finally {
        await provider.dispose()
      }
    })

    it("a tight budget that fits the match plus one neighbor omits the second neighbor and reports budgetExhausted", async () => {
      const provider = new PostgresMemoryProvider(searchProviderConfig)
      try {
        const sessionId = "search-neighbor-budget-session"
        const projectId = "search-neighbor-budget-project"
        // Each envelope's fixed (non-text) overhead alone is already a few
        // hundred tokens (identity fields, two 64-char hex hashes), so
        // three short-text events plus their JSON overhead comfortably
        // exceed a deliberately tight ~1200-token budget -- just not by so
        // much that even one neighbor is excluded.
        await seed(
          provider,
          sessionId,
          [
            {
              turnId: "n1",
              text: "Preceding context event.",
              occurredAt: "2026-09-16T00:00:00.000Z",
            },
            {
              turnId: "n2",
              text: "We decided the neighbor-budget matching event.",
              occurredAt: "2026-09-16T00:01:00.000Z",
            },
            {
              turnId: "n3",
              text: "Following context event.",
              occurredAt: "2026-09-16T00:02:00.000Z",
            },
          ],
          projectId,
        )

        const result = await provider.searchEpisodes(
          "episodic-search-provider",
          "neighbor-budget matching event",
          contextFor(sessionId, projectId),
          { maxOutputTokens: 1200 },
        )
        expect(result.matches).toHaveLength(1)
        expect(result.matches[0]?.envelope.turnId).toBe("n2")
        // The match itself must never be sacrificed to make room for a
        // neighbor -- only the second neighbor may be dropped.
        expect(result.matches[0]?.neighbors.length).toBeLessThan(2)
        expect(result.budgetExhausted).toBe(true)
      } finally {
        await provider.dispose()
      }
    })

    it("returns no matches (not an error) for an empty query", async () => {
      const provider = new PostgresMemoryProvider(searchProviderConfig)
      try {
        const sessionId = "search-empty-query-session"
        const projectId = "search-empty-query-project"
        await seed(
          provider,
          sessionId,
          [
            {
              turnId: "eq1",
              text: "We decided something for the empty query test.",
              occurredAt: "2026-09-16T00:00:00.000Z",
            },
          ],
          projectId,
        )

        const result = await provider.searchEpisodes(
          "episodic-search-provider",
          "   ",
          contextFor(sessionId, projectId),
        )
        expect(result).toEqual({ matches: [], budgetExhausted: false })
      } finally {
        await provider.dispose()
      }
    })
  })

  describe("capacity accounting and compaction (TASK-012/TASK-060)", () => {
    const capacityProviderConfig = {
      type: "postgres" as const,
      id: "capacity-provider",
      connectionString: databaseUrl ?? "",
      primary: true,
      maxConnections: 2,
      catalogLimit: 100,
    }
    const enabledConfig = { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true }
    const oldTimestamp = "2020-01-01T00:00:00.000Z" // far more than 60 days before any test run
    const freshTimestamp = new Date().toISOString() // well within the last 60 days

    function contextFor(sessionId: string, projectId: string): MemoryContext {
      return {
        directory: "/workspace/capacity",
        worktree: "/workspace/capacity",
        projectId,
        sessionId,
      }
    }

    async function seedEvidence(
      provider: PostgresMemoryProvider,
      projectId: string,
      sessionId: string,
      turnId: string,
      text: string,
      occurredAt: string,
    ) {
      const authority: AdmissionAuthority = {
        providerId: "capacity-provider",
        host: "opencode-v2",
        projectId,
      }
      const admitted = admitEvidence(
        {
          providerId: "capacity-provider",
          host: "opencode-v2",
          context: contextFor(sessionId, projectId),
          turnId,
          messageId: `${turnId}-message`,
          role: "user",
          origin: "direct-user",
          kind: "turn-completed",
          occurredAt,
          payload: { text },
        },
        authority,
        enabledConfig,
      )
      if (admitted.outcome !== "admitted") {
        throw new Error(`seed admission failed: ${admitted.outcome}`)
      }
      const result = await provider.appendEvidence(admitted.envelope)
      if (result.outcome !== "appended") throw new Error(`seed append failed: ${result.outcome}`)
      return admitted.envelope
    }

    function pythonTraceback(lineCount: number): string {
      const frames = Array.from(
        { length: lineCount },
        (_, index) =>
          `  File "/app/service/module_${index}.py", line ${100 + index}, in handler_${index}`,
      ).join("\n")
      return `Traceback (most recent call last):\n${frames}\nValueError: deep failure`
    }

    /**
     * Inserts a session_events row directly via SQL, bypassing
     * admitEvidence entirely -- TASK-059's admission-time bulk-artifact
     * reduction is aggressive enough that most large stack traces are
     * already shrunk to a few hundred bytes before compaction would ever
     * see them, which would make it impossible to test TASK-060's
     * compaction behavior in isolation through the normal admission path.
     * This helper writes a row with `safe_text` exactly as given, as if it
     * had arrived through some other (or a future) admission path that
     * did not reduce it, so compaction has genuine work to do.
     */
    async function seedRawEvidenceRow(
      projectId: string,
      sessionId: string,
      turnId: string,
      text: string,
      occurredAt: string,
    ) {
      const evidenceId = createHash("sha256")
        .update(`${projectId}:${sessionId}:${turnId}`)
        .digest("hex")
      await pool.query(
        `INSERT INTO remem.session_events
           (id, session_id, project_id, kind, occurred_at, payload,
            provider_id, host, role, origin, turn_id, message_id, safe_text,
            evidence_refs, evidence_id, content_hash, schema_version)
         VALUES ($1,$2,$3,'turn-completed',$4,'{}'::jsonb,
                 'capacity-provider','opencode-v2','user','direct-user',$5,$6,$7,
                 '[]'::jsonb,$8,$9,1)`,
        [
          randomUUID(),
          sessionId,
          projectId,
          occurredAt,
          turnId,
          `${turnId}-message`,
          text,
          evidenceId,
          evidenceId,
        ],
      )
    }

    it("getCapacityStatus reports neither over-soft nor over-hard for an empty/small project, and correctly crosses each boundary as data grows", async () => {
      const provider = new PostgresMemoryProvider(capacityProviderConfig)
      try {
        const projectId = "capacity-boundary-project"
        const limits = { softLimitBytes: 500, hardLimitBytes: 1000 }

        const empty = await provider.getCapacityStatus("capacity-provider", projectId, limits)
        expect(empty).toMatchObject({
          overSoft: false,
          overHard: false,
          compactionLevel: "conservative",
        })

        await seedEvidence(
          provider,
          projectId,
          "capacity-boundary-session",
          "b1",
          "x".repeat(600),
          freshTimestamp,
        )
        const overSoftOnly = await provider.getCapacityStatus(
          "capacity-provider",
          projectId,
          limits,
        )
        expect(overSoftOnly.overSoft).toBe(true)
        expect(overSoftOnly.overHard).toBe(false)

        await seedEvidence(
          provider,
          projectId,
          "capacity-boundary-session",
          "b2",
          "y".repeat(600),
          freshTimestamp,
        )
        const overHard = await provider.getCapacityStatus("capacity-provider", projectId, limits)
        expect(overHard.overHard).toBe(true)
      } finally {
        await provider.dispose()
      }
    })

    it("runCompaction does nothing when under the soft limit and not forced", async () => {
      const provider = new PostgresMemoryProvider(capacityProviderConfig)
      try {
        const projectId = "capacity-under-soft-project"
        await seedEvidence(
          provider,
          projectId,
          "capacity-under-soft-session",
          "u1",
          pythonTraceback(5),
          oldTimestamp,
        )

        const report = await provider.runCompaction("capacity-provider", projectId, {
          limits: { softLimitBytes: 1_000_000, hardLimitBytes: 2_000_000 },
        })
        expect(report).toMatchObject({ rowsProcessed: 0, rowsReduced: 0, level: "conservative" })
      } finally {
        await provider.dispose()
      }
    })

    it("runCompaction shrinks a large bulk-artifact-shaped old entry, but never touches a fresh (<60 day) entry", async () => {
      const provider = new PostgresMemoryProvider(capacityProviderConfig)
      try {
        const projectId = "capacity-shrink-project"
        const sessionId = "capacity-shrink-session"
        const largeTrace = pythonTraceback(300)
        await seedRawEvidenceRow(projectId, sessionId, "s1-old", largeTrace, oldTimestamp)
        await seedRawEvidenceRow(projectId, sessionId, "s2-fresh", largeTrace, freshTimestamp)

        const smallLimits = { softLimitBytes: 10, hardLimitBytes: 1_000_000 }
        const report = await provider.runCompaction("capacity-provider", projectId, {
          limits: smallLimits,
        })

        expect(report.rowsProcessed).toBe(1) // only the old entry is eligible
        expect(report.rowsReduced).toBe(1)
        expect(report.bytesReclaimed).toBeGreaterThan(0)

        const rows = await pool.query<{ turn_id: string; safe_text: string }>(
          "SELECT turn_id, safe_text FROM remem.session_events WHERE project_id = $1 ORDER BY turn_id",
          [projectId],
        )
        const oldRow = rows.rows.find((row) => row.turn_id === "s1-old")
        const freshRow = rows.rows.find((row) => row.turn_id === "s2-fresh")
        expect(oldRow?.safe_text.length).toBeLessThan(largeTrace.length)
        expect(freshRow?.safe_text).toBe(largeTrace) // completely untouched
      } finally {
        await provider.dispose()
      }
    })

    it("does not reduce narrative (non-bulk-artifact) text at the conservative level", async () => {
      const provider = new PostgresMemoryProvider(capacityProviderConfig)
      try {
        const projectId = "capacity-narrative-project"
        const narrative = "We decided to migrate to logical replication because ".repeat(60)
        await seedEvidence(
          provider,
          projectId,
          "capacity-narrative-session",
          "n1",
          narrative,
          oldTimestamp,
        )

        const report = await provider.runCompaction("capacity-provider", projectId, {
          limits: { softLimitBytes: 10, hardLimitBytes: 1_000_000 },
        })
        expect(report.rowsProcessed).toBe(1)
        expect(report.rowsReduced).toBe(0) // stamped as processed, but left unchanged

        const row = await pool.query<{ safe_text: string }>(
          "SELECT safe_text FROM remem.session_events WHERE project_id = $1 AND turn_id = 'n1'",
          [projectId],
        )
        expect(row.rows[0]?.safe_text).toBe(narrative)
      } finally {
        await provider.dispose()
      }
    })

    it("a forced compaction ignores both the 60-day age gate and the soft-limit gate", async () => {
      const provider = new PostgresMemoryProvider(capacityProviderConfig)
      try {
        const projectId = "capacity-forced-project"
        const largeTrace = pythonTraceback(300)
        await seedRawEvidenceRow(
          projectId,
          "capacity-forced-session",
          "f1-fresh",
          largeTrace,
          freshTimestamp,
        )

        // Well under any realistic soft limit -- without force, nothing
        // would be touched (age gate) or considered (soft-limit gate).
        const report = await provider.runCompaction("capacity-provider", projectId, {
          force: true,
          limits: { softLimitBytes: 1_000_000_000, hardLimitBytes: 2_000_000_000 },
        })
        expect(report.rowsProcessed).toBe(1)
        expect(report.rowsReduced).toBe(1)
      } finally {
        await provider.dispose()
      }
    })

    it("does not reprocess a row already compacted at the current level -- a second identical-level run finds nothing new to do", async () => {
      const provider = new PostgresMemoryProvider(capacityProviderConfig)
      try {
        const projectId = "capacity-idempotent-project"
        await seedEvidence(
          provider,
          projectId,
          "capacity-idempotent-session",
          "i1",
          pythonTraceback(300),
          oldTimestamp,
        )
        const limits = { softLimitBytes: 10, hardLimitBytes: 1_000_000 }

        const first = await provider.runCompaction("capacity-provider", projectId, { limits })
        expect(first.rowsProcessed).toBe(1)

        const second = await provider.runCompaction("capacity-provider", projectId, { limits })
        expect(second.rowsProcessed).toBe(0)
      } finally {
        await provider.dispose()
      }
    })

    it("escalates to a more aggressive level after sustained non-improving compaction runs, and never de-escalates", async () => {
      const provider = new PostgresMemoryProvider(capacityProviderConfig)
      try {
        const projectId = "capacity-escalation-project"
        const limits = { softLimitBytes: 10, hardLimitBytes: 1_000_000 }

        // Prime capacity_state as if two consecutive prior runs already
        // failed to improve, at a known total -- the pure escalation
        // decision logic itself is exhaustively unit-tested in
        // tests/capacity.test.ts; this integration test only needs to
        // prove the storage layer correctly persists/reads that state and
        // applies the decision, not re-derive every case here.
        await pool.query(
          `INSERT INTO remem.capacity_state
             (provider_id, project_id, compaction_level, last_total_bytes, consecutive_no_improvement, last_checked_at)
           VALUES ($1, $2, 0, 0, 2, now())`,
          ["capacity-provider", projectId],
        )

        // Primed previous total is 0 -- no amount of content can ever be
        // "less than 0", so this run's post-compaction total is
        // guaranteed to count as non-improving regardless of its actual
        // size, deterministically triggering the third consecutive
        // non-improving run.
        await seedRawEvidenceRow(
          projectId,
          "capacity-escalation-session",
          "e1",
          pythonTraceback(5),
          oldTimestamp,
        )

        const report = await provider.runCompaction("capacity-provider", projectId, { limits })
        expect(report.escalated).toBe(true)
        expect(report.level).toBe("moderate")

        const state = await pool.query<{ compaction_level: number }>(
          "SELECT compaction_level FROM remem.capacity_state WHERE provider_id = $1 AND project_id = $2",
          ["capacity-provider", projectId],
        )
        expect(state.rows[0]?.compaction_level).toBe(1) // moderate

        const status = await provider.getCapacityStatus("capacity-provider", projectId, limits)
        expect(status.compactionLevel).toBe("moderate")
      } finally {
        await provider.dispose()
      }
    })

    it("enforceHardLimit does nothing under the hard limit, and removes oldest-eligible-first over it, never touching a fresh entry", async () => {
      const provider = new PostgresMemoryProvider(capacityProviderConfig)
      try {
        const projectId = "capacity-hardlimit-project"
        const sessionId = "capacity-hardlimit-session"
        await seedEvidence(
          provider,
          projectId,
          sessionId,
          "h1-oldest",
          "a".repeat(300),
          "2020-01-01T00:00:00.000Z",
        )
        await seedEvidence(
          provider,
          projectId,
          sessionId,
          "h2-older",
          "b".repeat(300),
          "2020-06-01T00:00:00.000Z",
        )
        await seedEvidence(
          provider,
          projectId,
          sessionId,
          "h3-fresh",
          "c".repeat(300),
          freshTimestamp,
        )

        const limits = { softLimitBytes: 100, hardLimitBytes: 500 }

        const noop = await provider.enforceHardLimit("capacity-provider", projectId, {
          softLimitBytes: 100,
          hardLimitBytes: 10_000,
        })
        expect(noop).toMatchObject({ rowsRemoved: 0 })

        const evicted = await provider.enforceHardLimit("capacity-provider", projectId, limits)
        expect(evicted.rowsRemoved).toBeGreaterThan(0)

        const remaining = await pool.query<{ turn_id: string }>(
          "SELECT turn_id FROM remem.session_events WHERE project_id = $1 ORDER BY turn_id",
          [projectId],
        )
        const remainingTurnIds = remaining.rows.map((row) => row.turn_id)
        // The oldest eligible entry must be removed before a younger one.
        expect(remainingTurnIds).not.toContain("h1-oldest")
        // The fresh (<60 day) entry must never be removed, regardless of
        // how far over the hard limit the project is.
        expect(remainingTurnIds).toContain("h3-fresh")
      } finally {
        await provider.dispose()
      }
    })

    it("enforceHardLimit reports exhaustedEligibleRows when still over the hard limit after removing every eligible row", async () => {
      const provider = new PostgresMemoryProvider(capacityProviderConfig)
      try {
        const projectId = "capacity-exhausted-project"
        // Only a fresh (<60 day) entry exists -- never eligible for
        // removal, so the project can never be brought under the hard
        // limit by this mechanism alone.
        await seedEvidence(
          provider,
          projectId,
          "capacity-exhausted-session",
          "x1-fresh",
          "z".repeat(1000),
          freshTimestamp,
        )

        const report = await provider.enforceHardLimit("capacity-provider", projectId, {
          softLimitBytes: 10,
          hardLimitBytes: 100,
        })
        expect(report.rowsRemoved).toBe(0)
        expect(report.exhaustedEligibleRows).toBe(true)
      } finally {
        await provider.dispose()
      }
    })

    it("enforceCapacity orchestrates compaction before eviction, running eviction only if still over the hard limit afterward", async () => {
      const provider = new PostgresMemoryProvider(capacityProviderConfig)
      try {
        const projectId = "capacity-orchestration-project"
        const sessionId = "capacity-orchestration-session"
        // Small enough that compaction alone brings it comfortably under
        // both limits -- eviction must not run at all.
        await seedEvidence(provider, projectId, sessionId, "o1", pythonTraceback(300), oldTimestamp)

        const report = await provider.enforceCapacity("capacity-provider", projectId, {
          limits: { softLimitBytes: 10, hardLimitBytes: 1_000_000 },
        })
        expect(report.compaction).toBeDefined()
        expect(report.hardLimitEviction).toBeUndefined()
        expect(report.status.overHard).toBe(false)
      } finally {
        await provider.dispose()
      }
    })

    it("enforceCapacity runs eviction when compaction alone is not enough to clear the hard limit", async () => {
      const provider = new PostgresMemoryProvider(capacityProviderConfig)
      try {
        const projectId = "capacity-orchestration-evict-project"
        const sessionId = "capacity-orchestration-evict-session"
        await seedEvidence(
          provider,
          projectId,
          sessionId,
          "oe1-oldest",
          pythonTraceback(300),
          "2020-01-01T00:00:00.000Z",
        )
        await seedEvidence(
          provider,
          projectId,
          sessionId,
          "oe2-newer",
          pythonTraceback(300),
          "2020-06-01T00:00:00.000Z",
        )

        // A hard limit so small that even fully compacted (conservative
        // level shrinks bulk artifacts to ~1500 bytes each) content still
        // exceeds it, forcing eviction to actually run.
        const report = await provider.enforceCapacity("capacity-provider", projectId, {
          limits: { softLimitBytes: 10, hardLimitBytes: 1_000 },
        })
        expect(report.compaction).toBeDefined()
        expect(report.hardLimitEviction).toBeDefined()
        expect(report.hardLimitEviction?.rowsRemoved).toBeGreaterThan(0)
      } finally {
        await provider.dispose()
      }
    })

    it("concurrent-writer safety: a fresh append during enforceCapacity survives untouched and is never evicted or reduced", async () => {
      const provider = new PostgresMemoryProvider(capacityProviderConfig)
      try {
        const projectId = "capacity-concurrent-project"
        const sessionId = "capacity-concurrent-session"
        await seedEvidence(
          provider,
          projectId,
          sessionId,
          "c1-old-bulk",
          pythonTraceback(300),
          oldTimestamp,
        )

        const [, freshEnvelope] = await Promise.all([
          provider.enforceCapacity("capacity-provider", projectId, {
            limits: { softLimitBytes: 10, hardLimitBytes: 50 },
          }),
          seedEvidence(
            provider,
            projectId,
            sessionId,
            "c2-fresh-concurrent",
            "concurrent fresh narrative text",
            freshTimestamp,
          ),
        ])

        const freshRow = await pool.query<{ safe_text: string }>(
          "SELECT safe_text FROM remem.session_events WHERE project_id = $1 AND turn_id = 'c2-fresh-concurrent'",
          [projectId],
        )
        expect(freshRow.rows[0]?.safe_text).toBe(freshEnvelope.payload.text)
      } finally {
        await provider.dispose()
      }
    })

    it("concurrent-writer safety: two concurrent enforceHardLimit calls for the same scope never jointly remove more than the minimum necessary", async () => {
      const provider = new PostgresMemoryProvider(capacityProviderConfig)
      try {
        const projectId = "capacity-concurrent-hardlimit-project"
        const sessionId = "capacity-concurrent-hardlimit-session"
        // Five equally-sized old rows -- each contributes the same known
        // byte cost, so the minimum number that must be removed to clear
        // a given hard limit is exactly computable and this test can
        // assert on it precisely, not just "some rows were removed."
        for (let index = 0; index < 5; index++) {
          await seedRawEvidenceRow(
            projectId,
            sessionId,
            `ch${index}`,
            "x".repeat(300),
            `2020-01-0${index + 1}T00:00:00.000Z`,
          )
        }

        const limits = { softLimitBytes: 10, hardLimitBytes: 700 }
        // Without serialization, two concurrent calls could both read the
        // same pre-deletion total and (depending on timing/new writes)
        // jointly remove more than the single minimum-necessary set --
        // the advisory lock in withCapacityLock (postgres.ts) exists
        // specifically to prevent that.
        await Promise.all([
          provider.enforceHardLimit("capacity-provider", projectId, limits),
          provider.enforceHardLimit("capacity-provider", projectId, limits),
        ])

        const remaining = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM remem.session_events WHERE project_id = $1",
          [projectId],
        )
        // 304 bytes/row (300 safe_text + '{}' + '[]' overhead); removing
        // the 3 oldest brings the total to 2*304=608 <= 700. Exactly 2
        // rows must remain -- more remaining would mean over-removal
        // never occurred (fine), fewer would mean the two concurrent
        // calls jointly removed more than the minimum necessary.
        expect(Number(remaining.rows[0]?.count)).toBe(2)

        const status = await provider.getCapacityStatus("capacity-provider", projectId, limits)
        expect(status.overHard).toBe(false)
      } finally {
        await provider.dispose()
      }
    })

    it("escalates naturally across repeated real runCompaction calls, without manually priming capacity_state", async () => {
      const provider = new PostgresMemoryProvider(capacityProviderConfig)
      try {
        const projectId = "capacity-natural-escalation-project"
        const sessionId = "capacity-natural-escalation-session"
        const limits = { softLimitBytes: 10, hardLimitBytes: 1_000_000 }

        // Each call adds one more old, already-below-classification-floor
        // row (so nothing is ever actually shrunk -- rowsReduced stays 0
        // every time) before compacting -- the total can therefore only
        // grow or stay flat across successive calls, which is a genuine,
        // naturally-produced non-improving streak: no manual
        // capacity_state priming anywhere in this test.
        let lastLevel: string = "conservative"
        for (let round = 0; round < 4; round++) {
          await seedRawEvidenceRow(
            projectId,
            sessionId,
            `ne${round}`,
            "y".repeat(50), // well under BULK_ARTIFACT_MIN_BYTES -- never reduced
            "2020-01-01T00:00:00.000Z",
          )
          const report = await provider.runCompaction("capacity-provider", projectId, { limits })
          lastLevel = report.level
        }

        expect(lastLevel).toBe("moderate")
        const status = await provider.getCapacityStatus("capacity-provider", projectId, limits)
        expect(status.compactionLevel).toBe("moderate")
      } finally {
        await provider.dispose()
      }
    })

    it("removing evidence via enforceHardLimit never touches the derived memory's confidence/freshness/status -- surviving semantic knowledge is not reclassified as freshly verified", async () => {
      const provider = new PostgresMemoryProvider(capacityProviderConfig)
      try {
        const projectId = "capacity-memory-isolation-project"
        const memory = await provider.write(
          {
            type: "decision",
            title: "Capacity isolation test decision",
            content: "We decided that evidence eviction must never touch derived memory records.",
            summary: "Evidence eviction is isolated from memory records.",
            scope: { kind: "project", id: projectId },
            importance: 0.5,
            aliases: [],
            tags: [],
            provenance: [
              {
                source: { kind: "session", uri: `session://${projectId}/decision` },
                capturedAt: "2026-08-31T12:00:00.000Z",
                original: true,
              },
            ],
          },
          {
            context: contextFor("capacity-memory-isolation-session", projectId),
            actor: "integration-test",
            reason: "capacity isolation test",
          },
        )
        const before = await pool.query<{
          confidence: number | null
          freshness: string
          updated_at: Date
        }>("SELECT confidence, freshness, updated_at FROM remem.memories WHERE id = $1", [
          memory.id,
        ])

        // Enough old, over-hard-limit evidence (unrelated to the memory
        // above) to force enforceHardLimit to actually remove rows.
        for (let index = 0; index < 5; index++) {
          await seedRawEvidenceRow(
            projectId,
            "capacity-memory-isolation-evidence-session",
            `mi${index}`,
            "z".repeat(300),
            `2020-01-0${index + 1}T00:00:00.000Z`,
          )
        }
        const eviction = await provider.enforceHardLimit("capacity-provider", projectId, {
          softLimitBytes: 10,
          hardLimitBytes: 100,
        })
        expect(eviction.rowsRemoved).toBeGreaterThan(0)

        const after = await pool.query<{
          confidence: number | null
          freshness: string
          updated_at: Date
        }>("SELECT confidence, freshness, updated_at FROM remem.memories WHERE id = $1", [
          memory.id,
        ])
        expect(after.rows[0]).toEqual(before.rows[0])
      } finally {
        await provider.dispose()
      }
    })
  })

  describe("session-start hard-limit capacity warning (TASK-062)", () => {
    const warningProviderConfig = {
      type: "postgres" as const,
      id: "warning-provider",
      connectionString: databaseUrl ?? "",
      primary: true,
      maxConnections: 2,
      catalogLimit: 100,
    }

    it("does not fire when well under the hard limit", async () => {
      const provider = new PostgresMemoryProvider(warningProviderConfig)
      try {
        const warning = await provider.checkHardLimitWarning(
          "warning-provider",
          "warning-under-project",
          { limits: { softLimitBytes: 10, hardLimitBytes: 1_000_000 } },
        )
        expect(warning).toBeUndefined()
      } finally {
        await provider.dispose()
      }
    })

    it("fires the first time a project is found over the hard limit", async () => {
      const provider = new PostgresMemoryProvider(warningProviderConfig)
      try {
        const projectId = "warning-first-fire-project"
        await pool.query(
          `INSERT INTO remem.session_events
             (id, session_id, project_id, kind, occurred_at, payload,
              provider_id, host, role, origin, turn_id, message_id, safe_text,
              evidence_refs, evidence_id, content_hash, schema_version)
           VALUES ($1,$2,$3,'turn-completed',now(),'{}'::jsonb,
                   'warning-provider','opencode-v2','user','direct-user','t1','t1-message',$4,
                   '[]'::jsonb,$5,$5,1)`,
          [
            randomUUID(),
            "warning-first-fire-session",
            projectId,
            "x".repeat(2000),
            createHash("sha256").update(`${projectId}:warning-first-fire`).digest("hex"),
          ],
        )

        const warning = await provider.checkHardLimitWarning("warning-provider", projectId, {
          limits: { softLimitBytes: 10, hardLimitBytes: 500 },
        })
        expect(warning).toBeDefined()
        expect(warning?.hardLimitBytes).toBe(500)
        expect(warning?.totalBytes).toBeGreaterThan(500)
      } finally {
        await provider.dispose()
      }
    })

    it("does not fire again within the throttle window, but fires again once it has elapsed", async () => {
      const provider = new PostgresMemoryProvider(warningProviderConfig)
      try {
        const projectId = "warning-throttle-project"
        await pool.query(
          `INSERT INTO remem.session_events
             (id, session_id, project_id, kind, occurred_at, payload,
              provider_id, host, role, origin, turn_id, message_id, safe_text,
              evidence_refs, evidence_id, content_hash, schema_version)
           VALUES ($1,$2,$3,'turn-completed',now(),'{}'::jsonb,
                   'warning-provider','opencode-v2','user','direct-user','t1','t1-message',$4,
                   '[]'::jsonb,$5,$5,1)`,
          [
            randomUUID(),
            "warning-throttle-session",
            projectId,
            "x".repeat(2000),
            createHash("sha256").update(`${projectId}:warning-throttle`).digest("hex"),
          ],
        )
        const limits = { softLimitBytes: 10, hardLimitBytes: 500 }

        const first = await provider.checkHardLimitWarning("warning-provider", projectId, {
          limits,
          throttleMs: 60_000,
        })
        expect(first).toBeDefined()

        const secondImmediately = await provider.checkHardLimitWarning(
          "warning-provider",
          projectId,
          { limits, throttleMs: 60_000 },
        )
        expect(secondImmediately).toBeUndefined()

        // Simulate the throttle window having fully elapsed by directly
        // backdating the persisted last-warned timestamp -- equivalent to
        // waiting out a real throttle interval without an actual sleep.
        await pool.query(
          `UPDATE remem.capacity_state SET last_hard_limit_warning_at = now() - interval '2 minutes'
           WHERE provider_id = 'warning-provider' AND project_id = $1`,
          [projectId],
        )
        const thirdAfterElapsed = await provider.checkHardLimitWarning(
          "warning-provider",
          projectId,
          { limits, throttleMs: 60_000 },
        )
        expect(thirdAfterElapsed).toBeDefined()
      } finally {
        await provider.dispose()
      }
    })

    it("never fires for soft-limit-only pressure, even far over soft but comfortably under hard", async () => {
      const provider = new PostgresMemoryProvider(warningProviderConfig)
      try {
        const projectId = "warning-soft-only-project"
        await pool.query(
          `INSERT INTO remem.session_events
             (id, session_id, project_id, kind, occurred_at, payload,
              provider_id, host, role, origin, turn_id, message_id, safe_text,
              evidence_refs, evidence_id, content_hash, schema_version)
           VALUES ($1,$2,$3,'turn-completed',now(),'{}'::jsonb,
                   'warning-provider','opencode-v2','user','direct-user','t1','t1-message',$4,
                   '[]'::jsonb,$5,$5,1)`,
          [
            randomUUID(),
            "warning-soft-only-session",
            projectId,
            "x".repeat(2000),
            createHash("sha256").update(`${projectId}:warning-soft-only`).digest("hex"),
          ],
        )

        const warning = await provider.checkHardLimitWarning("warning-provider", projectId, {
          limits: { softLimitBytes: 10, hardLimitBytes: 1_000_000 },
        })
        expect(warning).toBeUndefined()
      } finally {
        await provider.dispose()
      }
    })
  })

  describe("explicit privacy forget (TASK-013)", () => {
    const forgetProviderConfig = {
      type: "postgres" as const,
      id: "forget-provider",
      connectionString: databaseUrl ?? "",
      primary: true,
      maxConnections: 2,
      catalogLimit: 100,
    }
    const projectId = "forget-project"
    const forgetContext: MemoryContext = {
      directory: "/workspace/forget",
      worktree: "/workspace/forget",
      projectId,
      sessionId: "forget-session",
    }

    async function appendForgetEvidence(provider: PostgresMemoryProvider, suffix: string) {
      const admitted = admitEvidence(
        {
          providerId: "forget-provider",
          host: "opencode-v2",
          context: { ...forgetContext, sessionId: `forget-session-${suffix}` },
          turnId: `forget-turn-${suffix}`,
          messageId: `forget-message-${suffix}`,
          role: "user",
          origin: "direct-user",
          kind: "turn-completed",
          occurredAt: "2026-09-17T00:00:00.000Z",
          payload: { text: "private episode content that must not appear in a tombstone" },
        },
        { providerId: "forget-provider", host: "opencode-v2", projectId },
        { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
      )
      if (admitted.outcome !== "admitted") throw new Error("forget evidence admission failed")
      expect(await provider.appendEvidence(admitted.envelope)).toMatchObject({
        outcome: "appended",
      })
      return admitted.envelope
    }

    it("requires a body-free preview, deletes only direct episode derivatives after confirmation, and suppresses replay", async () => {
      const provider = new PostgresMemoryProvider(forgetProviderConfig)
      try {
        // This semantic memory has no proven direct derivation from the
        // episode, so privacy forget must leave it and its derived indexes.
        const independentMemory = await provider.write({
          type: "semantic",
          title: "Independent project decision",
          content: "This semantic memory has separate support.",
          scope: { kind: "project", id: projectId },
        })
        const envelope = await appendForgetEvidence(provider, "confirmed")
        const event = await pool.query<{ id: string }>(
          `SELECT id FROM remem.session_events
           WHERE provider_id = 'forget-provider' AND project_id = $1 AND evidence_id = $2`,
          [projectId, envelope.id],
        )
        const candidateId = randomUUID()
        await pool.query(
          `INSERT INTO remem.candidate_memories
             (id, session_event_id, type, title, content, scope_kind, scope_id, metadata)
           VALUES ($1, $2, 'decision', 'Derived candidate', 'derived private candidate',
                   'project', $3, '{"providerId":"forget-provider"}'::jsonb)`,
          [candidateId, event.rows[0]!.id, projectId],
        )

        const preview = await provider.previewForget("forget-provider", envelope.id, projectId)
        if (!preview) throw new Error("forget preview was unexpectedly absent")
        expect(preview).toMatchObject({
          providerId: "forget-provider",
          projectId,
          evidenceId: envelope.id,
          episodeCount: 1,
          candidateCount: 1,
          semanticMemoryCount: 0,
        })
        expect(JSON.stringify(preview)).not.toContain("private episode content")
        expect(
          await pool.query(
            `SELECT id FROM remem.session_events
             WHERE provider_id = 'forget-provider' AND project_id = $1 AND evidence_id = $2`,
            [projectId, envelope.id],
          ),
        ).toMatchObject({ rowCount: 1 })

        const confirmed = await provider.confirmForget(preview.id)
        expect(confirmed).toEqual({
          previewId: preview.id,
          evidenceDeleted: true,
          candidatesDeleted: 1,
        })
        expect(
          await provider.readEvidence("forget-provider", envelope.id, forgetContext),
        ).toBeUndefined()
        expect(
          await pool.query("SELECT id FROM remem.candidate_memories WHERE id = $1", [candidateId]),
        ).toMatchObject({ rowCount: 0 })
        expect(await provider.get(independentMemory.id, forgetContext)).toBeDefined()
        expect(await provider.appendEvidence(envelope)).toEqual({
          outcome: "forgotten",
          id: envelope.id,
        })

        const tombstones = await pool.query<{ target_kind: string; target_id: string }>(
          `SELECT target_kind, target_id
           FROM remem.forget_tombstones
           WHERE provider_id = 'forget-provider' AND project_id = $1
           ORDER BY target_kind`,
          [projectId],
        )
        expect(tombstones.rows).toEqual([
          { target_kind: "candidate", target_id: candidateId },
          { target_kind: "evidence", target_id: envelope.id },
        ])
        expect(JSON.stringify(tombstones.rows)).not.toContain("private episode content")
      } finally {
        await provider.dispose()
      }
    })

    it("rejects an expired preview without deleting its episode", async () => {
      const provider = new PostgresMemoryProvider(forgetProviderConfig)
      try {
        const envelope = await appendForgetEvidence(provider, "expired")
        const preview = await provider.previewForget("forget-provider", envelope.id, projectId)
        if (!preview) throw new Error("forget preview was unexpectedly absent")
        await pool.query(
          `UPDATE remem.forget_previews
           SET created_at = now() - interval '16 minutes', expires_at = now() - interval '1 second'
           WHERE id = $1`,
          [preview.id],
        )

        await expect(provider.confirmForget(preview.id)).rejects.toThrow("unavailable or expired")
        expect(
          await provider.readEvidence("forget-provider", envelope.id, forgetContext),
        ).toBeDefined()
      } finally {
        await provider.dispose()
      }
    })

    it("serializes confirmation behind the restore tombstone lock", async () => {
      // A one-connection provider catches a nested-pool-acquisition deadlock:
      // confirmation must perform its lookup and delete transaction using the
      // same connection that holds the global restore lock.
      const provider = new PostgresMemoryProvider({ ...forgetProviderConfig, maxConnections: 1 })
      const lockClient = await pool.connect()
      try {
        const envelope = await appendForgetEvidence(provider, "restore-lock")
        const preview = await provider.previewForget("forget-provider", envelope.id, projectId)
        if (!preview) throw new Error("forget preview was unexpectedly absent")
        await lockClient.query("SELECT pg_advisory_lock($1)", [FORGET_RESTORE_ADVISORY_LOCK])

        const confirmation = provider.confirmForget(preview.id)
        await new Promise((resolve) => setTimeout(resolve, 25))
        // The restore lock models the interval after restore snapshots current
        // tombstones and before it reapplies them. Confirmation must not
        // delete/create a tombstone in that gap. Use the independent fixture
        // pool because the provider's sole connection is intentionally
        // blocked on the shared lock.
        expect(
          await pool.query(
            `SELECT id FROM remem.session_events
             WHERE provider_id = 'forget-provider' AND project_id = $1 AND evidence_id = $2`,
            [projectId, envelope.id],
          ),
        ).toMatchObject({ rowCount: 1 })

        await lockClient.query("SELECT pg_advisory_unlock($1)", [FORGET_RESTORE_ADVISORY_LOCK])
        await expect(confirmation).resolves.toMatchObject({ evidenceDeleted: true })
      } finally {
        await lockClient
          .query("SELECT pg_advisory_unlock($1)", [FORGET_RESTORE_ADVISORY_LOCK])
          .catch(() => undefined)
        lockClient.release()
        await provider.dispose()
      }
    })
  })
})

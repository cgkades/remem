import { appendFile, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PostgresMemoryProvider } from "../src/providers/postgres.js"
import { runDoctor } from "../src/cli/doctor.js"
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

      const upgraded = await runMigrations(pool)
      expect(upgraded).toMatchObject({ applied: [2], currentVersion: 2 })

      const repeated = await runMigrations(pool)
      expect(repeated).toMatchObject({ applied: [], currentVersion: 2 })

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
        entities: [{ name: "Amazon Bedrock", type: "service", aliases: ["Bedrock"] }],
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
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

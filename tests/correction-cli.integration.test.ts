import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { runCli } from "../src/cli/index.js"
import type { CorrectionCandidate, CorrectionInput } from "../src/correction.js"
import { PostgresCorrectionCandidateStore } from "../src/providers/postgres-correction-store.js"
import { runMigrations } from "../src/storage/migrations.js"
import { rememPaths } from "../src/storage/paths.js"
import { writeAppConfig, type RememAppConfig } from "../src/storage/config-file.js"
import type { MemoryContext, MemoryTrace } from "../src/types.js"

const databaseUrl = process.env.REMEM_TEST_DATABASE_URL
const integration = databaseUrl ? describe.sequential : describe.skip

const context: MemoryContext = {
  directory: "/workspace/phoenix",
  worktree: "/workspace/phoenix",
  projectId: "phoenix",
  sessionId: "session-1",
}

const trace: MemoryTrace = {
  sessionId: "session-1",
  prompt: "Can we skip the rollback plan?",
  timestamp: "2026-09-04T00:00:00.000Z",
  catalogEntries: 0,
  catalogMatches: [],
  shouldRetrieve: false,
  confidence: 0,
  topics: [],
  signals: [],
  providers: [],
  rawResults: 0,
  deduplicatedResults: 0,
  selectedResults: 0,
  catalogTokens: 0,
  recallTokens: 0,
  totalDurationMs: 0,
  diagnostics: [],
}

function correction(overrides: Partial<CorrectionInput> = {}): CorrectionInput {
  return {
    sessionId: "session-1",
    prompt: "Can we skip the rollback plan?",
    correctionText: "Rollback plans are required.",
    expectedOutcome: "Production rollouts require an approved rollback plan.",
    actor: "opencode-session:session-1",
    context,
    trace,
    ...overrides,
  }
}

function validatedCandidate(id: string): CorrectionCandidate {
  const now = new Date().toISOString()
  return {
    id,
    state: "validated",
    correction: correction({ id }),
    rootCause: "knowledge_gap",
    affectedMemoryIds: [],
    mutation: {
      kind: "create",
      proposed: {
        title: `Correction candidate ${id}`,
        content: "Production rollouts require an approved rollback plan.",
        scope: { kind: "project", id: "phoenix" },
        type: "decision",
      },
    },
    structuralValidation: { valid: true, issues: [] },
    replay: { passed: true, caseIds: [id], failures: [] },
    audit: [{ at: now, actor: "reviewer@example.test", event: "submitted" }],
    createdAt: now,
    updatedAt: now,
  }
}

integration("correction-candidates / correction-review CLI", () => {
  const pool = new Pool({ connectionString: databaseUrl })

  beforeAll(async () => {
    await pool.query("DROP SCHEMA IF EXISTS remem CASCADE")
    await runMigrations(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  async function withCli<T>(run: (paths: ReturnType<typeof rememPaths>) => Promise<T>): Promise<T> {
    const root = await mkdtemp(path.join(os.tmpdir(), "remem-correction-cli-"))
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
    await mkdir(paths.dataDir, { recursive: true, mode: 0o700 })
    await writeAppConfig(config, paths)
    return run(paths)
  }

  it("lists correction candidates and filters by state", async () => {
    const store = new PostgresCorrectionCandidateStore(pool, "remem-local")
    const id = randomUUID()
    await store.insert(validatedCandidate(id))

    await withCli(async (paths) => {
      const lines: string[] = []
      const exitCode = await runCli(["correction-candidates"], {
        paths,
        stdout: (line) => lines.push(line),
      })
      expect(exitCode).toBe(0)
      const listed = JSON.parse(lines.join("\n")) as CorrectionCandidate[]
      expect(listed.some((candidate) => candidate.id === id)).toBe(true)

      const filteredLines: string[] = []
      await runCli(["correction-candidates", "--state", "applied"], {
        paths,
        stdout: (line) => filteredLines.push(line),
      })
      const filtered = JSON.parse(filteredLines.join("\n")) as CorrectionCandidate[]
      expect(filtered.some((candidate) => candidate.id === id)).toBe(false)
    })
  })

  it("approves a validated candidate, applying its mutation to the primary provider", async () => {
    const store = new PostgresCorrectionCandidateStore(pool, "remem-local")
    const id = randomUUID()
    await store.insert(validatedCandidate(id))

    await withCli(async (paths) => {
      const lines: string[] = []
      const exitCode = await runCli(
        ["correction-review", id, "--approve", "--actor", "reviewer@example.test"],
        { paths, stdout: (line) => lines.push(line) },
      )
      expect(exitCode).toBe(0)
      expect(lines.join("\n")).toContain("applied as memory")
    })

    const stored = await store.get(id)
    expect(stored?.state).toBe("applied")
    expect(stored?.appliedMemoryId).toBeDefined()

    const memoryRow = await pool.query<{ title: string }>(
      "SELECT title FROM remem.memories WHERE id = $1",
      [stored?.appliedMemoryId],
    )
    expect(memoryRow.rows[0]?.title).toBe(`Correction candidate ${id}`)
  })

  it("rejects a candidate with a reason and never applies its mutation", async () => {
    const store = new PostgresCorrectionCandidateStore(pool, "remem-local")
    const id = randomUUID()
    await store.insert(validatedCandidate(id))

    await withCli(async (paths) => {
      const lines: string[] = []
      const exitCode = await runCli(
        [
          "correction-review",
          id,
          "--reject",
          "--reason",
          "not needed",
          "--actor",
          "reviewer@example.test",
        ],
        { paths, stdout: (line) => lines.push(line) },
      )
      expect(exitCode).toBe(0)
      expect(lines.join("\n")).toContain("rejected")
    })

    const stored = await store.get(id)
    expect(stored?.state).toBe("rejected")
    expect(stored?.reviewerDecision).toMatchObject({ decision: "rejected", reason: "not needed" })
  })

  it("requires --reason for --reject and rejects neither/both of --approve/--reject", async () => {
    const store = new PostgresCorrectionCandidateStore(pool, "remem-local")
    const id = randomUUID()
    await store.insert(validatedCandidate(id))

    await withCli(async (paths) => {
      const exitCode = await runCli(["correction-review", id, "--reject"], { paths })
      expect(exitCode).toBe(1)
    })

    await withCli(async (paths) => {
      const exitCode = await runCli(["correction-review", id], { paths })
      expect(exitCode).toBe(1)
    })
  })
})

import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PostgresMemoryProvider } from "../src/providers/postgres.js"
import { admitEvidence, DEFAULT_EVIDENCE_ADMISSION_CONFIG } from "../src/observation-admission.js"
import { runMigrations } from "../src/storage/migrations.js"
import { estimateTokens } from "../src/token-budget.js"
import type { MemoryContext } from "../src/types.js"

const databaseUrl = process.env.REMEM_TEST_DATABASE_URL
const integration = databaseUrl ? describe.sequential : describe.skip
integration("search-first episodic query correctness", () => {
  const pool = new Pool({ connectionString: databaseUrl })
  const context: MemoryContext = {
    directory: "/workspace/query",
    worktree: "/workspace/query",
    projectId: "query-project",
    sessionId: "shared-session",
  }
  const provider = new PostgresMemoryProvider(
    {
      type: "postgres",
      id: "query-provider",
      connectionString: databaseUrl ?? "",
      primary: true,
      maxConnections: 2,
      catalogLimit: 100,
    },
    { pool },
  )

  beforeAll(async () => {
    await pool.query("DROP SCHEMA IF EXISTS remem CASCADE")
    await runMigrations(pool)
    for (const [providerId, projectId] of [
      ["query-provider", "query-project"],
      ["foreign-provider", "query-project"],
      ["query-provider", "foreign-project"],
    ]) {
      for (let i = 0; i < 5; i++) {
        const role = i % 2 === 0 ? ("user" as const) : ("assistant" as const)
        const admitted = admitEvidence(
          {
            providerId,
            host: "opencode-v2",
            context: { ...context, projectId },
            role,
            origin: role === "user" ? "direct-user" : "host-observed",
            kind: "turn-completed",
            turnId: "turn-" + i,
            messageId: "message-" + i,
            occurredAt: "2026-09-01T00:00:00.000Z",
            payload: { text: "neighbortoken" + i },
          },
          { providerId, host: "opencode-v2", projectId },
          { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
        )
        if (admitted.outcome !== "admitted") throw new Error("fixture admission failed")
        await provider.appendEvidence(admitted.envelope)
      }
    }
  })
  afterAll(async () => {
    await pool.end()
  })

  async function middle() {
    const rows = (
      await pool.query<{
        evidence_id: string
        role: "user" | "assistant"
        turn_id: string
        safe_text: string
      }>(
        "SELECT evidence_id,role,turn_id,safe_text FROM remem.session_events WHERE provider_id=$1 AND project_id=$2 ORDER BY occurred_at,id",
        [provider.id, context.projectId],
      )
    ).rows
    if (!rows[2]) throw new Error("missing middle fixture")
    return { rows, target: rows[2] }
  }

  it("preserves same-session neighbors across role filtering and equal timestamp UUID ties", async () => {
    const { rows, target } = await middle()
    const result = await provider.searchEpisodes(provider.id, target.safe_text, context, {
      limit: 1,
      roles: [target.role],
    })
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.envelope.id).toBe(target.evidence_id)
    expect(result.matches[0]?.neighbors.map((value) => value.envelope.id)).toEqual([
      rows[1]?.evidence_id,
      rows[3]?.evidence_id,
    ])
    for (const neighbor of result.matches[0]?.neighbors ?? []) {
      expect(neighbor.envelope.providerId).toBe(provider.id)
      expect(neighbor.envelope.context.projectId).toBe(context.projectId)
      expect(neighbor.envelope.context.sessionId).toBe(context.sessionId)
    }
  })

  it("omits neighbors on explicit opt-out and keeps output within the existing budget", async () => {
    const { target } = await middle()
    const result = await provider.searchEpisodes(provider.id, target.safe_text, context, {
      limit: 1,
      includeNeighbors: false,
      maxOutputTokens: 1000,
    })
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.neighbors).toEqual([])
    expect(estimateTokens(JSON.stringify(result.matches))).toBeLessThanOrEqual(1000)
    expect(
      await provider.searchEpisodes(provider.id, target.safe_text, context, { maxOutputTokens: 0 }),
    ).toEqual({ matches: [], budgetExhausted: false })
  })

  it("does not expose a matching foreign provider/project or unrelated query", async () => {
    expect(await provider.searchEpisodes(provider.id, "absentmarker", context)).toEqual({
      matches: [],
      budgetExhausted: false,
    })
    const found = await provider.searchEpisodes(provider.id, "neighbortoken0", context)
    expect(found.matches).toHaveLength(1)
    expect(found.matches[0]?.envelope.providerId).toBe(provider.id)
    expect(found.matches[0]?.envelope.context.projectId).toBe(context.projectId)
  })
})

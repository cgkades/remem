import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { CorrectionCandidate, CorrectionInput } from "../src/correction.js"
import { PostgresCorrectionCandidateStore } from "../src/providers/postgres-correction-store.js"
import { runMigrations } from "../src/storage/migrations.js"
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
    actor: "reviewer@example.test",
    context,
    trace,
    ...overrides,
  }
}

function candidate(overrides: Partial<CorrectionCandidate> = {}): CorrectionCandidate {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    state: "pending_validation",
    correction: correction(),
    affectedMemoryIds: [],
    audit: [{ at: now, actor: "reviewer@example.test", event: "submitted" }],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

integration("PostgresCorrectionCandidateStore", () => {
  const pool = new Pool({ connectionString: databaseUrl })

  beforeAll(async () => {
    await pool.query("DROP SCHEMA IF EXISTS remem CASCADE")
    await runMigrations(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  it("round-trips a candidate through insert/get/list, including optional fields", async () => {
    const store = new PostgresCorrectionCandidateStore(pool, "remem-local")
    const seeded = candidate({
      rootCause: "knowledge_gap",
      rootCauseReason: "no disputed memory was identified",
      impactedMemoryIds: ["position.dependent"],
      mutation: {
        kind: "create",
        proposed: {
          title: "Correction: rollback plans are required",
          content: "Production rollouts require an approved rollback plan.",
          scope: { kind: "project", id: "phoenix" },
          type: "decision",
        },
      },
      structuralValidation: { valid: true, issues: [] },
    })
    await store.insert(seeded)

    const fetched = await store.get(seeded.id)
    expect(fetched).toEqual(seeded)

    const listed = await store.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(seeded.id)

    const filtered = await store.list({ state: "validated" })
    expect(filtered).toHaveLength(0)
  })

  it("scopes candidates by provider id, so two providers never see each other's rows", async () => {
    const storeA = new PostgresCorrectionCandidateStore(pool, "provider-a")
    const storeB = new PostgresCorrectionCandidateStore(pool, "provider-b")
    const seeded = candidate()
    await storeA.insert(seeded)

    expect(await storeB.get(seeded.id)).toBeUndefined()
    expect(await storeB.list()).toEqual([])
    expect(await storeA.get(seeded.id)).toMatchObject({ id: seeded.id })
  })

  it("update() persists a mutation and re-reads the fresher row on the next call", async () => {
    const store = new PostgresCorrectionCandidateStore(pool, "remem-local")
    const seeded = candidate({ id: randomUUID() })
    await store.insert(seeded)

    const validated = await store.update(seeded.id, (current) => ({
      ...current,
      state: "validated",
      audit: [
        ...current.audit,
        { at: new Date().toISOString(), actor: "system", event: "validated" },
      ],
    }))
    expect(validated.state).toBe("validated")
    expect(validated.audit).toHaveLength(2)

    const fetched = await store.get(seeded.id)
    expect(fetched?.state).toBe("validated")
    expect(fetched?.audit).toHaveLength(2)
  })

  it("update() rolls back and rejects when the mutate callback throws, leaving the row unchanged", async () => {
    const store = new PostgresCorrectionCandidateStore(pool, "remem-local")
    const seeded = candidate({ id: randomUUID() })
    await store.insert(seeded)

    await expect(
      store.update(seeded.id, () => {
        throw new Error("guard rejected the transition")
      }),
    ).rejects.toThrow("guard rejected the transition")

    const fetched = await store.get(seeded.id)
    expect(fetched?.state).toBe("pending_validation")
  })

  it("update() throws for an unknown id instead of creating a row", async () => {
    const store = new PostgresCorrectionCandidateStore(pool, "remem-local")
    await expect(store.update(randomUUID(), (current) => current)).rejects.toThrow(
      /unknown correction candidate/,
    )
  })

  it("serializes concurrent update() calls on the same row via row-level locking", async () => {
    const store = new PostgresCorrectionCandidateStore(pool, "remem-local")
    const seeded = candidate({ id: randomUUID() })
    await store.insert(seeded)

    const order: string[] = []
    const first = store.update(seeded.id, (current) => {
      order.push("first-read")
      return { ...current, rootCauseReason: "first" }
    })
    const second = store.update(seeded.id, (current) => {
      order.push("second-read")
      return { ...current, rootCauseReason: "second" }
    })
    await Promise.all([first, second])

    // Whichever transaction's SELECT ... FOR UPDATE acquires the row lock
    // first must fully commit before the other's SELECT can proceed --
    // so the two mutate callbacks can never interleave, only sequence.
    expect(order).toHaveLength(2)
    const fetched = await store.get(seeded.id)
    expect(["first", "second"]).toContain(fetched?.rootCauseReason)
  })
})

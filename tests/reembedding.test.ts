import { describe, expect, it, vi } from "vitest"
import { PostgresReembedRunner, shouldAttemptReembed } from "../src/reembedding.js"
import { describeError } from "../src/text.js"

function fakePool(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    connect: vi.fn(),
    query: vi.fn(),
    ...overrides,
  }
}

describe("PostgresReembedRunner", () => {
  it("reports zero work when there is nothing to claim", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    const pool = fakePool({
      query: vi.fn().mockResolvedValue({ rows: [] }), // recoverInterruptedRuns calls
      connect: vi.fn().mockResolvedValue(client),
    })
    const embed = vi.fn()
    const runner = new PostgresReembedRunner(pool as never, embed, {
      modelId: "bge-small-en-v1.5",
      dimensions: 384,
      batchSize: 10,
    })
    const result = await runner.run()
    expect(result.status).toBe("no-op")
    expect(embed).not.toHaveBeenCalled()
  })

  it("persists and releases a claim around a re-embed run", async () => {
    const target = { memory_id: "memory-1", content: "stale content" }
    const clientQueries: Array<{ sql: string; values?: unknown[] }> = []
    const client = {
      query: vi.fn((sql: string, values?: unknown[]) => {
        clientQueries.push(values === undefined ? { sql } : { sql, values })
        if (sql.includes("SELECT me.memory_id")) return Promise.resolve({ rows: [target] })
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
      release: vi.fn(),
    }
    const pool = fakePool({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
      connect: vi.fn().mockResolvedValue(client),
    })
    const runner = new PostgresReembedRunner(pool as never, () => Promise.resolve([0]), {
      modelId: "bge-small-en-v1.5",
      dimensions: 384,
      batchSize: 10,
    })

    await runner.run()

    const claimCall = clientQueries.find(({ sql }) => sql.includes("SET reembed_claim_id = $1"))
    expect(claimCall?.values?.[1]).toEqual([target.memory_id])
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("AND me.reembed_claim_id IS NULL"),
      expect.any(Array),
    )
    expect(clientQueries.findIndex(({ sql }) => sql === "COMMIT")).toBeGreaterThan(
      clientQueries.findIndex(({ sql }) => sql.includes("SET reembed_claim_id = $1")),
    )
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE reembed_claim_id = $1"),
      expect.any(Array),
    )
  })

  it("records a descriptive error, not just the error name, when an embed call fails", async () => {
    const target = { memory_id: "memory-1", content: "stale content" }
    const client = {
      query: vi.fn((sql: string) => {
        if (sql.includes("SELECT me.memory_id")) return Promise.resolve({ rows: [target] })
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
      release: vi.fn(),
    }
    const pool = fakePool({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
      connect: vi.fn().mockResolvedValue(client),
    })
    const runner = new PostgresReembedRunner(
      pool as never,
      () => Promise.reject(new TypeError("dimension mismatch: expected 384, got 512")),
      { modelId: "bge-small-en-v1.5", dimensions: 384, batchSize: 10 },
    )

    const result = await runner.run()

    expect(result.status).toBe("failed")
    expect(result.errors).toEqual(["TypeError: dimension mismatch: expected 384, got 512"])
  })
})

describe("describeError", () => {
  it("combines the error name and message", () => {
    expect(describeError(new TypeError("bad input"))).toBe("TypeError: bad input")
  })

  it("falls back to just the name when there is no message", () => {
    expect(describeError(new Error())).toBe("Error")
  })

  it("returns 'unknown error' for a non-Error value", () => {
    expect(describeError("not an error")).toBe("unknown error")
    expect(describeError(undefined)).toBe("unknown error")
  })

  it("truncates a pathologically long message instead of persisting it unbounded", () => {
    const description = describeError(new Error("x".repeat(1_000)), 20)
    expect(description.length).toBeLessThanOrEqual(21)
    expect(description.startsWith("Error: xxxxxxxxxxxxx")).toBe(true)
  })
})

describe("shouldAttemptReembed", () => {
  it("returns true when never attempted", () => {
    expect(shouldAttemptReembed(undefined, () => 1_000, 5 * 60_000)).toBe(true)
  })

  it("returns false within the cooldown window", () => {
    expect(shouldAttemptReembed(1_000, () => 1_000 + 60_000, 5 * 60_000)).toBe(false)
  })

  it("returns true after the cooldown window elapses", () => {
    expect(shouldAttemptReembed(1_000, () => 1_000 + 6 * 60_000, 5 * 60_000)).toBe(true)
  })
})

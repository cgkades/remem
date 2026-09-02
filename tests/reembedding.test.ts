import { describe, expect, it, vi } from "vitest"
import { PostgresReembedRunner } from "../src/reembedding.js"

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
})

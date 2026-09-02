import { describe, expect, it } from "vitest"
import { RememOrchestrator } from "../src/orchestrator.js"
import { MarkdownMemoryProvider } from "../src/providers/markdown.js"
import { fixtureDirectory, memoryContext, testConfig } from "./helpers.js"

function createOrchestrator(recallTokens = 1_400) {
  const config = testConfig({
    budgets: { catalogTokens: 600, recallTokens, perProviderTokens: 900 },
  })
  const providerConfig = {
    type: "markdown" as const,
    id: "fixtures",
    paths: [fixtureDirectory],
    exclude: ["**/.git/**"],
    scope: "workspace" as const,
    maxFileBytes: 256 * 1024,
    maxFiles: 100,
  }
  return new RememOrchestrator(
    [new MarkdownMemoryProvider(providerConfig, [fixtureDirectory])],
    config,
  )
}

describe("Remem orchestration behavior", () => {
  it("recognizes, recalls, and injects relevant Phoenix memory", async () => {
    const injection = await createOrchestrator().processPrompt(
      "Let's continue the Phoenix database work.",
      memoryContext,
    )

    expect(injection.plan.shouldRetrieve).toBe(true)
    expect(injection.text).toContain("<memory-catalog>")
    expect(injection.text).toContain("<memory-context>")
    expect(injection.text).toContain("use logical replication")
    expect(injection.text).toContain("fixtures:0:project-phoenix.md")
    expect(injection.trace.selectedResults).toBeGreaterThan(0)
    const recalled = injection.text.split("<memory-context>")[1] ?? ""
    expect(recalled).not.toContain("Project Mercury")
    expect(recalled).not.toContain("Kafka migration")
  })

  it("does not inject Phoenix details for an unrelated prompt", async () => {
    const injection = await createOrchestrator().processPrompt(
      "Can you explain a Python list comprehension?",
      memoryContext,
    )

    expect(injection.plan.shouldRetrieve).toBe(false)
    expect(injection.text).toContain("<memory-catalog>")
    expect(injection.text).not.toContain("<memory-context>")
    expect(injection.text).not.toContain("use logical replication")
    expect(injection.trace.selectedResults).toBe(0)
  })

  it("labels stale conflicting memory rather than silently reconciling it", async () => {
    const injection = await createOrchestrator().processPrompt(
      "Continue the Phoenix database migration",
      memoryContext,
    )

    expect(injection.text).toContain("current; decision")
    expect(injection.text).toContain("stale; decision")
    expect(injection.text).toContain("pg_dump cutover")
  })

  it("keeps catalog and recalled memory inside separate token budgets", async () => {
    const injection = await createOrchestrator(120).processPrompt(
      "Continue the Phoenix database migration",
      memoryContext,
    )

    expect(injection.trace.catalogTokens).toBeLessThanOrEqual(600)
    expect(injection.trace.recallTokens).toBeLessThanOrEqual(120)
  })

  it("falls back to deterministic synthesis when an optional strategy fails", async () => {
    const config = testConfig()
    const provider = new MarkdownMemoryProvider(
      {
        type: "markdown",
        id: "fixtures",
        paths: [fixtureDirectory],
        exclude: [],
        scope: "workspace",
        maxFileBytes: 256 * 1024,
        maxFiles: 100,
      },
      [fixtureDirectory],
    )
    const injection = await new RememOrchestrator([provider], config, undefined, {
      synthesizer: {
        id: "unavailable-model",
        synthesize: () => Promise.reject(new Error("model unavailable")),
      },
    }).processPrompt("Continue the Phoenix database migration", memoryContext)

    expect(injection.memoryText).toContain("use logical replication")
    expect(injection.trace.diagnostics).toContain("synthesis strategy failed: Error")
  })

  it("bounds a synthesis strategy that never completes", async () => {
    const provider = new MarkdownMemoryProvider(
      {
        type: "markdown",
        id: "fixtures",
        paths: [fixtureDirectory],
        exclude: [],
        scope: "workspace",
        maxFileBytes: 256 * 1024,
        maxFiles: 100,
      },
      [fixtureDirectory],
    )
    const started = performance.now()
    const injection = await new RememOrchestrator(
      [provider],
      testConfig({ providerTimeoutMs: 50 }),
      undefined,
      {
        synthesizer: {
          id: "hung-model",
          synthesize: () => new Promise(() => undefined),
        },
      },
    ).processPrompt("Continue the Phoenix database migration", memoryContext)

    expect(performance.now() - started).toBeLessThan(500)
    expect(injection.memoryText).toContain("use logical replication")
    expect(injection.trace.diagnostics).toContain(
      "synthesis strategy failed: OperationTimeoutError",
    )
  })
})

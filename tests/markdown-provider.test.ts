import { describe, expect, it } from "vitest"
import type { MarkdownProviderConfig } from "../src/config.js"
import { MarkdownMemoryProvider } from "../src/providers/markdown.js"
import { fixtureDirectory, memoryContext } from "./helpers.js"

const config: MarkdownProviderConfig = {
  type: "markdown",
  id: "fixtures",
  paths: [fixtureDirectory],
  exclude: ["**/.git/**"],
  scope: "workspace",
  maxFileBytes: 256 * 1024,
  maxFiles: 100,
}

describe("MarkdownMemoryProvider", () => {
  it("builds a compact catalog from Markdown metadata", async () => {
    const provider = new MarkdownMemoryProvider(config, [fixtureDirectory])
    const catalog = await provider.catalog(memoryContext, new AbortController().signal)

    expect(catalog.map((entry) => entry.title)).toEqual(
      expect.arrayContaining(["Project Phoenix", "Kafka migration", "User testing preference"]),
    )
    expect(catalog.find((entry) => entry.title === "Kafka migration")?.unresolved).toBe(true)
    expect(catalog.find((entry) => entry.title === "User testing preference")?.scope.kind).toBe(
      "global",
    )
    expect(catalog.some((entry) => entry.title === "Session-only rollout note")).toBe(false)
    expect(catalog.some((entry) => entry.title === "Invalid scope note")).toBe(false)

    const owningSession = await provider.catalog(
      { ...memoryContext, sessionId: "session-owner" },
      new AbortController().signal,
    )
    expect(owningSession.some((entry) => entry.title === "Session-only rollout note")).toBe(true)
  })

  it("retrieves relevant files and preserves provenance and freshness", async () => {
    const provider = new MarkdownMemoryProvider(config, [fixtureDirectory])
    const results = await provider.search({
      query: "Let's continue the Phoenix database work.",
      topics: ["Project Phoenix"],
      context: memoryContext,
      limit: 10,
      maxTokens: 1_000,
      reason: "test",
      signal: new AbortController().signal,
    })

    const current = results.find((result) => result.record.title === "Project Phoenix")
    expect(current?.record.source).toContain("project-phoenix.md")
    expect(results.some((result) => result.record.freshness === "stale")).toBe(true)
    expect(results.every((result) => result.record.providerId === "fixtures")).toBe(true)
    expect(results.some((result) => result.record.title === "Project Mercury")).toBe(false)
    expect(results.some((result) => result.record.title === "Kafka migration")).toBe(false)
  })

  it("does not return unrelated memory", async () => {
    const provider = new MarkdownMemoryProvider(config, [fixtureDirectory])
    const results = await provider.search({
      query: "Explain a Python list comprehension",
      topics: [],
      context: memoryContext,
      limit: 10,
      maxTokens: 1_000,
      reason: "test",
      signal: new AbortController().signal,
    })

    expect(results).toEqual([])
  })
})

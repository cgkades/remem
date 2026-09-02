import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
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

  it("honors path exclusions, file limits, and symlink boundaries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remem-markdown-"))
    try {
      await mkdir(path.join(root, "private"))
      await writeFile(path.join(root, "keep.md"), "# Kept note\n\nVisible memory.")
      await writeFile(path.join(root, "private", "hidden.md"), "# Hidden note\n\nExcluded.")
      await writeFile(path.join(root, "oversized.md"), `# Oversized\n\n${"x".repeat(2_000)}`)
      await symlink(path.join(root, "keep.md"), path.join(root, "linked.md"))
      const provider = new MarkdownMemoryProvider(
        {
          type: "markdown",
          id: "bounded",
          paths: [root],
          exclude: ["private/**"],
          scope: "workspace",
          maxFileBytes: 1_000,
          maxFiles: 10,
        },
        [root],
      )
      const catalog = await provider.catalog(
        { ...memoryContext, directory: root, worktree: root },
        new AbortController().signal,
      )

      expect(catalog.map(({ title }) => title)).toEqual(["Kept note"])
      expect((await provider.health()).status).toBe("degraded")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

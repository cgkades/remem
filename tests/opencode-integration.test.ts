import { describe, expect, it } from "vitest"
import { injectPromptMemory, type PromptMessageOutput } from "../src/integration/opencode.js"
import { RememOrchestrator } from "../src/orchestrator.js"
import { MarkdownMemoryProvider } from "../src/providers/markdown.js"
import { fixtureDirectory, memoryContext, testConfig } from "./helpers.js"

describe("OpenCode prompt injection", () => {
  it("preserves existing system text and appends bounded Remem context", async () => {
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
    const output: PromptMessageOutput = {
      message: { system: "Existing project instruction." },
      parts: [{ type: "text", text: "Let's continue the Phoenix database work." }],
    }

    await injectPromptMemory(new RememOrchestrator([provider], config), output, memoryContext)

    expect(output.message.system).toMatch(/^Existing project instruction\./u)
    expect(output.message.system).toContain("<memory-catalog>")
    expect(output.message.system).toContain("<memory-context>")
    expect(output.message.system).toContain("use logical replication")
  })
})

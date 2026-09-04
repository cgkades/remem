import { describe, expect, it } from "vitest"
import { injectV1PromptMemory, type V1PromptMessageOutput } from "../src/hosts/opencode/v1.js"
import { injectV2DispatchMemory } from "../src/hosts/opencode/v2.js"
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
    const output: V1PromptMessageOutput = {
      message: { system: "Existing project instruction." },
      parts: [{ type: "text", text: "Let's continue the Phoenix database work." }],
    }

    await injectV1PromptMemory(new RememOrchestrator([provider], config), output, memoryContext)

    expect(output.message.system).toMatch(/^Existing project instruction\./u)
    expect(output.message.system).toContain("<memory-catalog>")
    expect(output.message.system).toContain("<memory-context>")
    expect(output.message.system).toContain("use logical replication")
  })

  it("keeps retrieved v2 data out of privileged system instructions", async () => {
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
    const originalUserMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Let's continue the Phoenix database work." }],
    }
    const event = {
      sessionID: "session-1",
      system: [{ type: "text" as const, text: "Existing project instruction." }],
      messages: [originalUserMessage],
    }

    await injectV2DispatchMemory(
      new RememOrchestrator([provider], testConfig()),
      event,
      memoryContext,
    )

    expect(event.messages[0]).toBe(originalUserMessage)
    expect(event.system.map((part) => part.text).join("\n")).not.toContain(
      "use logical replication",
    )
    expect(event.system.at(-1)?.text).toContain("untrusted evidence")
    expect(event.messages).toHaveLength(2)
    expect(event.messages.at(-1)?.content[0]?.text).toContain("use logical replication")
  })

  it("reuses the latest canonical user prompt during a v2 tool-loop dispatch", async () => {
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
    const event = {
      sessionID: "tool-loop",
      system: [] as unknown[],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Continue the Phoenix database migration." }],
        },
        { role: "assistant", content: [{ type: "tool-call", name: "read", id: "1", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", name: "read", id: "1", result: {} }] },
      ] as unknown[],
    }

    await injectV2DispatchMemory(
      new RememOrchestrator([provider], testConfig()),
      event,
      memoryContext,
    )

    expect(JSON.stringify(event.messages.at(-1))).toContain("use logical replication")
  })

  it("binds a correction to the original answered turn, not a tool-loop continuation dispatch within the correction turn", async () => {
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
    const orchestrator = new RememOrchestrator([provider], testConfig())
    const sessionID = "correction-turn-loop"

    // Turn 1: original question -> dispatch A.
    await injectV2DispatchMemory(
      orchestrator,
      {
        sessionID,
        system: [],
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Continue the Phoenix database migration." }],
          },
        ],
      },
      memoryContext,
    )

    // Turn 2: the user's correction message -> a fresh dispatch (B), which
    // must NOT be mistaken for the trace behind the disputed response.
    const correctionEvent = {
      sessionID,
      system: [] as unknown[],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Continue the Phoenix database migration." }],
        },
        { role: "assistant", content: [{ type: "text", text: "Here is the migration plan." }] },
        {
          role: "user",
          content: [{ type: "text", text: "That answer was wrong; rollback plans are required." }],
        },
      ] as unknown[],
    }
    await injectV2DispatchMemory(orchestrator, correctionEvent, memoryContext)

    // Same correction turn: the model calls a tool, then OpenCode
    // re-dispatches to the model with the tool result appended -- re-running
    // the "context" hook (dispatch C) without a new user message.
    const toolLoopEvent = {
      sessionID,
      system: [] as unknown[],
      messages: [
        ...correctionEvent.messages,
        { role: "assistant", content: [{ type: "tool-call", name: "read", id: "1", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", name: "read", id: "1", result: {} }] },
      ] as unknown[],
    }
    await injectV2DispatchMemory(orchestrator, toolLoopEvent, memoryContext)

    // The model now calls memory_submit_correction. explainPreviousTurn must
    // resolve to turn 1's dispatch (A), not turn 2's own repeated dispatches
    // (B or C).
    const previous = orchestrator.explainPreviousTurn(memoryContext.sessionId ?? "")
    if ("status" in previous) throw new Error("expected a trace")
    expect(previous.prompt).toBe("Continue the Phoenix database migration.")
  })
})

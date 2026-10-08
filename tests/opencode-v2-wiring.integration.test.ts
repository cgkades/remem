import type { Context } from "@opencode-ai/plugin/promise/plugin"
import { Pool } from "pg"
import { randomUUID } from "node:crypto"
import { beforeAll, afterAll, describe, expect, it } from "vitest"
import { RememPlugin } from "../src/hosts/opencode/v2.js"
import { runMigrations } from "../src/storage/migrations.js"
import { RememOrchestrator } from "../src/orchestrator.js"
import { PostgresMemoryProvider } from "../src/providers/postgres.js"
import { testConfig } from "./helpers.js"

const databaseUrl = process.env.REMEM_TEST_DATABASE_URL
const integration = databaseUrl ? describe.sequential : describe.skip

/**
 * A minimal stand-in for `@opencode-ai/plugin`'s `Context`, implementing
 * only what `RememPlugin.setup()` actually touches: `location`, `options`,
 * `session.hook`, and `tool.transform`. Records every hook registration so
 * tests can assert on which hooks got wired up, without needing a real
 * OpenCode runtime.
 */
function fakeContext(pluginOptions: Record<string, unknown>, projectId = "wiring-test-project") {
  const hookCalls: { name: string; callback: (input: unknown) => unknown }[] = []
  const toolHooks: { name: string; callback: (input: unknown) => unknown }[] = []
  const context = {
    location: {
      directory: "/repo",
      project: { directory: "/repo", id: projectId },
    },
    options: pluginOptions,
    session: {
      hook: (name: string, callback: (input: unknown) => unknown) => {
        hookCalls.push({ name, callback })
        return Promise.resolve({ dispose: () => Promise.resolve() })
      },
    },
    tool: {
      hook: (name: string, callback: (input: unknown) => unknown) => {
        toolHooks.push({ name, callback })
        return Promise.resolve({ dispose: () => Promise.resolve() })
      },
      transform: (_callback: unknown) => Promise.resolve({ dispose: () => Promise.resolve() }),
    },
  }
  return { context, hookCalls, toolHooks }
}

integration("OpenCode cross-session admitted evidence slice", () => {
  const pool = new Pool({ connectionString: databaseUrl })
  beforeAll(async () => {
    await runMigrations(pool)
  })
  afterAll(async () => {
    await pool.end()
  })

  it("retains ordinary investigation evidence and recalls user-confirmed conclusions after restart", async () => {
    const providerId = `learning-${randomUUID()}`
    const projectId = `phoenix-${randomUUID()}`
    const options = {
      providers: [
        { type: "postgres", id: providerId, connectionString: databaseUrl, primary: true },
      ],
      evidenceAdmission: { enabled: true },
      capture: { enabled: true, autoPromote: true },
      planner: { semantic: false },
      budgets: { catalogTokens: 900, recallTokens: 2000, perProviderTokens: 1800 },
      providerTimeoutMs: 5000,
    }
    const sessionA = fakeContext(options, projectId)
    const cleanupA = await RememPlugin.setup(sessionA.context as unknown as Context)
    expect(cleanupA).toBeTypeOf("function")
    const promptHooks = sessionA.hookCalls.filter(({ name }) => name === "prompt")
    const toolHook = sessionA.toolHooks.find(({ name }) => name === "execute.after")
    expect(toolHook).toBeDefined()
    async function user(messageID: string, text: string) {
      for (const hook of promptHooks)
        await hook.callback({ sessionID: "session-a", messageID, prompt: { text } })
    }
    async function tool(
      id: string,
      content: string,
      input: unknown = { command: "npm run test:auth" },
    ) {
      await toolHook?.callback({
        tool: "bash",
        sessionID: "session-a",
        messageID: "assistant-1",
        id,
        input,
        status: "completed",
        result: { content, metadata: { exit: content.includes("FAIL") ? 1 : 0 } },
      })
    }
    try {
      await user("problem", "Why does Phoenix migration authentication fail?")
      await user("hypothesis", "Could increasing the Phoenix connection pool timeout fix it?")
      await tool(
        "failed-attempt",
        "FAIL Phoenix authentication: increasing the pool timeout did not help.",
      )
      await tool(
        "omitted-detail",
        "Phoenix diagnostic detail: credential refresh requires AWS_PROFILE=phoenix-dev.",
      )
      await tool(
        "successful-verification",
        "PASS Phoenix authentication regression after forwarding the credential provider chain.",
      )
      await tool("secret", "safe result", { nested: { password: "supersecretvalue123" } })
      await toolHook?.callback({
        tool: "memory_search",
        sessionID: "session-a",
        messageID: "assistant-1",
        id: "recaptured-memory",
        status: "completed",
        input: {},
        result: { content: "INJECTED_MEMORY_SHOULD_NOT_REENTER" },
      })
      await user(
        "conclusions",
        "Phoenix authentication is fixed by forwarding the credential provider chain. Decision: we decided to preserve lazy credential refresh for Phoenix. Phoenix rollout is blocked on testing credential rotation.",
      )
      await tool(
        "successful-verification",
        "PASS Phoenix authentication regression after forwarding the credential provider chain.",
      )
    } finally {
      await cleanupA?.()
    }
    const evidence = await pool.query<{ evidence_id: string; safe_text: string; role: string }>(
      "SELECT evidence_id, safe_text, role FROM remem.session_events WHERE provider_id=$1 AND project_id=$2 AND evidence_id IS NOT NULL",
      [providerId, projectId],
    )
    expect(evidence.rows).toHaveLength(6)
    expect(evidence.rows.filter(({ role }) => role === "tool")).toHaveLength(3)
    expect(JSON.stringify(evidence.rows)).not.toContain("supersecret")
    expect(JSON.stringify(evidence.rows)).not.toContain("INJECTED_MEMORY")

    const sessionB = fakeContext(options, projectId)
    const cleanupB = await RememPlugin.setup(sessionB.context as unknown as Context)
    try {
      const dispatch = {
        sessionID: "session-b",
        system: [] as unknown[],
        messages: [
          { role: "user", content: [{ type: "text", text: "Let's continue the Phoenix work." }] },
        ] as unknown[],
      }
      const started = performance.now()
      await sessionB.hookCalls.find(({ name }) => name === "context")?.callback(dispatch)
      const latencyMs = performance.now() - started
      const injected = JSON.stringify(dispatch.messages.slice(1))
      expect(injected).toContain("forwarding the credential provider chain")
      expect(injected).toContain("preserve lazy credential refresh")
      expect(injected).toContain("testing credential rotation")
      expect(injected).toContain("Evidence:")
      expect(injected).not.toContain("pool timeout")
      expect(injected).not.toContain("AWS_PROFILE")
      expect(injected).not.toContain("supersecret")
      expect(injected).not.toContain("FAIL")
      expect(latencyMs).toBeLessThan(5000)
      const lineage = await pool.query<{
        source_metadata: { evidenceRefs?: { eventId: string }[] }
      }>(
        "SELECT s.metadata AS source_metadata FROM remem.memory_provenance mp JOIN remem.sources s ON s.id=mp.source_id JOIN remem.memories m ON m.id=mp.memory_id WHERE m.provider_id=$1",
        [providerId],
      )
      expect(lineage.rows).toHaveLength(3)
      for (const row of lineage.rows) {
        expect(row.source_metadata.evidenceRefs).toHaveLength(1)
        expect(evidence.rows.map(({ evidence_id }) => evidence_id)).toContain(
          row.source_metadata.evidenceRefs?.[0]?.eventId,
        )
      }
      const unrelated = {
        sessionID: "unrelated",
        system: [],
        messages: [
          { role: "user", content: [{ type: "text", text: "Summarize the weather forecast." }] },
        ],
      }
      await sessionB.hookCalls.find(({ name }) => name === "context")?.callback(unrelated)
      expect(JSON.stringify(unrelated.messages)).not.toContain("<memory-context>")
      expect(JSON.stringify(unrelated.messages)).not.toContain("Evidence:")
    } finally {
      await cleanupB?.()
    }

    const provider = new PostgresMemoryProvider({
      type: "postgres",
      id: providerId,
      connectionString: databaseUrl!,
      primary: true,
      maxConnections: 2,
      catalogLimit: 100,
    })
    try {
      const orchestrator = new RememOrchestrator(
        [provider],
        testConfig({
          semantic: { enabled: false, minimumSimilarity: 0.55, deterministicHighConfidence: 0.82 },
        }),
      )
      const context = { directory: "/repo", worktree: "/repo", projectId, sessionId: "session-b" }
      const historical = await orchestrator.search(
        "AWS_PROFILE",
        context,
        providerId,
        undefined,
        "episodic",
      )
      expect(historical.text).toContain("AWS_PROFILE=phoenix-dev")
      expect(historical.text).toContain("Historical tool evidence")
      expect(historical.text).toContain("host-observed")
      expect(historical.text).toContain("session-a")
      expect(historical.trace.recallTokens).toBeLessThanOrEqual(2000)
      const foreign = await orchestrator.search(
        "AWS_PROFILE",
        { ...context, projectId: "foreign" },
        providerId,
        undefined,
        "episodic",
      )
      expect(foreign.trace.selectedResults).toBe(0)
      const procedures = await pool.query<{ count: string }>(
        "SELECT count(*) FROM remem.memories WHERE provider_id=$1 AND type='procedure'",
        [providerId],
      )
      expect(procedures.rows[0]?.count).toBe("0")
    } finally {
      await provider.dispose()
    }
  })
})

integration("RememPlugin.setup hook wiring", () => {
  it("registers no 'prompt' hook (and still registers the 'context' hook) without a PostgreSQL provider", async () => {
    const { context, hookCalls } = fakeContext({ providers: [] })

    const cleanup = await RememPlugin.setup(context as unknown as Context)
    try {
      const promptHooks = hookCalls.filter((call) => call.name === "prompt")
      const contextHooks = hookCalls.filter((call) => call.name === "context")
      // Neither the capture hook (requires capture.enabled, off by default)
      // nor the hook-triggered re-embed trigger (requires a PostgreSQL
      // provider) should register here.
      expect(promptHooks).toHaveLength(0)
      expect(contextHooks).toHaveLength(1)
    } finally {
      await cleanup?.()
    }
  })

  it("registers exactly one 'prompt' hook for hook-triggered re-embedding once a PostgreSQL provider is configured", async () => {
    const { context, hookCalls } = fakeContext({
      providers: [
        {
          type: "postgres",
          id: "remem-local",
          connectionString: databaseUrl,
        },
      ],
    })

    const cleanup = await RememPlugin.setup(context as unknown as Context)
    try {
      const promptHooks = hookCalls.filter((call) => call.name === "prompt")
      const contextHooks = hookCalls.filter((call) => call.name === "context")
      // Exactly one -- the re-embed trigger. The capture hook still isn't
      // registered here because capture.enabled defaults to false and this
      // provider isn't marked `primary`. A regression that always registers
      // the re-embed hook regardless of provider configuration (or never
      // registers it even when one is configured) would show up here as an
      // unexpected count.
      expect(promptHooks).toHaveLength(1)
      expect(contextHooks).toHaveLength(1)
    } finally {
      await cleanup?.()
    }
  })

  it("registers both 'prompt' hooks (capture and re-embed) when capture is enabled against a primary PostgreSQL provider", async () => {
    const { context, hookCalls } = fakeContext({
      providers: [
        {
          type: "postgres",
          id: "remem-local",
          connectionString: databaseUrl,
          primary: true,
        },
      ],
      capture: { enabled: true },
    })

    const cleanup = await RememPlugin.setup(context as unknown as Context)
    try {
      const promptHooks = hookCalls.filter((call) => call.name === "prompt")
      const contextHooks = hookCalls.filter((call) => call.name === "context")
      expect(promptHooks).toHaveLength(2)
      expect(contextHooks).toHaveLength(1)
    } finally {
      await cleanup?.()
    }
  })
})

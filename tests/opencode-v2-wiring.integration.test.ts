import type { Context } from "@opencode-ai/plugin/promise/plugin"
import { describe, expect, it } from "vitest"
import { RememPlugin } from "../src/hosts/opencode/v2.js"

const databaseUrl = process.env.REMEM_TEST_DATABASE_URL
const integration = databaseUrl ? describe.sequential : describe.skip

/**
 * A minimal stand-in for `@opencode-ai/plugin`'s `Context`, implementing
 * only what `RememPlugin.setup()` actually touches: `location`, `options`,
 * `session.hook`, and `tool.transform`. Records every hook registration so
 * tests can assert on which hooks got wired up, without needing a real
 * OpenCode runtime.
 */
function fakeContext(pluginOptions: Record<string, unknown>) {
  const hookCalls: { name: string; callback: (input: unknown) => unknown }[] = []
  const context = {
    location: {
      directory: "/repo",
      project: { directory: "/repo", id: "wiring-test-project" },
    },
    options: pluginOptions,
    session: {
      hook: (name: string, callback: (input: unknown) => unknown) => {
        hookCalls.push({ name, callback })
        return Promise.resolve({ dispose: () => Promise.resolve() })
      },
    },
    tool: {
      transform: (_callback: unknown) => Promise.resolve({ dispose: () => Promise.resolve() }),
    },
  }
  return { context, hookCalls }
}

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

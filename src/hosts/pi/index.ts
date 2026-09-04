import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { createCaptureCoordinator, type CaptureCoordinator } from "../../capture.js"
import { parseConfig, type RememConfig } from "../../config.js"
import { RememOrchestrator } from "../../orchestrator.js"
import { PostgresMemoryProvider } from "../../providers/postgres.js"
import { createProviders } from "../../providers/factory.js"
import { shouldAttemptReembed } from "../../reembedding.js"
import { loadInstalledPluginOptions } from "../../storage/config-file.js"
import { createEmbeddingModel } from "../../storage/embedding-neural.js"
import type { MemoryProvider, RememLogger } from "../../types.js"
import {
  TRUSTED_REMEM_INSTRUCTION,
  disposeProviders,
  memoryContext,
  recallForDispatch,
  safeLoggerCall,
  type HostLocation,
} from "../opencode/shared.js"
import { deriveHostLocation } from "./location.js"

/**
 * Session-scoped state built on `session_start` and torn down on
 * `session_shutdown`. Pi's `pi.on(...)` registrations are not
 * session-scoped (they run for the life of the extension module), so every
 * handler below reads through this closure-held state and no-ops when it is
 * unset -- either before the first `session_start` or after
 * `session_shutdown` has already run for the current session.
 */
interface PiSessionState {
  location: HostLocation
  config: Pick<RememConfig, "compaction">
  orchestrator: RememOrchestrator
  providers: MemoryProvider[]
  capture?: CaptureCoordinator | undefined
  primaryPostgres?: PostgresMemoryProvider | undefined
  lastReembedAttempt?: number | undefined
}

function piLogger(): RememLogger {
  return {
    log(level, event, data) {
      if (level === "debug" || level === "info") return
      const detail = data ? ` ${JSON.stringify(data)}` : ""
      console.error(`[remem] ${event}${detail}`)
    },
  }
}

function contextFor(state: PiSessionState, ctx: Pick<ExtensionContext, "sessionManager">) {
  return memoryContext(state.location, ctx.sessionManager.getSessionId())
}

async function buildSessionState(
  ctx: ExtensionContext,
  logger: RememLogger,
): Promise<PiSessionState | undefined> {
  try {
    const parsed = parseConfig(await loadInstalledPluginOptions(undefined))
    for (const diagnostic of parsed.diagnostics) {
      safeLoggerCall(logger, diagnostic.level, "config.invalid", { message: diagnostic.message })
    }
    const location = await deriveHostLocation(ctx.cwd)
    const embeddingModel = await createEmbeddingModel(parsed.config.embedding)
    const created = createProviders(
      parsed.config.providers,
      { worktree: location.worktree },
      { embeddingModel },
    )
    for (const diagnostic of created.diagnostics) {
      safeLoggerCall(logger, "warn", "provider.initialization_failed", { message: diagnostic })
    }
    const primaryPostgres = created.providers.find(
      (provider): provider is PostgresMemoryProvider => provider instanceof PostgresMemoryProvider,
    )
    const orchestrator = new RememOrchestrator(created.providers, parsed.config, logger, {
      embeddingModel,
    })
    const capture = createCaptureCoordinator(created.providers, parsed.config, logger)
    return {
      location,
      config: parsed.config,
      orchestrator,
      providers: created.providers,
      capture,
      primaryPostgres,
    }
  } catch (error) {
    safeLoggerCall(logger, "error", "extension.initialization_failed", {
      error: error instanceof Error ? error.name : "unknown error",
    })
    return undefined
  }
}

async function teardownSessionState(state: PiSessionState | undefined): Promise<void> {
  if (!state) return
  await Promise.allSettled([state.capture?.dispose(), disposeProviders(state.providers)])
}

function registerTools(pi: ExtensionAPI, getState: () => PiSessionState | undefined): void {
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search configured long-term memory providers explicitly. Use when automatic recall was insufficient.",
    promptSnippet: "Explicitly search Remem's long-term memory providers",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Specific memory query" }),
      provider: Type.Optional(Type.String({ minLength: 1, description: "Optional provider ID" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const state = getState()
      if (!state) {
        return {
          content: [
            { type: "text", text: "Memory search failed. Pi can continue without memory." },
          ],
          details: {},
        }
      }
      try {
        const result = await state.orchestrator.search(
          params.query,
          contextFor(state, ctx),
          params.provider,
          signal,
        )
        return {
          content: [{ type: "text", text: result.text }],
          details: {
            providers: result.trace.providers.map((provider) => provider.providerId),
            selectedResults: result.trace.selectedResults,
            estimatedTokens: result.trace.recallTokens,
          },
        }
      } catch (error) {
        if (signal?.aborted) throw error
        return {
          content: [
            { type: "text", text: "Memory search failed. Pi can continue without memory." },
          ],
          details: {},
        }
      }
    },
  })

  pi.registerTool({
    name: "memory_status",
    label: "Memory Status",
    description: "Show memory health and bounded diagnostics without memory bodies.",
    promptSnippet: "Show Remem's memory health and diagnostics",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const state = getState()
      if (!state) {
        return {
          content: [{ type: "text", text: "Memory status unavailable: extension not initialized" }],
          details: {},
        }
      }
      try {
        const status = await state.orchestrator.status(contextFor(state, ctx))
        return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }], details: {} }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Memory status unavailable: ${error instanceof Error ? error.name : "unknown error"}`,
            },
          ],
          details: {},
        }
      }
    },
  })

  pi.registerTool({
    name: "memory_explain",
    label: "Memory Explain",
    description: "Explain the latest memory retrieval decision without exposing memory bodies.",
    promptSnippet: "Explain Remem's latest memory retrieval decision",
    parameters: Type.Object({}),
    execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const state = getState()
      if (!state) {
        return Promise.resolve({
          content: [{ type: "text", text: JSON.stringify({ status: "no-trace" }, null, 2) }],
          details: {},
        })
      }
      const trace = state.orchestrator.explain(ctx.sessionManager.getSessionId())
      return Promise.resolve({
        content: [{ type: "text", text: JSON.stringify(trace, null, 2) }],
        details: {},
      })
    },
  })
}

/**
 * Pi extension entry point (`export default function(pi: ExtensionAPI)`).
 * Mirrors the memory-injection, tool, capture, and (optional)
 * compaction-context behavior of the OpenCode v1/v2 adapters
 * (`src/hosts/opencode/v1.ts`, `src/hosts/opencode/v2.ts`), mapped onto
 * Pi's `before_agent_start` / `pi.registerTool` / `input` /
 * `session_before_compact` events instead of OpenCode's plugin hooks.
 */
export default function remem(pi: ExtensionAPI): void {
  const logger = piLogger()
  let state: PiSessionState | undefined

  pi.on("session_start", async (_event, ctx) => {
    state = await buildSessionState(ctx, logger)
  })

  pi.on("session_shutdown", async () => {
    const disposing = state
    state = undefined
    await teardownSessionState(disposing)
  })

  pi.on("before_agent_start", async (event, ctx) => {
    if (!state) return
    try {
      const injection = await recallForDispatch(
        state.orchestrator,
        event.prompt,
        contextFor(state, ctx),
      )
      if (!injection.text) return
      return {
        message: {
          customType: "remem-memory",
          content: [
            { type: "text", text: TRUSTED_REMEM_INSTRUCTION },
            {
              type: "text",
              // Untrusted-memory-data attribution is carried in the text itself
              // (Pi's TextContent has no metadata field, unlike OpenCode's
              // message content parts) so the trust boundary survives even if
              // this message is later rendered or logged without its
              // customType/details context.
              text: `<memory-context source="remem" trust="untrusted-memory-data">\n${injection.text}\n</memory-context>`,
            },
          ],
          display: false,
        },
      }
    } catch (error) {
      safeLoggerCall(logger, "warn", "prompt.injection_failed", {
        error: error instanceof Error ? error.name : "unknown error",
      })
      return undefined
    }
  })

  pi.on("input", (event, ctx) => {
    if (!state) return
    const sessionId = ctx.sessionManager.getSessionId()
    try {
      state.capture?.enqueue({
        host: "pi",
        context: contextFor(state, ctx),
        sessionId,
        text: event.text,
      })
    } catch (error) {
      safeLoggerCall(logger, "warn", "capture.enqueue_failed", {
        error: error instanceof Error ? error.name : "unknown error",
      })
    }
    const primaryPostgres = state.primaryPostgres
    if (primaryPostgres && shouldAttemptReembed(state.lastReembedAttempt)) {
      state.lastReembedAttempt = Date.now()
      // Fire-and-forget: must never delay or fail input handling.
      void primaryPostgres.reembedStale().catch((error) => {
        safeLoggerCall(logger, "warn", "reembed.attempt_failed", {
          error: error instanceof Error ? error.name : "unknown error",
        })
      })
    }
  })

  pi.on("session_before_compact", async (event, ctx) => {
    if (!state || !state.config.compaction) return
    try {
      const summary = await state.orchestrator.compactionContext(contextFor(state, ctx))
      return {
        compaction: {
          summary,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      }
    } catch (error) {
      safeLoggerCall(logger, "warn", "compaction.context_failed", {
        error: error instanceof Error ? error.name : "unknown error",
      })
      return undefined
    }
  })

  registerTools(pi, () => state)
}

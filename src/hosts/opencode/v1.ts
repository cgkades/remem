import { tool, type Hooks, type Plugin, type PluginInput } from "opencode-plugin-v1"
import { createCaptureCoordinator, type CaptureCoordinator } from "../../capture.js"
import { parseConfig, type RememConfig } from "../../config.js"
import { RememOrchestrator } from "../../orchestrator.js"
import { createProviders } from "../../providers/factory.js"
import { loadInstalledPluginOptions } from "../../storage/config-file.js"
import { createEmbeddingModel } from "../../storage/embedding-neural.js"
import type { MemoryContext, RememLogger } from "../../types.js"
import { formatMemoryExplain, MEMORY_TOOL_DESCRIPTIONS } from "./memory-ux.js"
import {
  disposeProviders,
  memoryContext,
  recallForDispatch,
  safeLoggerCall,
  textFromParts,
  type HostLocation,
} from "./shared.js"

function locationFor(
  input: Pick<PluginInput, "directory" | "worktree" | "project">,
  directory = input.directory,
  worktree = input.worktree,
): HostLocation {
  return { directory, worktree, projectId: input.project.id }
}

export interface V1PromptMessageOutput {
  message: { system?: string }
  parts: readonly unknown[]
}

export async function injectV1PromptMemory(
  orchestrator: RememOrchestrator,
  output: V1PromptMessageOutput,
  context: MemoryContext,
  turnId?: string,
): Promise<void> {
  const injection = await recallForDispatch(
    orchestrator,
    textFromParts(output.parts),
    context,
    turnId,
  )
  output.message.system = [output.message.system, injection.text].filter(Boolean).join("\n\n")
}

export function createOpenCodeV1Hooks(
  input: Pick<PluginInput, "directory" | "worktree" | "project">,
  orchestrator: RememOrchestrator,
  config: Pick<RememConfig, "compaction">,
  logger: RememLogger,
  capture?: CaptureCoordinator,
): Hooks {
  // TASK-062: the v1 plugin API's `chat.message` hook carries no turn-count
  // signal analogous to v2's `currentTurnId` (derived from the full
  // message array, which this hook shape does not expose) -- without this,
  // `turnId` would always be `undefined` here and the session-start
  // hard-limit warning (gated on `turnId === "1"` in
  // `RememOrchestrator.processPrompt`) would silently never fire for this
  // host. Tracked per `sessionID` instead: a small in-memory counter,
  // scoped to this plugin instance's lifetime, incremented on every
  // dispatch for that session -- "1" on the first dispatch, matching v2's
  // semantics closely enough for this purpose without needing v1's hook
  // shape to change.
  // Bounded to avoid unbounded growth over a long-lived plugin instance
  // that sees many distinct sessions: only the first-dispatch detection
  // (count === 1, gating the session-start warning) matters, so evicting
  // the oldest tracked session merely risks re-firing the warning for a
  // very old session on its next dispatch -- itself throttled downstream
  // by `checkHardLimitWarning` -- never a correctness problem. Map
  // iteration order is insertion order, so the first key is the oldest.
  const MAX_TRACKED_SESSIONS = 1024
  const dispatchCountBySession = new Map<string, number>()
  const recordDispatch = (sessionID: string): number => {
    const dispatchCount = (dispatchCountBySession.get(sessionID) ?? 0) + 1
    dispatchCountBySession.set(sessionID, dispatchCount)
    while (dispatchCountBySession.size > MAX_TRACKED_SESSIONS) {
      const oldest = dispatchCountBySession.keys().next().value
      if (oldest === undefined) break
      dispatchCountBySession.delete(oldest)
    }
    return dispatchCount
  }
  const hooks: Hooks = {
    "chat.message": async ({ sessionID }, output) => {
      try {
        capture?.enqueue({
          host: "opencode-v1",
          context: memoryContext(locationFor(input), sessionID),
          sessionId: sessionID,
          text: textFromParts(output.parts),
        })
      } catch (error) {
        safeLoggerCall(logger, "warn", "capture.enqueue_failed", {
          error: error instanceof Error ? error.name : "unknown error",
        })
      }
      try {
        const dispatchCount = recordDispatch(sessionID)
        await injectV1PromptMemory(
          orchestrator,
          output,
          memoryContext(locationFor(input), sessionID),
          String(dispatchCount),
        )
      } catch (error) {
        safeLoggerCall(logger, "warn", "prompt.injection_failed", {
          error: error instanceof Error ? error.name : "unknown error",
        })
      }
    },
    tool: {
      memory_search: tool({
        description: MEMORY_TOOL_DESCRIPTIONS.search,
        args: {
          query: tool.schema.string().min(1).describe("Specific memory query"),
          provider: tool.schema.string().min(1).optional().describe("Optional provider ID"),
        },
        async execute(args, toolContext) {
          try {
            const context = memoryContext(
              locationFor(input, toolContext.directory, toolContext.worktree),
              toolContext.sessionID,
            )
            const result = await orchestrator.search(
              args.query,
              context,
              args.provider,
              toolContext.abort,
            )
            return {
              title: "Memory search",
              output: result.text,
              metadata: {
                providers: result.trace.providers.map((provider) => provider.providerId),
                selectedResults: result.trace.selectedResults,
                estimatedTokens: result.trace.recallTokens,
              },
            }
          } catch (error) {
            if (toolContext.abort.aborted) throw error
            return "Memory search failed. OpenCode can continue without memory."
          }
        },
      }),
      memory_status: tool({
        description: MEMORY_TOOL_DESCRIPTIONS.status,
        args: {},
        async execute(_args, toolContext) {
          try {
            return {
              title: "Memory status",
              output: JSON.stringify(
                await orchestrator.status(
                  memoryContext(
                    locationFor(input, toolContext.directory, toolContext.worktree),
                    toolContext.sessionID,
                  ),
                ),
                null,
                2,
              ),
            }
          } catch (error) {
            return `Memory status unavailable: ${error instanceof Error ? error.name : "unknown error"}`
          }
        },
      }),
      memory_explain: tool({
        description: MEMORY_TOOL_DESCRIPTIONS.explain,
        args: {},
        execute(_args, toolContext) {
          return Promise.resolve({
            title: "Memory retrieval explanation",
            output: JSON.stringify(
              formatMemoryExplain(
                orchestrator.explain(toolContext.sessionID),
                capture?.explain(toolContext.sessionID),
              ),
              null,
              2,
            ),
          })
        },
      }),
    },
  }

  if (config.compaction) {
    hooks["experimental.session.compacting"] = async ({ sessionID }, output) => {
      try {
        output.context.push(
          await orchestrator.compactionContext(memoryContext(locationFor(input), sessionID)),
        )
      } catch (error) {
        safeLoggerCall(logger, "warn", "compaction.context_failed", {
          error: error instanceof Error ? error.name : "unknown error",
        })
      }
    }
  }
  return hooks
}

export const RememV1Plugin = (async (input, options) => {
  const logger: RememLogger = {
    async log(level, event, data) {
      await input.client.app.log({
        body: {
          service: "remem",
          level,
          message: event,
          ...(data ? { extra: data } : {}),
        },
      })
    },
  }

  try {
    const parsed = parseConfig(await loadInstalledPluginOptions(options))
    for (const diagnostic of parsed.diagnostics) {
      safeLoggerCall(logger, diagnostic.level, "config.invalid", { message: diagnostic.message })
    }
    const embeddingModel = await createEmbeddingModel(parsed.config.embedding)
    const created = createProviders(
      parsed.config.providers,
      { worktree: input.worktree },
      { embeddingModel },
    )
    for (const diagnostic of created.diagnostics) {
      safeLoggerCall(logger, "warn", "provider.initialization_failed", { message: diagnostic })
    }
    const orchestrator = new RememOrchestrator(created.providers, parsed.config, logger, {
      embeddingModel,
    })
    const capture = createCaptureCoordinator(created.providers, parsed.config, logger)
    const hooks = createOpenCodeV1Hooks(input, orchestrator, parsed.config, logger, capture)
    hooks.dispose = async () => {
      await capture?.dispose()
      await disposeProviders(created.providers)
    }
    return hooks
  } catch (error) {
    safeLoggerCall(logger, "error", "plugin.initialization_failed", {
      error: error instanceof Error ? error.name : "unknown error",
    })
    return {}
  }
}) satisfies Plugin

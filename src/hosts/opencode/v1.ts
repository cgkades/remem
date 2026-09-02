import { tool, type Hooks, type Plugin, type PluginInput } from "opencode-plugin-v1"
import { parseConfig, type RememConfig } from "../../config.js"
import { RememOrchestrator } from "../../orchestrator.js"
import { createProviders } from "../../providers/factory.js"
import type { MemoryContext, RememLogger } from "../../types.js"
import {
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
): Promise<void> {
  const injection = await recallForDispatch(orchestrator, textFromParts(output.parts), context)
  output.message.system = [output.message.system, injection.text].filter(Boolean).join("\n\n")
}

export function createOpenCodeV1Hooks(
  input: Pick<PluginInput, "directory" | "worktree" | "project">,
  orchestrator: RememOrchestrator,
  config: Pick<RememConfig, "compaction">,
  logger: RememLogger,
): Hooks {
  const hooks: Hooks = {
    "chat.message": async ({ sessionID }, output) => {
      try {
        await injectV1PromptMemory(
          orchestrator,
          output,
          memoryContext(locationFor(input), sessionID),
        )
      } catch (error) {
        safeLoggerCall(logger, "warn", "prompt.injection_failed", {
          error: error instanceof Error ? error.name : "unknown error",
        })
      }
    },
    tool: {
      memory_search: tool({
        description:
          "Search configured long-term memory providers explicitly. Use when automatic recall was insufficient.",
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
        description: "Show memory health and bounded diagnostics without memory bodies.",
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
        description: "Explain the latest memory retrieval decision without exposing memory bodies.",
        args: {},
        execute(_args, toolContext) {
          return Promise.resolve({
            title: "Memory retrieval explanation",
            output: JSON.stringify(orchestrator.explain(toolContext.sessionID), null, 2),
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

export const RememV1Plugin = ((input, options) => {
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
    const parsed = parseConfig(options)
    for (const diagnostic of parsed.diagnostics) {
      safeLoggerCall(logger, diagnostic.level, "config.invalid", { message: diagnostic.message })
    }
    const created = createProviders(parsed.config.providers, { worktree: input.worktree })
    for (const diagnostic of created.diagnostics) {
      safeLoggerCall(logger, "warn", "provider.initialization_failed", { message: diagnostic })
    }
    const orchestrator = new RememOrchestrator(created.providers, parsed.config, logger)
    return Promise.resolve(createOpenCodeV1Hooks(input, orchestrator, parsed.config, logger))
  } catch (error) {
    safeLoggerCall(logger, "error", "plugin.initialization_failed", {
      error: error instanceof Error ? error.name : "unknown error",
    })
    return Promise.resolve({})
  }
}) satisfies Plugin

import os from "node:os"
import path from "node:path"
import { tool, type Hooks, type Plugin, type PluginInput } from "@opencode-ai/plugin"
import { parseConfig, type RememConfig } from "../config.js"
import { RememOrchestrator } from "../orchestrator.js"
import { MarkdownMemoryProvider } from "../providers/markdown.js"
import type { MemoryContext, RememLogger } from "../types.js"

function resolveMemoryPath(value: string, worktree: string): string {
  if (value === "~") return os.homedir()
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2))
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(worktree, value)
}

function contextFor(
  input: Pick<PluginInput, "directory" | "worktree" | "project">,
  sessionId?: string,
  directory = input.directory,
  worktree = input.worktree,
): MemoryContext {
  return {
    directory,
    worktree,
    projectId: input.project.id,
    ...(sessionId ? { sessionId } : {}),
  }
}

function promptText(parts: readonly unknown[]): string {
  return parts
    .filter(
      (part): part is { type: "text"; text: string; synthetic?: boolean } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string" &&
        (!("synthetic" in part) || part.synthetic !== true),
    )
    .map((part) => part.text)
    .join("\n")
    .trim()
}

export interface PromptMessageOutput {
  message: { system?: string }
  parts: readonly unknown[]
}

export async function injectPromptMemory(
  orchestrator: RememOrchestrator,
  output: PromptMessageOutput,
  context: MemoryContext,
): Promise<void> {
  const injection = await orchestrator.processPrompt(promptText(output.parts), context)
  output.message.system = [output.message.system, injection.text].filter(Boolean).join("\n\n")
}

function safeLoggerCall(
  logger: RememLogger,
  level: "debug" | "info" | "warn" | "error",
  event: string,
  data?: Record<string, unknown>,
): void {
  try {
    void Promise.resolve(logger.log(level, event, data)).catch(() => undefined)
  } catch {
    // OpenCode logging cannot be allowed to break plugin startup or a prompt.
  }
}

export function createOpenCodeHooks(
  input: Pick<PluginInput, "directory" | "worktree" | "project">,
  orchestrator: RememOrchestrator,
  config: Pick<RememConfig, "compaction">,
  logger: RememLogger,
): Hooks {
  const hooks: Hooks = {
    "chat.message": async ({ sessionID }, output) => {
      try {
        await injectPromptMemory(orchestrator, output, contextFor(input, sessionID))
      } catch (error) {
        safeLoggerCall(logger, "warn", "prompt.injection_failed", {
          error: error instanceof Error ? error.name : "unknown error",
        })
      }
    },
    tool: {
      memory_search: tool({
        description:
          "Search configured long-term memory providers explicitly. Use when the compact catalog suggests more detail exists or automatic recall was insufficient.",
        args: {
          query: tool.schema.string().min(1).describe("Specific memory query"),
          provider: tool.schema
            .string()
            .min(1)
            .optional()
            .describe("Optional provider ID; omit to search all configured providers"),
        },
        async execute(args, toolContext) {
          try {
            const result = await orchestrator.search(
              args.query,
              contextFor(input, toolContext.sessionID, toolContext.directory, toolContext.worktree),
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
            safeLoggerCall(logger, "warn", "tool.search_failed", {
              error: error instanceof Error ? error.name : "unknown error",
            })
            return "Memory search failed. OpenCode can continue without memory; inspect memory_status for diagnostics."
          }
        },
      }),
      memory_status: tool({
        description:
          "Show configured memory providers, catalog size, token budgets, and the last retrieval decision without exposing full memory contents.",
        args: {},
        async execute(_args, toolContext) {
          try {
            const status = await orchestrator.status(
              contextFor(input, toolContext.sessionID, toolContext.directory, toolContext.worktree),
            )
            return {
              title: "Memory status",
              output: JSON.stringify(status, null, 2),
            }
          } catch (error) {
            return `Memory status unavailable: ${error instanceof Error ? error.name : "unknown error"}`
          }
        },
      }),
    },
  }

  if (config.compaction) {
    hooks["experimental.session.compacting"] = async ({ sessionID }, output) => {
      try {
        output.context.push(await orchestrator.compactionContext(contextFor(input, sessionID)))
      } catch (error) {
        safeLoggerCall(logger, "warn", "compaction.context_failed", {
          error: error instanceof Error ? error.name : "unknown error",
        })
      }
    }
  }
  return hooks
}

export const RememPlugin = ((input, options) => {
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
      safeLoggerCall(logger, diagnostic.level, "config.invalid", {
        message: diagnostic.message,
      })
    }
    const providers = parsed.config.providers.map(
      (provider) =>
        new MarkdownMemoryProvider(
          provider,
          provider.paths.map((memoryPath) => resolveMemoryPath(memoryPath, input.worktree)),
        ),
    )
    const orchestrator = new RememOrchestrator(providers, parsed.config, logger)
    safeLoggerCall(logger, "info", "plugin.initialized", {
      providers: providers.map((provider) => provider.id),
      experimentalCompaction: parsed.config.compaction,
    })
    return Promise.resolve(createOpenCodeHooks(input, orchestrator, parsed.config, logger))
  } catch (error) {
    safeLoggerCall(logger, "error", "plugin.initialization_failed", {
      error: error instanceof Error ? error.name : "unknown error",
    })
    return Promise.resolve({})
  }
}) satisfies Plugin

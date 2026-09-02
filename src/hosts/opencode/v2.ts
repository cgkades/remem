import { Plugin } from "@opencode-ai/plugin"
import type { Context } from "@opencode-ai/plugin/promise/plugin"
import { parseConfig } from "../../config.js"
import { RememOrchestrator } from "../../orchestrator.js"
import { createProviders } from "../../providers/factory.js"
import { loadInstalledPluginOptions } from "../../storage/config-file.js"
import type { MemoryContext, MemoryProvider, RememLogger } from "../../types.js"
import {
  TRUSTED_REMEM_INSTRUCTION,
  disposeProviders,
  latestUserPrompt,
  memoryContext,
  recallForDispatch,
  safeLoggerCall,
  type HostLocation,
} from "./shared.js"

function hostLocation(context: Context): HostLocation {
  return {
    directory: context.location.directory,
    worktree: context.location.project.directory,
    projectId: context.location.project.id,
  }
}

export async function injectV2DispatchMemory(
  orchestrator: RememOrchestrator,
  event: { readonly sessionID: string; system: unknown[]; messages: unknown[] },
  context: MemoryContext,
): Promise<void> {
  const injection = await recallForDispatch(orchestrator, latestUserPrompt(event.messages), context)
  if (!injection.text) return

  event.system.push({ type: "text", text: TRUSTED_REMEM_INSTRUCTION })
  event.messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: injection.text,
        metadata: { source: "remem", trust: "untrusted-memory-data" },
      },
    ],
    metadata: { source: "remem", ephemeral: true },
  })
}

function consoleLogger(): RememLogger {
  return {
    log(level, event, data) {
      if (level === "debug" || level === "info") return
      const detail = data ? ` ${JSON.stringify(data)}` : ""
      console.error(`[remem] ${event}${detail}`)
    },
  }
}

async function registerTools(
  context: Context,
  orchestrator: RememOrchestrator,
  location: HostLocation,
) {
  return context.tool.transform((draft) => {
    draft.add({
      name: "memory_search",
      description: "Search configured long-term memory providers explicitly.",
      input: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          provider: { type: "string", minLength: 1 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(input, toolContext) {
        const args = input as { query: string; provider?: string }
        try {
          const result = await orchestrator.search(
            args.query,
            memoryContext(location, toolContext.sessionID),
            args.provider,
          )
          return {
            content: result.text,
            metadata: {
              providers: result.trace.providers.map((provider) => provider.providerId),
              selectedResults: result.trace.selectedResults,
              estimatedTokens: result.trace.recallTokens,
            },
          }
        } catch {
          return { content: "Memory search failed. OpenCode can continue without memory." }
        }
      },
    })
    draft.add({
      name: "memory_status",
      description: "Show memory health and bounded diagnostics without memory bodies.",
      input: { type: "object", properties: {}, additionalProperties: false },
      async execute(_input, toolContext) {
        try {
          return {
            content: JSON.stringify(
              await orchestrator.status(memoryContext(location, toolContext.sessionID)),
              null,
              2,
            ),
          }
        } catch (error) {
          return {
            content: `Memory status unavailable: ${error instanceof Error ? error.name : "unknown error"}`,
          }
        }
      },
    })
    draft.add({
      name: "memory_explain",
      description: "Explain the latest retrieval decision without exposing memory bodies.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute(_input, toolContext) {
        return Promise.resolve({
          content: JSON.stringify(orchestrator.explain(toolContext.sessionID), null, 2),
        })
      },
    })
  })
}

export const RememPlugin = Plugin.define({
  id: "opencode-remem",
  async setup(context) {
    const logger = consoleLogger()
    let providers: MemoryProvider[] = []
    let contextRegistration: { dispose(): Promise<void> } | undefined
    try {
      const parsed = parseConfig(await loadInstalledPluginOptions(context.options))
      for (const diagnostic of parsed.diagnostics) {
        safeLoggerCall(logger, diagnostic.level, "config.invalid", { message: diagnostic.message })
      }
      const location = hostLocation(context)
      const created = createProviders(parsed.config.providers, { worktree: location.worktree })
      providers = created.providers
      for (const diagnostic of created.diagnostics) {
        safeLoggerCall(logger, "warn", "provider.initialization_failed", { message: diagnostic })
      }
      const orchestrator = new RememOrchestrator(created.providers, parsed.config, logger)
      contextRegistration = await context.session.hook("context", async (event) => {
        try {
          await injectV2DispatchMemory(
            orchestrator,
            event,
            memoryContext(location, event.sessionID),
          )
        } catch (error) {
          safeLoggerCall(logger, "warn", "context.injection_failed", {
            error: error instanceof Error ? error.name : "unknown error",
          })
        }
      })
      const toolRegistration = await registerTools(context, orchestrator, location)
      return async () => {
        await Promise.allSettled([
          contextRegistration?.dispose(),
          toolRegistration.dispose(),
          disposeProviders(providers),
        ])
      }
    } catch (error) {
      await Promise.allSettled([contextRegistration?.dispose(), disposeProviders(providers)])
      safeLoggerCall(logger, "error", "plugin.initialization_failed", {
        error: error instanceof Error ? error.name : "unknown error",
      })
      return undefined
    }
  },
})

export default RememPlugin

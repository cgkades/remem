import os from "node:os"
import path from "node:path"
import type { MemoryProviderConfig } from "../config.js"
import type { EmbeddingModel, MemoryProvider } from "../types.js"
import { MarkdownMemoryProvider } from "./markdown.js"
import { PostgresMemoryProvider } from "./postgres.js"

export interface ProviderFactoryLocation {
  worktree: string
}

export interface ProviderFactoryOptions {
  embeddingModel?: EmbeddingModel
}

export interface ProviderFactoryResult {
  providers: MemoryProvider[]
  diagnostics: string[]
}

export function resolveProviderPath(value: string, worktree: string): string {
  if (value === "~") return os.homedir()
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2))
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(worktree, value)
}

export function createProviders(
  configs: MemoryProviderConfig[],
  location: ProviderFactoryLocation,
  options: ProviderFactoryOptions = {},
): ProviderFactoryResult {
  const providers: MemoryProvider[] = []
  const diagnostics: string[] = []

  for (const config of configs) {
    try {
      if (config.type === "postgres") {
        providers.push(
          new PostgresMemoryProvider(
            config,
            options.embeddingModel ? { embeddingModel: options.embeddingModel } : {},
          ),
        )
      } else {
        providers.push(
          new MarkdownMemoryProvider(
            config,
            config.paths.map((memoryPath) => resolveProviderPath(memoryPath, location.worktree)),
          ),
        )
      }
    } catch (error) {
      diagnostics.push(
        `provider ${config.id} initialization failed: ${error instanceof Error ? error.name : "unknown error"}`,
      )
    }
  }

  return { providers, diagnostics }
}

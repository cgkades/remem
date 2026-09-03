import { randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { CaptureConfig, MemoryProviderConfig, PlannerConfig, TokenBudgets } from "../config.js"
import { rememPaths, type RememPaths } from "./paths.js"

export interface ManagedStorageConfig {
  mode: "managed"
  connectionString: string
  composeFile: string
  environmentFile: string
  projectName: string
  database: string
  user: string
  port: number
}

export interface ExternalStorageConfig {
  mode: "external"
  connectionString: string
}

export type EmbeddingSetting =
  | { provider: "local-hash"; model: "remem-local-hash-v1"; dimensions: 384 }
  | { provider: "neural"; model: "bge-small-en-v1.5"; dimensions: 384 }

export interface RememAppConfig {
  version: 1
  storage: ManagedStorageConfig | ExternalStorageConfig
  providers: MemoryProviderConfig[]
  budgets?: Partial<TokenBudgets>
  planner?: Partial<PlannerConfig> & {
    semantic?: boolean
    semanticMinimumSimilarity?: number
    deterministicHighConfidence?: number
  }
  providerTimeoutMs?: number
  maxResults?: number
  debug?: boolean
  compaction?: boolean
  capture?: Partial<CaptureConfig>
  embedding: EmbeddingSetting
  opencode?: {
    configured: boolean
    configPath?: string
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function validateAppConfig(value: unknown): asserts value is RememAppConfig {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.storage)) {
    throw new Error("invalid Remem configuration")
  }
  if (value.storage.mode !== "managed" && value.storage.mode !== "external") {
    throw new Error("storage.mode must be managed or external")
  }
  if (typeof value.storage.connectionString !== "string" || !value.storage.connectionString) {
    throw new Error("storage connection is missing")
  }
  if (!Array.isArray(value.providers) || !isRecord(value.embedding)) {
    throw new Error("provider or embedding configuration is missing")
  }
  if (value.embedding.provider !== "local-hash" && value.embedding.provider !== "neural") {
    throw new Error("embedding.provider must be 'local-hash' or 'neural'")
  }
}

export async function readAppConfig(paths: RememPaths = rememPaths()): Promise<RememAppConfig> {
  const value: unknown = JSON.parse(await readFile(paths.configFile, "utf8"))
  validateAppConfig(value)
  const override = process.env.REMEM_DATABASE_URL
  if (!override || value.storage.mode === "managed") return value
  return {
    ...value,
    storage: { ...value.storage, connectionString: override },
    providers: value.providers.map((provider) =>
      provider.type === "postgres" ? { ...provider, connectionString: override } : provider,
    ),
  }
}

export async function writeAppConfig(
  config: RememAppConfig,
  paths: RememPaths = rememPaths(),
): Promise<void> {
  validateAppConfig(config)
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 })
  const temporary = path.join(
    paths.configDir,
    `.config-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  )
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" })
  await rename(temporary, paths.configFile)
  await chmod(paths.configFile, 0o600)
}

export async function loadInstalledPluginOptions(options: unknown): Promise<unknown> {
  if (isRecord(options) && Object.hasOwn(options, "providers")) return options
  try {
    const installed = await readAppConfig()
    if (!isRecord(options)) return installed
    return {
      ...installed,
      ...options,
      providers: Object.hasOwn(options, "providers") ? options.providers : installed.providers,
      capture:
        isRecord(installed.capture) && isRecord(options.capture)
          ? { ...installed.capture, ...options.capture }
          : (options.capture ?? installed.capture),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return options
  }
}

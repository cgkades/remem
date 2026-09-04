import { randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { CaptureConfig, MemoryProviderConfig, PlannerConfig, TokenBudgets } from "../config.js"
import {
  EMBEDDING_DIMENSIONS,
  LOCAL_HASH_MODEL_ID,
  NEURAL_MODEL_ID,
} from "./embedding-model-ids.js"
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

/**
 * The persisted app-config embedding shape (`{provider, model, dimensions}`)
 * `remem init` writes to disk, distinct from `EmbeddingPluginOptions`
 * (`../config.js`), the runtime plugin-options shape (`{backend,
 * modelPath}`). See that type's doc comment for why these are deliberately
 * named differently rather than sharing a name.
 */
export type EmbeddingAppConfig =
  | {
      provider: "local-hash"
      model: typeof LOCAL_HASH_MODEL_ID
      dimensions: typeof EMBEDDING_DIMENSIONS
    }
  | { provider: "neural"; model: typeof NEURAL_MODEL_ID; dimensions: typeof EMBEDDING_DIMENSIONS }

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
  embedding: EmbeddingAppConfig
  opencode?: {
    configured: boolean
    configPath?: string
  }
  pi?: {
    configured: boolean
    settingsPath?: string
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
  // Validate the full literal pair, not just `provider`: downstream code
  // (warnAboutNeuralDownload, doctor's "embedding settings persistence"
  // check) trusts `model`/`dimensions` unconditionally after this
  // assertion, so a hand-edited config with a mismatched combination (e.g.
  // provider "local-hash" with model "bge-small-en-v1.5") would otherwise
  // pass validation and mislead those checks.
  if (value.embedding.provider === "local-hash") {
    if (
      value.embedding.model !== LOCAL_HASH_MODEL_ID ||
      value.embedding.dimensions !== EMBEDDING_DIMENSIONS
    ) {
      throw new Error(
        `embedding.model/dimensions do not match provider 'local-hash' ` +
          `(expected model '${LOCAL_HASH_MODEL_ID}' and dimensions ${EMBEDDING_DIMENSIONS})`,
      )
    }
  } else if (
    value.embedding.model !== NEURAL_MODEL_ID ||
    value.embedding.dimensions !== EMBEDDING_DIMENSIONS
  ) {
    throw new Error(
      `embedding.model/dimensions do not match provider 'neural' ` +
        `(expected model '${NEURAL_MODEL_ID}' and dimensions ${EMBEDDING_DIMENSIONS})`,
    )
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

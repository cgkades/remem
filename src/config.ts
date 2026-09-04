import path from "node:path"
import type { MemoryScopeKind } from "./types.js"

export interface TokenBudgets {
  catalogTokens: number
  recallTokens: number
  perProviderTokens: number
}

export interface PlannerConfig {
  minimumConfidence: number
  maxTopics: number
}

export interface SemanticPlannerConfig {
  enabled: boolean
  minimumSimilarity: number
  deterministicHighConfidence: number
}

export interface CaptureConfig {
  enabled: boolean
  queueLimit: number
  maxInputCharacters: number
  maxCandidateCharacters: number
  timeoutMs: number
}

/**
 * The runtime plugin-options embedding shape (`{backend, modelPath}`),
 * distinct from `EmbeddingAppConfig` (`storage/config-file.ts`), the
 * persisted app-config shape (`{provider, model, dimensions}`) `remem init`
 * writes to disk. Confusing the two was the direct root cause of a real
 * bug (the OpenCode plugin only recognized this shape's `backend` field,
 * silently ignoring `remem init`'s neural default written in the other
 * shape) -- kept intentionally distinctly named so that mistake is harder
 * to make again.
 */
export interface EmbeddingPluginOptions {
  backend: "hash" | "neural"
  modelPath?: string
}

export interface MarkdownProviderConfig {
  type: "markdown"
  id: string
  paths: string[]
  exclude: string[]
  scope: MemoryScopeKind
  maxFileBytes: number
  maxFiles: number
}

export interface PostgresProviderConfig {
  type: "postgres"
  id: string
  connectionString: string
  primary: boolean
  maxConnections: number
  catalogLimit: number
}

export type MemoryProviderConfig = MarkdownProviderConfig | PostgresProviderConfig

export interface OrchestratorConfig {
  budgets: TokenBudgets
  planner: PlannerConfig
  semantic?: SemanticPlannerConfig
  providerTimeoutMs: number
  maxResults: number
  debug: boolean
}

export interface RememConfig extends OrchestratorConfig {
  providers: MemoryProviderConfig[]
  compaction: boolean
  capture: CaptureConfig
  embedding: EmbeddingPluginOptions
  /** Minimum time between hook-triggered opportunistic re-embed attempts (see `shouldAttemptReembed`). */
  reembedCooldownMs: number
}

export interface ConfigDiagnostic {
  level: "warn" | "error"
  message: string
}

export interface ParsedConfig {
  config: RememConfig
  diagnostics: ConfigDiagnostic[]
}

const DEFAULT_EXCLUSIONS = ["**/.git/**", "**/.trash/**", "**/node_modules/**"]
const SCOPE_KINDS = new Set<MemoryScopeKind>(["global", "workspace", "project", "session"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

function parseProvider(
  value: unknown,
  index: number,
  diagnostics: ConfigDiagnostic[],
): MemoryProviderConfig | undefined {
  if (!isRecord(value)) {
    diagnostics.push({
      level: "warn",
      message: `providers[${index}] is not an object and was disabled`,
    })
    return undefined
  }
  if (value.type !== "markdown" && value.type !== "postgres") {
    diagnostics.push({
      level: "warn",
      message: `providers[${index}] has unsupported type and was disabled`,
    })
    return undefined
  }
  if (typeof value.id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/iu.test(value.id)) {
    diagnostics.push({
      level: "warn",
      message: `providers[${index}] has an invalid id and was disabled`,
    })
    return undefined
  }
  if (value.type === "postgres") {
    const environmentValue =
      typeof value.connectionStringEnv === "string"
        ? process.env[value.connectionStringEnv]
        : undefined
    const connectionString =
      typeof value.connectionString === "string" ? value.connectionString : environmentValue
    if (!connectionString) {
      diagnostics.push({
        level: "warn",
        message: `provider ${value.id} has no database connection and was disabled`,
      })
      return undefined
    }
    return {
      type: "postgres",
      id: value.id,
      connectionString,
      primary: value.primary === true,
      maxConnections: finiteNumber(value.maxConnections, 5, 1, 50),
      catalogLimit: finiteNumber(value.catalogLimit, 2_000, 10, 20_000),
    }
  }
  const paths = strings(value.paths)
  if (paths.length === 0) {
    diagnostics.push({
      level: "warn",
      message: `provider ${value.id} has no paths and was disabled`,
    })
    return undefined
  }
  if (value.scope !== undefined && !SCOPE_KINDS.has(value.scope as MemoryScopeKind)) {
    diagnostics.push({
      level: "warn",
      message: `provider ${value.id} has an invalid scope and was disabled`,
    })
    return undefined
  }

  return {
    type: "markdown" as const,
    id: value.id,
    paths,
    exclude: [...DEFAULT_EXCLUSIONS, ...strings(value.exclude)],
    scope: (value.scope as MemoryScopeKind | undefined) ?? "workspace",
    maxFileBytes: finiteNumber(value.maxFileBytes, 256 * 1024, 1024, 10 * 1024 * 1024),
    maxFiles: finiteNumber(value.maxFiles, 2_000, 1, 100_000),
  }
}

function parseEmbedding(value: unknown, diagnostics: ConfigDiagnostic[]): EmbeddingPluginOptions {
  const options = isRecord(value) ? value : {}
  const backendFromPluginOptions =
    options.backend === "neural" ? "neural" : options.backend === "hash" ? "hash" : undefined
  if (options.backend !== undefined && backendFromPluginOptions === undefined) {
    diagnostics.push({
      level: "warn",
      message: "embedding.backend must be 'hash' or 'neural'; defaulted to 'hash'",
    })
  }
  // loadInstalledPluginOptions() merges the app-generated config (written by
  // `remem init`, shape `{ provider, model, dimensions }`) into the object
  // passed here whenever the plugin doesn't set its own `embedding` options.
  // Without this fallback, `remem init`'s neural default is silently never
  // read: this function would only recognize the plugin-options shape's
  // `backend` field, defaulting every installed plugin to "hash" regardless
  // of what `remem init` configured.
  const backendFromAppConfig =
    options.provider === "neural"
      ? "neural"
      : options.provider === "local-hash"
        ? "hash"
        : undefined
  return {
    backend: backendFromPluginOptions ?? backendFromAppConfig ?? "hash",
    ...(parseModelPath(options.modelPath, diagnostics) ? { modelPath: options.modelPath } : {}),
  }
}

/**
 * Basic defense-in-depth for the air-gapped local-weights override:
 * `modelPath` is set by whoever can already edit this config (the same
 * trust level as a Postgres connection string or a Markdown provider
 * path), so this is not a trust-boundary check -- it just requires an
 * absolute, normalized path instead of accepting any string verbatim,
 * catching accidental relative paths (whose resolution would silently
 * depend on the process's current working directory) or path-traversal
 * segments before they reach `@huggingface/transformers`.
 */
function parseModelPath(value: unknown, diagnostics: ConfigDiagnostic[]): value is string {
  if (value === undefined) return false
  if (typeof value !== "string" || !value.trim()) {
    diagnostics.push({ level: "warn", message: "embedding.modelPath must be a non-empty string" })
    return false
  }
  const normalized = path.normalize(value)
  if (!path.isAbsolute(normalized) || normalized !== value) {
    diagnostics.push({
      level: "warn",
      message: "embedding.modelPath must be an absolute, normalized path (e.g. no '..' segments)",
    })
    return false
  }
  return true
}

export function parseConfig(options: unknown): ParsedConfig {
  const diagnostics: ConfigDiagnostic[] = []
  const root = isRecord(options) ? options : {}
  if (options !== undefined && !isRecord(options)) {
    diagnostics.push({
      level: "warn",
      message: "plugin options are not an object; defaults were used",
    })
  }

  const providersSpecified = Object.hasOwn(root, "providers")
  const rawProviders = Array.isArray(root.providers) ? root.providers : undefined
  if (providersSpecified && !rawProviders) {
    diagnostics.push({
      level: "warn",
      message: "providers must be an array; no memory providers were enabled",
    })
  }
  const parsedProviders = rawProviders
    ? rawProviders
        .map((provider, index) => parseProvider(provider, index, diagnostics))
        .filter((provider): provider is MemoryProviderConfig => provider !== undefined)
    : providersSpecified
      ? []
      : [
          {
            type: "markdown" as const,
            id: "workspace-memory",
            paths: [".remem/memory"],
            exclude: DEFAULT_EXCLUSIONS,
            scope: "workspace" as const,
            maxFileBytes: 256 * 1024,
            maxFiles: 2_000,
          },
        ]
  const providerIds = new Set<string>()
  const providers = parsedProviders.filter((provider) => {
    if (providerIds.has(provider.id)) {
      diagnostics.push({
        level: "warn",
        message: `provider ${provider.id} has a duplicate id and was disabled`,
      })
      return false
    }
    providerIds.add(provider.id)
    return true
  })

  const budgetOptions = isRecord(root.budgets) ? root.budgets : {}
  const plannerOptions = isRecord(root.planner) ? root.planner : {}
  const captureOptions = isRecord(root.capture) ? root.capture : {}

  return {
    config: {
      providers,
      budgets: {
        catalogTokens: finiteNumber(budgetOptions.catalogTokens, 600, 200, 20_000),
        recallTokens: finiteNumber(budgetOptions.recallTokens, 1_400, 100, 50_000),
        perProviderTokens: finiteNumber(budgetOptions.perProviderTokens, 900, 100, 50_000),
      },
      planner: {
        minimumConfidence: finiteNumber(plannerOptions.minimumConfidence, 0.42, 0, 1),
        maxTopics: finiteNumber(plannerOptions.maxTopics, 3, 1, 20),
      },
      semantic: {
        enabled: plannerOptions.semantic !== false,
        minimumSimilarity: finiteNumber(plannerOptions.semanticMinimumSimilarity, 0.55, 0, 1),
        deterministicHighConfidence: finiteNumber(
          plannerOptions.deterministicHighConfidence,
          0.82,
          0,
          1,
        ),
      },
      providerTimeoutMs: finiteNumber(root.providerTimeoutMs, 2_000, 50, 60_000),
      maxResults: finiteNumber(root.maxResults, 8, 1, 100),
      debug: root.debug === true,
      compaction: root.compaction !== false,
      capture: {
        enabled: captureOptions.enabled === true,
        queueLimit: finiteNumber(captureOptions.queueLimit, 32, 1, 1_000),
        maxInputCharacters: finiteNumber(captureOptions.maxInputCharacters, 2_000, 256, 20_000),
        maxCandidateCharacters: finiteNumber(
          captureOptions.maxCandidateCharacters,
          1_500,
          128,
          10_000,
        ),
        timeoutMs: finiteNumber(captureOptions.timeoutMs, 1_000, 50, 10_000),
      },
      embedding: parseEmbedding(root.embedding, diagnostics),
      reembedCooldownMs: finiteNumber(root.reembedCooldownMs, 5 * 60_000, 0, 60 * 60_000),
    },
    diagnostics,
  }
}

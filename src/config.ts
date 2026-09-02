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

export interface MarkdownProviderConfig {
  type: "markdown"
  id: string
  paths: string[]
  exclude: string[]
  scope: MemoryScopeKind
  maxFileBytes: number
  maxFiles: number
}

export interface OrchestratorConfig {
  budgets: TokenBudgets
  planner: PlannerConfig
  providerTimeoutMs: number
  maxResults: number
  debug: boolean
}

export interface RememConfig extends OrchestratorConfig {
  providers: MarkdownProviderConfig[]
  compaction: boolean
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

function parseProvider(value: unknown, index: number, diagnostics: ConfigDiagnostic[]) {
  if (!isRecord(value)) {
    diagnostics.push({
      level: "warn",
      message: `providers[${index}] is not an object and was disabled`,
    })
    return undefined
  }
  if (value.type !== "markdown") {
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
        .filter((provider): provider is MarkdownProviderConfig => provider !== undefined)
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
      providerTimeoutMs: finiteNumber(root.providerTimeoutMs, 2_000, 50, 60_000),
      maxResults: finiteNumber(root.maxResults, 8, 1, 100),
      debug: root.debug === true,
      compaction: root.compaction !== false,
    },
    diagnostics,
  }
}

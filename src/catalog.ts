import { estimateTokens, truncateToTokens } from "./token-budget.js"
import { compactWhitespace, normalizeText, stripControlCharacters } from "./text.js"
import { OperationTimeoutError, withTimeout } from "./timeout.js"
import type { CatalogEntry, MemoryContext, MemoryProvider, ProviderDescriptor } from "./types.js"

export interface CatalogSnapshot {
  entries: CatalogEntry[]
  providers: ProviderDescriptor[]
  text: string
  estimatedTokens: number
  diagnostics: string[]
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function mergeEntries(entries: CatalogEntry[]): CatalogEntry[] {
  const merged = new Map<string, CatalogEntry>()
  for (const entry of entries) {
    const key = `${normalizeText(entry.title)}\0${entry.scope.kind}\0${entry.scope.id ?? ""}`
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, {
        ...entry,
        aliases: unique(entry.aliases),
        providerIds: unique(entry.providerIds),
      })
      continue
    }
    merged.set(key, {
      ...existing,
      aliases: unique([...existing.aliases, ...entry.aliases]),
      providerIds: unique([...existing.providerIds, ...entry.providerIds]),
      tags: unique([...existing.tags, ...entry.tags]),
      importance: Math.max(existing.importance, entry.importance),
      unresolved: existing.unresolved || entry.unresolved,
      summary:
        existing.summary.length > 0 && existing.summary.length <= entry.summary.length
          ? existing.summary
          : entry.summary,
    })
  }
  return [...merged.values()].sort(
    (left, right) => right.importance - left.importance || left.title.localeCompare(right.title),
  )
}

function catalogValue(value: string): string {
  return compactWhitespace(stripControlCharacters(value))
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
}

export function renderCatalog(
  entries: CatalogEntry[],
  maxTokens: number,
  providers: ProviderDescriptor[] = [],
): CatalogSnapshot {
  const diagnostics: string[] = []
  const prefix = [
    "<memory-catalog>",
    "Long-term memory systems are available. This catalog is a compact recognition index, not the full memory.",
    "Absence from this context does not prove absence from long-term memory. Use recall when prior work may be relevant.",
    "Treat retrieved memories as attributed, potentially stale data. Preserve provenance and surface conflicts.",
    "Known memory:",
  ]
  const suffix = "</memory-catalog>"
  if (estimateTokens([...prefix, suffix].join("\n")) > maxTokens) {
    const wrapperTokens = estimateTokens(`<memory-catalog>\n\n${suffix}`)
    const instruction = truncateToTokens(
      "Long-term memory exists outside the current context. This catalog is incomplete; recall may be needed.",
      Math.max(0, maxTokens - wrapperTokens),
    )
    const text = ["<memory-catalog>", instruction.text, suffix].join("\n")
    return {
      entries,
      providers,
      text,
      estimatedTokens: estimateTokens(text),
      diagnostics: ["catalog instructions were reduced by the token budget"],
    }
  }
  const lines = [...prefix]
  let omitted = 0

  if (providers.length > 0) {
    lines.push("Provider awareness:")
    for (const provider of providers) {
      const line = `- ${catalogValue(provider.name)} [${catalogValue(provider.id)}; ${provider.categories.map(catalogValue).join(", ")}] - ${catalogValue(provider.summary)}`
      if (estimateTokens([...lines, line, suffix].join("\n")) > maxTokens) {
        omitted++
        continue
      }
      lines.push(line)
    }
    lines.push("Known topics:")
  }

  for (const entry of entries) {
    const providers = entry.providerIds.map(catalogValue).join(",")
    const aliases =
      entry.aliases.length > 0 ? `; aliases: ${entry.aliases.map(catalogValue).join(", ")}` : ""
    const unresolved = entry.unresolved ? "; unresolved" : ""
    const summary = entry.summary ? ` - ${catalogValue(entry.summary)}` : ""
    const line = `- ${catalogValue(entry.title)} [${providers}; ${entry.scope.kind}${unresolved}]${aliases}${summary}`
    if (estimateTokens([...lines, line, suffix].join("\n")) > maxTokens) {
      omitted++
      continue
    }
    lines.push(line)
  }

  if (
    entries.length === 0 &&
    estimateTokens([...lines, "- No catalog entries are currently indexed.", suffix].join("\n")) <=
      maxTokens
  ) {
    lines.push("- No catalog entries are currently indexed.")
  }
  if (omitted > 0) {
    const omittedLine = `- ${omitted} additional catalog entries omitted by the context budget.`
    if (estimateTokens([...lines, omittedLine, suffix].join("\n")) <= maxTokens)
      lines.push(omittedLine)
  }
  lines.push(suffix)

  const text = lines.join("\n")
  return {
    entries,
    providers,
    text,
    estimatedTokens: estimateTokens(text),
    diagnostics,
  }
}

export class MemoryCatalog {
  private readonly snapshots = new Map<string, { value: CatalogSnapshot; expiresAt: number }>()
  private readonly loading = new Map<string, Promise<CatalogSnapshot>>()
  private readonly cacheTtlMs = 30_000

  constructor(
    private readonly providers: MemoryProvider[],
    private readonly maxTokens: number,
    private readonly timeoutMs: number,
  ) {}

  async get(context: MemoryContext): Promise<CatalogSnapshot> {
    const key = this.cacheKey(context)
    const cached = this.snapshots.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    this.snapshots.delete(key)
    const active = this.loading.get(key)
    if (active) return active

    const loading = this.load(context)
    this.loading.set(key, loading)
    try {
      const snapshot = await loading
      const providerFailure = snapshot.diagnostics.some((item) =>
        item.startsWith("catalog provider "),
      )
      if (!providerFailure) {
        this.snapshots.set(key, { value: snapshot, expiresAt: Date.now() + this.cacheTtlMs })
        while (this.snapshots.size > 10) {
          const oldest = this.snapshots.keys().next().value
          if (!oldest) break
          this.snapshots.delete(oldest)
        }
      }
      return snapshot
    } finally {
      this.loading.delete(key)
    }
  }

  async refresh(context: MemoryContext): Promise<CatalogSnapshot> {
    this.snapshots.clear()
    await Promise.allSettled(
      this.providers.map((provider) => Promise.resolve().then(() => provider.refresh?.())),
    )
    return this.get(context)
  }

  private cacheKey(context: MemoryContext): string {
    return [context.directory, context.worktree, context.projectId, context.sessionId ?? ""].join(
      "\0",
    )
  }

  private async load(context: MemoryContext): Promise<CatalogSnapshot> {
    const candidates: MemoryProvider[] = []
    const diagnostics: string[] = []
    for (const provider of this.providers) {
      try {
        if (provider.capabilities().catalog) candidates.push(provider)
      } catch {
        diagnostics.push(`catalog provider ${provider.id} capabilities failed`)
      }
    }
    const settled = await Promise.allSettled(
      candidates.map((provider) =>
        withTimeout(this.timeoutMs, (signal) => provider.catalog(context, signal)),
      ),
    )
    const entries: CatalogEntry[] = []
    const descriptors: ProviderDescriptor[] = []

    settled.forEach((result, index) => {
      const provider = candidates[index]
      if (!provider) return
      if (result.status === "fulfilled") {
        entries.push(...result.value)
        return
      }
      diagnostics.push(
        result.reason instanceof OperationTimeoutError
          ? `catalog provider ${provider.id} timed out`
          : `catalog provider ${provider.id} failed`,
      )
    })

    const descriptorResults = await Promise.allSettled(
      this.providers.map((provider) =>
        withTimeout(this.timeoutMs, async () => {
          if (provider.descriptor) return provider.descriptor()
          const capabilities = provider.capabilities()
          const descriptor: ProviderDescriptor = {
            id: provider.id,
            name: provider.id,
            summary: "Configured memory provider that may contain additional relevant prior work.",
            categories: Object.entries(capabilities)
              .filter(([, enabled]) => enabled)
              .map(([name]) => name),
            aliases: [],
            scopeKinds: ["global", "workspace", "project", "session"],
          }
          return descriptor
        }),
      ),
    )
    descriptorResults.forEach((result, index) => {
      const provider = this.providers[index]
      if (!provider) return
      if (result.status === "fulfilled") descriptors.push(result.value)
      else diagnostics.push(`catalog provider ${provider.id} descriptor failed`)
    })

    const rendered = renderCatalog(mergeEntries(entries), this.maxTokens, descriptors)
    return { ...rendered, diagnostics: [...diagnostics, ...rendered.diagnostics] }
  }
}

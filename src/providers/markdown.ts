import type { Dirent } from "node:fs"
import { lstat, readFile, readdir } from "node:fs/promises"
import path from "node:path"
import type { MarkdownProviderConfig } from "../config.js"
import {
  clamp,
  compactWhitespace,
  containsPhrase,
  contentFingerprint,
  overlapRatio,
  tokenize,
} from "../text.js"
import { truncateToTokens } from "../token-budget.js"
import type {
  CatalogEntry,
  MemoryCapabilities,
  MemoryContext,
  MemoryFreshness,
  MemoryProvider,
  MemoryResult,
  MemoryScope,
  MemoryScopeKind,
  MemorySearchRequest,
  MemoryType,
  ProviderDescriptor,
  ProviderHealth,
} from "../types.js"

interface MarkdownDocument {
  id: string
  title: string
  aliases: string[]
  tags: string[]
  summary: string
  content: string
  source: string
  root: string
  scopeKind: MemoryScopeKind
  scopeId?: string
  type: MemoryType
  freshness: MemoryFreshness
  importance: number
  confidence?: number
  unresolved: boolean
  createdAt?: string
  updatedAt?: string
  metadata: Record<string, unknown>
}

type FrontmatterValue = string | string[]

const MEMORY_TYPES = new Set<MemoryType>([
  "semantic",
  "episodic",
  "decision",
  "preference",
  "procedure",
  "task",
  "other",
])
const FRESHNESS_VALUES = new Set<MemoryFreshness>(["current", "stale", "superseded", "unknown"])
const SCOPE_VALUES = new Set<MemoryScopeKind>(["global", "workspace", "project", "session"])
const GENERIC_ROUTING_TOKENS = new Set(["project", "service", "work", "migration"])

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseList(value: string): string[] {
  const unwrapped = value.trim().replace(/^\[/u, "").replace(/\]$/u, "")
  return unwrapped
    .split(",")
    .map(stripQuotes)
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseFrontmatter(source: string): {
  attributes: Record<string, FrontmatterValue>
  body: string
} {
  const withoutBom = source.replace(/^\uFEFF/u, "")
  if (!withoutBom.startsWith("---\n") && !withoutBom.startsWith("---\r\n")) {
    return { attributes: {}, body: withoutBom }
  }
  const normalized = withoutBom.replace(/\r\n/gu, "\n")
  const delimiter = /\n---(?:\n|$)/u.exec(normalized.slice(4))
  if (!delimiter || delimiter.index < 0) return { attributes: {}, body: withoutBom }
  const end = delimiter.index + 4

  const attributes: Record<string, FrontmatterValue> = {}
  const lines = normalized.slice(4, end).split("\n")
  let listKey: string | undefined
  for (const line of lines) {
    const listItem = /^\s*-\s+(.+)$/u.exec(line)
    if (listItem?.[1] && listKey) {
      const current = attributes[listKey]
      const values = Array.isArray(current) ? current : []
      values.push(stripQuotes(listItem[1]))
      attributes[listKey] = values
      continue
    }

    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line)
    if (!match?.[1]) continue
    const key = match[1].toLocaleLowerCase()
    const value = match[2] ?? ""
    if (value.trim() === "") {
      attributes[key] = []
      listKey = key
    } else {
      attributes[key] = value.trim().startsWith("[") ? parseList(value) : stripQuotes(value)
      listKey = undefined
    }
  }
  return { attributes, body: normalized.slice(end + delimiter[0].length) }
}

function scalar(attributes: Record<string, FrontmatterValue>, key: string): string | undefined {
  const value = attributes[key]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function list(attributes: Record<string, FrontmatterValue>, key: string): string[] {
  const value = attributes[key]
  if (Array.isArray(value)) return value
  return typeof value === "string" ? parseList(value) : []
}

function number(
  attributes: Record<string, FrontmatterValue>,
  key: string,
  fallback: number,
): number {
  const value = Number(scalar(attributes, key))
  return Number.isFinite(value) ? clamp(value) : fallback
}

function boolean(attributes: Record<string, FrontmatterValue>, key: string): boolean {
  return /^(true|yes|1)$/iu.test(scalar(attributes, key) ?? "")
}

function enumValue<T extends string>(value: string | undefined, allowed: Set<T>, fallback: T): T {
  return value && allowed.has(value as T) ? (value as T) : fallback
}

function firstSummary(body: string): string {
  const paragraph = body
    .split(/\n\s*\n/u)
    .map(compactWhitespace)
    .find((item) => item.length > 0 && !item.startsWith("#"))
  if (!paragraph) return ""
  return paragraph.length > 180 ? `${paragraph.slice(0, 177).trimEnd()}...` : paragraph
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//u, "")
  let expression = "^"
  for (let index = 0; index < normalized.length; index++) {
    const character = normalized[index]
    const next = normalized[index + 1]
    if (character === "*" && next === "*") {
      if (normalized[index + 2] === "/") {
        expression += "(?:.*/)?"
        index += 2
      } else {
        expression += ".*"
        index++
      }
    } else if (character === "*") expression += "[^/]*"
    else if (character === "?") expression += "[^/]"
    else expression += character?.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&") ?? ""
  }
  return new RegExp(`${expression}$`, "u")
}

function configuredScopeId(attributes: Record<string, FrontmatterValue>): string | undefined {
  return (
    scalar(attributes, "scope-id") ??
    scalar(attributes, "scope_id") ??
    scalar(attributes, "scopeid")
  )
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function scopeFor(document: MarkdownDocument, context: MemoryContext): MemoryScope | undefined {
  if (document.scopeKind === "global") return { kind: "global" }
  const expectedId =
    document.scopeKind === "workspace"
      ? context.worktree
      : document.scopeKind === "project"
        ? context.projectId
        : context.sessionId

  if (document.scopeId) {
    const matches =
      document.scopeKind === "workspace"
        ? path.resolve(document.scopeId) === path.resolve(expectedId ?? "")
        : document.scopeId === expectedId
    return matches ? { kind: document.scopeKind, id: document.scopeId } : undefined
  }
  if (document.scopeKind === "workspace" && isWithin(context.worktree, document.root)) {
    return { kind: "workspace", id: context.worktree }
  }
  return undefined
}

function titleFromBody(body: string, filePath: string): string {
  const heading = /^#\s+(.+)$/mu.exec(body)?.[1]?.trim()
  return heading || path.basename(filePath, path.extname(filePath))
}

function isoDate(value: string | undefined, fallback?: Date): string | undefined {
  if (value) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  return fallback?.toISOString()
}

function parseDocument(
  raw: string,
  filePath: string,
  source: string,
  id: string,
  root: string,
  stat: Awaited<ReturnType<typeof lstat>>,
  defaultScope: MemoryScopeKind,
): MarkdownDocument | undefined {
  const { attributes, body } = parseFrontmatter(raw)
  const type = enumValue(scalar(attributes, "type"), MEMORY_TYPES, "other")
  const freshness = enumValue(scalar(attributes, "freshness"), FRESHNESS_VALUES, "unknown")
  const requestedScope = scalar(attributes, "scope")
  if (requestedScope && !SCOPE_VALUES.has(requestedScope as MemoryScopeKind)) return undefined
  const scopeKind = enumValue(requestedScope, SCOPE_VALUES, defaultScope)
  const status = scalar(attributes, "status") ?? ""
  const unresolved =
    boolean(attributes, "unresolved") ||
    /^(active|blocked|in-progress|open)$/iu.test(status) ||
    /\b(todo|blocker|blocked|unresolved)\b/iu.test(body)
  const createdAt = isoDate(scalar(attributes, "created"), stat.birthtime)
  const updatedAt = isoDate(scalar(attributes, "updated"), stat.mtime)
  const ownerScopeId = configuredScopeId(attributes)

  return {
    id,
    title: scalar(attributes, "title") ?? titleFromBody(body, filePath),
    aliases: [...list(attributes, "aliases"), ...list(attributes, "alias")],
    tags: list(attributes, "tags").map((tag) => tag.replace(/^#/u, "")),
    summary:
      scalar(attributes, "summary") ?? scalar(attributes, "description") ?? firstSummary(body),
    content: body.trim(),
    source,
    root,
    scopeKind,
    ...(ownerScopeId ? { scopeId: ownerScopeId } : {}),
    type,
    freshness,
    importance: number(attributes, "importance", 0.5),
    ...(scalar(attributes, "confidence")
      ? { confidence: number(attributes, "confidence", 0.5) }
      : {}),
    unresolved,
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    metadata: {
      tags: list(attributes, "tags"),
      status,
    },
  }
}

function scoreDocument(
  query: string,
  queryTokens: string[],
  document: MarkdownDocument,
): MemoryResult | undefined {
  let score = 0
  const reasons: string[] = []
  const distinctiveQueryTokens = queryTokens.filter((token) => !GENERIC_ROUTING_TOKENS.has(token))

  if (containsPhrase(query, document.title)) {
    score = 0.98
    reasons.push("title phrase")
  }
  for (const alias of document.aliases) {
    if (containsPhrase(query, alias)) {
      score = Math.max(score, 0.94)
      reasons.push("alias phrase")
    }
  }

  const titleOverlap = overlapRatio(
    tokenize(document.title).filter((token) => !GENERIC_ROUTING_TOKENS.has(token)),
    distinctiveQueryTokens,
  )
  if (titleOverlap > 0) {
    score = Math.max(score, 0.78 * titleOverlap)
    reasons.push("title tokens")
  }
  const aliasOverlap = Math.max(
    0,
    ...document.aliases.map((alias) =>
      overlapRatio(
        tokenize(alias).filter((token) => !GENERIC_ROUTING_TOKENS.has(token)),
        distinctiveQueryTokens,
      ),
    ),
  )
  if (aliasOverlap > 0) {
    score = Math.max(score, 0.72 * aliasOverlap)
    reasons.push("alias tokens")
  }
  const tagOverlap = overlapRatio(
    document.tags.flatMap(tokenize).filter((token) => !GENERIC_ROUTING_TOKENS.has(token)),
    distinctiveQueryTokens,
  )
  if (tagOverlap > 0) {
    score = Math.max(score, 0.55 * tagOverlap)
    reasons.push("tags")
  }

  const contentTokens = new Set(tokenize(`${document.summary} ${document.content}`))
  const shared = distinctiveQueryTokens.filter((token) => contentTokens.has(token)).length
  if (shared > 0) {
    score = Math.max(score, 0.18 + Math.min(0.48, (shared / distinctiveQueryTokens.length) * 0.48))
    reasons.push("content tokens")
  }

  if (score < 0.3) return undefined
  return {
    record: {
      providerId: "",
      id: document.id,
      title: document.title,
      content: document.content,
      source: document.source,
      scope: { kind: document.scopeKind },
      type: document.type,
      freshness: document.freshness,
      ...(document.createdAt ? { createdAt: document.createdAt } : {}),
      ...(document.updatedAt ? { updatedAt: document.updatedAt } : {}),
      ...(document.confidence !== undefined ? { confidence: document.confidence } : {}),
      importance: document.importance,
      metadata: document.metadata,
    },
    score: clamp(score),
    reasons: [...new Set(reasons)],
    fingerprint: contentFingerprint(document.content),
  }
}

export class MarkdownMemoryProvider implements MemoryProvider {
  readonly id: string
  private documents: Promise<MarkdownDocument[]> | undefined
  private cacheExpiresAt = 0
  private warnings: string[] = []
  private readonly exclusions: RegExp[]
  private visitedEntries = 0

  constructor(
    private readonly config: MarkdownProviderConfig,
    private readonly roots: string[],
  ) {
    this.id = config.id
    this.exclusions = config.exclude.map(globToRegExp)
  }

  capabilities(): MemoryCapabilities {
    return {
      lexicalSearch: true,
      semanticSearch: false,
      metadataFiltering: true,
      catalog: true,
      read: true,
      write: false,
      update: false,
      delete: false,
      episodicHistory: false,
      structuredEntities: false,
      filesystemDocuments: true,
    }
  }

  descriptor(): ProviderDescriptor {
    return {
      id: this.id,
      name: "Markdown memory",
      summary:
        "Local documents that may contain project notes, decisions, preferences, tasks, and prior incidents.",
      categories: ["documents", "decisions", "preferences", "tasks", "incidents"],
      aliases: ["notes", "Obsidian", "local documents"],
      scopeKinds: ["global", "workspace", "project", "session"],
    }
  }

  async catalog(context: MemoryContext, signal: AbortSignal): Promise<CatalogEntry[]> {
    const documents = await this.loadDocuments(signal)
    return documents.flatMap((document) => {
      const scope = scopeFor(document, context)
      if (!scope) return []
      return [
        {
          id: `${this.id}:${document.id}`,
          title: document.title,
          aliases: document.aliases,
          summary: document.summary,
          providerIds: [this.id],
          scope,
          tags: document.tags,
          importance: document.importance,
          unresolved: document.unresolved,
          source: document.source,
        },
      ]
    })
  }

  async search(request: MemorySearchRequest): Promise<MemoryResult[]> {
    const documents = await this.loadDocuments(request.signal)
    const queryTokens = tokenize(request.query)
    if (queryTokens.length === 0) return []

    const matched = documents
      .flatMap((document) => {
        const scope = scopeFor(document, request.context)
        if (!scope) return []
        if (request.scopes && !request.scopes.includes(document.scopeKind)) return []
        if (request.types && !request.types.includes(document.type)) return []
        return [{ document, scope }]
      })
      .map(({ document, scope }) => {
        const result = scoreDocument(request.query, queryTokens, document)
        if (!result) return undefined
        result.record.providerId = this.id
        result.record.scope = scope
        return result
      })
      .filter((result): result is MemoryResult => result !== undefined)
      .sort((left, right) => right.score - left.score)
      .slice(0, request.limit)

    const perResultTokens = Math.max(1, Math.floor(request.maxTokens / Math.max(1, matched.length)))
    let remainingTokens = request.maxTokens
    return matched.flatMap((result) => {
      if (remainingTokens <= 0) return []
      const excerpt = truncateToTokens(
        result.record.content,
        Math.min(perResultTokens, remainingTokens),
      )
      remainingTokens -= excerpt.estimatedTokens
      return [{ ...result, record: { ...result.record, content: excerpt.text } }]
    })
  }

  async health(): Promise<ProviderHealth> {
    try {
      const controller = new AbortController()
      const documents = await this.loadDocuments(controller.signal)
      return {
        status: this.warnings.length > 0 ? "degraded" : "healthy",
        message: `${documents.length} Markdown document(s) indexed${
          this.warnings.length > 0 ? `; ${this.warnings.length} path warning(s)` : ""
        }`,
        checkedAt: new Date().toISOString(),
      }
    } catch (error) {
      return {
        status: "unavailable",
        message: error instanceof Error ? error.name : "unknown error",
        checkedAt: new Date().toISOString(),
      }
    }
  }

  refresh(): void {
    this.documents = undefined
    this.cacheExpiresAt = 0
  }

  private loadDocuments(signal: AbortSignal): Promise<MarkdownDocument[]> {
    if (this.cacheExpiresAt <= Date.now()) this.documents = undefined
    if (!this.documents) {
      const scan = this.scan(new AbortController().signal)
      const cached = scan.catch((error: unknown) => {
        if (this.documents === cached) this.documents = undefined
        throw error
      })
      this.documents = cached
      this.cacheExpiresAt = Date.now() + 30_000
    }
    const abortError = () => {
      const reason: unknown = signal.reason
      return reason instanceof Error
        ? reason
        : new DOMException("The operation was aborted", "AbortError")
    }
    if (signal.aborted) return Promise.reject(abortError())
    const documents = this.documents
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort)
        reject(abortError())
      }
      signal.addEventListener("abort", onAbort, { once: true })
      void documents.then(
        (value) => {
          signal.removeEventListener("abort", onAbort)
          resolve(value)
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort)
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })
  }

  private async scan(signal: AbortSignal): Promise<MarkdownDocument[]> {
    const documents: MarkdownDocument[] = []
    this.warnings = []
    this.visitedEntries = 0

    for (const [rootIndex, root] of this.roots.entries()) {
      if (documents.length >= this.config.maxFiles) break
      await this.walk(root, root, rootIndex, documents, signal)
    }
    return documents
  }

  private async walk(
    root: string,
    current: string,
    rootIndex: number,
    documents: MarkdownDocument[],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    if (documents.length >= this.config.maxFiles) return
    this.visitedEntries++
    if (this.visitedEntries > this.config.maxFiles * 20) {
      if (!this.warnings.includes("filesystem traversal limit reached")) {
        this.warnings.push("filesystem traversal limit reached")
      }
      return
    }

    let stat: Awaited<ReturnType<typeof lstat>>
    try {
      stat = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.warnings.push("unreadable path")
      return
    }
    if (stat.isSymbolicLink()) return

    const relative = path.relative(root, current).replaceAll(path.sep, "/") || "."
    if (relative !== "." && this.exclusions.some((pattern) => pattern.test(relative))) return

    if (stat.isDirectory()) {
      let entries: Dirent<string>[]
      try {
        entries = await readdir(current, { withFileTypes: true, encoding: "utf8" })
      } catch {
        this.warnings.push("unreadable directory")
        return
      }
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        if (documents.length >= this.config.maxFiles) break
        await this.walk(root, path.join(current, entry.name), rootIndex, documents, signal)
      }
      return
    }

    if (!stat.isFile() || path.extname(current).toLocaleLowerCase() !== ".md") return
    if (stat.size > this.config.maxFileBytes) {
      this.warnings.push("oversized Markdown file")
      return
    }

    try {
      const raw = await readFile(current, "utf8")
      const rootLabel =
        this.roots.length > 1 ? `${path.basename(root)}[${rootIndex}]` : path.basename(root)
      const source = `${rootLabel}/${relative}`
      const document = parseDocument(
        raw,
        current,
        source,
        `${rootIndex}:${relative}`,
        root,
        stat,
        this.config.scope,
      )
      if (document) documents.push(document)
      else this.warnings.push("invalid Markdown scope")
    } catch {
      this.warnings.push("unreadable Markdown file")
    }
  }
}

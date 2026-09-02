# Provider Interface

## Design Rules

Providers normalize capabilities and records without inheriting orchestration policy. They do not
decide whether a prompt deserves recall, how cross-provider results rank, or what enters the model
context.

The core contract is conceptually:

```ts
interface MemoryProvider {
  readonly id: string
  capabilities(): MemoryCapabilities
  catalog(context: MemoryContext): Promise<CatalogEntry[]>
  search(request: MemorySearchRequest): Promise<MemoryResult[]>
  get?(id: string, context: MemoryContext): Promise<MemoryRecord | undefined>
  write?(memory: MemoryWrite): Promise<MemoryRecord>
  update?(id: string, memory: MemoryWrite): Promise<MemoryRecord>
  delete?(id: string, context: MemoryContext): Promise<void>
  health?(): Promise<ProviderHealth>
}
```

The implemented TypeScript declaration in `src/types.ts` is authoritative.

## Capabilities

Capabilities are explicit booleans for:

- lexical and semantic search;
- metadata filtering;
- catalog enumeration;
- point reads;
- writes, updates, and deletes;
- episodic history;
- structured entities; and
- filesystem documents.

The planner may request only advertised operations. A write-capable provider is not automatically
authorized for automatic capture.

## Search Contract

A search request includes:

- query and optional topics;
- workspace, project, and session context;
- allowed scopes and types;
- result and token limits;
- an abort signal; and
- the planner's reason for routing to this provider.

Results return normalized records and query-dependent retrieval signals. Provider scores should be
normalized to `0..1` when possible, but are not assumed comparable across providers.

## Catalog Contract

Catalog enumeration should be cheaper and smaller than full retrieval. A provider can return
metadata-native entries or derive entries from document titles and frontmatter. Catalog failure
does not disable direct tool search.

Providers with no cheap enumeration can return an empty catalog and still support explicit search.

## Health and Failure

Provider methods may reject. The router catches each provider independently, records a sanitized
diagnostic, and continues. Providers should honor abort signals and avoid global process state.

Health checks must not return credentials or sample memory content.

## Adapter Guidance

### Markdown

The reference adapter recursively indexes configured Markdown directories, parses a conservative
frontmatter subset, applies path exclusions, and performs local lexical search. It does not require
Obsidian or a database.

### Obsidian

Use the Markdown adapter with Obsidian metadata conventions first. A future adapter may understand
wikilinks, backlinks, or a local index while keeping Markdown as the source of truth.

### Mem0

Map user/project/session identifiers to Remem scopes. Keep Mem0 extraction and graph features behind
the adapter; do not expose its client types to core interfaces. Remote processing must be explicit.

### Cognee

The user requirement calls this "Congee"; current prior art indicates the likely system is Cognee.
Integrate only after confirming the intended project and stable API. Its `remember`, `recall`,
`improve`, and `forget` operations should map through an adapter rather than reshape the core.

### MCP

An MCP-backed provider should bind configured server/tool names to search and CRUD capabilities.
Tool schemas and returned text are untrusted provider data. The adapter must enforce output limits
before normalization.

### OpenCode Sessions

A session provider can use the OpenCode SDK to search prior messages if a stable and efficient
history path is available. It should remain outside the OpenCode hook adapter to avoid coupling the
entire core to SDK message types.

## Provider Conformance

Future adapters should share a conformance suite covering:

- stable provenance;
- scope filtering;
- abort and timeout behavior;
- bounded outputs;
- malformed data;
- duplicate identifiers; and
- content-safe health diagnostics.

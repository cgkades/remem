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
  descriptor?(): ProviderDescriptor | Promise<ProviderDescriptor>
  catalog(context: MemoryContext, signal: AbortSignal): Promise<CatalogEntry[]>
  search(request: MemorySearchRequest): Promise<MemoryResult[]>
  get?(id: string, context: MemoryContext): Promise<MemoryRecord | undefined>
  write?(memory: MemoryWrite, options?: MemoryMutationOptions): Promise<MemoryRecord>
  update?(id: string, memory: MemoryWrite, options?: MemoryMutationOptions): Promise<MemoryRecord>
  supersede?(
    id: string,
    replacement: MemoryWrite,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord>
  delete?(id: string, context: MemoryContext, options?: MemoryMutationOptions): Promise<void>
  health?(): Promise<ProviderHealth>
  refresh?(): void | Promise<void>
  dispose?(): void | Promise<void>
}
```

The implemented TypeScript declaration in `src/types.ts` is authoritative.

`RememOrchestrator` accepts the backend-neutral `OrchestratorConfig`. Provider construction and
OpenCode options live in the composition layer. The contract follows
[ADR 0002](adr/0002-use-provider-adapters.md).

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

The planner requests only advertised search operations. A write-capable provider is not
automatically authorized for capture, and the OpenCode adapters expose no mutation tool.

`descriptor()` supplies provider-level awareness for catalogs with few or no topic entries. It
contains a bounded name, summary, categories, aliases, supported scope kinds, and optional
embedding. It is recognition metadata, not a record body.

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

Providers must honor `limit` and `maxTokens` before returning result bodies. Core synthesis applies
its own independent context budget as a second boundary.

## Catalog Contract

Catalog enumeration should be cheaper and smaller than full retrieval. A provider can return
metadata-native entries or derive entries from document titles and frontmatter. Catalog failure
does not disable direct tool search.

Providers may implement `refresh()` to invalidate local indexes. The core keeps context-keyed
catalog snapshots for a short TTL and does not cache snapshots produced with provider failures.
Resource-owning providers implement `dispose()`; host adapters call it during unload and partial
setup failure.

Providers with no cheap enumeration can return an empty catalog and still support explicit search.

## Mutation Contract

`MemoryMutationOptions` carries optional context, abort signal, actor, and reason. Context can resolve
a missing owner for a non-global scope. Providers must reject non-global writes that still have no
scope owner.

`MemoryManager` is the managed orchestration API for `create`, `get`, `update`, `supersede`, and
`delete`. It chooses an explicit or primary provider, verifies the method is present, and refreshes
the provider after mutation. It does not infer authorization, automatically derive memories, or
write session activity.

`PostgresMemoryProvider.supersede()` creates the replacement and marks the original as superseded in
one database transaction. Generated synthesis is never passed to this method automatically.

## Health and Failure

Provider methods may reject. The router catches each provider independently, records a sanitized
diagnostic, and continues. Providers should honor abort signals and avoid global process state.

Health checks must not return credentials or sample memory content.

## Adapter Guidance

### Markdown

The reference adapter recursively indexes configured Markdown directories, parses a conservative
frontmatter subset, applies path exclusions, and performs local lexical search. It does not require
Obsidian or a database.

The OpenCode composition root constructs this adapter and the PostgreSQL adapter from plugin or
installed application configuration.

### PostgreSQL

`PostgresMemoryProvider` is implemented for both managed and external connections. It advertises
lexical search, semantic search, metadata filters, catalog, point reads, CRUD, episodic history, and
structured entities. It stores provenance, aliases, tags, entities, relationships, catalog entries,
and 384-dimensional embeddings under the `remem` schema.

Search combines PostgreSQL full-text ranking and pgvector cosine similarity while enforcing scope
in SQL. Embedding failure during a write omits the vector but preserves the canonical record and
full-text search. Health reports PostgreSQL, pgvector, and schema versions without returning the
connection string.

Managed and external modes differ only in lifecycle and operational ownership; they use this same
adapter and schema. See [Storage architecture](storage-architecture.md) and
[ADR 0010](adr/0010-separate-managed-and-external-database-provisioning.md).

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

## Deferred Adapters

Mem0, Cognee, MCP, OpenCode sessions, and an Obsidian-specific graph/index adapter are not
implemented. The existing core can accept them only after an adapter satisfies the contract and
security boundaries above.

## Provider Conformance

Future adapters should share a conformance suite covering:

- stable provenance;
- scope filtering;
- abort and timeout behavior;
- bounded outputs;
- malformed data;
- duplicate identifiers; and
- content-safe health diagnostics.

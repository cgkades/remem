# MVP

## Hypothesis

A compact provider/topic catalog plus staged local recognition can recover useful prior context
without a mandatory model call or indiscriminate context injection. A managed local store can make
that path durable without coupling orchestration policy to one database.

## Included

- OpenCode v2 beta adapter using `ctx.session.hook("context")` for each model dispatch.
- Isolated OpenCode `1.18.26` compatibility through `chat.message`.
- Ephemeral v2 memory data under a separate trusted untrusted-data policy.
- Worktree-aware Markdown provider with conservative frontmatter support.
- Managed and external `PostgresMemoryProvider` using the same schema.
- Docker Compose provisioning pinned to `pgvector/pgvector:0.8.1-pg16` on loopback.
- CLI lifecycle, diagnostics, migrations, backup, restore, and managed reset.
- Database schema version 3 with checksummed transactional migrations.
- PostgreSQL full-text search and 384-dimensional pgvector search.
- Deterministic Stage 0 and local semantic Stage 1 provider/topic recognition.
- `EmbeddingModel` extension point and the local `remem-local-hash-v1` feature-hash model.
- Independent provider failure handling, timeouts, scope validation, ranking, exact-content
  deduplication, provenance, and token budgets.
- Deterministic attributed synthesis and read-only memory tools.
- Explicit CRUD and transactional supersession through `PostgresMemoryProvider` and `MemoryManager`.
- Structured diagnostics, health checks, and an executable 30-entry/8-prompt evaluation corpus.
- CI with pgvector integration coverage on Node.js 22 and 24.

The canonical runtime, storage, installation, and future-learning diagrams remain in
[Architecture](architecture.md). Implemented storage details are in
[Storage architecture](storage-architecture.md), with decisions cross-linked from both documents.

## Not Included

- Automatic session observation, candidate extraction, durable capture, or consolidation.
- A general neural embedding model; the default uses deterministic feature hashing and small concept
  groups.
- An LLM planner or model-backed synthesizer.
- Full automatic population/rendering of arbitrary-depth topic branches.
- Mem0, Cognee, MCP, OpenCode session-history, or Obsidian-specific adapters.
- Scheduled backup, retention, encryption, or point-in-time recovery.
- Automatic pre-restore or pre-reset backups.
- Semantic contradiction resolution or near-duplicate merging.
- A `/memory` TUI command or graphical dashboard.
- Exact model-specific tokenizers.
- A published npm artifact.

## Acceptance Scenarios

Given a catalog entry and memory stating:

```text
Bedrock Claude credential passthrough failure
The AWS authentication failure was fixed by forwarding the credential provider chain into Bedrock.
```

when the user asks:

```text
What did we end up doing about the AWS auth thing?
```

Stage 1 can recognize the paraphrase, route only to the relevant provider, and inject an attributed
excerpt. With the default local hash model this works through the small AWS/authentication concept
groups; it is not evidence of general language understanding.

When the user asks an unrelated question such as:

```text
Calculate the prime factorization of 391.
```

the provider/topic catalog remains bounded, but no detailed memory is selected.

If PostgreSQL or one provider is unavailable, OpenCode still dispatches the prompt without that
memory. If migration integrity or scope validation fails, Remem does not bypass the check.

## Operational Acceptance

```sh
remem init --mode managed
remem doctor
remem backup
remem restore /path/to/remem-backup.dump --confirm
remem reset --confirm
```

Managed provisioning must generate protected files, publish only to `127.0.0.1`, reach schema
version 2, and pass doctor. Restore and reset require explicit confirmation, and reset must refuse an
external database.

## Success Metrics

- No automatic retrieval occurs below the configured confidence/similarity thresholds.
- Catalog and recall remain within independent budgets.
- Every recalled item retains provider and source attribution.
- One failed provider does not discard another provider's result or block OpenCode.
- The checked-in evaluation meets the thresholds in [Evaluation](evaluation.md).
- Migrations are repeatable and detect unknown, missing, or changed history.
- PostgreSQL integration tests cover CRUD, scope, provenance, lexical/vector search, supersession,
  and embedding failure fallback.
- Lint, formatting, typecheck, unit/integration tests, and build pass in CI.

## Exit Boundary

The implemented MVP now demonstrates recognition, routed recall, managed durability, explicit
mutation, recovery primitives, and both OpenCode host boundaries as separate testable components.
Automatic learning and a general semantic model are intentionally outside this boundary.

See [the roadmap](future-roadmap.md) for deferred work and [the ADR index](adr/) for accepted design
constraints.

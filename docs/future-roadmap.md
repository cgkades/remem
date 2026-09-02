# Future Roadmap

The items below are deferred. Managed PostgreSQL, schema version 4, semantic Stage 1, explicit CRUD,
backup/restore commands, OpenCode v2 integration, and executable evaluation already exist and are not
roadmap claims.

## Phase 1: Harden Distribution and Operations

- Publish `opencode-remem` after package and beta-host compatibility validation.
- Replace source-only OpenCode setup with tested package installation and upgrade instructions.
- Validate supported external PostgreSQL/pgvector version ranges and privilege combinations
  explicitly in `doctor`.
- Add safe pre-upgrade and optional pre-restore/pre-reset backup workflows.
- Add scheduled backups, retention, encryption hooks, and restore verification beyond migration
  checks.
- Add disk/volume capacity reporting and clearer container lifecycle diagnostics.
- Define a Windows permission guarantee where POSIX `0600` mode bits are not authoritative.

## Phase 2: Recognition and Catalog Quality

- Add a stronger opt-in local neural embedding model with explicit download, model identity, and
  reindexing behavior.
- Keep `remem-local-hash-v1` as a deterministic fallback and expand evaluation before changing its
  small concept groups.
- Populate provider/topic/subtopic relationships from managed writes and render selected hierarchy
  branches rather than only provider/topic levels.
- Add embedding model migrations and controlled reindex commands.
- Improve Markdown chunking, Obsidian aliases, wikilinks, frontmatter parsing, and filesystem refresh.
- Add near-duplicate grouping and richer temporal/supersession ranking without automatic truth
  reconciliation.

## Phase 3: Provider Ecosystem

- Obsidian-specific indexing over Markdown as source of truth.
- Mem0 adapter with explicit remote-processing and scope policy.
- Confirm whether the historical "Congee" request means Cognee, then target a stable Cognee API.
- Generic MCP tool-backed provider with strict output and trust boundaries.
- OpenCode prior-session provider using stable history APIs.
- Shared provider conformance coverage for scope, timeout, malformed output, CRUD, and provenance.

## Phase 4: Optional Planning and Synthesis

- Ambiguity-gated Stage 2 planner with explicit privacy, latency, and cost controls.
- Optional local and remote model-backed synthesis behind the existing strategy interface.
- Conflict grouping and query expansion informed by aliases and project state.
- Exact tokenizer adapters where a host exposes model tokenization.

No phase should make an LLM call mandatory for every prompt. Deterministic extraction remains the
fallback required by [ADR 0014](adr/0014-support-bounded-synthesis-strategies.md).

## Phase 5: Observation and Reviewable Learning

- Connect normalized host observations to the `session_events` table introduced in schema version 2.
- Extract candidate memories without writing durable facts by default.
- Add redaction, secret scanning, trust classification, and source-message references.
- Build a user review queue for approve/reject/edit decisions.
- Promote approved candidates through `MemoryManager` with idempotency and audit metadata.
- Keep retrieved instructions and generated synthesis unable to authorize their own persistence.

The target learning flow is diagrammed in [Architecture](architecture.md) and constrained by
[ADR 0015](adr/0015-treat-retrieved-memory-as-untrusted-data.md).

## Phase 6: Consolidation and UX

- Session-bound and background consolidation jobs.
- Idempotent topic summaries and catalog updates.
- Duplicate merge and supersession proposals with reversible audit records.
- `/memory`, `/memory explain`, and provider health views if OpenCode exposes stable command APIs.
- Cross-model evaluation for Anthropic, OpenAI, Bedrock, Gemini, and local models.
- Larger redacted evaluation sets, repeated latency distributions, and context-cost dashboards.
- Team and organization scopes with explicit access control.

## Non-Goals

Remem should not become a mandatory hosted service, a universal vector database, a transcript dump,
or a replacement for provider-owned knowledge systems. It should not silently learn from every
session, trust similarity as truth, or treat a successful backup command as a complete disaster
recovery program.

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `BgeSmallEmbeddingModel`, a local `bge-small-en-v1.5` neural embedding model run via
  `@huggingface/transformers`, selected by default for `remem init --mode managed|external` and
  configurable through the OpenCode plugin's `embedding` option, with automatic fail-open fallback
  to `remem-local-hash-v1`. Resolves [#1](https://github.com/cgkades/remem/issues/1).
- Hook-triggered, cooldown-gated re-embedding that opportunistically re-embeds stale memories via
  `PostgresReembedRunner` the next time OpenCode's `"prompt"` session hook fires, plus the manual
  `remem reembed [--batch-size NUMBER]` CLI command.
- `remem doctor` checks for embedding backlog size and embedding-settings persistence, so a
  model-identity mismatch or stuck backlog is visible without querying the database directly.

### Fixed

- The OpenCode plugin now correctly reads the neural embedding backend `remem init` writes to the
  application config; previously `parseEmbedding` only recognized the plugin-options config shape
  and silently defaulted every installed plugin to `remem-local-hash-v1` regardless of
  `remem init`'s selection.
- `remem reembed` now uses the configured embedding backend instead of always re-embedding into
  `remem-local-hash-v1`, which previously overwrote neural embeddings on any neural-configured
  install.
- The hook-triggered re-embed cooldown is now scoped per plugin session instead of a shared
  module-level map, preventing one workspace's Postgres provider from suppressing another
  workspace's re-embed attempt when `remem init`'s default provider id is reused.

## [0.2.0] - 2026-09-01

### Added

- Managed local PostgreSQL and pgvector provisioning through Docker Compose, pinned to
  `pgvector/pgvector:0.8.1-pg16` and bound to loopback.
- External PostgreSQL mode and the `remem init`, `start`, `stop`, `status`, `doctor`, `migrate`,
  `backup`, `restore`, and `reset` CLI commands.
- Platform-specific configuration and data directories, environment overrides, generated database
  credentials, and restrictive file permissions.
- Ordered transactional migrations with advisory locking and checksum validation. The current
  database schema is version 4.
- `PostgresMemoryProvider` with scoped full-text and pgvector search, provenance, entities,
  relationships, catalog records, health checks, CRUD, and transactional supersession.
- `MemoryManager` as the explicit provider-neutral API for point reads and managed mutations.
- Hierarchical provider/topic recognition, provider descriptors, optional catalog parent identity,
  and semantic Stage 1 routing.
- `EmbeddingModel` and the local 384-dimensional `remem-local-hash-v1` feature-hashing
  implementation.
- OpenCode v2 adapter using the beta `context` session hook and registering `memory_search`,
  `memory_status`, and `memory_explain`.
- Custom-format `pg_dump` backups, guarded `pg_restore`, and managed-only guarded reset.
- Executable evaluation coverage with 30 catalog entries and 8 prompts, plus PostgreSQL integration
  coverage in CI on Node.js 22 and 24.

### Changed

- The package root now targets OpenCode v2 beta `0.0.0-beta-18743`.
- OpenCode `1.18.26` support is isolated at `./server` and `./opencode/v1`.
- Retrieved content is appended in v2 as an ephemeral ordinary user message under a separate trusted
  system policy; provider content is never promoted into that policy.
- Automatic recall now attempts local semantic Stage 1 only when deterministic recognition is not
  already high confidence, and falls back when semantic recognition fails.

### Security

- Generated `config.json`, `.env`, managed Compose configuration, and backup artifacts use mode
  `0600`; generated directories use mode `0700` on POSIX platforms.
- Managed PostgreSQL publishes only to `127.0.0.1`.
- Restore and reset require `--confirm`; reset refuses external databases.
- Subprocess failures redact configured database passwords, provider failures remain isolated, and
  normal retrieval continues to fail open without memory augmentation.

### Known Limitations

- `opencode-remem` has not yet been published to npm.
- The default semantic model is deterministic feature hashing with a small concept vocabulary, not a
  general neural embedding model.
- Session observation, candidate tables, and consolidation interfaces do not automatically capture
  or write memory.
- Scheduled backups, retention, encryption, Stage 2 model planning, model-backed synthesis, and
  non-Markdown/non-PostgreSQL adapters remain deferred.

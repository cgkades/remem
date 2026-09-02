# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

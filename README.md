# ReMem

<p align="center">
  <img src="docs/assets/remem-logo.png" alt="ReMem — Remember What Matters" width="720" />
</p>

Remem is a local-first memory orchestration plugin for [OpenCode](https://opencode.ai) and
[Pi](https://github.com/earendil-works/pi-coding-agent). It recognizes
when prior work may matter, routes bounded recall across memory providers, and injects attributed
working context instead of dumping an entire search result into the model prompt.

Remem does not replace Markdown, Obsidian, Mem0, Cognee, MCP servers, or other systems of record. It
provides a control plane over those stores and uses a managed PostgreSQL provider as the default for
Remem-native memory.

This project is not affiliated with the unrelated Rust project
[`majiayu000/remem`](https://github.com/majiayu000/remem). The npm package identity for this
OpenCode/Pi plugin is `opencode-remem`.

```text
recognition -> retrieval planning -> recall -> synthesis -> context injection
```

## Status

Remem is pre-1.0 and has **not been published to npm yet**. Install it from source. The primary host
adapter targets the current OpenCode v2 beta API, pinned and tested at
`@opencode-ai/plugin@0.0.0-beta-18743`. OpenCode `1.18.26` remains available through a separate,
weaker compatibility entry.

What works now:

- managed Docker storage using `pgvector/pgvector:0.8.1-pg16`, exposed on loopback only;
- operator-managed external PostgreSQL with pgvector;
- checksum-verified, ordered migrations through database schema version 4;
- PostgreSQL full-text and 384-dimensional pgvector retrieval;
- local semantic Stage 1 recognition, deterministic routing, provider/topic awareness, ranking,
  deduplication, token budgets, and attributed synthesis;
- a read-only Markdown/Obsidian-style provider;
- managed CRUD and supersession through `PostgresMemoryProvider` and `MemoryManager`;
- deterministic, bounded consolidation of approved candidates with duplicate merging, provenance,
  conflict preservation, supersession, and restart-safe PostgreSQL run records;
- opt-in bounded, deterministic capture of explicit user corrections, decisions, and preferences into
  reviewable pending candidates;
- OpenCode and Pi tools `memory_search`, `memory_status`, and `memory_explain`, plus Pi's
  `before_agent_start` memory injection and optional compaction-context injection;
- logical backup and guarded restore/reset commands; and
- an executable evaluation corpus plus PostgreSQL integration tests in CI on Node.js 22 and 24.

Remem never stores model or tool output as durable memory. Capture is disabled by default and must be
enabled with `remem init --capture` or `capture.enabled`; it writes only eligible explicit user
statements into **pending** candidates. Review/approval and consolidation remain explicit operations.

## Install from Source

Requirements are Node.js 22 or newer and, for managed mode, Docker with Compose.

```sh
npm ci
npm run build
npm link
remem init --mode managed
remem doctor
```

`npm link` only makes the local CLI available. You can use `node ./dist/cli.js` instead of `remem`
for every command. See [Installation](docs/installation.md) for external PostgreSQL and platform
details.

## OpenCode v2

Because the package is not published, point OpenCode at the built v2 package-root entry:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "file:///absolute/path/to/remem/dist"
    }
  ]
}
```

With no inline provider options, the plugin reads the configuration created by `remem init`. Restart
OpenCode after changing plugin configuration. Do not use the bare `opencode-remem` package name until
the package is resolvable in your OpenCode installation.

The package root and `./opencode/v2` are v2 entries. OpenCode `1.18.26` compatibility is isolated at
`./server` or `./opencode/v1`; it uses the older `chat.message` boundary. See
[OpenCode integration](docs/opencode-integration.md) and [the examples](examples/).

## Pi

`remem init --pi` registers this package as a local [Pi package](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/packages.md)
in Pi's global settings, so Pi auto-discovers the extension declared at `package.json#pi.extensions`
(`./dist/hosts/pi/index.js`). Restart Pi, or run `/reload`, after changing its settings. See
[Pi integration](docs/pi-integration.md) for the event mapping, tool parity with OpenCode, and how
`projectId`/`worktree` are derived without Pi's own project concept.

## Storage Modes

Managed mode creates protected configuration, starts a dedicated Docker volume, and applies schema
migrations:

```sh
remem init --mode managed
remem status
```

External mode never starts, stops, or resets the database server:

```sh
REMEM_DATABASE_URL='postgresql://user:password@db.example/remem?sslmode=require' \
  remem init --mode external
remem doctor
```

The external role must be able to create the `vector` extension and the `remem` schema during first
installation. See [Storage architecture](docs/storage-architecture.md) and
[Configuration](docs/configuration.md).

## CLI

```text
remem init [--mode managed|external] [--database-url URL] [--opencode] [--pi]
remem start
remem stop
remem status
remem doctor
remem migrate
remem backup [--output FILE]
remem restore FILE --confirm
remem reset --confirm
```

`restore` replaces objects in the Remem schema of the configured database. `reset --confirm` is destructive and is
available only in managed mode. Read [Backup and restore](docs/backup-restore.md) first.

## Semantic Recognition

The default `remem-local-hash-v1` model is a deterministic 384-dimensional feature hash over words,
character trigrams, adjacent word pairs, and a small set of hand-written concept groups. It is local
and dependency-free, but it is **not a general neural embedding model**. It improves a bounded set of
paraphrases while remaining lexical in character. `EmbeddingModel` is extensible so applications can
provide a stronger local or remote model explicitly.

## Memory Notes

A plain Markdown file is enough. Optional frontmatter improves recognition:

```markdown
---
title: Project Phoenix
aliases: phoenix database, phoenix migration
tags: database, migration, postgres
type: decision
importance: 0.9
---

# Project Phoenix

Database migration is PostgreSQL 14 to PostgreSQL 17.

Decision: use logical replication.
```

Relative provider paths resolve from the OpenCode worktree. `project` and `session` notes require a
matching `scope-id`; an external `workspace` root does too. Use `global` only for content intended to
be visible in every context that configures the provider.

## Documentation

- [Architecture and diagrams](docs/architecture.md)
- [Storage architecture](docs/storage-architecture.md)
- [Installation](docs/installation.md)
- [Configuration](docs/configuration.md)
- [Backup and restore](docs/backup-restore.md)
- [Memory model](docs/memory-model.md)
- [Retrieval pipeline](docs/retrieval-pipeline.md)
- [Provider interface](docs/provider-interface.md)
- [OpenCode integration](docs/opencode-integration.md)
- [Pi integration](docs/pi-integration.md)
- [Security model](docs/security-model.md)
- [Evaluation](docs/evaluation.md)
- [MVP boundary](docs/mvp.md)
- [Roadmap](docs/future-roadmap.md)
- [Prior art](docs/prior-art.md)
- [Architecture decisions](docs/adr/)

## Development

```sh
npm ci
npm run check
```

CI runs the full check against `pgvector/pgvector:0.8.1-pg16` on Node.js 22 and 24.

Run the PostgreSQL integration suite locally with Docker:

```sh
npm run test:postgres:up
npm run test:postgres
npm run test:postgres:down
```

The test database is bound only to `127.0.0.1:54330`; the teardown command removes its volume.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).

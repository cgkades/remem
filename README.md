# ReMem

<p align="center">
  <img src="docs/assets/remem-logo.png" alt="ReMem — Remember What Matters" width="720" />
</p>

Remem is a local-first memory orchestration plugin for [OpenCode](https://opencode.ai) and
[Pi](https://github.com/earendil-works/pi-coding-agent). It recognizes
when prior work may matter, routes bounded recall across memory providers, and injects attributed
working context instead of dumping an entire search result into the model prompt.

Remem does not replace Markdown, Obsidian, Mem0, Cognee, MCP servers, or other systems of record. It
uses a managed PostgreSQL provider as the default for Remem-native memory. PostgreSQL and Markdown
are the current built-in providers; the other adapters remain planned extensions of the control plane.

This project is not affiliated with the unrelated Rust project
[`majiayu000/remem`](https://github.com/majiayu000/remem). The npm package identity for this
OpenCode/Pi plugin is `agentic-remem`.

```text
recognition -> retrieval planning -> recall -> synthesis -> context injection
```

## Status

Remem is pre-1.0 and published as `agentic-remem` (registry version `0.2.3` verified on 2026-09-09).
Source installation remains supported. OpenCode v2 is the primary adapter; v1 compatibility has a
separate, weaker trust boundary. See [OpenCode integration](docs/opencode-integration.md) for the
supported runtime and configuration details.

For development, start with the [executable recovery plan](plan/feature-memory-recovery-1.md) and
[issue audit](docs/ISSUE-AUDIT.md). The [product vision](docs/PRODUCT-VISION.md) and
[target architecture](docs/TARGET-ARCHITECTURE.md) outrank stale roadmap prose. ReMem has working
capture/recall foundations, but the complete automatic episodic learning loop is not finished.

What works now:

- managed Docker storage using `pgvector/pgvector:0.8.1-pg16`, exposed on loopback only;
- operator-managed external PostgreSQL with pgvector;
- checksum-verified, ordered migrations; the migration set and installed database ledger define schema version;
- PostgreSQL full-text and 384-dimensional pgvector retrieval;
- local semantic Stage 1 recognition, deterministic routing, provider/topic awareness, ranking,
  deduplication, token budgets, and attributed synthesis;
- a read-only Markdown/Obsidian-style provider;
- managed CRUD and supersession through `PostgresMemoryProvider` and `MemoryManager`;
- deterministic, bounded consolidation of approved candidates with duplicate merging, provenance,
  conflict preservation, supersession, and restart-safe PostgreSQL run records;
- bounded, deterministic multi-statement user capture with review-based or configured automatic
  promotion, provenance, and safe processed-identity replay;
- OpenCode and Pi tools `memory_search`, `memory_status`, and `memory_explain`, plus Pi's
  `before_agent_start` memory injection and optional compaction-context injection;
- logical backup and guarded restore/reset commands; and
- an executable evaluation corpus plus PostgreSQL integration tests in CI on Node.js 22 and 24.

Current host capture observes screened user text, not unrestricted model/tool output. Plain, v2, and
Pi initialization leave capture off unless requested; `remem init --opencode-v1` enables capture and
automatic promotion. Review-based capture keeps candidates pending. A verified-procedure extraction
API also exists, but its production host-outcome wiring remains recovery work. See
[Configuration](docs/configuration.md) for exact defaults, exclusions, and limitations.

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

For a source checkout, point OpenCode at the built v2 package-root entry:

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
OpenCode after changing plugin configuration. Do not use the bare `agentic-remem` package name until
the package is resolvable in your OpenCode installation.

The package root and `./opencode/v2` are v2 entries. OpenCode `1.18.27` compatibility is isolated at
`./server` or `./opencode/v1`; configure it with `remem init --opencode-v1` after installation. It
uses the older, weaker `chat.message` boundary. See [OpenCode integration](docs/opencode-integration.md)
and [the examples](examples/).

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
remem init [--mode managed|external] [--database-url URL] [--opencode|--opencode-v1] [--pi]
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

`remem correction-candidates [--state STATE]` and `remem correction-review <ID> --approve|--reject|--request-changes`
review and act on expert corrections an OpenCode session submitted. Read
[Correction Candidate Review Workflow](docs/correction-workflow.md).

## Semantic Recognition

Managed/external initialization selects local BGE neural embeddings, with the hash model as fallback.
The `remem-local-hash-v1` model is a deterministic 384-dimensional feature hash over words,
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

- [Executable recovery plan](plan/feature-memory-recovery-1.md)
- [GitHub issue audit and proposed updates](docs/ISSUE-AUDIT.md)
- [Product vision](docs/PRODUCT-VISION.md)
- [Target architecture](docs/TARGET-ARCHITECTURE.md)
- [Recovery milestone checklist](docs/IMPLEMENTATION-PLAN.md)
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

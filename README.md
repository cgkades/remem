# Remem

Remem is a memory orchestration plugin for [OpenCode](https://opencode.ai). It helps an agent
recognize when prior knowledge is relevant, route recall across memory providers, and inject a
small, attributed working set instead of dumping a database search into the context window.

Remem is not intended to replace Mem0, Cognee, Obsidian, Markdown notes, session history, MCP
servers, or other memory stores. It is the control plane that teaches OpenCode what can be
remembered and when to look.

```text
recognition -> retrieval planning -> recall -> synthesis -> context injection
```

## MVP

The current MVP provides:

- an OpenCode plugin entry point;
- a dependency-free Markdown provider that can index local directories and Obsidian-style notes;
- a compact, token-budgeted memory catalog;
- deterministic prompt recognition and staged retrieval planning;
- failure-isolated provider queries, deduplication, ranking, and attributed synthesis;
- per-turn context injection through OpenCode's stable `chat.message` hook;
- compact catalog preservation through OpenCode's currently experimental compaction hook;
- `memory_search` and `memory_status` tools;
- structured, content-safe debug traces; and
- behavioral tests for relevant recall, irrelevant prompts, budgets, and failure fallback.

The MVP does not yet include embeddings, an LLM planner/synthesizer, automatic durable writes,
session consolidation, or Mem0/Cognee/MCP adapters. See [`docs/mvp.md`](docs/mvp.md) and
[`docs/future-roadmap.md`](docs/future-roadmap.md).

## Install from Source

Remem has not been published to npm yet.

```sh
npm install
npm run build
```

Reference the built plugin from `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///absolute/path/to/remem/dist/index.js",
      {
        "providers": [
          {
            "type": "markdown",
            "id": "project-notes",
            "paths": [".remem/memory"],
            "scope": "workspace"
          }
        ],
        "debug": false
      }
    ]
  ]
}
```

Paths are resolved from OpenCode's worktree. If no provider is configured, Remem looks in
`.remem/memory` and remains inert when that directory does not exist.

Restart OpenCode after changing plugin configuration.

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

Previous blocker: extension compatibility.
```

See [`examples/`](examples/) for a complete setup.

## Design

- [Architecture](docs/architecture.md)
- [Memory model](docs/memory-model.md)
- [Retrieval pipeline](docs/retrieval-pipeline.md)
- [Provider interface](docs/provider-interface.md)
- [OpenCode integration](docs/opencode-integration.md)
- [Security model](docs/security-model.md)
- [Prior art](docs/prior-art.md)
- [ADRs](docs/adr/)

## Development

```sh
npm ci
npm run check
```

## License

Apache License 2.0. See [`LICENSE`](LICENSE).

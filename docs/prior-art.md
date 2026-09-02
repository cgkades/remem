# Prior Art

Research snapshot: 2026-09-01. Remem studies architectural ideas and public interfaces; it does not
copy implementation code. Implementation status is documented in [MVP](mvp.md); accepted direction
is documented in the [ADRs](adr/).

## Letta and Letta Code

[MemGPT](https://arxiv.org/abs/2310.08560) introduced an operating-system analogy for moving
information between limited model context and larger external memory. Letta's
[memory blocks](https://docs.letta.com/v1-sdk/memory/memory-blocks/) are small labeled sections that
remain visible, while [archival memory](https://docs.letta.com/v1-sdk/memory/archival-memory/) and
conversation recall hold detail outside the active context.

Current Letta Code's [MemFS](https://docs.letta.com/concepts/memfs) uses Git-backed Markdown. A small
`system/` area is injected while paths to other files act as retrieval signposts. Its
[dreaming](https://docs.letta.com/configuration/memory) process uses background agents to consolidate
recent activity. The associated [sleep-time compute paper](https://arxiv.org/abs/2504.13171) frames
consolidation as query-independent work that improves future responses.

Remem adopts the lean always-visible index, external detail, and asynchronous consolidation
principles. It differs by orchestrating memory available to OpenCode rather than providing a full
stateful agent runtime. Letta and Letta Code are Apache-2.0 licensed.

## Mem0

[Mem0's architecture](https://docs.mem0.ai/core-concepts/how-it-works) separates fact extraction,
deduplication, storage, and application-time search. It supports user, agent, run, and metadata
scopes. Its [OpenCode integration](https://docs.mem0.ai/integrations/opencode) adds prompt-time
retrieval, project/session/global scopes, compaction capture, and consolidation around the hosted
service.

This is the nearest direct lifecycle integration, but it orchestrates one memory platform. Remem
keeps capture, planning, retrieval, synthesis, and storage replaceable across providers while now
offering PostgreSQL as its managed default. Mem0's open-source repository is Apache-2.0; hosted
service terms are separate.

## Cognee

No relevant agent-memory project named "Congee" was found. The likely reference is
[Cognee](https://github.com/topoteretes/cognee). Its current high-level operations are
[`remember`](https://docs.cognee.ai/core-concepts/main-operations/remember),
[`recall`](https://docs.cognee.ai/core-concepts/main-operations/recall), `improve`, and `forget`.
Recall performs query routing over session and graph-backed memory; improve consolidates durable
lessons.

Cognee is a sophisticated substrate but does not itself coordinate OpenCode hooks or competing
memory systems. Core code is Apache-2.0; separately licensed production components require review
before integration.

## OpenCode Memory Plugins

- [opencode-mem](https://github.com/tickernelz/opencode-mem) combines local vector storage,
  background extraction, retrieval, and a UI. It is a broad vertical plugin tied to its storage
  choices. MIT.
- [true-mem](https://github.com/rizal72/true-mem) implements short/long-term promotion, decay,
  heuristic filtering, and multi-factor ranking over SQLite. It is an opinionated cognitive engine
  rather than a provider-neutral router. MIT.
- [opencode-plugin-simple-memory](https://github.com/ApplauseLab/opencode-plugin-simple-memory) uses
  transparent daily files, explicit CRUD, deduplication, and conservative hooks. It is a strong
  simplicity baseline. MIT.
- [EchoesVault](https://github.com/psinetron/echoes-vault-opencode) uses Obsidian-style Markdown,
  indexes, daily logs, and ADR-like records. It favors a human-auditable knowledge workflow over
  automatic orchestration. MIT.
- [opencode-lcm](https://github.com/Plutarch01/opencode-lcm) keeps lossless SQLite/FTS session
  history, summaries, lineage, and compaction resume notes. It primarily solves conversation
  continuity. MIT.
- [opencode-agent-memory](https://github.com/joshuadavidthomas/opencode-agent-memory) provides
  Letta-inspired global/project Markdown blocks and an optional semantic journal. MIT.
- [opencode-working-memory](https://github.com/sdwolf4103/opencode-working-memory) reuses OpenCode's
  compaction call to extract durable workspace memory without an extra model request. MIT.

These projects show valuable retrieval, storage, and lifecycle patterns. Remem's distinction is
that providers remain adapters and the main product is recognition and routing policy. Its managed
PostgreSQL provider is one peer behind that contract, not a requirement that external systems copy
their records into Remem.

## Same-Name Project

[`majiayu000/remem`](https://github.com/majiayu000/remem) is an existing, unrelated Rust project for
local-first Claude Code and Codex memory. This project retains the user-selected Remem name but uses
the distinct `opencode-remem` npm identity and documents the difference to reduce confusion.

## MCP and Agent Memory

The [official MCP memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)
offers a local entity/relation/observation graph and basic CRUD/search tools. It demonstrates a
minimal portable tool contract but relies on the model to remember when to call it. MIT.

[mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) combines hybrid retrieval,
typed graph memory, decay, consolidation, scopes, and an OpenCode bridge. It is closer to a vertical
memory platform. Apache-2.0.

[agent-memory-mcp](https://github.com/ipiton/agent-memory-mcp) emphasizes typed engineering memory,
temporal validity, supersession, drift detection, provenance, and reviewable consolidation. MIT.

[Basic Memory](https://github.com/basicmachines-co/basic-memory) uses Markdown as source of truth
and indexes observations and links for lexical, vector, and graph traversal. Its portability and
human readability are relevant, but its AGPL-3.0 license requires care around derivative code.

## Resulting Principles

- Keep recognition memory small and detailed memory external.
- Treat session history, curated knowledge, and always-visible state as separate planes.
- Separate capture, storage, retrieval, ranking, injection, and consolidation policies.
- Make provenance, scope, temporal validity, supersession, and deletion first-class.
- Keep consolidation asynchronous, reviewable, idempotent, and reversible.
- Support lexical retrieval as a reliable local baseline.
- Treat local feature hashing as a bounded fallback, not as a general neural embedding model.
- Bound injected context independently from retained provider data.
- Keep durable writes explicit and authorized; no retrieved text may authorize its own persistence.

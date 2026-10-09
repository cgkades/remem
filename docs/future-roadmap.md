# Future Roadmap

**TARGET expansion, not a list of missing primitives.** Use the
[implementation checklist](IMPLEMENTATION-PLAN.md) and live
[GitHub issues](https://github.com/cgkades/remem/issues) for work selection. Intended behavior comes
from [PRODUCT-VISION](PRODUCT-VISION.md), [TARGET-ARCHITECTURE](TARGET-ARCHITECTURE.md) and accepted
ADRs; [current status](current-status.md) records shipped, tested behavior.

Managed/external PostgreSQL, migrations through 0014, local BGE embeddings and hash fallback,
embedding model tracking/re-embedding, CRUD/supersession, candidate review/consolidation, correction
audit, canonical episodic persistence/retention/forgetting, evidence links, atomic candidate lineage,
server learning policy, bounded startup recovery and the native cross-session investigation gate
already exist. Do not recreate them from older roadmap phases.

## Remaining learning-loop work

- Broader verified outcomes and causal inference beyond the narrow shell recovery grammar.
- Equivalent canonical evidence/outcome mappings for Pi and v1 where their host APIs support them.
- Inspectable persisted learning/backlog diagnostics and guidance for explicit bounded episodic recall.
- Reviewed setup disclosures and source choices before changing capture/admission defaults; preserve opt-outs.
- More complete current-state transitions, conflict and relationship impact handling.
- Bounded topic hierarchy evolution and measured paraphrase recognition after learning.
- Generative-model answer-quality evaluation beyond deterministic context-reader fixtures.
- Recovery guarantees for events lost before evidence persistence, if justified by host replay contracts.

## Quality and operations

- Full immutable embedding compatibility identity, safe legacy eligibility and completed reindex semantics (#45).
- Measure the existing hybrid retrieval baseline before fusion or optional local reranking (#44).
- Larger redacted corpora, precision/context-cost distributions and exact tokenizer adapters where available.
- Validate external PostgreSQL/pgvector version and privilege ranges; improve Windows permission guarantees.
- Pre-operation backup workflows, scheduled backups, encrypted export and representative restore verification.

## Later expansion

Obsidian-specific behavior, Mem0, Cognee, MCP and session-history providers remain extensions behind
the existing capability contract. Optional model planning/synthesis, opt-in sync, team scopes and
richer UI follow core learning correctness. No expansion makes a remote service or model call
mandatory for memory, trusts similarity as truth, or permits generated text to authorize its own
persistence. See [ADR 0014](adr/0014-support-bounded-synthesis-strategies.md) and
[ADR 0015](adr/0015-treat-retrieved-memory-as-untrusted-data.md).

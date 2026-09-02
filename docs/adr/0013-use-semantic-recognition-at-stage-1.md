# ADR 0013: Use Semantic Recognition at Stage 1

- Status: Accepted
- Date: 2026-09-01

## Context

Deterministic and lexical recognition is fast and explainable but misses paraphrases and vague
continuity. Sending every ambiguous prompt to a model planner adds latency, cost, and disclosure.

## Decision

Keep deterministic recognition at Stage 0. At Stage 1, combine lexical evidence with local vector
similarity over bounded catalog titles, aliases, summaries, tags, and provider descriptors. Use the
result to select candidate topics and providers, not detailed memory or factual truth. PostgreSQL
catalog entries can load persisted vectors from pgvector; similarity comparison for recognition runs
in process. Reserve Stage 2 for a future optional model planner when still ambiguous.

Implementation status: Stage 1 uses `remem-local-hash-v1`, a deterministic 384-dimensional feature
hash with character/token features and small concept groups. It is not a general neural embedding
model. Deterministic and lexical recognition remain the fallback.

## Alternatives

- Lexical recognition only: retained as fallback but rejected as the complete target.
- Direct vector search over all memory on every prompt: rejected because it bypasses recognition,
  provider routing, scope, and context controls.
- Mandatory model classification: rejected for local-first privacy, latency, and availability.

## Consequences

- Paraphrased topics can be recognized without a remote model call.
- Embedding model identity, dimensions, versioning, and reindexing must be recorded.
- Thresholds require behavioral evaluation across false-positive and false-negative cases.
- Embedding or vector-index failure falls back to deterministic and lexical recognition.
- Authorization and provider scope filters run independently of semantic similarity.

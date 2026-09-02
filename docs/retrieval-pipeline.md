# Retrieval Pipeline

## Goals

Automatic recall should have high precision, bounded latency, transparent reasons, and no mandatory
model call. The planner must be able to say no.

The end-to-end and provider-routing diagrams are in [Architecture](architecture.md). Planning follows
[ADR 0004](adr/0004-stage-retrieval-planning.md), and semantic Stage 1 follows
[ADR 0013](adr/0013-use-semantic-recognition-at-stage-1.md).

## Stage 0: Deterministic Signals

The deterministic planner checks:

- exact title and alias phrases;
- distinctive title and alias token overlap;
- tag and summary token overlap; and
- continuity phrases such as `last time`, `we decided`, `remember`, `continue`, and `again`.

Generic routing words such as `project`, `service`, `work`, and `migration` do not qualify a topic by
themselves. A continuity phrase boosts an existing match, with a larger boost for unresolved work. If
continuity has no catalog match, the planner can issue a bounded request to each available provider
without claiming a known topic.

## Stage 1: Local Semantic Recognition

The deterministic planner first scores title and alias phrases, token overlap, tags, summaries,
unresolved state, and continuity. If it has no retrieval plan or its confidence is below the default
`0.82` high-confidence boundary, Stage 1 compares the prompt with topic and provider embeddings.

The default `LocalHashEmbeddingModel` is `remem-local-hash-v1`:

- 384 dimensions;
- deterministic signed feature hashing;
- token, character-trigram, and adjacent-token-pair features; and
- small hand-written concept groups for authentication, AWS/Bedrock, PostgreSQL, failures,
  decisions, deployment, and queues/Kafka.

This is not a general neural embedding model. It catches spelling and phrasing variation near those
features, but has limited semantic coverage outside the small concept groups and can suffer hash
collisions. `EmbeddingModel` is an extensible interface, so a caller can inject another model with a
stable ID, dimension count, and `embed()` implementation.

Topic/provider matches at or above the default `0.55` similarity threshold can produce a plan. A
topic match routes only to that entry's configured providers. If no topic qualifies, provider
descriptor similarity can still route to a provider without pretending that a specific memory is
known. Similarity selects candidates; it does not establish truth or bypass scope filters.

The planner emits:

```json
{
  "shouldRetrieve": true,
  "confidence": 0.91,
  "topics": ["Project Phoenix"],
  "requests": [
    {
      "providerId": "project-notes",
      "query": "Project Phoenix database migration",
      "reason": "Project Phoenix: semantic catalog similarity 0.910",
      "limit": 8
    }
  ]
}
```

Thresholds and provider limits are configurable. A no-recall decision still includes the bounded
provider/topic catalog so the model can recognize a topic or use `memory_search` explicitly.

## Stage 2: Optional Planner

Not implemented. A future model planner may run only when deterministic and local semantic signals
are ambiguous. It must implement the same structured plan contract, have timeout/privacy/cost
budgets, and fall back to the existing decision.

## Provider Execution

Planned requests execute concurrently with individual timeouts. The router uses settled results so
one rejected request cannot discard successful provider responses. Scope and workspace context are
passed to every provider.

PostgreSQL combines `plainto_tsquery('simple', query)` ranking with pgvector cosine similarity. It
accepts a vector result at similarity `0.34` or better and orders by the stronger lexical or semantic
score. Markdown remains lexical. Core normalization rejects malformed or out-of-scope results,
truncates each provider body, and then applies the independent synthesis budget.

## Ranking

The current ranker combines bounded signals:

- provider retrieval score;
- catalog/planner confidence;
- scope specificity;
- declared importance;
- freshness and recency; and
- penalties for stale or superseded records.

No signal can transform an irrelevant result into certain truth. Scores are for selection, not
factual confidence.

## Deduplication

Results are first deduplicated by `(providerId, id)`, then by normalized content fingerprint. When
two providers contain equivalent text, Remem keeps one body and preserves duplicate source
references on the ranked result and in selected synthesis. Near-duplicate semantic merging remains
future work.

## Synthesis

The default deterministic synthesizer:

1. orders records by rank;
2. labels topic, freshness, type, and source;
3. takes whole bounded excerpts where possible;
4. stops at the recall budget; and
5. reports omitted result counts without implying they were irrelevant.

It never asks an external model and never silently reconciles conflicts. Both catalog and record
text are XML-escaped, delimited, attributed, and labeled as potentially stale source data rather than
instructions. See [ADR 0015](adr/0015-treat-retrieved-memory-as-untrusted-data.md).

## Token Budgets

Configuration separates:

- `catalogTokens` for always-visible recognition;
- `recallTokens` for synthesized working memory;
- `perProviderTokens` for source balance.

Remem uses UTF-8 byte length as a deliberately conservative upper bound because tokenizer behavior
differs by model. Truncation occurs at code-point boundaries. This underfills context rather than
risking a model-specific tokenizer exceeding the configured soft budget. Exact provider
tokenization can be added behind a model adapter.

When over budget, Remem shortens summaries and excerpts, then drops the lowest-ranked items. It does
not exceed a configured context budget to preserve every result.

## Failure Fallback

Semantic embedding or comparison failure leaves the deterministic plan intact. One provider failure
does not discard another provider's results. If the whole orchestration path fails, Remem returns the
already bounded catalog or no augmentation. Provider failure therefore fails open for the host, not
open across authorization or scope boundaries. See [ADR 0007](adr/0007-fail-open-without-memory.md).

## Behavioral Evaluation

The checked-in evaluation is executable, not a future proposal: 30 catalog entries and 8 prompts
cover relevant paraphrases, continuity, preferences, unresolved work, superseded/current decisions,
and unrelated negatives. It asserts recall, false-positive, budget, latency, provider-failure, and
deduplication thresholds. See [Evaluation](evaluation.md) for exact metrics and limitations.

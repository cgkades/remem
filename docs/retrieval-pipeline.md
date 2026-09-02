# Retrieval Pipeline

## Goals

Automatic recall should have high precision, bounded latency, transparent reasons, and no mandatory
model call. The planner must be able to say no.

## Stage 0: Deterministic Signals

The MVP checks:

- exact or token-level title and alias matches from the catalog;
- tags and retrieval hints;
- paths, service names, and project names represented in the catalog;
- continuity phrases such as `last time`, `we decided`, `remember`, `continue`, and `again`; and
- catalog entries marked as unresolved work.

An explicit continuity phrase raises recall confidence but does not make an unrelated catalog entry
relevant by itself.

## Stage 1: Lexical Routing

Prompt tokens are compared with catalog title, aliases, tags, and summary tokens. Exact phrase and
title matches receive more weight than generic token overlap. Common stop words and one-character
tokens are ignored.

The planner emits:

```json
{
  "shouldRetrieve": true,
  "confidence": 0.91,
  "topics": ["Project Phoenix", "database migration"],
  "requests": [
    {
      "providerId": "project-notes",
      "query": "Project Phoenix database migration",
      "reason": "catalog title and alias match",
      "limit": 5
    }
  ]
}
```

Thresholds and provider limits are configurable. A no-recall decision still injects the bounded
catalog so the model can recognize a topic in later reasoning or use an explicit memory tool.

## Stage 2: Optional Planner

Not implemented in the MVP. A future semantic or model planner may run only when deterministic
signals are ambiguous. It must implement the same structured plan contract, have a timeout and cost
budget, and fail back to the deterministic decision.

## Provider Execution

Planned requests execute concurrently with individual timeouts. The router uses settled results so
one rejected request cannot discard successful provider responses. Scope and workspace context are
passed to every provider.

## Ranking

The MVP combines bounded signals:

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
references on the ranked result and in selected synthesis. Near-duplicate semantic merging is
future work.

## Synthesis

The deterministic MVP synthesizer:

1. orders records by rank;
2. labels topic, freshness, type, and source;
3. takes whole bounded excerpts where possible;
4. stops at the recall budget; and
5. reports omitted result counts without implying they were irrelevant.

It never asks an external model and never silently reconciles conflicts.

## Token Budgets

Configuration separates:

- `catalogTokens` for always-visible recognition;
- `recallTokens` for synthesized working memory;
- `perProviderTokens` for source balance; and
- a future `synthesisTokens` budget for model-backed synthesis.

The MVP uses UTF-8 byte length as a deliberately conservative upper bound because tokenizer behavior
differs by model. Truncation occurs at code-point boundaries. This underfills context rather than
risking a model-specific tokenizer exceeding the configured soft budget. Exact provider
tokenization can be added behind a model adapter.

When over budget, Remem shortens summaries and excerpts, then drops the lowest-ranked items. It does
not exceed a configured context budget to preserve every result.

## Behavioral Evaluation

Unit and integration fixtures cover prior decisions, stale conflicts, unrelated projects, user
preferences, previous failures, and unresolved work. The future evaluation harness will measure:

- relevant recall rate;
- irrelevant injection rate;
- source coverage and provenance preservation;
- estimated and provider-reported injected tokens;
- planner and per-provider latency;
- behavior under provider and synthesis failures; and
- regression sets of real, redacted prompts.

Evaluation should report precision and context cost together. Maximizing recall by injecting
everything is a failure.

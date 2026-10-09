# Deterministic hybrid retrieval quality

Refs #44. `REMEM_TEST_DATABASE_URL=... npx vitest run tests/hybrid-quality.integration.test.ts`
uses the existing destructive disposable-database convention: never target installed memory.
It seeds the current 30-entry evaluation corpus through the real PostgreSQL provider, adds exact
identifiers and preserves current/superseded facts and foreign project/session controls.
Eight existing cases and six labeled holdout cases measure actual provider recall@5, precision@5,
MRR, relevant injection, false injection, estimated context tokens and latency.

The offline RRF comparison reuses the exact executed provider SQL and its scoped, freshness- and
model-filtered candidate union, expands only the final presentation limit, then fuses lexical and
semantic ranks with constant 60. This isolates candidate ordering; it does not alter production
injection or establish cross-encoder quality. Existing recall re-ranks candidates, so a production
fusion change would also need evaluation through that layer.

The model is the deterministic local hash backend. Neural quality remains in the separate optional
evaluation suite. Persisted JSON reports contain fixture labels, scores, reason codes and numeric
measurements, with no raw prompts, memory bodies or connection strings. Artifacts are retained by CI.
Embedding-outage lexical availability, provider fail-open behavior, cancellation, supersession,
scope exclusion, unrelated non-injection and configured budgets/deadlines remain test gates.

The measured comparison and resulting ranking decision will be recorded after the baseline runs.

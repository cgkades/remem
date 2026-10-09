# Episodic query comparison

Refs #89 and #87. `node scripts/benchmark-episodes.mjs` requires
`REMEM_TEST_DATABASE_URL`. It creates connection-local temporary tables only, reads no stored
memory and changes no installed schema. The fixture reproduces the current episode columns,
generated text vector, primary key, scoped partial index and GIN text index.

Compare the original scoped window-before-filter query, the proposed complete window-order
partial index, and a search-first query with at most one same-session neighbor on each side.
Run sparse, dense and absent queries over 5,000 and 50,000 scoped events plus 2,000 foreign events,
with 500-event sessions and equal timestamps. All returned match/neighbor identities must agree
before timing. Measure 20 warmed client round trips, p95, EXPLAIN ANALYZE BUFFERS, temporary I/O,
node types, index build time and index/table size. Complete plans are in
`artifacts/episode-query-benchmark.json`; CI retains the artifact.

This is a synthetic local PostgreSQL baseline, not production latency or a recall-quality
evaluation. Temporary relation buffer counts appear as local buffers. Query-plan measurements are
informational; correctness and scope remain gates. The selected production change and measured
tradeoffs will be recorded after the comparison runs. No new index migration is proposed yet.

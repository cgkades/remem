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

## Selected change

CI run 37987793309 compared all four plans. For 50,000 scoped plus 2,000 foreign synthetic events:

| Query | Original window p95 ms | Window + composite index | Search first, existing indexes | Search first + composite index |
| --- | ---: | ---: | ---: | ---: |
| Sparse | 147.58 | 71.26 | 3.01 | 3.28 |
| Dense | 236.88 | 174.97 | 119.51 | 99.24 |
| Absent | 146.76 | 75.52 | 2.70 | 2.84 |

The original plan used Seq Scan, Sort and WindowAgg, spilling 2,933 read / 2,939 written
temporary blocks. The composite index removed that window sort/spill but still visited the scoped
history. Search first used GIN bitmap lookup for sparse/absent cases and a scoped scan for dense
queries, then at most ten pairs of scoped index neighbor probes. It eliminated the window spill.
Sparse local block visits fell from 3,250 reads to 432 hits; dense search still read about 3,253
blocks, so it remains proportional to the matching corpus. The optional index's modest dense-case
benefit did not justify another index, storage/write overhead and a deployment dependency on #87.

Select search first with existing indexes. Match ranking, completion preference, current-session
exclusion, roles and output budgets remain unchanged. Neighbor probes include all evidence roles
and pin provider, project and session; tuple comparisons preserve the original timestamp/UUID tie
ordering. Explicit no-neighbor and automatic recall skip neighbor probes. No applied migration is
edited and no new index is created. #87's historical table-rewrite/index deployment concern remains.

These are 20 warmed client samples on one CI runner with temporary synthetic tables, not measured
installed-memory p95. At 5,000 scoped events the sparse comparison was 16.31 to 2.05 ms. Full plans
and index size/build costs are retained in the artifact; rerun on representative installations
before claiming a production SLO. No model-dependent memory quality claim follows from this result.

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

## Measured recovery decision

Run [38097518316](https://github.com/cgkades/remem/actions/runs/38097518316) at
`a5e1c1f3a7550e095bf9e4d0cca88d6348189d65` executes the same real PostgreSQL corpus
through the original candidate union and a bounded topic-candidate extension. Its body-free
report is retained in `docs/evidence/hybrid-quality-ci-38097518316.json`.

| Measure                          | Original / topics suppressed | Topic-aware extension |
| -------------------------------- | ---------------------------: | --------------------: |
| Direct candidate recall@5        |                         0.90 |                  1.00 |
| Direct precision@5               |                       0.6233 |                0.5900 |
| Direct candidate MRR             |                         0.85 |                  0.95 |
| Relevant automatic injection     |                         0.80 |                  0.90 |
| Unrelated automatic injection    |                          0/4 |                   0/4 |
| Maximum estimated context tokens |                        2,286 |                 2,286 |
| Dispatch p95 ms                  |                           13 |                     6 |

Original direct precision@5 is 0.6233. Offline RRF is identical to the original union on
recall/precision/MRR; therefore neither production fusion nor a cross-encoder changes.
Topic candidates recover the recognized streaming-cutover alias missed by full-prompt search.
The recovered branch's initial 0.91 topic score also displaced a previously successful Kafka
answer: aggregate injection remained 0.80, hiding a per-case regression. Reduce this fallback
score to 0.50 and require every previously recalled answer to survive; the actual after result
is 0.90 with eight non-target selected records rather than nine. Topic candidates retain the
same provider/project/workspace/session, freshness and requested type/scope filters. Reasons
distinguish topic lookup from full-text/vector matches without exposing bodies.

These 14 labeled cases (10 relevant, four unrelated) are now regression/development data,
including six cases originally held out. They are not an untouched final holdout after reviewing
and tuning the fallback. The one remaining relevant miss is `exact-timezone`: provider search
finds the record, but automatic recognition does not route it. Non-target selections on related
prompts remain a precision limitation; zero unrelated injection does not mean every selected
record was relevant. Candidate p95 was 4.85 ms in this small warmed run; the apparent dispatch
speed difference is order/cache/runner-dependent and is not evidence of a latency improvement.

Embedding-outage lexical recall, provider failure isolation, cancellation, forged-topic scope
and supersession exclusion are unskipped PostgreSQL gates. The existing native host and separate
neural suites run independently. Broad unseen paraphrase quality, neural/post-rerank quality,
production-size latency and semantic answer correctness remain separate work under #44/#45.

The topic-aware direct precision@5 is 0.5900 (original 0.6233): recovering a missed
relevant record adds candidates and lowers precision on this single-target labeling. This
tradeoff is explicitly retained alongside higher recall/MRR and the no-per-case-loss injection
gate; it does not justify claiming a broad ranking-quality improvement.

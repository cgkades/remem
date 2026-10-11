# Hybrid retrieval quality acceptance (#44)

Base comparison: `0dc565310475964c7c2ac030dda4a31b4c7ee664`. Benchmark run [38099164079](https://github.com/cgkades/remem/actions/runs/38099164079); body-free numerical evidence: `docs/evidence/retrieval-validation-38099164079.json`.

ReMem already had lexical/vector union, scope filtering and ranking helpers. PR #114 measured that baseline and compared offline RRF: recall/MRR tied existing fusion, so it did not introduce a cross-encoder or a new fusion dependency. Its 14 cases were inspected/tuned and are regression data. This follow-up fixes the missed complete structured ID (`resolved-test`) and avoids weak partial-topic expansion when an explicit catalog title, alias or structured ID names the intended topic. Automatic PostgreSQL recall then admits the recognized titles. Manual/broad searches retain hybrid candidates. Multiple explicitly named topics remain available; no body text establishes an identifier match.

## Fresh validation

The separate 12-case fixture was frozen before its first PostgreSQL run. It has eight relevant prompts (including one naming two topics), four negative prompts, 10 labeled records including a superseded record and an identically titled foreign-project record, plus 5,000 stored background records and vectors. It uses both deterministic hash and the real pinned BGE model. A copied baseline planner preserves base-main behavior; the baseline provider call disables only the new automatic catalog restriction. Every injected identity, including background records, counts in precision and unwanted selection metrics.

| Measured behavior                                                   | Hash before → after | Neural before → after |
| ------------------------------------------------------------------- | ------------------- | --------------------- |
| Mean relevant candidate recall@5                                    | .875 → 1.00         | .625 → 1.00           |
| Mean relevant candidate precision@5                                 | .875 → 1.00         | .125 → 1.00           |
| Mean relevant candidate MRR (first relevant for multi-topic prompt) | .875 → 1.00         | .625 → 1.00           |
| Mean automatic relevant recall                                      | .75 → 1.00          | .50 → 1.00            |
| Automatic non-target selections                                     | 0 → 0               | 31 → 0                |
| Negative-prompt automatic injections                                | 0/4 → 0/4           | 0/4 → 0/4             |
| Maximum estimated catalog + recall tokens                           | 1,978 → 1,978       | 2,604 → 1,978         |
| Candidate timing, max per-case observed p95                         | 6.19 → 6.17 ms      | 46.01 → 20.80 ms      |

Timing includes inference and the candidate query, with 10 warm samples per case, paired baseline/current measurements on one shared CI runner. The reported p95 aggregation is the maximum across case p95s, not a production latency guarantee or a cold model-load measurement. The catalog holds the labeled topics; the background records stress the provider query rather than a 5,000-topic catalog. This adversarial repeated inventory background exposes candidate pollution, but is not a representative production distribution.

No baseline success regresses. All expected automatic excerpts are selected with precision 1.0 in the fresh set. Direct forced searches still return neural neighbors for three negative cases; recognition rejects those prompts before automatic recall. A manually forced search is therefore not evidence of safe automatic injection. Neither forced-search neighbors nor timing prove model understanding.

## Regression and security behavior

On the older 14-case hash corpus, automatic relevant injection improves .90 → 1.00 compared with the merged #114 evidence; unwanted selections fall 8 → 3. All four unrelated prompts remain uninjected. Direct broad hybrid metrics remain recall@5 .90/MRR .85; topic-aware candidate metrics remain recall@5 1.00/MRR .95. The exact-timezone case now recalls its expected memory. Weak/non-explicit routing still permits three non-target selections, so retrieval is not universally precise.

Scope/supersession checks, forged topic requests, embedding-outage lexical service, fail-open provider failure, cancellation and body-free ranking reasons remain covered by real PostgreSQL tests. The full suite also checks credential protection, prompt injection, institutional applicability and native hosts. Ranking reasons describe the signal and score rather than copying memory bodies.

The measured recognition/selection change meets #44's benchmark and improvement acceptance without adding a mandatory neural dependency or an optional cross-encoder whose material benefit has not been demonstrated. The fresh set is now inspected validation/regression data, not an independent blind holdout for future tuning. General low-overlap entity inference, weak-match precision, larger/distributed catalogs, cold-load costs and real-user quality remain limitations to measure in future development; these results do not establish universal retrieval accuracy.

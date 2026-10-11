# Remaining issue development checkpoint

Current base: main `0dc565310475964c7c2ac030dda4a31b4c7ee664`.
Current branch: `fix/retrieval-recognition`; current commit is the containing commit.

## Completed implementation awaiting verification

- #44: recognize whole structured title/alias identifiers; explicit phrase/identifier matches suppress incidental partial topic matches.
- For explicit recognized matches, automatic PostgreSQL recall admits only the recognized catalog titles. Broad explicit/manual searches and low-confidence continuity routing retain hybrid candidates. All scope/supersession filters remain before selection.
- Frozen baseline planner from base main and fresh validation corpus; compare baseline/current selection with real hash and neural embeddings and 5k background rows. Required neural CI now includes PostgreSQL; fallback must fail this acceptance benchmark.
- Unit coverage for whole IDs, non-prefix recognition, multiple explicit topics.

## Pending verification

- Full local checks, real PostgreSQL regression results, fresh neural/hash benchmark, native host gates. Inspect every failure and archive numerical evidence before merging #44.
- Evaluate remaining unwanted selections and per-case recall, not just aggregate improvement. Fresh fixture is validation, not a claim of blind generalization; once inspected/tuned it becomes regression data.

## Next actions

1. Finish verification and measured report for #44; merge only if acceptance is supported.
2. #45: canonical embedding-space fingerprints, persisted query/document compatibility, fail-closed legacy vectors with lexical availability, staged reindex coverage/cutover and interrupted recovery tests. Reuse durable claims and existing operator commands. No applied migration edits or security/default changes.
3. Combined host/learning validation, accurate docs, close substantiated issues and update this checkpoint with exact accepted commits.

## Retrieval acceptance evidence

Run 38099164079: fresh real PostgreSQL hash/neural comparison measures candidates and automatic selections, counts background distractors, preserves every baseline success and rejects all four negative prompts. Hash automatic recall .75→1; neural .50→1, unwanted neural selections31→0. Existing 14-case regression automatic recall 1.0, non-target3 (previous8). Exact timezone ID fixed. Numerical evidence and actual limits in docs/retrieval-quality-completion.md. Latest source commit is recorded in the evidence file; this commit adds documentation only. Await all nine job conclusions and then merge #116; #45 remains underway separately in #117.

## Final disposition (October 11)

#116 merged as `1b74daf2a4bbbdca6b5f91133116534a8f613ec0`; #44 closed. #117 merged as `49e91facdd5446d7d2ec28694c601a6d8039e08b`; #45 closed. All 774 tests with real PostgreSQL and all nine combined/final jobs passed. The live issue/PR lists are empty; no acceptance verification remains pending. Current authoritative handoff: `plan/RECOVERY-CHECKPOINT.md`. Earlier pending sections above are historical.

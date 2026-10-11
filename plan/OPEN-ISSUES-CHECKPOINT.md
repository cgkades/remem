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

# Embedding compatibility development checkpoint

Base main `0dc565310475964c7c2ac030dda4a31b4c7ee664`. Branch `feat/embedding-fingerprints`; current commit is the containing commit.

Implemented, awaiting verification: canonical paired-space identities, built-in/fallback/offline asset identity, query/document encoder helpers, persisted fingerprints and fail-closed similarity comparisons, migration 0015, staged provider-isolated reindex with durable claims and atomic full-coverage cutover, source-change protection, missing-vector recovery, cancellation, diagnostics and operator guide.

Tests cover same-label/dimension cross-generation mismatch, lexical availability, asymmetric encoders, unknown legacy/missing vectors, provider isolation, staged batches, interrupted claims, source changes, cancellation, inference failure and real transaction rollback/reuse after interrupted cutover. Existing tests are being updated where they assumed immediate per-batch replacement or label-only compatibility.

Pending: full local check; real PostgreSQL execution and inspect all failures; merge latest #44 branch into this PR without losing bounded recall or the required neural benchmark; update 5k fixture writes with fingerprints; all native OpenCode/Pi, fresh-session learning and benchmark checks; measured report and durable final evidence. Do not merge from CI alone or close #45 before the behavioral cases pass.

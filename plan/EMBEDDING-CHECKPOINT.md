# Embedding compatibility development checkpoint

Base main `1b74daf2a4bbbdca6b5f91133116534a8f613ec0` (#116 merged and #44 closed). Branch `feat/embedding-fingerprints`; current commit is the containing commit.

Implemented, awaiting verification: canonical paired-space identities, built-in/fallback/offline asset identity, query/document encoder helpers, persisted fingerprints and fail-closed similarity comparisons, migration 0015, staged provider-isolated reindex with durable claims and atomic full-coverage cutover, source-change protection, missing-vector recovery, cancellation, diagnostics and operator guide.

Tests cover same-label/dimension cross-generation mismatch, lexical availability, asymmetric encoders, unknown legacy/missing vectors, provider isolation, staged batches, interrupted claims, source changes, cancellation, inference failure and real transaction rollback/reuse after interrupted cutover. Existing tests are being updated where they assumed immediate per-batch replacement or label-only compatibility.

Pending: full local check; real PostgreSQL execution and inspect all failures; merge latest #44 branch into this PR without losing bounded recall or the required neural benchmark; update 5k fixture writes with fingerprints; all native OpenCode/Pi, fresh-session learning and benchmark checks; measured report and durable final evidence. Do not merge from CI alone or close #45 before the behavioral cases pass.

First real PostgreSQL run38099296493: all six new fingerprint/cutover behavior tests pass. Four existing tests fail because they assume cross-provider maintenance or label-only coverage; historical lineage fixture incorrectly uses new provider SQL against schema12. Fixes: configure CLI test with seeded provider, actually rebuild hash fallback corpus before claiming compatible coverage, explicitly persist fingerprint in settings fixture, seed historical layout with historical SQL. Optional embedding SQL now has a savepoint so a vector-storage failure cannot abort the retained-source write. Neural backend identity includes actual library/runtime versions. Pending next real run and integration of #116.

Integrated verified #116/main without losing catalog-only recall; query now binds catalog gate as parameter15 and fingerprint as16. Five-thousand-row neural/hash benchmark background vectors are explicitly fingerprinted. Added content-digest relocation/change-race tests and real PG optional-vector SQL rejection test. Current commit is containing commit; awaiting new all-nine-job run, with no merge approval claimed yet.

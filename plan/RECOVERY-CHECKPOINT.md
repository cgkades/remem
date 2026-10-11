# Recovery checkpoint — October 10, 2026

GitHub is authoritative. Refresh main, PR heads, issues and CI before resuming.

## Recovered state

- Main: da886e1728e9b0f52397d0b2ca2028de4beb0bad.
- PR #113: perf/episodic-search-first, audited head 95ef5227fac91cd2a368ad26fdb4a33a601bbf77; 7 commits ahead, none behind main. Search-first SQL already implemented. No review comments. Run 37989515031 passed eight jobs, including real PostgreSQL benchmark/API tests and native hosts. Artifact 11644376853 inspected: 50k sparse p95 147.66 → 3.27 ms, dense 267.67 → 119.70 ms, absent 156.09 → 2.78 ms; identity equality precedes timing. No index added. Synthetic warmed temporary-table results, not production SLOs.
- PR #114: test/postgres-hybrid-quality, audited head f556adf3e7b324329e957de46c9893190c5068ab; 4 ahead, none behind main. Includes bounded scoped catalog-topic candidates and quality fixture. No review comments. Run 37989452343 failed Node 22 container initialization because Docker Hub rate-limited the image pull, before checkout. Other seven jobs passed. Artifact 11643949125 inspected: candidate recall@5 .90, MRR .85, relevant injection .80, unrelated injection 0/4. Offline RRF ties existing ranking. This is deterministic hash evidence, not neural quality.
- Open issues: #44, #45, #87, #89. #46 is a closed PR, not an unfinished issue; do not duplicate it.
- No uncommitted changes in surviving previous checkout. Main already includes learning policy/lineage/startup recovery, native v2 investigation gate, and Pi parity/guidance/status. Old planning ledgers are historical.

## Current work / next actions

This file's branch is PR #113; the containing commit records current progress.

1. Review query/API coverage and retain exact audited benchmark evidence durably; rerun required checks after any changes. Resolve #113 only after verification.
2. Add measured before/after injection comparison and honest limits to #114; rerun failed Node 22 checks without bypass. RRF/cross-encoder changes have no supporting evidence.
3. Implement #87 explicit resumable nontransactional steps, checksum/crash/concurrency/lock tests and existing-installation procedure. Never edit applied SQL history or weaken default transactional migration semantics.
4. Run installed native-host fresh-session acceptance with PostgreSQL, including unsafe/unsupported rejection and recovery; distinguish tool-verified narrow procedures from original-user causal assertions and model inference.
5. Record final supported slice, remaining gaps and blockers; address #45 only if safe and verified.

## Constraints / pending verification

No force push, test bypass, capture-default change, security weakening or npm publication. Merge only accepted verified changes; close issues only after merged evidence satisfies the full criteria. Local runtime currently lacks Docker/PostgreSQL; GitHub disposable pgvector CI is available. Matching package-lock dependencies survive in the previous checkout, but no prior execution result is assumed. Optional model-backed inference requires a configured model and is not established by deterministic fixtures.

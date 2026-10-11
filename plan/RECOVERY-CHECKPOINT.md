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

## Superseding progress update

- #113 merged as 68f20eb7eb4f4d2c3d8b26da2528ebc9bbd47911 after run 38097076698 passed all eight jobs. #89 closed. Complete original query plans are permanently preserved in docs/evidence/episodic-query-ci-37989515031.zip.
- #114 integrated current main without force push, preserving both benchmark jobs. The original 0.91 topic score recovered one case but lost a previously recalled Kafka answer. A per-case gate caught that regression. Bound fallback to 0.50: candidate recall@5 .90→1.00, MRR .85→.95, relevant automatic injection .80→.90, unrelated injection 0/4, direct precision .6233→.5900. All nine jobs passed at a5e1c1f3a7550e095bf9e4d0cca88d6348189d65 (run 38097518316). Report preserved in docs/evidence/hybrid-quality-ci-38097518316.json. Current documentation-only commit still requires its own CI before merge. #44 remains open for recognition miss/non-target quality and broader validation; RRF ties baseline, no neural dependency added.
- #87 implemented in draft #115, branch feat/resumable-concurrent-index, latest head 1271e8fc5f9935371d96ad9151e5167b52f4d6c4. Real PostgreSQL tests exposed a concurrent-index/advisory-lock virtual-transaction deadlock; fixed using nonblocking lock probes. Check run 38097610637 and plan/CONCURRENT-MIGRATION-CHECKPOINT.md before merging. Existing numbered migration SQL/default transactions remain unchanged.
- #46 confirmed already merged; no duplicate implementation. #45 remains open and unimplemented.
- Native installed v2 cross-session gate passed five fresh sessions without prior transcript: required recall 1.0, procedure/provenance correct, unsupported assertions/false injection 0. Tool evidence proves only native-shell missing-file recovery; the causal conclusion is an original-user assertion. Model-inferred causal learning and generative quality remain unverified.

Next: finish #114 documentation CI/merge, resolve #115 database/host gates and merge if accepted, then validate integrated main and write final supported-behavior evidence/checkpoint. Never close #44/#45 from a narrow fixture result. Local checks pass after removing proxy environment variables; PostgreSQL tests are skipped locally, so acceptance relies on unskipped disposable CI runs. No npm publication/default change/test bypass/security weakening occurred.

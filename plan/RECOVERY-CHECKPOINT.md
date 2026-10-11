# ReMem recovery checkpoint — October 10, 2026

GitHub is authoritative. Refresh main, PR heads, issues and CI before resuming. The containing
commit identifies this checkpoint's exact branch/commit; do not trust an earlier Work session.

## Completed work

- Audited refreshed main `da886e1728e9b0f52397d0b2ca2028de4beb0bad`, all PRs/issues/branches,
  architecture/ADRs, harnesses, reviews, CI and downloaded benchmark artifacts. Surviving old
  checkout had no uncommitted changes. #46 is already merged; no duplicate was built.
- #113 merged as `68f20eb7eb4f4d2c3d8b26da2528ebc9bbd47911`; #89 closed. Run 38097076698
  passed all eight jobs. Sparse p95 147.66→3.27 ms at 50k synthetic scoped events, with identity
  equivalence and no new index. Full plans: `docs/evidence/episodic-query-ci-37989515031.zip`.
- #114 merged as `ffaadb70aebecb07c6009287a06a2b904c629450`, current main at integration.
  Run 38097702520 passed all nine jobs. A high topic score hid a per-case Kafka regression;
  the bounded .50 fallback/per-case gate preserves baseline successes. Direct recall@5 .90→1.00,
  MRR .85→.95, injection .80→.90, precision .6233→.5900, unrelated injection 0/4. RRF ties
  baseline. Report: `docs/evidence/hybrid-quality-ci-38097518316.json`; no neural dependency added.
- Native v2 five-session learning gate passed without old transcripts/memory commands: required
  recall 1.0, correct procedure/provenance, unsupported/false injection 0. Durable evidence:
  `docs/evidence/recovery-native-learning-38097702520.json`. Root cause is original-user
  authority; native tools verify only missing-file check/create/recheck.

## Current branch and verification

Branch `feat/resumable-concurrent-index`, PR #115. Verified source head before integration:
`dc6f2a986e183f8af7193e2451b297ac9840bf13` (all eight jobs passed in run 38097812339).
The containing commit merges current main/#114 and records this final report/checkpoint.

#87 implements literal-true operator opt-in, immutable single-index statements, checksum/ownership
receipts, invalid-index retry, completed-build reuse, atomic ledger finalization, bounded waits and
doctor/operator diagnostics. Six real PostgreSQL migration regressions pass. A real advisory-lock/
virtual-transaction deadlock was found and fixed with nonblocking probes and waits outside SQL.
See `plan/CONCURRENT-MIGRATION-CHECKPOINT.md` and `docs/recovery-validation-2026-10-10.md`.

Local checks use matching lockfile dependencies. Initial proxy-environment test assumptions failed;
with proxy variables unset, local format/lint/types/unit/build pass. Database tests skip locally
because only root is mapped. Acceptance uses unskipped disposable PostgreSQL CI, not those skips.

## Pending verification and next actions

1. Inspect the containing commit's combined Node 22/24 PostgreSQL, native OpenCode v1/v2, Pi,
   episodic/hybrid benchmark and neural jobs. Inspect failures, six migration recovery/locking
   tests and native fresh-session metrics before merging #115 or closing #87. If already merged,
   refresh actual main and do not repeat the implementation.
2. Keep #44 open: exact-timezone automatic recognition miss, non-target selection quality,
   untouched validation data and broader neural/production-size evidence remain.
3. #45 remains open/unimplemented: complete immutable embedding-space fingerprints and staged
   reindex/cutover recovery. Existing model/dimension matching and durable reembedding claims
   must be reused rather than duplicated.
4. General model-inferred causal learning/generative quality remain undeveloped or unmeasured.
   No configured generative model was tested. Deterministic context reading and original-user
   assertions are not independent inference verification.

## Constraints and persistent limits

No force push, failing-gate bypass, capture-default change, security weakening or npm publication.
Existing numbered SQL/default transactions remain unchanged; no production index was added.
Migration 0008's stored-column rewrite still needs maintenance. Evidence can compact/expire;
callbacks lost before persistence lack a durable outbox. This verifies supported deterministic
slices, not production SLOs, arbitrary poisoning resistance or the broader product milestone.

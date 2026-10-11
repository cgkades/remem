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

## Completed integrated verification

#115 merged as `2585bdd98b6d3539f60492e589ac8417d1add59b`; #87 is closed. Main's tree
was verified identical to accepted source head `ef545b6af3cc3eb46c376e4dae87b8bbdc6c82f5`.
Run 38098052171 passed all nine jobs. Node 22/24 each passed 757 tests in 56 files with
real PostgreSQL and no skips, including six migration interruption/concurrency/lock regressions.
Native OpenCode v1/v2, Pi, package checks, both benchmarks and neural evaluation passed.

Native v2 again passed five fresh sessions without prior transcript/memory commands: recall 1.0,
correct procedure/provenance, unsupported/false injection 0, 4201-byte max context, observed
host dispatch p95 89.19 ms. Evidence: `docs/evidence/recovery-native-learning-38098052171.json`.
These are deterministic fixture results, not model inference or production latency promises.

#87 includes literal-true operator opt-in, immutable single-index statements, checksum/ownership
receipts, invalid-index retry, completed-build reuse, atomic ledger finalization, bounded waits
and doctor/operator diagnostics. The measured virtual-transaction deadlock was fixed using
nonblocking lock probes. No pending implementation verification or recovery blocker remains for
#113/#114/#115. Initial failures were inspected and fixed, never bypassed.

This final checkpoint is a documentation-only update on `main`, based on verified merge commit
`2585bdd98b6d3539f60492e589ac8417d1add59b`. Its containing commit is the current checkpoint
commit; resolve actual HEAD with GitHub/git before further work. Local final documentation
formatting checks pass; code is unchanged from the fully verified source above. Historical branch
`feat/resumable-concurrent-index` contains the accepted implementation and checkpoints.

## Next work and remaining issues

- #44 remains open: exact-timezone automatic recognition miss, non-target selection quality,
  independent untouched validation data and broader neural/production-size evidence. The
  benchmark cases already reviewed/tuned are regression data, not blind validation.
- #45 remains open/unimplemented: complete immutable embedding-space fingerprints and staged
  reindex/cutover recovery. Reuse existing model/dimension matching and durable claims. Design
  the compatibility contract and test mismatch/query-document asymmetry/fallback/interruption
  against PostgreSQL before introducing a cutover or declaring reindex completion.
- General model-inferred causal learning and generative answer quality remain undeveloped or
  unmeasured. No configured generative model was tested. Original-user assertions and a
  deterministic context reader are not independent causal verification.
- Next agent should refresh GitHub, read current architecture/ADRs and these preserved evidence
  reports, then select a bounded #44 or #45 acceptance gap. Do not duplicate the three merged PRs.

Local checks use matching lockfile dependencies. Initial proxy-environment tests failed on existing
shared-state assumptions; with proxy variables unset, local checks pass (605 tests / 152 database
skips on the combined source). PostgreSQL cannot run safely locally with only a mapped root UID;
acceptance uses the unskipped disposable CI counts, not local skips.

## Constraints and persistent limits

No force push, failing-gate bypass, capture-default change, security weakening or npm publication.
Existing numbered SQL/default transactions remain unchanged; no production index was added.
Migration 0008's stored-column rewrite still needs maintenance. Evidence can compact/expire;
callbacks lost before persistence lack a durable outbox. This verifies supported deterministic
slices, not production SLOs, arbitrary poisoning resistance or the broader product milestone.

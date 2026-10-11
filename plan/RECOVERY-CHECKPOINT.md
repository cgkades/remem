# Durable ReMem progress checkpoint

Continuation authorized after this recovery: new core issues #118–#125 are tracked in `plan/DEVELOPMENT-CHECKPOINT.md`; #118 implementation/verification is in draft PR #126. The empty-backlog statement below describes the prior completed checkpoint, not the new backlog. Refresh GitHub before resuming.

Updated October 11, 2026. Branch: `main`. Verified implementation merge: `49e91facdd5446d7d2ec28694c601a6d8039e08b`.
The containing commit is the current documentation checkpoint; refresh GitHub/git HEAD before resuming.
This update changes documentation only. Accepted PR #117 head `0806bace6c318f90b396082f92e1e9c78e447023`
has the same implementation as final measured source `4bc3510ab9e273e091c391618ac96d6db0787341`.

## Completed work

| Work                                                                | Persisted completion                                         | Evidence                                                                                                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #113 / #89: episodic search-first optimization                      | Merge `68f20eb7eb4f4d2c3d8b26da2528ebc9bbd47911`; #89 closed | 5k/50k query identity checks, plans/buffers, latency and index-cost report; `docs/episodic-query-performance.md` and retained ZIP                                           |
| #114: hybrid candidate quality baseline and bounded topic fallback  | Merge `ffaadb70aebecb07c6009287a06a2b904c629450`             | Real PostgreSQL before/after, per-case non-regression, RRF comparison; `docs/hybrid-retrieval-quality.md`                                                                   |
| #115 / #87: resumable opt-in concurrent index migrations            | Merge `2585bdd98b6d3539f60492e589ac8417d1add59b`; #87 closed | Real ownership/checksum/invalid-index/ledger-failure/termination tests; nonblocking advisory probes fix measured deadlock                                                   |
| #116 / #44: exact-ID recognition and explicit automatic selection   | Merge `1b74daf2a4bbbdca6b5f91133116534a8f613ec0`; #44 closed | Fresh 12-case 5,010-row hash/real-neural comparison and preserved baseline successes; `docs/retrieval-quality-completion.md`                                                |
| #117 / #45: embedding fingerprints and full-coverage staged reindex | Merge `49e91facdd5446d7d2ec28694c601a6d8039e08b`; #45 closed | Seven real PG cutover/recovery cases, paired encoder/fallback/offline digest controls, required actual-neural and native gates; `docs/open-issues-validation-2026-10-11.md` |

#46 was an already-merged PR, not an unfinished issue. GitHub's open issue/PR lists were refreshed;
no currently open issues or PRs remain after these verified merges. Historical branch checkpoints
preserve intermediate failures/decisions; this file is the current handoff.

## Completed verification

- Accepted source run 38100705774 and final documentation run 38100944479 each pass all nine jobs.
  Node 22/24 each pass 774 tests in 59 files with real PostgreSQL, zero skipped. Format/lint/types,
  build, package dry-run/smoke, episodic plans, hybrid regression, native OpenCode v1.18.27/v1.18.29/package,
  v2 beta, Pi adapter and Pi Docker gates pass.
- Required actual-neural artifact inspected:7 passed, zero failed/pending. A prior startup fallback
  correctly failed the required gate; its cause was not established. Added redacted diagnostics and
  serialized shared-cache evaluation; no fallback/skipped run is substituted for neural acceptance.
- Fingerprinted 5k hash/neural fixture: every baseline success preserved, expected automatic recall
  and precision 1.0, negative injection 0/4, neural unwanted excerpts 31→0. Existing 14-case regression
  unwanted excerpts 8→3 and relevant injection .90→1.00. Timing varies; no consistent speedup/SLO claim.
- Five fresh native v2 sessions again receive no prior transcript or manual memory commands:
  recall 1.0, correct answer/procedure/provenance, unsupported assertions and false injection 0,
  maximum 4,201-byte recall context. Deterministic context-reader/host-evidence proof, not generative
  causal inference. Source, numeric results and limits are permanently retained in
  `docs/evidence/open-issues-validation-38100705774.json`.
- Consecutive/concurrent neural loads serialize and restore shared loader settings; remote loads
  reject unidentified local assets and preserve external remote-download prohibitions.
- Same-label/dimension mismatch cannot enter returned similarity candidates. Unknown legacy vectors
  remain lexical. Both vector surfaces stage and promote atomically only at full retained-source
  coverage; expired claims, source drift, cancellation, inference/SQL/cutover failure and retry are tested.

## Pending verification and blockers

None for the closed issue acceptance contracts. Existing installations still need standard migration 0015
and `remem reembed` until `coverage.cutover` is completed; settings or batch completion alone is not
compatible corpus coverage. No user production database or npm registry was modified.

Local database tests skip because the container only maps root and cannot safely run PostgreSQL.
Acceptance uses the unskipped disposable CI evidence. The inherited proxy environment makes two
local proxy tests order-dependent; all the same tests pass when those ambient variables are removed.
All inspected implementation failures were resolved; gates were not bypassed.

## Next actions and supported limits

1. Refresh GitHub state, read current architecture/ADRs and the preserved evidence before new work.
   Do not duplicate the five merged PRs or infer unpersisted state from this Work session.
2. Choose a new bounded product requirement if development continues: general model-inferred learning,
   broader host evidence/Pi parity, persisted learning diagnostics or catalog evolution. These are
   beyond the completed issue contracts and remain incomplete/unmeasured.
3. Preserve capture/admission defaults and authority boundaries. Keep 384-dimensional compatibility,
   explicitly version changed embedding algorithms/assets and use consistent intended worker configuration.
   Old differently configured processes become lexical-only after cutover; historical stages can use disk.
4. Treat warm fixture latency/precision as measured samples, not production guarantees or blind
   generalization. Evidence can expire/compact; callbacks lost before persistence lack a durable outbox;
   content filters are conservative protections rather than arbitrary poisoning resistance.

No force push, failing-test bypass, capture-default change, security weakening or npm publication.
Applied SQL history remains immutable. Concurrent index work does not remove migration 0008's
maintenance requirement; no unmeasured production index was added.

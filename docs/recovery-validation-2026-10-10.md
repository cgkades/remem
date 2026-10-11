# October 10 recovery validation

GitHub persisted state replaced the failed Work session's assumptions. Main was refreshed at
`da886e1728e9b0f52397d0b2ca2028de4beb0bad`. Recovered #113 and #114 were inspected against
source, diffs, divergence, review timelines, CI failures and downloaded benchmark artifacts before
changes. Both were ahead of main without missing main commits; neither had review feedback.
A surviving old checkout had no uncommitted changes. #46 is an already-merged PR, not an open issue.

## Completed retrieval recovery

- #113 merged as `68f20eb7eb4f4d2c3d8b26da2528ebc9bbd47911` after eight jobs passed in
  run 38097076698. Search-first preserves results/neighbors and scope with existing indexes.
  See [query plans/tradeoffs](episodic-query-performance.md) and its permanently retained ZIP.
- #114 merged as `ffaadb70aebecb07c6009287a06a2b904c629450` after nine jobs passed in
  run 38097702520. Its initial high topic score hid a per-case regression behind unchanged aggregate
  injection. The measured bounded fallback preserves baseline successes and recovers one missing
  case. See [before/after ranking evidence](hybrid-retrieval-quality.md) and retained JSON.
- RRF ties the measured baseline. No cross-encoder, changed fusion, new production index or neural
  dependency was justified. #44 remains open for the remaining recognition miss, precision,
  independent validation data and broader neural/production-scale evaluation.

## Migration verification

The explicit concurrent-index path in #115 preserves old transactional migration files and requires
operator opt-in. Real PostgreSQL tests exposed an advisory-lock/virtual-transaction deadlock; it
was fixed using nonblocking lock probes. Checksum/ownership drift fails closed, incomplete owned
indexes are retried, complete builds survive ledger failure without rebuilding, and final ledger
updates are atomic. Run 38097610637 passed all eight jobs including all six migration regressions
at `1271e8fc5f9935371d96ad9151e5167b52f4d6c4`. Literal-true opt-in also passed all eight jobs in run 38097812339 at
`dc6f2a986e183f8af7193e2451b297ac9840bf13`. Integration with #114 is the subsequent gate;
consult the containing commit's combined CI and #115 for final merge status.

See [operator procedure](concurrent-migrations.md), [ADR 0018](adr/0018-resumable-concurrent-index-migrations.md)
and [migration checkpoint](../plan/CONCURRENT-MIGRATION-CHECKPOINT.md). No applied SQL history was
rewritten. Migration 0008's stored-column rewrite still needs a maintenance window; concurrent
index creation does not remove that lock or guarantee zero downtime.

## Actual automatic learning behavior

[Run 38097702520](https://github.com/cgkades/remem/actions/runs/38097702520), job 114346958645,
tested the installed package inside the pinned native OpenCode v2 runtime against real PostgreSQL.
Session A used production callbacks; five fresh Session Bs received no previous transcript or
memory commands. The structured measurements are preserved in
`docs/evidence/recovery-native-learning-38097702520.json`.

| Gate                                     | Observed result                            | What it establishes                                                                                       |
| ---------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Pre-learning baseline                    | Required recall 0, answer incorrect        | Knowledge is absent before automatic learning                                                             |
| Five fresh Session Bs                    | Required recall 1.0, answer correct        | Durable learning, recognition and injection across fresh native sessions                                  |
| Procedure/provenance                     | Correct, eight canonical procedure sources | Complete native check/action/recheck and attributable evidence                                            |
| Unsupported assertions / false injection | 0 / 0                                      | Fixture rejection of unsupported success, stale conclusion, secret/poison and foreign/unrelated knowledge |
| Maximum recalled context                 | 4,201 UTF-8 bytes                          | Bounded memory block; byte upper bound, not tokenizer output                                              |
| Host dispatch p95                        | 95.80 ms over five sessions                | This CI fixture's prompt-to-response timing, not a database or production SLO                             |

**Tool evidence and inferred conclusions have different authority.** Native shell callbacks verify
only a failed missing-file presence check, bounded creation and a successful identical recheck.
The root-cause statement is supplied by an original user and retains that provenance. An assistant's
unsupported claim of fully verified interruption recovery is not promoted to verified truth.
This is deterministic host-evidence learning plus conservative original-user assertion learning.
The fixture's deterministic context reader verifies transport and answer contracts; it does not
measure a generative model's reasoning or prove autonomous causal inference.

Scope/supersession and security controls remain in the full PostgreSQL/unit/native suites. Canonical
policy receipts and lineage recover approved learning after interruption without manually replaying
callbacks. Cancelled recovery leaves the approved record unapplied, unknown/legacy approvals do
not gain authority, and concurrent scoped recovery does not duplicate promotion. Native OpenCode
v1/v2 and Pi compatibility gates run independently. Pi/v1 retain conservative user-statement capture;
this is not a claim of broad native-tool learning parity with v2.

## Supported limits and remaining work

- Capture defaults were preserved. Plain/v2/Pi assertion capture and canonical evidence admission
  require explicit configuration; v1 retains its existing legacy capture behavior. No broader
  source permissions were inferred from narrower consent.
- General model-inferred causal learning, arbitrary tool-outcome verification and blind neural
  answer-quality evaluation remain undeveloped or unmeasured. No configured generative model
  evaluation was substituted with deterministic success flags.
- #44 remains open: the exact-timezone fixture is found by provider search but not routed by
  automatic recognition; non-target selections and unseen neural/paraphrase quality remain.
- #45 remains open: model/dimension matching and durable reembedding claims exist, but complete
  immutable embedding-space fingerprints and staged cutover recovery are not implemented.
- Filters are conservative checks, not a general poisoning detector. Evidence retention/compaction
  can remove inspectable originals. Callbacks lost before persistence still have no durable outbox.
- Local verification initially exposed two existing proxy-environment test assumptions. With proxy
  variables unset, local checks pass; database tests skip locally because this container has only
  a mapped root UID. Real PostgreSQL acceptance evidence comes from unskipped disposable CI,
  including inspected failures, rather than mocks or skipped test counts.

No force push, bypassed failing gate, capture-default change, security weakening or npm publication
occurred. Query/ranking claims are limited to measured fixtures. The broader product milestone is
not declared complete. The current recovery handoff is [the repository checkpoint](../plan/RECOVERY-CHECKPOINT.md).

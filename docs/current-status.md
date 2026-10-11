# Current implementation status

Continuation: remaining core work is tracked in issues #118–#125 and [the active development checkpoint](../plan/DEVELOPMENT-CHECKPOINT.md). The completed issue contracts below remain valid; they do not finish the broader product milestones. Persistent diagnostics #118, optional offline model proposals #119 and native Pi learning #120 are verified and merged in PR126/128/127. #121/#122/#124/#125 and #129 remain open. Privacy/disclosure and explicit historical search #123 are verified in PR130. Model proposal acceptance is narrow quotation selection with explicit review, not generative answer-quality acceptance.

**CURRENT source snapshot: October 11, 2026, `main` at `49e91facdd5446d7d2ec28694c601a6d8039e08b`.**
[Open-issue validation](open-issues-validation-2026-10-11.md) records the completed retrieval and
embedding acceptance, measured neural/hash results, real PostgreSQL reindex recovery and native
fresh-session evidence. #113–#117 are merged; #89, #87, #44 and #45 are closed. All nine final jobs pass,
including 774 tests with PostgreSQL with no skips and the required actual-neural evaluation.
The [durable checkpoint](../plan/RECOVERY-CHECKPOINT.md) records current commit and next work.
This describes verified behavior, not completion of every target milestone. Follow
[PRODUCT-VISION](PRODUCT-VISION.md), [TARGET-ARCHITECTURE](TARGET-ARCHITECTURE.md) and accepted ADRs
for intended behavior. Follow live [issues](https://github.com/cgkades/remem/issues) for remaining
work; the September audits are historical snapshots.

## Memory lifecycle

| Stage                 | Current implementation and evidence                                                                                                                           | Limit                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Host observation      | Native OpenCode v2 original prompt and completed tool hooks; `src/evidence-capture.ts`, `tests/evidence-capture.test.ts`, native E2E                          | Opt-in; Pi/v1 still user-statement capture; assistant claims are not verified outcomes                   |
| Admission/provenance  | Host-neutral normalized envelope, source/project authority, privacy and bounded payload/hash checks; `src/observation-admission.ts` and its tests             | Known content filters are not a general poisoning detector                                               |
| Episodic persistence  | PostgreSQL screened evidence independent of candidate creation; migrations 0008-0012; episodic/capacity/forget integration tests                              | Bounded capacity and compaction can make original evidence unavailable                                   |
| Candidate extraction  | Deterministic multi-statement original-user assertions and cross-turn native shell recovery; `src/capture.ts`, `src/procedure.ts`                             | Conservative English patterns; no general model causal extraction                                        |
| Learning policy       | Server `scoped-evidence-learning-v1` records four outcomes; `src/learning-policy.ts`, policy unit/database tests                                              | Narrow supported assertions and missing-file recovery; corrections/conflicts/old evidence require review |
| Consolidation         | Existing bounded deterministic engine, duplicate/conflict handling, explicit supersession, transactional managed writes                                       | Broad task-state/relationship inference and arbitrary topic evolution remain incomplete                  |
| Lineage               | Migration 0013 scoped ledger and append-only audit; candidate-to-canonical-evidence-to-memory links; lineage integration tests                                | Missing legacy intermediate history is not fabricated                                                    |
| Planning/recall       | Recognition, scoped lexical/vector recall, prior-session episodic continuity, independent failure handling; `src/planner.ts`, `src/recall.ts`, episodic tests | No optional model planner; neural retrieval quality is separately evaluated                              |
| Injection             | Complete bounded procedures, adjacent provenance, historical uncertainty; untrusted data boundary                                                             | Byte-based token estimates; no exact host tokenizer                                                      |
| Correction/forgetting | Existing correction store/review, preview-confirm forgetting, body-free tombstones; correction/forget tests                                                   | Forgetting evidence does not independently authorize semantic deletion or erase backups                  |
| Recovery              | Atomic promotion/replay and one bounded host-startup approved-candidate batch; `tests/host-procedure.integration.test.ts`                                     | At most eight per initialization; no durable outbox for callbacks lost before persistence                |

Operational details: [host learning](host-evidence-learning.md), [lineage](candidate-lineage.md),
[startup recovery](learning-recovery.md), [configuration](configuration.md) and
[storage](storage-architecture.md). PostgreSQL and Markdown are built-in providers. The package is
`agentic-remem`; source `package.json` remains version 0.2.3. The registry verification recorded in
README is dated, and newly merged source is not automatically a new npm release.

## Verified gates

The original policy/recovery gate was [PR #105](https://github.com/cgkades/remem/pull/105), including merged policy
[#104](https://github.com/cgkades/remem/pull/104) and recovery
[#106](https://github.com/cgkades/remem/pull/106), passed all seven CI jobs at head
`33205371b45cb9abbd24f9d333ec30c59b0a415e`
([run 37981144122](https://github.com/cgkades/remem/actions/runs/37981144122)). Node 22 and 24 each
passed 717 tests in 52 files with PostgreSQL, none skipped, plus format/lint/type/build/package
checks. Native OpenCode v1/v2, Pi and separate neural evaluation jobs passed. A local run without
PostgreSQL passed 581 tests and skipped 136; skipped tests are not completion evidence.

The final October 11 run38100705774 revalidates 774 PostgreSQL tests with no skips and the native measurement below. The original callback timing remains a separately measured historical fixture.

The installed-package native v2 investigation contains an incorrect hypothesis, ineffective
troubleshooting, a tool-verified presence-check recovery, an original-user causal conclusion and
decision, and an unresolved follow-up. Five fresh Session Bs have no old transcript or memory
commands and must recover five expected records, including an episodic-only detail. A seeded
superseded record is only a negative control. See [acceptance specification](investigation-acceptance.md).

| Measurement                              | Observed result                                      | Interpretation                                                                                             |
| ---------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Baseline recall@5 / answer               | 0 / incorrect                                        | Actual pre-learning native dispatch                                                                        |
| Learned recall@5 / answer                | 1 / correct, five fresh sessions                     | Deterministic reader of actual injected context                                                            |
| Procedure / provenance                   | Correct / correct, eight canonical procedure sources | Complete check/action/recheck and source links                                                             |
| Unsupported assertions / false injection | 0 / 0                                                | Fixture controls include obsolete, secret, poisoned, unrelated and foreign-project content                 |
| Maximum recalled context                 | 4,201 UTF-8 bytes                                    | Conservative token upper bound, not tokenizer output; excludes global recognition catalog hints            |
| Fresh dispatch p95                       | 66.73 ms                                             | Five host prompt-to-response samples, including retrieval and mock dispatch; not isolated database latency |
| Capture callback p95                     | 17.90 ms                                             | Ten PostgreSQL callback samples on Node 24, separate fixture                                               |
| Interrupted promotion                    | Recovery and concurrent replay tests pass            | Scoped approved learning resumes without manual approval or callback replay                                |

This proves the deterministic supported slice. The original-user assertion supplies the root cause;
tool signals verify only the observed presence-check recovery. Generative-model quality, autonomous
causal inference, production latency and broad paraphrase accuracy remain unmeasured here.

## Configuration and next work

Plain/v2/Pi initialization leaves assertion capture off unless requested; v1 initialization enables
legacy automatic user capture. Canonical evidence admission is separately disabled by default and
requires explicit configuration with a primary PostgreSQL provider. With admission enabled,
automatic promotion requires a server policy receipt; an agent-provided approval cannot grant it.
Changing defaults or broadening observed sources requires a reviewed disclosure/authorization
design, preserving existing opt-outs.

Remaining work includes broader host-supported outcomes, Pi evidence parity, persisted learning
diagnostics, shared guidance for bounded historical search, catalog/current-state evolution and broader real-user retrieval quality. Embedding identity and
measured hybrid retrieval acceptance (#45/#44) are complete; no currently open GitHub issues remain.
The broader product vision still requires the capabilities above. Optional model-quality evaluation requires
a selected configured model and must be reported separately from these deterministic gates.

Embedding compatibility is now an explicit paired-space fingerprint contract, with lexical-only
unknown legacy vectors, provider-isolated stages and full-coverage atomic cutover. See
[operator recovery](embedding-compatibility.md) and [ADR 0019](adr/0019-embedding-space-and-staged-cutover.md).
Persisted settings and batch completion do not prove compatible generation coverage. All existing
capture/privacy/authority defaults remain unchanged; no npm release was published.

## Retained-source recovery completion (#125)

PR131 (merge2b8ad093) adds one bounded retained-evidence extraction batch at native OpenCodev2/Pi initialization and shutdown, in addition to approved-candidate recovery. Explicit evidence admission and capture modes must both be enabled. Source identity/hash, provider/project/host/origin,24h age, availability, policy and conflicts are rechecked; progress and30second leases survive process interruption. At most8 events per attempt and5seconds; later sessions handle backlog. Disabled capture does no replay; review mode remains pending and existing reviews/declines are not overridden. Events never persisted cannot be reconstructed.

Run38110674948 source27120f64 passes852 unskipped realPostgreSQL tests on both Node versions and all11native/model/benchmark jobs. ActualnativePi proof-only A (no candidate/memory) recovers one procedure in fresh B without A transcript/callbacks, and repeated B creates no duplicate. Five native v2/Pi baseline repetitions retain recall1 and false/unsupported0 with correct provenance/procedure. Whole-source poisoning is screened before segmentation and at server persistence/promotion. Procedures cite exactly the four complete safe proof sources; other attempts remain historical. Measurements and per-case regression evidence: docs/evidence/retained-evidence-recovery-38110674948.json. This remains deterministic host-evidence learning/reader validation; real generative answer quality is still issue124.129 semantic-forget,121 bounded catalog aliases and122 current-state synthesis remain unfinished.

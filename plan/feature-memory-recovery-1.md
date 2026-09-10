---
goal: Complete the safe learning-to-recall loop in bounded implementation slices
version: 1.0
date_created: 2026-09-09
last_updated: 2026-09-09
owner: ReMem maintainers
status: Planned
tags: [feature, architecture, memory, recovery, agent-handoff]
baseline: 683ba5011fb82d29196b1153ec8246902c889b24
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This handbook turns [PRODUCT-VISION](../docs/PRODUCT-VISION.md), [TARGET-ARCHITECTURE](../docs/TARGET-ARCHITECTURE.md), and [IMPLEMENTATION-PLAN](../docs/IMPLEMENTATION-PLAN.md) into bounded tasks for a smaller coding model. The [issue audit](../docs/ISSUE-AUDIT.md) accounts for all 48 issues and their comments. Use existing issue numbers plus task IDs in implementation PRs; do not create duplicate epics.

**Start with TASK-001, then TASK-004.** TASK-004 is the next core behavioral regression. Do not begin with a reranker, additional host, UI, general knowledge graph, or model-driven truth extraction.

## 1. Requirements & Constraints

- **REQ-001**: Implement the Session A/Session B contract: ordinary work yields recoverable evidence and safe durable conclusions; a fresh session receives relevant current context without memory commands; unrelated prompts stay clean.
- **REQ-002**: Preserve recognition -> planning -> provider recall -> ranking -> synthesis -> attributed injection. Providers store/search data; they do not own user-intent or learning policy.
- **REQ-003**: Keep semantic current knowledge distinct from episodic historical evidence. Rejecting/superseding a semantic candidate must not erase otherwise safe historical evidence.
- **SEC-001**: Scope, authorization, source classification, credential screening, and integrity checks fail closed for memory actions without failing the host request.
- **SEC-002**: User assertions, host-observed tool results, assistant claims, and retrieved/extension content have different origins. Repetition does not upgrade trust; model text cannot authorize its own verification or approval.
- **SEC-003**: Keep memory transport local by default. Asset installation is not permission to send prompts/evidence remotely. New providers/models/telemetry require explicit configuration.
- **SEC-004**: Preserve explicit capture/auto-promotion opt-outs. User-text permission is not assistant/tool-transcript permission. Never enable sources merely to make tests pass.
- **SEC-005**: Never execute stored procedures or instructions. CLI-only approval is not access control against a shell-capable agent; actual human authorization remains required.
- **CON-001**: Baseline is the commit above. Resolve exact symbols at task start; if contracts have changed, reconcile before editing. Do not guess SDK fields or treat stale line numbers as authoritative.
- **CON-002**: One bounded behavior per PR; its tightly coupled test/implementation/verification tasks may land together. Demonstrate red/green regressions. Do not lower unrelated thresholds, weaken assertions, or skip integration tests to pass CI.
- **CON-003**: Add checksum-safe migrations numbered one greater than the highest actual version at implementation time. Never rewrite applied migrations or assume schema version 4 is current.
- **CON-004**: PostgreSQL integration tests drop the `remem` schema. Use only a disposable, loopback-bound test database. Never use an installed user/production memory database.
- **CON-005**: Obtain authorization before commits, pushes, issue mutations, publishing, deploying, persistent deletion, or installed-configuration changes. Test setup must not run `remem reset`/restore against user data.
- **GUD-001**: Initially read only this protocol, the selected phase, its dependencies, and named source targets. Follow project navigation rules; avoid repeated whole-repository exploration and overlapping review agents.
- **GUD-002**: Report changed paths, tests/counts/skips, acceptance results, and unresolved assumptions. Mark milestone criteria complete only when fully implemented, verified, and merged; a smaller task is not full P1/P4 completion.
- **GUD-003**: Stop on undocumented host events, unavailable verification signals, incompatible transaction semantics, or unspecified permission/default changes. Report the exact missing contract; do not substitute guessed APIs or a model-supplied `verified: true`.
- **PAT-001**: Reuse `SessionObservation`, `CandidateMemory`, `CaptureCoordinator`, consolidation runners, `MemoryProvider`, correction queue/store, and existing host/runtime harnesses. Paths explicitly marked new/proposed are designs, not existing files.

### Readiness and Dependencies

`READY` permits starting after dependencies. `DEPENDENT` requires prerequisites to land. `REVIEW-GATED` additionally requires maintainer approval of the concrete contract/patch before shipping. `DEFERRED` follows the core loop unless repairing a demonstrated regression. These statuses do not authorize live operations.

| Phase | Work                                        | Readiness                             | Prerequisite phases             | Tracking                    | Recovery mapping     |
| ----- | ------------------------------------------- | ------------------------------------- | ------------------------------- | --------------------------- | -------------------- |
| 0     | Docs/backlog reconciliation                 | READY                                 | None                            | #50                         | P0                   |
| 1     | Short-continuity query fix                  | READY                                 | 0                               | Existing recovery checklist | P1/P9                |
| 2     | Observation/admission contract              | REVIEW-GATED                          | 0                               | #43                         | P2/P13               |
| 3     | Episodic persistence/retrieval/retention    | DEPENDENT                             | 2                               | #43                         | P3/P13               |
| 4     | Durable identity/audit/learning transaction | REVIEW-GATED                          | 3                               | #49                         | P5/P8                |
| 5     | Host outcome wiring                         | REVIEW-GATED                          | 2, 3, 4                         | #75 proposed reopen         | P2/P4                |
| 6     | Evidence extraction/four-way policy         | REVIEW-GATED                          | 3, 4, 5                         | #43; #74 baseline history   | P4/P6                |
| 7     | Current truth/consolidation lifecycle       | REVIEW-GATED                          | 4, 6                            | #49; #4 baseline history    | P7/P8                |
| 8     | Catalog evolution                           | DEPENDENT                             | 1, 7                            | Recovery checklist          | P9                   |
| 9     | Working context/explanations/guidance       | DEPENDENT                             | 3, 4, 7                         | #56 guidance; #76 baseline  | P11/P12              |
| 10    | Full acceptance/default rollout gate        | REVIEW-GATED                          | 5, 6, 7, 8, 9                   | #43/#75                     | P1/P6/P13            |
| 11    | Embedding identity completion               | REVIEW-GATED                          | 0                               | #45                         | Compatibility safety |
| 12    | Ranking experiments                         | DEFERRED                              | 10, 11                          | #44                         | P10                  |
| 13    | Shared policy/review infrastructure         | DEFERRED                              | 4, 7                            | #48/#49                     | Remaining P5         |
| 14    | Pi parity/skills/RPC/UI                     | DEFERRED                              | 9 for shared guidance           | #53/#55/#56/#57             | Integration/UX       |
| 15    | Version flag; later expansion               | READY for version; expansion DEFERRED | 0 for version; 10 for expansion | #80                         | Housekeeping/P14/P15 |

Phases 1 and 2 are independent after phase 0. Phase 11 can run in parallel, but does not block deterministic observation unless embedding identity changes. Do not run concurrent agents editing the same provider/schema/configuration files.

Within a phase, tasks execute in numerical order unless explicitly described as independent. Phase 0's technical exit depends on TASK-001/TASK-002, not authorization for the administrative TASK-003. Do not submit a failing test-only PR; keep a red test with its corresponding implementation and verification in one working branch.

### Existing Foundations

PostgreSQL/Markdown providers, lexical/vector candidate generation, BGE/hash embeddings, re-embedding claims, correction durability/revisions, host adapters, and runtime tests exist. User capture already handles bounded multiple statements and whole-input safety screening. Known processed identities are reused without overwriting reviewed/merged/superseded memory. Procedure extraction exists but production hosts do not invoke `enqueueResolvedTask`. #82 proves a narrower user-text learning/recall slice, not the complete product contract.

## 2. Implementation Steps

### Implementation Phase 0

- **GOAL-001**: Give implementers an accurate entry point without rewriting history.

| Task     | Description                                                                                                                                                                                                                                                                                              | Completed | Date          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------- |
| TASK-001 | Finish #50 reconciliation in `README.md`, `docs/architecture.md`, `docs/memory-model.md`, `docs/mvp.md`, `docs/future-roadmap.md`, `docs/storage-architecture.md`. Label current/target/historical claims; correct package, schema, embedding, and capture defaults from code. Preserve historical ADRs. | No        | Not completed |
| TASK-002 | Inventory actual migrations and test scripts; record exact versions/commands in the implementation PR. Document read-only schema-status inspection. Do not infer the latest migration from this plan's examples.                                                                                         | No        | Not completed |
| TASK-003 | If authorized, apply the issue audit's 11 open-body updates and proposed #75 reopening. Preserve closure evidence and link task dependencies. Otherwise report proposed GitHub changes without applying them.                                                                                            | No        | Not completed |

**Exit:** README and linked docs distinguish delivered foundations from the target loop. This documentation change repairs key README entry points; finish remaining #50 surfaces rather than duplicate that work.

### Implementation Phase 1

- **GOAL-002**: Retrieve newly learned memory from a short, topic-bearing continuity prompt without weakening global relevance rules.

**Targets:** `src/planner.ts` `scoreEntry`/`DeterministicRetrievalPlanner.plan`; `src/providers/postgres.ts` `search`; the Orion learning test in `tests/postgres-provider.integration.test.ts`. The fallback currently sends the full prompt to `plainto_tsquery('simple', ...)`. Do not begin with vector-threshold changes or global OR search.

**Proposed bounded algorithm:** preserve institutional filtering, normal qualified matches, and core scope checks. Only in the existing strong-continuity/no-qualified-match fallback, derive an anchor from prompt tokens also present in an eligible catalog title or alias. Do not use summaries, retrieved bodies, or model suggestions as the sole source. Exclude `project`, `service`, `work`, `migration`, `memory`, `fact`, `decision`, `preference`, `task`, `procedure`, `explicit`, `user`, `continue`, `resume`, `again`, `remember`, `last`, `time`, `thing`, `pick`, `where`, `left`, `off`, `lets`, `the`, `and`, `this`, `that`. Require at least three characters. Rank remaining anchors by lowest eligible-catalog document frequency, then original prompt order; select one. Route only to configured providers owning eligible entries with that anchor, within existing topic/result budgets. Send the literal anchor as the parameterized provider query. With no anchor, preserve the existing fallback. Keep scores/thresholds unchanged and emit a distinct anchor-routing reason.

This does not solve arbitrary pronouns, ambiguous projects, or semantic entity inference. Those belong to later catalog work.

| Task     | Description                                                                                                                                                                                                                                                                                        | Completed | Date          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------- |
| TASK-004 | Add a red PostgreSQL regression using #82's three Orion statements, then a new provider/orchestrator/session. Query exactly `Let's continue the Orion work.`; assert current fact/decision/blocker injection, provenance, and token bounds. No manual memory writes/approval or preseeded aliases. | No        | Not completed |
| TASK-005 | Implement the bounded fallback above. Add planner tests for configured-provider restriction, blocked institutional entries, anchor tie-breaking, punctuation/case, no anchor, and disabled providers. Preserve `minimumConfidence`, vector cutoff, and non-continuity behavior.                    | No        | Not completed |
| TASK-006 | Reuse the successful prompt in a foreign project; run an unrelated prompt in a fresh same-project session. Both must inject zero detailed memory. `continue the work` must not gain a new anchor route. Keep the topic-rich positive case.                                                         | No        | Not completed |

**Exit:** short and topic-rich positives pass with discriminating negative controls. This is progress toward P1, not the full Session A/Session B acceptance.

### Implementation Phase 2

- **GOAL-003**: Define safe host-neutral observation before adding transcript-like persistence.

**Targets:** `src/observation.ts`, `src/capture.ts`, `src/config.ts`, `src/storage/config-file.ts`, host adapters. Proposed new `src/observation-admission.ts` holds pure validation/redaction, with no host SDK or database imports.

**Contract:** extend, rather than replace, `SessionObservation`. Preserve existing IDs/fields for legacy capture. Add a schema version and typed envelope containing provider ID, host, project/session/turn/message identity, role, origin, event kind, and evidence references. Roles: `user`, `assistant`, `tool`, `system`. Origins: `direct-user`, `host-observed`, `retrieved`, `extension`, `unknown`. Raw event kinds describe completed turns, tool results, and lifecycle events; they do not require a semantic label such as decision/fact. References identify provider/event IDs, not arbitrary fetchable files or URLs.

Host identity must be documented or use an established stable turn identity. Missing both yields an explicit unsupported-identity result for the new evidence path; do not deduplicate by prompt text. Reject NUL-containing identity fields and bound each to 256 UTF-16 code units. Preserve legacy IDs. A new namespace must be versioned and include provider/host/project/session identity. Hash canonical sanitized immutable evidence, excluding ingestion time and later classifier results. Same identity/different evidence is a collision, not an upsert.

**Development profile, not a shipped-default change:** new evidence capture disabled until configured; project scope only; user source allowed when enabled; assistant/tool sources separately disabled. Maximum serialized safe event payload 8 KiB, 16 evidence references, and 32 queued events. Unknown origins cannot auto-promote. Reuse configured timeouts and bounded shutdown. Maintainer approval of these proposed values is part of TASK-007; do not present them as today's defaults.

| Task     | Description                                                                                                                                                                                                                                                                                                        | Completed | Date          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ------------- |
| TASK-007 | Define the additive normalized-envelope/admission-result contracts, source enablement, and identity rules. Preserve old `SessionObservation` consumers. Review schema/default/compatibility choices before persistence begins.                                                                                     | No        | Not completed |
| TASK-008 | Implement pure admission: validate scope/identity/source/configuration; recursively screen bounded metadata/text with existing credential protection; reject unscreenable values rather than store them raw. Screening failure rejects memory only. Diagnostics contain bounded reason codes, not unsafe payloads. | No        | Not completed |
| TASK-009 | Test malformed IDs, unknown origins, foreign projects, nested credentials, recursive/oversized payloads, disabled sources, identity collisions, and retrieved text repeated by an assistant. Safe evidence must be admissible even if it yields no semantic candidates.                                            | No        | Not completed |

**Exit:** deterministic, independently tested admission; no broad source or auto-promotion default is enabled. Legacy adapters do not silently inherit new privileges.

### Implementation Phase 3

- **GOAL-004**: Persist and retrieve evidence independently of semantic extraction.

**Storage decision:** extend `remem.session_events` as the canonical event evidence store rather than create a competing raw-trace pipeline. Initially an episode is the provider/host/project/session grouping. Add a separate grouping table only after a demonstrated need. New columns represent normalized identity/origin/role, safe text, references, canonical hash, schema version, and expiry. Legacy rows remain usable by existing candidate paths; never invent missing text or trust during backfill.

**API decision:** add a proposed `EpisodicStore` beside `ObservationStore` with bounded append, search, and evidence-read operations. `episodicHistory` capability alone does not establish method support. Implement PostgreSQL storage in the existing provider or a connection-sharing internal module; do not introduce another pool/configuration lifecycle. Initially search only the requested project/provider. Return role/origin/status/source identity with excerpts; neighbor expansion stays inside the episode and budget.

**Retention proposal:** 30-day maximum age and 64 MiB logical safe payload per provider/project; seven-day baseline before significance-based expiry. Hard capacity and explicit privacy deletion override that baseline and produce body-free gap diagnostics. Approve these policy values before coding eviction. Define deterministic oldest-eligible eviction, transactionally coordinate capacity accounting across writers, and distinguish logical bytes from physical PostgreSQL disk/VACUUM usage.

| Task     | Description                                                                                                                                                                                                                                                                                      | Completed | Date          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ------------- |
| TASK-010 | Add the next migration and append/read methods. Preserve legacy rows and candidate foreign keys. Exact repeated append is a no-op; same identity/different safe evidence fails without changing the first record. Test rollback and cross-provider/project collisions.                           | No        | Not completed |
| TASK-011 | Add scoped lexical episode search and neighbors: at most ten events, one preceding/following neighbor, and 2,000 output tokens; caller budgets may lower limits. An unclassified failed approach must be independently findable and labeled historical/untrusted. Defer vector episode indexing. | No        | Not completed |
| TASK-012 | Implement approved retention/capacity policy with boundary and concurrent-writer tests. Expired evidence is explicitly unavailable; surviving semantic knowledge is not reclassified as freshly verified. Neither admission nor retention requires a candidate.                                  | No        | Not completed |
| TASK-013 | Define and test explicit forget preview/confirmation and derived-data scope before default enablement. Distinguish episode expiry from forgetting related candidates/memories/embeddings/catalog entries. Keep content out of tombstones/audit; document backup expiry and restore suppression.  | No        | Not completed |

**Exit:** independently retrievable evidence, including zero-candidate turns, without secret or foreign-project leakage. Forget scope is review-gated: do not let a smaller model decide whether to delete independently supported semantic knowledge. Until approved, implement no destructive forget operation or evidence-default rollout.

### Implementation Phase 4

- **GOAL-005**: Persist learning decisions and every processed association without replay rewriting reviewed memory.

**Targets:** `src/consolidation.ts`, `src/providers/postgres.ts`, `src/observation.ts`, `src/types.ts`, migrations, capture/consolidation/PostgreSQL tests. Reuse the correction store's integer-revision/CAS pattern; do not rebuild correction persistence.

**Association contract:** use a managed ledger keyed by provider ID, scope kind, non-null normalized scope key, and candidate ID. Record state, resulting memory ID, reason codes, policy/extractor versions, evidence IDs, and revision. No raw prompts in audit. Preserve body-free processed tombstones when needed to suppress stale replay after forgetting/retirement. A merged candidate is associated with a result, not authorized to overwrite it. Keep all associations; origin/latest memory metadata is compatibility evidence, not a complete ledger.

**Atomicity contract:** claim/check identity, validate current revisions, mutate semantic state, update mandatory projection/audit, and finalize the association in one PostgreSQL transaction or a documented durable recoverable protocol. Existing public provider `write`/`update` acquire their own connections/transactions: invoking them inside another outer transaction is **not atomic**. Refactor connection-aware internal mutation helpers while preserving public wrappers; use those helpers inside the managed learning transaction. Domain mutation planning stays in consolidation, while the store enforces claims/revisions/scope/transactionality. Re-plan on revision conflict rather than retry a stale mutation blindly.

| Task     | Description                                                                                                                                                                                                                                                                                                       | Completed | Date          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------- |
| TASK-014 | Add ledger/audit storage. Preserve retained legacy associations without inventing lost history. Test two candidates merging into one result, additional merges, and replay of every candidate after manual edits, supersession, and forgetting.                                                                   | No        | Not completed |
| TASK-015 | Make managed mutation internals share one transaction and add claim/revision checks. Test concurrent first deliveries, post-commit replay, crash between semantic mutation and finalization, and concurrent manual edits. No automatic wrapper cleanup of promoted memory.                                        | No        | Not completed |
| TASK-016 | Wire automatic and review capture paths to durable evidence/decision recording. Pending refresh requires the same identity/context and expected revision; reviewed states are immutable to re-extraction. Persist reason/version/evidence/scope/confidence/action/result fields without unsafe diagnostic bodies. | No        | Not completed |

**Exit:** restart cannot leave untracked successful mutation or duplicate a processed candidate. Guarantees are initially managed-PostgreSQL-specific; unsupported external provider atomicity is explicit, never assumed.

### Implementation Phase 5

- **GOAL-006**: Deliver #75's host-connected behavior using existing procedure extraction.

**Targets:** `src/hosts/opencode/v2.ts`, `src/hosts/opencode/shared.ts`, `src/capture.ts` `enqueueResolvedTask`, `src/procedure.ts`, `tests/procedure.test.ts`, `tests/opencode-v2-wiring.integration.test.ts`, `tests/opencode-v2.e2e.mjs`.

**Verification contract:** host-observed execution status proves a particular operation/test result, not every natural-language causal claim. A procedure may describe the recorded action that resolved a reproducible failure when evidence links the same task, failing attempt, action, and verification. A root-cause assertion needs supporting evidence appropriate to that claim or review. An assistant saying “fixed” or returning its own success boolean is insufficient. Never execute a recorded command to validate it without explicit test/operation authorization.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Completed | Date          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------- |
| TASK-017 | Inspect the pinned OpenCode v2 SDK and real harness; record actual completed-turn/tool-result/lifecycle callback signatures and stable IDs. Add an adapter contract test. If a required signal is unavailable, document it and stop that binding; do not invent a hook.                                                                                                                                                                                              | No        | Not completed |
| TASK-018 | Map supported callbacks into the admitted episode stream and derive bounded `ResolvedTaskEpisode` input from stored evidence. Reuse `enqueueResolvedTask` only after verification and through phase 4's durable path. New host-derived procedures remain pending regardless of legacy user-text auto-promotion until phase 6 authorizes them; do not invoke the legacy automatic callback for this new source. Test host callbacks and duplicate tool-loop dispatch. | No        | Not completed |
| TASK-019 | Add failure/abandonment/unknown-result, forged model success, secret output, scope mismatch, cancellation, and shutdown tests. Preserve v1/Pi behavior unless a separately tested mapping is added; mark unsupported capabilities explicitly.                                                                                                                                                                                                                        | No        | Not completed |

**Exit:** a real supported host path yields one evidence-backed procedure; production call-site coverage replaces the current test-only wiring. Do not close #75 from a unit test of the library helper alone.

### Implementation Phase 6

- **GOAL-007**: Extract supported durable claims and apply an explicit four-outcome policy.

**Targets:** `src/capture.ts`, `src/observation.ts` `CandidateExtractor`, `src/procedure.ts`, `src/consolidation.ts`; proposed new `src/learning-policy.ts` and a checked-in learning fixture under `tests/fixtures/learning/`.

Keep `CandidateExtractor.extract` as the shared boundary. Inject extractors without requiring a remote model or breaking existing constructor callers. In the new evidence path, semantic classification occurs after admitted evidence persistence, not as a prerequisite to persistence. Candidate IDs, evidence IDs, source spans, extractor version, and rule reasons must be deterministic for replay. Cross-turn support links exact admitted events rather than concatenating an entire transcript and relabeling it as a user assertion.

**Policy order:** reject unsafe/unauthorized/corrupt candidates; retain episodically only when evidence is historical/transient/unverified and makes no supported semantic claim; require review for meaningful conflicts, institutional/high-impact claims, scope escalation, or insufficient evidence; auto-promote only if enabled and a versioned, server-validated low-risk rule permits it. Capture keywords, model confidence, retrieval score, and model-supplied rule names are not authorization. Initially allow only reviewed rule implementations for explicit original-user durable assertions and host-verified procedures. Any broader fact/inference rule needs corpus evidence and maintainer approval. Persist the policy decision even when no semantic write occurs.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                  | Completed | Date          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ------------- |
| TASK-020 | Expand the checked-in corpus: multiple claims, mixed questions, wrapper removal, rationales separated across turns, tactical `let's`/`we'll`, conversational `actually`, paraphrased blockers, scope distinctions, quoted/poisoned evidence, and failed approaches. Label expected claims/evidence/outcome, not only classifier categories.                  | No        | Not completed |
| TASK-021 | Implement evidence-linked extraction through the shared interface. Preserve the existing deterministic span behavior and complete-statement bounds. Unknown/proposed claims remain candidates, not trusted facts. A local model adapter is optional and disabled unless explicitly configured; its output goes through identical schema/evidence validation. | No        | Not completed |
| TASK-022 | Implement the pure ordered learning policy and all four outcomes. Test disabled auto-promotion, missing/foreign/expired evidence, false success, conflicts, high-impact institutional data, scope escalation, and unknown provenance. Rejection must not remove safe source episodes.                                                                        | No        | Not completed |
| TASK-023 | Measure capture precision, recall, false durable-memory rate, and rationale recovery by fixture category. Require zero secret leakage/scope violations in the corpus. Freeze approved rule/threshold versions; do not trade away safety to increase recall or silently change defaults.                                                                      | No        | Not completed |

**Exit:** ordinary supported work produces useful candidates and safe policy decisions without manual curation of every event. General language understanding and unverified model claims are not asserted as solved.

### Implementation Phase 7

- **GOAL-008**: Maintain current truth and complete bounded, restart-safe consolidation.

**Targets:** `src/consolidation.ts`, `src/providers/postgres.ts`, `src/capture.ts`, `src/observation.ts`, configuration/lifecycle wiring, existing consolidation/PostgreSQL tests.

Do not treat recency or token similarity as authority to replace a decision. Known identity replay remains non-mutating. A new contradictory candidate is different from replay and must retain its evidence and explicit review/conflict state. Prefer explicit subject/predicate/entity keys derived from verified data for task/configuration state transitions; ambiguous semantic equivalence stays unresolved. Never silently append conflicting active task states while claiming a single current truth.

| Task     | Description                                                                                                                                                                                                                                                                                                                      | Completed | Date          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------- |
| TASK-024 | Add regression matrices for exact/near duplicates, additive evidence, explicit supersession, contradiction, procedure revisions, and task-state transitions. Include old authoritative versus newer unverified evidence and an old candidate replay after manual correction.                                                     | No        | Not completed |
| TASK-025 | Implement only the supported mutation plans with expected revisions and immutable historical evidence. Preserve uncertain conflicts instead of choosing a winner; reject stale mutation plans and re-evaluate. Test every dependent relationship affected by supersession.                                                       | No        | Not completed |
| TASK-026 | Connect incremental and session-end consolidation to the durable pending-work/claim mechanism. Reuse `PostgresConsolidationRunner` recovery where possible. Bound batches and shutdown; re-run safely after crash without requiring an always-running daemon. Do not perform unbounded reflection on the dispatch critical path. | No        | Not completed |

**Exit:** repeated/interrupted work converges to current semantic state plus preserved history. Every promoted result has durable evidence and audit; a partial operation cannot look complete.

### Implementation Phase 8

- **GOAL-009**: Make learned knowledge improve recognition without creating another source of truth.

**Targets:** `src/catalog.ts` `MemoryCatalog`, `src/providers/postgres.ts` catalog/write internals, `src/planner.ts`, existing topic/entity/relationship tables. Catalog entries are projections; source memory/evidence remains authoritative.

| Task     | Description                                                                                                                                                                                                                                                                                                                    | Completed | Date          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ------------- |
| TASK-027 | Define deterministic projection rules for memory IDs, entity/topic keys, aliases, scopes, provider locations, and continuity hints. Initially bound hierarchy depth to three and aliases per entry to sixteen; approve changes before widening. Derive aliases from explicit admitted evidence, not arbitrary generated names. | No        | Not completed |
| TASK-028 | Update or enqueue durable projection/index work with each learning transaction. Invalidate `MemoryCatalog` caches after successful writes. Rebuild projections from durable state and demonstrate idempotence; do not make cache state necessary for correctness.                                                              | No        | Not completed |
| TASK-029 | Test a topic learned in Session A and recognized from a paraphrase in Session B, including cache refresh/restart, conflicting aliases, missing provider, and foreign scope. Keep the phase-1 short-prompt regression.                                                                                                          | No        | Not completed |

**Exit:** new learning changes later recognition, with bounded recoverable catalog state and no scope leakage.

### Implementation Phase 9

- **GOAL-010**: Produce useful working context and explain learning from durable evidence.

**Targets:** synthesis strategy used by `src/orchestrator.ts` (resolve its existing import/interface before editing), `src/types.ts`, `src/hosts/opencode/memory-ux.ts`, `src/hosts/pi/index.ts`, ledger/evidence readers. Do not create another synthesis abstraction before checking the existing one.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                               | Completed | Date          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------- |
| TASK-030 | Wire `EpisodicStore` into core search/recall and explicit memory tools with capability checks, bounded evidence-class selection, and origin/source labels. Extend planner selection and deterministic synthesis to distinguish current semantic state from historical evidence, procedures, tasks, and conflicts. Preserve budgets/attribution; do not query all history unconditionally or recapture synthesized output. | No        | Not completed |
| TASK-031 | Back learning explanations/status with persisted policy/audit/evidence records. Report why promoted/reviewed/rejected/episodic-only, backlog/health, and expired/unavailable evidence. Never dump raw unsafe content, credentials, or arbitrary free-text errors. Verify explanations after restart.                                                                                                                      | No        | Not completed |
| TASK-032 | Before adding history-search guidance, prove a host/tool call retrieves a zero-candidate event after restart through TASK-030, with negative scope/budget controls. Then add guidance to supported tool descriptions/prompt snippets: search bounded history before repeating investigations or asserting absence; empty results are not proof of absence. This fallback does not replace automatic acceptance.           | No        | Not completed |

**Exit:** memory is usable and inspectable without routine manual curation. Local model-backed synthesis is a later optional strategy with the same provenance, budgets, and failure semantics; remote synthesis remains explicit opt-in.

### Implementation Phase 10

- **GOAL-011**: Prove the full product behavior before broad default enablement.

**Fixture contract:** Session A starts without seeded memories. It encounters a reproducible failure, a disproven hypothesis, a verified root cause with supporting evidence, verified resolution, adopted decision, successful procedure, and unresolved follow-up. It performs no explicit memory commands or manual approval for ordinary safe claims. End/dispose the host and start Session B without history or process-local state. Use a short natural continuity prompt. Assert the verified root cause/current conclusion, procedure, decision, follow-up, and evidence references; the disproven hypothesis must be historical only. A successful command alone must not validate an unsupported causal explanation. Use the identical successful prompt for foreign-scope controls and a fresh unrelated prompt for non-injection. Do not assert only tool registration or trace flags.

| Task     | Description                                                                                                                                                                                                                                                                                                                          | Completed | Date          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ------------- |
| TASK-033 | Build the deterministic core fixture from phases 2-9 with expected evidence/claims, including the verified root cause and a negative unsupported-cause case. Assert no direct DB memory seeding, hidden approvals, or process-local dependency; verify token/latency bounds and recovery of a detail omitted by semantic extraction. | No        | Not completed |
| TASK-034 | Drive that fixture through the pinned real OpenCode v2 harness/local mock model with actual lifecycle/tool events. Session B must recover the evidenced root cause, not merely a successful fix. Exercise cancellation, outage, duplicate delivery, and restart. CI must enable its database and fail required skips.                | No        | Not completed |
| TASK-035 | Verify default/local no-remote-memory transport with network instrumentation after explicit asset provisioning. Test source disablement, nested credentials, poisoned retrieved/model content, forgotten-data restore suppression, and durable audit redaction.                                                                      | No        | Not completed |
| TASK-036 | Only after approved acceptance, reconcile new-install/upgrade behavior across plain/v2/Pi/v1 setup. Disclose sources/scopes/retention/disable/forget controls; preserve explicit opt-outs and require authorization to broaden sources. Document rollback/disable behavior and require a maintainer-reviewed default change.         | No        | Not completed |

**Exit:** the full P1/recovery milestone is demonstrated, not inferred from component tests. Do not close the milestone while any required host/evidence/privacy assertion is missing.

### Implementation Phase 11

- **GOAL-012**: Complete #45 without recreating existing neural/fallback/re-embedding code.

**Targets:** `src/types.ts` `EmbeddingModel`, `src/storage/embedding.ts`, `src/storage/embedding-neural.ts`, `src/providers/postgres.ts`, `src/reembedding.ts`, `src/cli/doctor.ts`, migrations, existing embedding/re-embedding tests.

**Identity contract:** canonical fields are identity schema version, backend, model ID, immutable revision or asset digest, dimensions, dtype, pooling, normalization, encoder role/mode, and instruction variant. Use a deterministic serialization/fingerprint. The pinned Hugging Face revision is already present; expose it as compatibility data rather than invent another mutable identifier. Current database filters/settings compare model ID and dimensions; a same-ID/revision change must become detectable.

| Task     | Description                                                                                                                                                                                                                                                                                                             | Completed | Date          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------- |
| TASK-037 | Define additive built-in identity metadata and third-party compatibility behavior. Existing public `id`/`dimensions` remain meaningful. Legacy rows without enough identity retain lexical eligibility but do not silently compare against a newly identified vector space. Review migration and fallback behavior.     | No        | Not completed |
| TASK-038 | Persist/enforce identity through writes, catalog vectors, searches, re-embedding claims, settings, and diagnostics. Preserve source text; interrupted rebuilds remain resumable and must not mark an incompatible index healthy. Do not add unsupported vector dimensions or overwrite old migration files.             | No        | Not completed |
| TASK-039 | Test same dimensions/different revision, dtype, normalization, query/document mode, local model path identity, fallback, interrupted rebuild, and concurrent claims. Reuse the existing claim runner and doctor fallback tests; separately inspect ancillary #16/#17 operational concerns before calling them resolved. | No        | Not completed |

**Exit:** incompatible comparisons are excluded across both catalog recognition and provider retrieval, with a documented supported rebuild path and truthful diagnostics.

### Implementation Phase 12

- **GOAL-013**: Improve retrieval quality only with evidence after the full loop works.

**Targets:** #44; `src/providers/postgres.ts` `search`, `src/recall.ts`, planner/evaluation entry points. First locate existing fusion/reranking code by symbol/search; this audit did not prove every such implementation absent.

| Task     | Description                                                                                                                                                                                                                                                                                                          | Completed | Date          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------- |
| TASK-040 | Record the existing lexical/vector union baseline on identifiers, paraphrases, near-duplicates, old authoritative records, conflicts, and unrelated prompts. Measure candidate recall, top-k precision/MRR or nDCG, p50/p95 latency, and token cost. Preserve fixtures before experiments.                           | No        | Not completed |
| TASK-041 | Compare a documented fusion method, such as RRF, against baseline before selecting it. Add an optional local cross-encoder only over a bounded candidate set, with explicit identity/runtime/timeout and deterministic fallback. Preserve scope filtering before any remote-capable stage and attribution afterward. | No        | Not completed |
| TASK-042 | Keep a change only if approved quality/latency criteria improve without safety/non-injection regressions. Document model footprint, disable/failure behavior, and reindex compatibility. Do not use a reranker to conceal missing-candidate defects.                                                                 | No        | Not completed |

### Implementation Phase 13

- **GOAL-014**: Share infrastructure while retaining domain semantics and mandatory security boundaries.

**Targets:** #48/#49; `src/planner.ts`, `src/recall.ts`, `src/orchestrator.ts`, `src/institutional.ts`, `src/correction.ts`, `src/correction-wiring.ts`, correction PostgreSQL store reached from the v2 adapter import, and phase-4 managed learning infrastructure.

| Task     | Description                                                                                                                                                                                                                                                                                                                      | Completed | Date          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------- |
| TASK-043 | Introduce a small proposed `src/memory-policy.ts` boundary for catalog/result eligibility. Move institutional-specific decisions behind it with identical behavior. Mandatory core scope/authorization runs first and cannot be overridden by a policy allow. Policy errors deny affected memory but preserve host availability. | No        | Not completed |
| TASK-044 | Preserve diagnostics and compatibility for existing `MemoryTrace.applicability` consumers while adding generic policy explanations. Test expired/forged institutional metadata, all/any phrase gates, absent/throwing policy, foreign scope, and unchanged valid guidance. Do not move domain logic into providers.              | No        | Not completed |
| TASK-045 | Factor only actually shared revision/CAS, bounded audit, persistence/recovery, and retention primitives across generic and correction candidates. Keep their payloads/states/replay/approval rules distinct. Add concurrent-review and restart tests for both; no new giant union or duplicate correction persistence.           | No        | Not completed |

**Exit:** domain-specific orchestration branches are contained without introducing optional security or weakening human-review authority. Do not make this broad refactor a prerequisite for the first useful learning slice.

### Implementation Phase 14

- **GOAL-015**: Complete valid Pi follow-ups without diverting the recovery-critical path.

**Targets:** `src/hosts/pi/index.ts`, `src/hosts/opencode/v2.ts`, `src/hosts/opencode/memory-ux.ts`, `src/correction-wiring.ts`, `tests/pi-integration.test.ts`, `tests/pi.e2e.mjs`, `package.json`, `docs/pi-integration.md`.

| Task     | Description                                                                                                                                                                                                                                                                                                                                    | Completed | Date          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------- |
| TASK-046 | For #53, add correction queue wiring selected by the configured primary PostgreSQL provider ID, not the first PostgreSQL instance. Reuse existing store/queue factories and reviewed redaction. Preserve intentional in-memory fallback only where the host contract permits it; do not silently downgrade configured durable state on errors. | No        | Not completed |
| TASK-047 | Add Pi `memory_review_status` and `memory_submit_correction` with existing v2 limits, current-session/trace binding, redaction, and no approval/apply authority. Submission writes queue state, so describe it accurately. Test before-session behavior, multiple providers, malformed input, and no sensitive bodies in tool results.         | No        | Not completed |
| TASK-048 | For #56, first verify conventional skill discovery. If absent, add proposed `skills/remem-memory/SKILL.md` and `pi.skills` registration using phase-9 guidance. Package/load it from an installed tarball. Teach correction submission only when #53 is available; search guidance need not wait for it.                                       | No        | Not completed |
| TASK-049 | For #57, retain interactive-only capture and document RPC/extension exclusion with tests. Any future RPC enablement is a separate reviewed source/authentication contract, not a boolean that turns arbitrary generated input into user intent. Resolve the issue as a decision after authorization.                                           | No        | Not completed |
| TASK-050 | For #55, verify the pinned Pi SDK's actual UI-availability contract, then add a bounded body-free status surface only in supported interactive modes. No-op in print/JSON; failures cannot delay turns. Do not invent `ctx` fields from the issue's illustrative examples.                                                                     | No        | Not completed |

**Exit:** each issue's real acceptance passes independently. Existing #54 tree-summary behavior remains intact; do not replace conversation history with memory-only summaries.

### Implementation Phase 15

- **GOAL-016**: Finish small independent usability work and gate later expansion behind recovery.

| Task     | Description                                                                                                                                                                                                                                                                                                     | Completed | Date          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------- |
| TASK-051 | For #80, handle single-argument `--version` and `-V` in `src/cli/index.ts` `runCli` before config/database/lock access. Read the installed package version relative to `import.meta.url`, not `process.cwd` or a hardcoded duplicate. Emit only the version and exit zero; preserve help/other-command parsing. | No        | Not completed |
| TASK-052 | Add pre-initialization tests in the existing CLI test suite and installed-tarball assertions in `scripts/package-smoke.mjs`. Run both flags from outside the repository with missing user config. Verify no provider/runner/config-lock operation is invoked. No publishing is required.                        | No        | Not completed |
| TASK-053 | After phase 10, scope one provider integration at a time: session-history access, Obsidian-specific behavior, MCP, Mem0, or Cognee. Start read-only with explicit source/egress/scope budgets and provider conformance tests. Define live-provider versus import semantics before copying data.                 | No        | Not completed |
| TASK-054 | After phase 10, create separate approved plans for scheduled/encrypted backup, sync/export, dashboards, more hosts/team scopes, or measured performance work. Each needs explicit authorization, rollback, privacy, and tests; none substitutes for the core loop.                                              | No        | Not completed |

Do not reopen #58 to publish the obsolete package name. `agentic-remem` is already published; release/publishing is a distinct authorized operation.

## 3. Alternatives

- **ALT-001**: Add vector ranking/LLM synthesis first. Rejected as the recovery priority because it cannot retrieve evidence that was never captured; baseline ranking improvements remain phase 12.
- **ALT-002**: Save unrestricted transcripts as semantic memory. Rejected: it conflates evidence/truth, stores unsafe or irrelevant content, and bypasses source/retention policy.
- **ALT-003**: Replace every learning/review object with one generic state machine. Rejected: domain validation/replay/approval rules differ. Share infrastructure only where two actual consumers need it.
- **ALT-004**: Treat candidate replay as permission to update existing memory. Rejected by #82 regressions: this can erase richer merges/manual corrections or revive superseded facts. Use a durable association and explicit mutation authority.
- **ALT-005**: Create an issue for every checklist line now. Rejected to avoid duplicate trackers and synchronization overhead. This handbook contains the detailed tasks; create small child issues only when assigning concrete work and authorized to do so.

## 4. Dependencies

- **DEP-001**: Current supported Node.js/TypeScript dependencies and lockfile; CI tests Node.js 22/24. No new dependency is required for the first continuity task or CLI version flag.
- **DEP-002**: Disposable PostgreSQL with pgvector for SQL/learning tests; existing CI supplies it. Local tests must never use the installed ReMem database.
- **DEP-003**: Pinned OpenCode v2 SDK/runtime and existing local-model E2E harness. Host binding implementation depends on inspected supported callbacks, not examples from a different version.
- **DEP-004**: Maintainer approval of observation identity/source contracts, retention/forget semantics, learning policy, and default changes before shipping the review-gated phases.
- **DEP-005**: Phase readiness table and within-phase ordering above. Optional Pi/reranking/enterprise work does not block the first managed local loop.

## 5. Files

Existing targets are entry points, not permission to rewrite whole modules. Resolve actual interfaces before editing. New modules/fixtures are explicitly proposed; allocate new migration numbers from the live checkout.

- **FILE-001**: Existing direction/tracking: `docs/PRODUCT-VISION.md`, `docs/TARGET-ARCHITECTURE.md`, `docs/IMPLEMENTATION-PLAN.md`, `docs/CURRENT-STATE-AUDIT.md`, and `README.md`. Keep the dated audit historical; update current execution status separately.
- **FILE-002**: Existing recognition/recall: `src/planner.ts`, `src/catalog.ts`, `src/orchestrator.ts`, `src/recall.ts`, `src/providers/postgres.ts`, `src/types.ts`.
- **FILE-003**: Existing learning: `src/observation.ts`, `src/capture.ts`, `src/procedure.ts`, `src/consolidation.ts`, `src/config.ts`, `src/storage/config-file.ts`.
- **FILE-004**: Existing hosts: `src/hosts/opencode/v2.ts`, `src/hosts/opencode/v1.ts`, `src/hosts/opencode/shared.ts`, `src/hosts/opencode/memory-ux.ts`, `src/hosts/pi/index.ts`.
- **FILE-005**: Existing correction: `src/correction.ts`, `src/correction-wiring.ts`, `src/replay-gate.ts`, and the PostgreSQL correction-store module imported by `src/hosts/opencode/v2.ts`. Preserve the existing factory and revision contract.
- **FILE-006**: Existing embedding/CLI: `src/storage/embedding.ts`, `src/storage/embedding-neural.ts`, `src/reembedding.ts`, `src/cli/index.ts`, `src/cli/doctor.ts`, `package.json`, `scripts/package-smoke.mjs`.
- **FILE-007**: Existing schema examples: `migrations/0002_consolidation_observation.sql`, `migrations/0005_embedding_settings.sql`, `migrations/0006_reembed_claims.sql`, `migrations/0007_correction_candidates.sql`. These identify existing concepts, not files to modify.
- **FILE-008**: New/proposed pure modules: `src/observation-admission.ts`, `src/learning-policy.ts`, `src/memory-policy.ts`. Create only when the owning phase is active; do not scaffold all of them in advance.
- **FILE-009**: New/proposed evidence fixtures: `tests/fixtures/learning/`, with versioned input, expected admitted evidence, candidates, policy outcomes, and Session B expectations. Do not store real user transcripts or credentials.
- **FILE-010**: New/proposed Pi skill: `skills/remem-memory/SKILL.md`, only after checking discovery and supported package registration in TASK-048.

### Observation Field Checklist

Use these exact logical fields when writing TASK-007's reviewed type; keep existing `SessionObservation` fields and avoid competing envelopes.

| Field                      | Meaning and validation                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`            | Explicit normalized evidence schema version; legacy observations are not silently asserted to satisfy it.                                                                                 |
| `id`, `providerId`, `host` | Stable namespaced event identity, configured store identity, supported host. Source data cannot select another provider or project.                                                       |
| `context`                  | Existing `MemoryContext`, initially project-scoped for episodic admission. Validate it at the host/core boundary.                                                                         |
| `turnId`, `messageId`      | Stable host identities where applicable. Lifecycle-only events may lack message IDs; semantic claims may not pretend to have unavailable message provenance.                              |
| `role`, `origin`           | Transport/source classification assigned by the host adapter. A direct user message may contain third-party claims; role alone does not grant its entire content original-user authority. |
| `kind`, `occurredAt`       | Raw event category and source time. Server ingestion time is separate and must not perturb replay identity/hash.                                                                          |
| `payload`                  | Allowlisted, bounded safe text and structured tool-result metadata. No arbitrary nested host object serialization.                                                                        |
| `evidenceRefs`             | At most sixteen same-authorized-scope references, identified by provider/event IDs. No implicit network/filesystem dereference.                                                           |
| `contentHash`              | Deterministic hash of canonical sanitized immutable evidence; never hash/persist excluded raw secrets as a substitute for redaction.                                                      |

Candidate span offsets reference the stored sanitized text, not a nonexistent raw transcript. An expired/deleted/foreign evidence read must not return content. Foreign IDs return a non-disclosing not-found/denied result, not evidence about another project's retention state.

## 6. Testing

- **TEST-001**: Recognition and recall: preserve `tests/orchestrator.behavior.test.ts`, the planner tests resolved from its symbol references, and the Orion learning case in `tests/postgres-provider.integration.test.ts`. Negative controls use the successful positive query in a foreign context.
- **TEST-002**: Capture: extend `tests/capture.test.ts` and `tests/procedure.test.ts` with exact content/span assertions, whole-input safety, source-role distinctions, multi-turn support, and false-success/false-promotion cases. Preserve Unicode/name/option-label regressions.
- **TEST-003**: Persistence/recovery: extend `tests/consolidation.test.ts`, `tests/postgres-provider.integration.test.ts`, and correction-store/CLI integration tests. Verify stored rows/identities/provenance after restart, not just returned booleans. Inject failure before/after transaction boundaries and race independent clients.
- **TEST-004**: Host behavior: preserve `tests/opencode-v2-wiring.integration.test.ts`, `tests/opencode-v2.e2e.mjs`, v1 E2E, and Pi integration/E2E coverage. A mock callback-shape test is not a substitute for a real supported runtime path.
- **TEST-005**: Models/policy: retain existing embedding/re-embedding and curated replay suites. Neural quality CI is currently non-blocking; an approved release gate must explicitly enforce required invariants rather than infer them from an overall green workflow.
- **TEST-006**: Privacy: assert no raw secrets in event/candidate/semantic/audit/diagnostic surfaces, no scope leakage, no new remote-memory transport, no self-authorizing retrieved/model content, and no forgotten-content resurrection from retained artifacts.

### Validation Commands

Use repository scripts rather than inventing equivalent test selections. On the implementation branch:

```sh
npm run lint
npm run typecheck
npm test
npm run build
git diff --check
```

`npm test` without `REMEM_TEST_DATABASE_URL` skips database integrations. For learning/schema changes, set that variable **only to the disposable database created for the task**, then run the full suite again. The exact connection string must come from that container's inspected loopback port, not a guessed port or installed configuration. Require zero unexpected skips. `npm run test:opencode-v2` also uses that isolated test database for the host acceptance path. Run `npm run test:pi` for Pi edits and the existing package smoke script for CLI/package changes.

Run Prettier on the explicit changed files. Avoid formatting unrelated/untracked documents. If an existing unrelated file prevents a repository-wide gate, report it rather than silently editing it. Do not run E2E/database suites concurrently against the same schema; existing integration files reset it.

### First Coding Prompt

```text
Implement phase 1 (TASK-004 through TASK-006) from plan/feature-memory-recovery-1.md.
Read its protocol and phase-1 contract first, then the named planner/provider/test sites.
Do not implement later phases or change capture defaults, scope policy, vector thresholds,
or ordinary recognition thresholds. Keep the existing topic-rich positive regression.
Demonstrate the short Orion prompt failing before the fix, then passing against disposable
PostgreSQL with provenance/token assertions and discriminating negative controls.
Do not commit or push unless authorized. Report changed files, test counts/skips,
remaining limitations, and the exact milestone criteria this slice does not complete.
```

## 7. Risks & Assumptions

- **RISK-001**: Host SDK signals may not expose sufficient verification or stable identity. TASK-017 must resolve this before wiring; unsupported is safer than fabricated provenance.
- **RISK-002**: Transcript-like evidence creates new privacy/retention obligations. Phase 3 remains opt-in and review-gated until forget/backup semantics are explicit.
- **RISK-003**: Separate provider transactions can look atomic while leaving orphaned memory/audit state. TASK-015 must test actual stored rollback/recovery, not mock success.
- **RISK-004**: Legacy metadata cannot reconstruct every processed identity. Preserve known associations and document gaps; never fabricate a historical ledger or use a replay to rewrite reviewed truth.
- **RISK-005**: Model confidence is not truth or authorization. Unknown evidence and meaningful contradictions remain episodic/reviewable regardless of model score.
- **RISK-006**: Published npm version and current source can differ. #80 must report the installed package; source work must not publish a release without authorization.
- **RISK-007**: This is bounded architecture/issue reconciliation, not exhaustive proof of every closed issue's original acceptance. Unverified ancillary operational requirements remain qualified in the audit.
- **ASSUMPTION-001**: Managed local PostgreSQL is the first write-capable recovery target. External providers and broader/team scopes require their own capability/authorization contracts.
- **ASSUMPTION-002**: Retention numbers and future contracts in this plan are proposals requiring the indicated review gates. They are not descriptions of existing defaults or permission to deploy them.
- **ASSUMPTION-003**: A smaller model implements one bounded behavior, with independent review for schema, trust, lifecycle, and default changes. It need not rediscover all 48 issues on each task.

## 8. Related Specifications / Further Reading

- [Product vision](../docs/PRODUCT-VISION.md): normative user-visible contract.
- [Target architecture](../docs/TARGET-ARCHITECTURE.md): system boundaries and safety invariants.
- [Milestone checklist](../docs/IMPLEMENTATION-PLAN.md): full P0-P15 completion status.
- [Current-state audit](../docs/CURRENT-STATE-AUDIT.md): historical snapshot; do not silently rewrite it.
- [Complete issue audit](../docs/ISSUE-AUDIT.md): all issue dispositions and proposed updates.
- [Configuration](../docs/configuration.md): actual capture/replay behavior and limits.
- [Correction workflow](../docs/correction-workflow.md): existing specialized review lifecycle.
- [Ordered migration ADR](../docs/adr/0016-use-ordered-transactional-checksum-migrations.md): preserve migration integrity.
- [GitHub issues](https://github.com/cgkades/remem/issues): existing trackers; state changes require authorization.

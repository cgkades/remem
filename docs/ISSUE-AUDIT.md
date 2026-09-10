---
title: ReMem GitHub Issue Audit
date: 2026-09-09
baseline: 683ba5011fb82d29196b1153ec8246902c889b24
repository: https://github.com/cgkades/remem
status: Reviewed; GitHub changes proposed, not applied
---

# ReMem Issue Audit

## Scope and Authority

This audit covers **all 48 GitHub issues: 11 open and 37 closed**, and all **41 comments on the 21 commented issues** available on 2026-09-09. PRs are not counted as issues. Closure/reference timelines were checked. Source inspection uses `main` at `683ba5011fb82d29196b1153ec8246902c889b24`, after PRs #81 and #82.

No issue was opened, closed, reopened, or edited during this audit. The actions below are recommendations. Obtain authorization before applying GitHub state/body changes. Closed issues are not automatically reopened simply because the newer product vision is broader than their delivered baseline.

Authority order:

1. [Product vision](PRODUCT-VISION.md) and [target architecture](TARGET-ARCHITECTURE.md), subject to accepted ADRs.
2. [Recovery milestone checklist](IMPLEMENTATION-PLAN.md).
3. [Executable recovery plan](../plan/feature-memory-recovery-1.md): bounded work packages, dependencies, contracts, tests, and stop conditions.
4. This issue audit: a dated disposition record, not a competing product specification.
5. Older issue bodies and roadmap prose: historical context unless reconciled below.

The implementation baseline was validated during #82 with 353 passing tests against disposable PostgreSQL and passing CI. That does **not** establish every historical acceptance criterion or the full Session A/Session B product contract. This audit did not repeat every runtime, model-quality, or release test.

## Executive Decisions

- Keep the recall/control-plane architecture, provider boundaries, managed PostgreSQL, host adapters, and existing safety/recovery primitives.
- Complete the learning loop rather than add more unrelated integrations. The next bounded code task is the short-continuity retrieval regression, followed by safe observation/evidence persistence.
- Keep all 11 open issues as useful work, but update their scope and sequencing as specified below. None needs a duplicate replacement issue merely for this plan.
- Recommend reopening **#75**, narrowed to production host wiring and verified cross-session procedure behavior. Its extraction library exists; its headline end-user behavior is not delivered by library tests alone.
- Keep #3, #4, and #74 closed as delivered foundations. Their remaining broader behavior is tracked by #43 and the recovery plan, not by pretending those foundations do not exist.
- #44 already has a lexical/vector candidate-generation baseline. #45 already has model/dimension matching and re-embedding. #49 already has durable correction storage. Rewrite these as delta work, not greenfield implementations.
- Keep Pi parity/UI/packaging work secondary. Host-neutral fallback guidance is useful earlier, but is not a substitute for automatic recall.
- Do not use the old `opencode-remem` package name in new implementation instructions. `package.json` and the npm registry both identify `agentic-remem@0.2.3` at this snapshot.

## Current Evidence Map

Line numbers refer to the baseline above; resolve symbols again if the branch moves.

| Evidence      | Verified location                                                                                                                                                         | What it establishes                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E-CAPTURE     | `src/capture.ts`: `DeterministicCandidateExtractor`, `CaptureCoordinator`, `createCaptureCoordinator`; `tests/capture.test.ts`                                            | Bounded multi-statement user capture, whole-input screening, project scope, pending/automatic paths, transient capture explanations. Not broad session learning.                                                                                 |
| E-PROCEDURE   | `src/capture.ts:328` `enqueueResolvedTask`; `src/procedure.ts`; `tests/procedure.test.ts:169,182`                                                                         | Procedure normalization/extraction exists. The call-site search found test calls, not production OpenCode/Pi calls.                                                                                                                              |
| E-CONTINUITY  | `src/planner.ts:90-193`; `src/providers/postgres.ts:376-455`; `tests/postgres-provider.integration.test.ts`                                                               | Weak catalog matches can miss the normal threshold; continuity falls back to the full prompt; `plainto_tsquery('simple', ...)` requires its terms. The #82 fixture's short Orion prompt recalled nothing with hash embeddings.                   |
| E-HYBRID      | `src/providers/postgres.ts:376-455`                                                                                                                                       | Existing lexical and vector candidate branches are unioned. A new ranking proposal must measure this baseline, not describe vector/lexical retrieval as absent.                                                                                  |
| E-EMBEDDING   | `src/storage/embedding-neural.ts:31-99`; `src/providers/postgres.ts:376-455`; `src/reembedding.ts:130-174`; `src/cli/doctor.ts:250-315`                                   | Pinned BGE asset revision, model/dimension filtering, durable re-embed claims, active-model backlog diagnostics. Persisted compatibility checks shown here compare model ID and dimensions, not a full encoding fingerprint.                     |
| E-OBSERVATION | `migrations/0002_consolidation_observation.sql`; `src/observation.ts`; `src/providers/postgres.ts:698` `persistCandidate`                                                 | Session events, pending candidates, and consolidation runs exist. Current pending persistence deliberately omits prompt text from event payload; it is not general independently searchable episodic history.                                    |
| E-REPLAY      | `src/consolidation.ts` `consolidateCandidate`, `mergeRecord`; `src/providers/postgres.ts:511`                                                                             | #82 protects retained processed identities from replay rewrites/revival. Originating/latest IDs are not a complete durable identity ledger.                                                                                                      |
| E-CORRECTION  | `migrations/0007_correction_candidates.sql`; `src/correction-wiring.ts:17`; `src/hosts/opencode/v2.ts:14,130`; `src/providers/postgres-correction-store.js` import target | Correction candidates already have durable storage, revision counters, audit data, shared queue wiring, and a PostgreSQL-backed implementation. The `.js` import resolves to the TypeScript module during build.                                 |
| E-POLICY      | `src/planner.ts:1-15,93-136`; `src/institutional.ts`                                                                                                                      | Generic planning directly imports institutional applicability/review functions. #48's architectural concern remains valid.                                                                                                                       |
| E-PI          | `src/hosts/pi/index.ts:58-60,223-365,432-439`; `package.json:103-109`                                                                                                     | Pi has three memory tools, interactive-only capture eligibility, no queue dependency in its session builder, and extension registration without `pi.skills`. Targeted searches found no status/widget calls or correction tools in this adapter. |
| E-CLI         | `src/cli/index.ts:566-640`                                                                                                                                                | Help returns before config loading; no version-output branch appears there. #80 remains useful; implementation must test the installed CLI entry too.                                                                                            |
| E-DOCS        | baseline `README.md:24-52,145-151`; `docs/architecture.md:24-42`; `docs/memory-model.md:149-167`                                                                          | Publishing, schema-v4, capture-default, and embedding-default prose is stale. This documentation change repairs key README entry points; #50 still includes unreconciled detailed docs.                                                          |
| E-TESTS       | `.github/workflows/ci.yml`; `tests/curated-replay.test.ts`; `tests/reembedding.test.ts`; `tests/opencode-v2.e2e.mjs`; `tests/pi-integration.test.ts`                      | Existing CI/runtime/replay foundations. The replay test model includes outcomes, citations, forbidden conclusions, and escalation fields; that is not proof of every real-model behavior.                                                        |

Inspection was bounded and targeted. In particular, full reranker absence, every auxiliary requirement in old operational issues, and conventional unregistered skill directories were not exhaustively established. Their work packages require a targeted preflight rather than claiming these features cannot exist.

## Open Issue Dispositions

### #43: Episodic Session Evidence

**Keep open; make it the evidence umbrella.** Link execution phases 2-5 and 10. Keep semantic and episodic classes distinct, but reuse `SessionObservation`, session identities, scopes, and the existing event infrastructure.

Required body updates:

- Admission occurs after privacy/source/scope validation and before semantic significance classification. Unclassified safe evidence remains recoverable within configured retention limits.
- Explicitly require body persistence independent of candidate creation and review status, including automatic promotion.
- Define age/size bounds, source enablement, evidence deletion, derived-data handling, and honest expired/unavailable-source reporting before changing capture defaults.
- Separate SQL persistence, retrieval, host wiring, and consolidation tasks. Do not make one issue ask a small model to invent the whole subsystem.
- Carry forward the comment's existing-abstraction provenance/supersession fixture; do not adopt an unrelated external trace product.

### #44: Hybrid Retrieval and Reranking

**Keep open, update the baseline, defer quality expansion.** E-HYBRID already exists. Retitle to **“Evaluate and improve existing hybrid retrieval; optional local reranking.”**

Require baseline candidate recall, precision/MRR or nDCG, non-injection, latency, and model-failure results before selecting RRF or a cross-encoder. Verify whether ranking helpers already exist before adding them. Keep the short-continuity query defect in execution phase 1 separate: a cross-encoder cannot rescue candidates that were never retrieved.

### #45: Embedding Compatibility

**Keep open, narrow to remaining compatibility guarantees.** E-EMBEDDING is implemented; do not recreate the embedding backend, claim runner, or basic doctor check.

Require a canonical identity including immutable asset identity, dimensions, pooling/normalization, dtype, encoder mode/instructions, and schema version. Specify how legacy rows lose vector eligibility but keep lexical availability until rebuilt. Reindex success must reflect completed compatible records, not simply changing the active-model setting. Execution phase 11 provides the contract.

### #48: Generic Retrieval Policy Boundary

**Keep open; staged refactor, not a prerequisite framework rewrite.** Preserve mandatory scope/authorization checks outside optional policies. Port institutional policy with identical fail-closed behavior and existing trace compatibility. An `allow` from an extension must never override a core denial. Defer until the learning/evidence contracts are stable; see execution phase 13.

### #49: Shared Review/Audit Infrastructure

**Keep open; remove the obsolete “correction persistence is missing” premise.** E-CORRECTION already supplies PostgreSQL durability and revisions.

Keep separate generic and correction domain state machines. Share revision/CAS, attributable audit, retention, and recovery primitives incrementally. Prioritize a complete processed-candidate association ledger and durable learning decisions; do not use mutable memory metadata as an authorization to overwrite reviewed knowledge. The smallest managed learning transaction comes before a broad common framework. Execution phases 4 and 13 split these concerns.

### #50: Documentation Reconciliation

**Keep open; partially addressed, not complete.** #81 establishes normative direction and #82 adds an initial slice. They did not repair all older prose.

Replace the body’s generic audit request with the exact stale surfaces in E-DOCS plus `docs/mvp.md`, `docs/future-roadmap.md`, `docs/storage-architecture.md`, and operational examples. Label current/target/historical text, use `agentic-remem`, distinguish managed neural defaults from hash fallback, and document v1's different setup defaults. Preserve old ADR history. Read the actual migration set rather than replacing every “4” with an assumed new number. Execution phase 0 covers completion.

### #53: Pi Correction Tools

**Keep open; still valid but secondary.** Pi's current session builder/registerTools do not provide these tools. Reuse `createCorrectionReviewQueue`, the existing PostgreSQL correction store, and v2 validation/redaction behavior.

Correct “read-only/no-mutation” wording: status is read-only; submission mutates the review queue but does **not** approve or apply active memory. Require primary-provider selection rather than picking the first PostgreSQL provider. Existing shared wiring/redaction code may be refactored without changing its semantics; the old blanket “no changes to core files” restriction must not force duplication. See execution phase 14.

### #55: Pi Health UI

**Keep open; defer.** Targeted inspection found no current status/widget integration. Restrict any display to a supported interactive UI, bounded body-free diagnostics, and fail-open non-blocking updates. Do not change inference/capture behavior just to drive a widget. This is not required for the learning loop.

### #56: Pi Memory Skill

**Keep open; split host-neutral guidance from Pi packaging.** `pi.skills` is not registered in the current manifest. Verify conventional skill discovery before creating duplicate content.

Make bounded explicit recall, uncertainty about empty results, and inert/untrusted memory guidance reusable across hosts first. Package the Pi skill later, with a tarball loading test. Do not require #53 for search-only guidance or teach a correction tool that the current host does not expose. See execution phases 9 and 14.

### #57: RPC Input Trust

**Keep open as a policy decision until its documentation/tests are reconciled.** The safe current behavior is explicit: `isCaptureEligibleInputSource` accepts only `interactive`.

Recommended resolution is to retain RPC and extension exclusion for now and document why; this satisfies the issue's decision-oriented acceptance. Any future RPC enablement needs authenticated caller/source classification and explicit operator configuration. Do not classify arbitrary RPC as human intent. See execution phase 14.

### #80: CLI Version Flag

**Keep open; valid small housekeeping task.** Implement `--version` and `-V` before config/database/lock access, using the installed package's version rather than a duplicate constant. Test source and installed tarball invocation from a directory outside the repository. See execution phase 15. It can run independently but should not displace the recovery-critical path.

## Closed Issue Coverage Ledger

Every row below is closed with GitHub reason `completed`. “Retain” means no evidence here warrants changing that state; it is not certification of every original acceptance criterion. H denotes closure/comment history; E references current source evidence above. The linked issue retains its full body and discussion.

| Issue                                             | Title                                                                                                            | Closure evidence                              | Disposition                                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [#1](https://github.com/cgkades/remem/issues/1)   | Add real local neural embeddings with hash fallback                                                              | H: #15; E-EMBEDDING                           | Retain baseline; complete fingerprint contract in #45.                                                                  |
| [#2](https://github.com/cgkades/remem/issues/2)   | Add full-process OpenCode v2 end-to-end integration test                                                         | H: #7; E-TESTS                                | Retain; use the existing harness for the new learning loop.                                                             |
| [#3](https://github.com/cgkades/remem/issues/3)   | Implement automatic session observation and candidate memory capture                                             | H: #6; E-CAPTURE/E-OBSERVATION                | Retain delivered capture foundation; general evidence admission remains #43.                                            |
| [#4](https://github.com/cgkades/remem/issues/4)   | Implement memory consolidation, deduplication, and supersession pipeline                                         | H: #5; E-REPLAY                               | Retain primitives; durable full-loop transitions remain planned.                                                        |
| [#8](https://github.com/cgkades/remem/issues/8)   | opencode-v2 E2E: mock model lacks streaming-fidelity and error-path coverage                                     | H: #64; E-TESTS                               | Retain; preserve live negative controls and usage-after-stop qualification.                                             |
| [#9](https://github.com/cgkades/remem/issues/9)   | opencode-v2 E2E: no successful PostgreSQL provider round-trip is exercised                                       | H: #63; E-TESTS                               | Retain; seeded recall is not automatic memory formation.                                                                |
| [#10](https://github.com/cgkades/remem/issues/10) | opencode-v2 E2E: pinned beta runtime version is an external CI failure vector                                    | H: #69; E-TESTS                               | Retain maintenance baseline; registry availability remains an operational dependency.                                   |
| [#11](https://github.com/cgkades/remem/issues/11) | opencode-v2: plugin-registered memory tools are not invocable via function-calling in the live v2 beta runtime   | H: #21                                        | Retain registration fix; duplicate-load side concern was not independently re-proved here.                              |
| [#13](https://github.com/cgkades/remem/issues/13) | opencode-v2: verify multiple independent context.session.hook("prompt", ...) registrations both fire             | H: #62; E-TESTS                               | Retain; extend this test rather than assume another lifecycle callback works.                                           |
| [#14](https://github.com/cgkades/remem/issues/14) | eval tests (tests/**/*.eval.test.ts) need a dedicated CI job with model caching                                  | H: #41/#42; E-TESTS                           | Retain; quality evaluation is intentionally non-blocking, not a hard release gate.                                      |
| [#16](https://github.com/cgkades/remem/issues/16) | PostgresReembedRunner: concurrent claim doesn't survive commit, allowing double-processing                       | H: #22; E-EMBEDDING                           | Retain durable-claim fix. Audit ancillary timeout/starvation/count concerns when touching #45; not proven defects here. |
| [#17](https://github.com/cgkades/remem/issues/17) | remem doctor: embedding backlog check false-positives forever when the neural backend has fallen back to hash    | H: #23; E-EMBEDDING                           | Retain active-model fix; richer last-run diagnostics are separate operator work.                                        |
| [#18](https://github.com/cgkades/remem/issues/18) | Test coverage gaps: doctor neural-fallback detection, reembed recovery/failure paths, and the hook wiring itself | H: #60; E-TESTS                               | Retain; reuse regression suites.                                                                                        |
| [#19](https://github.com/cgkades/remem/issues/19) | Neural embeddings: minor hardening follow-ups (validation, error detail, naming)                                 | H: #61; E-EMBEDDING                           | Retain; richer persisted errors must remain sanitized.                                                                  |
| [#24](https://github.com/cgkades/remem/issues/24) | Add institutional positions, procedures, and deterministic applicability gates                                   | H: #27/#28/#29; E-POLICY                      | Retain; #48 must preserve the curated-metadata and applicability boundaries.                                            |
| [#25](https://github.com/cgkades/remem/issues/25) | Add behavioral replay evaluations for curated memory guidance                                                    | H: #30; E-TESTS                               | Retain replay foundation; add actual cross-session outcomes, not only trace assertions, in phase 10.                    |
| [#26](https://github.com/cgkades/remem/issues/26) | Turn expert corrections into reviewable, regression-gated memory candidates                                      | H: #46/#51; E-CORRECTION                      | Retain durable workflow. CLI-only approval is not by itself proof that a shell-capable agent lacks approval authority.  |
| [#31](https://github.com/cgkades/remem/issues/31) | Add Pi coding agent host support                                                                                 | H: #52; E-PI                                  | Retain base integration; #53 explicitly tracks omitted correction tools.                                                |
| [#32](https://github.com/cgkades/remem/issues/32) | Pi host: core adapter with before_agent_start memory injection                                                   | H: #52; E-PI                                  | Retain.                                                                                                                 |
| [#33](https://github.com/cgkades/remem/issues/33) | Pi host: register memory_search / memory_status / memory_explain tools                                           | H: #52; E-PI                                  | Retain three-tool baseline.                                                                                             |
| [#34](https://github.com/cgkades/remem/issues/34) | Pi host: wire capture coordinator + reembed-on-input                                                             | H: #52; E-PI                                  | Retain; interactive input restriction is intentional.                                                                   |
| [#35](https://github.com/cgkades/remem/issues/35) | Pi host: optional compaction-time context injection                                                              | H: #52                                        | Retain; never replace conversation summaries with memory-only text.                                                     |
| [#36](https://github.com/cgkades/remem/issues/36) | Pi host: derive directory/worktree/projectId for MemoryContext                                                   | H: #52; E-PI                                  | Retain established location derivation; do not redesign scope IDs casually.                                             |
| [#37](https://github.com/cgkades/remem/issues/37) | Pi host: package.json exports and build wiring                                                                   | H: #52; E-PI                                  | Retain; skills packaging remains #56.                                                                                   |
| [#38](https://github.com/cgkades/remem/issues/38) | Pi host: remem init --pi CLI support                                                                             | H: #52; E-CLI                                 | Retain installed local-package registration.                                                                            |
| [#39](https://github.com/cgkades/remem/issues/39) | Pi host: documentation (docs/pi-integration.md, README updates)                                                  | H: #52                                        | Retain initial docs delivery; current reconciliation belongs to #50.                                                    |
| [#40](https://github.com/cgkades/remem/issues/40) | Pi host: unit + E2E test coverage, new CI job                                                                    | H: #52; E-TESTS                               | Retain independent CI jobs.                                                                                             |
| [#47](https://github.com/cgkades/remem/issues/47) | Fix multi-word institutional topic applicability matching                                                        | H: #59; E-POLICY                              | Retain phrase-matching semantics through #48.                                                                           |
| [#54](https://github.com/cgkades/remem/issues/54) | Pi host: apply the session_before_compact fix pattern to session_before_tree (branch summarization)              | H: #65; Pi branch-summary helpers present     | Retain; do not create a duplicate tree-summary issue.                                                                   |
| [#58](https://github.com/cgkades/remem/issues/58) | Publish opencode-remem to npm so pi install npm:opencode-remem works                                             | H: #67; registry confirms agentic-remem 0.2.3 | Retain; old name was deliberately replaced. Fix current docs, not historical package identity.                          |
| [#66](https://github.com/cgkades/remem/issues/66) | Validate and release OpenCode v1.18.27 integration                                                               | H: #67; E-TESTS                               | Retain. Unchecked historical publication item is superseded by closure evidence.                                        |
| [#68](https://github.com/cgkades/remem/issues/68) | OpenCode v1: exercise published agentic-remem package installation                                               | H: #69; E-TESTS                               | Retain; account for the later file-URL loading change in #72.                                                           |
| [#70](https://github.com/cgkades/remem/issues/70) | Fix published CLI executable permissions                                                                         | H: #71; build/package smoke infrastructure    | Retain; #80 must preserve installed executable behavior.                                                                |
| [#72](https://github.com/cgkades/remem/issues/72) | Avoid OpenCode v1.18.29 Remem plugin initialization error                                                        | H: #73; E-TESTS                               | Retain tested compatibility workaround.                                                                                 |
| [#74](https://github.com/cgkades/remem/issues/74) | Capture direct remember requests and implicit durable decisions                                                  | H: #77; E-CAPTURE, #82                        | Retain delivered deterministic baseline; cross-turn/general-language behavior is not complete P4.                       |
| [#75](https://github.com/cgkades/remem/issues/75) | Learn reusable procedures from successful agent investigations                                                   | H: #79; E-PROCEDURE                           | **Recommend reopen and narrow to host wiring plus behavioral proof.**                                                   |
| [#76](https://github.com/cgkades/remem/issues/76) | Make memory capture and retrieval discoverable in OpenCode                                                       | H: #78; E-TESTS                               | Retain UX foundation; durable explanations and short-prompt recall remain recovery work.                                |

## Proposed #75 Update

**Title:** Wire verified host outcomes into existing procedure capture and prove later recall.

**Delivered:** `ResolvedTaskEpisode`, `observationFromResolvedTask`, `extractProcedureCandidate`, `CaptureCoordinator.enqueueResolvedTask`, and procedure tests. Reuse them.

**Remaining:** connect normalized, independently verifiable OpenCode v2 outcomes to this path; retain supporting evidence in the #43 store; drive the behavior through host callbacks, not direct coordinator calls. Neither assistant completion nor an arbitrary `succeeded: true` supplied in model text is verification.

**Acceptance:** one failing investigation, a failed approach, a verified fix, a decision, and an unresolved follow-up yield scoped evidence and safe candidates; a fresh session recalls the resulting procedure. Failed/abandoned/unverified work never auto-promotes a successful procedure. Secrets, cross-project evidence, duplicate tool-loop events, and shutdown interruption have negative tests. Execution phases 5 and 10 define the bounded implementation.

## Coverage and Follow-up Rules

- All 48 issue numbers appear above, with 11 detailed open dispositions and 37 closed ledger rows.
- Do not create 16 new GitHub epics mirroring the existing P0-P15 checklist. Use the execution plan's task IDs in PR descriptions and update the existing relevant issue.
- If authorized to update GitHub, preserve historical completion evidence, link this audit/plan after they are committed, and move only the remaining acceptance criteria into active scope.
- Reopening #75 is a recommendation, not an action already performed. Do not close #43/#49/#50 just because a related type, migration, or document exists.
- Release, runtime-pin, and model-quality claims not re-executed here remain qualified. The audit is an issue/architecture reconciliation, not a new full security or performance certification.

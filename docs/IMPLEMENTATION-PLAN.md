# ReMem Implementation Plan

> **Status:** Active source-of-truth checklist for reaching the behavior in `PRODUCT-VISION.md` and architecture in `TARGET-ARCHITECTURE.md`.
>
> Agents working on ReMem should read those two documents before selecting or implementing work from this checklist.

## How to use this document

- `[ ]` means not verified complete on `main`.
- `[x]` means implemented **and verified** against the stated acceptance criteria.
- Do not mark an item complete because a type/interface/table exists; verify the end-to-end behavior the item describes.
- When implementation differs from this plan, update the plan in the same PR or explain why the target architecture should change.
- Prefer small PRs, but optimize for complete vertical behavior rather than disconnected scaffolding.
- Existing implementation may partially satisfy many unchecked items. Reuse it; do not rewrite working foundations without evidence.

## P0 — Establish the source of truth

- [ ] Reconcile `docs/architecture.md` with `TARGET-ARCHITECTURE.md`, clearly separating CURRENT from TARGET behavior.
- [ ] Reconcile `docs/mvp.md` with actual current implementation; remove stale "not included" claims that are now implemented.
- [ ] Reconcile `docs/future-roadmap.md` with this plan; either replace it with a pointer here or redefine it as post-closed-loop future work.
- [ ] Reconcile README publishing/install status with the current released package state.
- [ ] Add a documentation index that labels documents as normative target, current-state snapshot, ADR, operational guide, or historical plan.
- [ ] Add contributor/agent guidance stating that `PRODUCT-VISION.md` + `TARGET-ARCHITECTURE.md` outrank stale roadmap/MVP text when selecting architecture work.
- [ ] Audit open GitHub issues against the target architecture; close/rewrite/deprioritize issues that encode obsolete sequencing or duplicate this plan.

**P0 exit:** an agent entering the repo can unambiguously determine what ReMem is supposed to become and what work is currently highest priority.

---

## P1 — Define the closed-loop behavioral regression

Build the test before or alongside the implementation so the project stops optimizing proxies.

- [ ] Create a deterministic Session A / Session B fixture matching `PRODUCT-VISION.md`.
- [ ] Session A includes a nontrivial failure, disproven hypothesis, verified root cause, decision, successful fix/procedure, and unresolved follow-up.
- [ ] Session A ends without explicit `remember`, `memory_search`, or manual candidate approval for ordinary low-risk facts.
- [ ] Session B starts with no conversation history.
- [ ] A natural continuity prompt causes relevant memory injection.
- [ ] Injected memory contains the current root cause/conclusion.
- [ ] Injected memory contains the verified procedure/fix.
- [ ] Injected memory contains the relevant decision.
- [ ] Injected memory contains the unresolved follow-up.
- [ ] The disproven hypothesis is not represented as current truth.
- [ ] Episodic provenance can identify the evidence/session that produced the conclusion.
- [ ] An unrelated Session B prompt does not inject detailed Session A memory.
- [ ] The scenario runs against the host-independent core.
- [ ] At least one real-host E2E version runs against OpenCode v2.
- [ ] Add metrics/assertions for latency and injected token budget.

**P1 exit:** CI contains a failing-or-passing executable definition of the product rather than only component tests.

---

## P2 — General normalized session observation

### Core observation model

- [ ] Review existing `SessionObservation`/capture types and define the canonical normalized observation schema.
- [ ] Give every observation stable host/session/turn/message identity where available.
- [ ] Represent observation source/trust explicitly.
- [ ] Represent scope explicitly.
- [ ] Represent evidence references separately from trusted semantic content.
- [ ] Support user-correction observations.
- [ ] Support preference observations.
- [ ] Support decision observations.
- [ ] Support fact/discovery observations.
- [ ] Support hypothesis-created and hypothesis-disproved observations.
- [ ] Support failure/incident observations.
- [ ] Support root-cause-verified observations.
- [ ] Support procedure attempt/success/failure observations.
- [ ] Support task opened/resolved/blocked observations.
- [ ] Support project-state observations.
- [ ] Support entity/relationship discovery observations.
- [ ] Define bounded observation payload limits.
- [ ] Define retention semantics for observations that are not promoted.

### Host adapters

- [ ] OpenCode v2 emits normalized user-message observations without duplicate tool-loop capture.
- [ ] OpenCode v2 can emit relevant assistant completion/outcome observations without treating model claims as trusted facts.
- [ ] OpenCode v2 can emit bounded tool result/evidence observations without blindly storing tool output.
- [ ] OpenCode v2 emits session-end/disposal/compaction lifecycle signals suitable for consolidation.
- [ ] Pi maps equivalent lifecycle events to the same normalized contracts where supported.
- [ ] OpenCode v1 compatibility maps what it can without weakening core semantics.
- [ ] Unsupported host signals degrade explicitly rather than being guessed.

### Safety

- [ ] Secret/credential screening occurs before durable observation persistence where appropriate.
- [ ] Retrieved ReMem context cannot be re-observed as fresh user knowledge.
- [ ] Quoted/reported third-party statements retain source semantics and cannot silently become user facts.
- [ ] Tool output remains evidence, not instructions or automatically trusted truth.

**P2 exit:** ReMem has a host-neutral stream of significant session evidence from which learning can be built.

---

## P3 — First-class episodic memory

- [ ] Define `Episode`/episodic record contract distinct from semantic `Memory`.
- [ ] Store ordered material events for an episode/session.
- [ ] Preserve host/session/turn/source provenance.
- [ ] Preserve outcome: succeeded/failed/disproved/unresolved as applicable.
- [ ] Link episodes to relevant project/workspace scope.
- [ ] Link semantic memories back to supporting episode(s).
- [ ] Add PostgreSQL schema/migrations for episodic memory if existing tables are insufficient.
- [ ] Add provider capability for episodic history.
- [ ] Implement bounded episodic retrieval in PostgreSQL provider.
- [ ] Add lexical retrieval for episodes.
- [ ] Add semantic retrieval/embedding strategy for episodes where useful.
- [ ] Define episodic retention/compaction policy independently from semantic memory.
- [ ] Ensure semantic supersession never mutates historical episode truth.
- [ ] Add tests proving a disproven approach remains historically recallable but is not current semantic truth.
- [ ] Add tests proving the evidence for a durable procedure/root cause can be recovered.

**P3 exit:** ReMem can answer both "what do we know now?" and "what happened?" using distinct memory classes.

---

## P4 — General candidate extraction

- [ ] Refactor current deterministic capture into a generic candidate-extraction pipeline over observations/episodes.
- [ ] Preserve deterministic explicit-remember/correction/preference/decision rules as high-confidence signals.
- [ ] Extract durable project facts from evidence-backed episodes.
- [ ] Extract verified root causes.
- [ ] Extract reusable successful procedures.
- [ ] Extract implementation/architecture decisions.
- [ ] Extract unresolved follow-up tasks/project state.
- [ ] Extract entities and aliases useful for recognition.
- [ ] Extract relationships useful for recognition/routing.
- [ ] Identify candidate supersession of existing semantic memory.
- [ ] Identify candidate conflict with existing semantic memory.
- [ ] Attach supporting observation/episode IDs to every candidate.
- [ ] Separate candidate confidence from provider similarity/retrieval score.
- [ ] Add optional local model-backed extractor interface.
- [ ] Keep deterministic extraction as fallback.
- [ ] Make remote extraction impossible unless explicitly configured/authorized.
- [ ] Evaluate extraction precision/false-memory rate on a checked-in corpus.

**P4 exit:** ordinary successful agent work produces useful candidate memories without requiring magic phrases.

---

## P5 — Unify candidate/review lifecycle infrastructure

The repository currently has generic and specialized review concepts. Preserve domain policy, converge infrastructure.

- [ ] Inventory `CandidateMemory`, correction candidates, institutional review state, and consolidation run state.
- [ ] Define one generic candidate lifecycle/state-machine abstraction.
- [ ] Define shared audit-history infrastructure.
- [ ] Define shared optimistic locking/CAS/concurrency behavior.
- [ ] Define shared reviewer identity/decision metadata.
- [ ] Define shared expiry/retention behavior.
- [ ] Define shared failure/retry/recovery behavior.
- [ ] Migrate generic candidate review to shared infrastructure.
- [ ] Adapt expert correction workflow to extend shared lifecycle while retaining replay/evidence requirements.
- [ ] Adapt institutional memory review to extend shared lifecycle where applicable.
- [ ] Remove duplicated lifecycle implementations after migration.
- [ ] Add concurrency regression tests for review/promotion races.

**P5 exit:** specialized memory types add policy, not parallel memory-management architectures.

---

## P6 — Learning policy and safe automatic promotion

- [ ] Define explicit learning-policy result: reject/expire, episodic-only, auto-promote, require-review.
- [ ] Define low-risk auto-promotion criteria.
- [ ] Define evidence sufficiency requirements by memory type.
- [ ] Define confidence thresholds by memory type.
- [ ] Define cases that always require review (meaningful conflicts, high-impact institutional position, uncertain correction, etc.).
- [ ] Define scope escalation rules; a project observation cannot silently become global memory.
- [ ] Define stale/superseding update policy.
- [ ] Define explicit-user-remember behavior as a strong signal subject to safety/scope constraints.
- [ ] Make normal managed-local configuration capable of forming memory automatically.
- [ ] Revisit `capture.enabled` default based on evaluation and privacy disclosure.
- [ ] Revisit `autoPromote` default; replace raw boolean with policy if necessary.
- [ ] Add dry-run/explain diagnostics showing why a candidate was promoted/reviewed/rejected.
- [ ] Add tests for false promotion prevention.
- [ ] Add tests for safe routine automatic promotion.

**P6 exit:** human review is the exception for ordinary safe memory formation, not the default bottleneck.

---

## P7 — Conflict, deduplication, supersession, and current truth

- [ ] Implement semantic near-duplicate detection beyond exact content equality.
- [ ] Distinguish additive update from duplicate.
- [ ] Distinguish supersession from contradiction.
- [ ] Preserve conflicting evidence when truth cannot be resolved safely.
- [ ] Prefer newer verified semantic state for "current knowledge" without deleting historical evidence.
- [ ] Ensure failed hypotheses do not compete as current facts.
- [ ] Support procedure version/supersession semantics.
- [ ] Support task-state transitions without accumulating contradictory active states.
- [ ] Add dependency/relationship impact calculation before superseding linked memory.
- [ ] Add regression tests for stale memory correction.
- [ ] Add regression tests for unresolved conflict presentation.

**P7 exit:** ReMem can maintain "what is currently known" over time without erasing what happened.

---

## P8 — Complete consolidation / reflection loop

- [ ] Define incremental consolidation trigger(s).
- [ ] Define session-end consolidation trigger.
- [ ] Define optional idle/background trigger without requiring a daemon for correctness.
- [ ] Consolidation consumes observations/episodes/candidates idempotently.
- [ ] Consolidation applies learning policy.
- [ ] Consolidation writes semantic mutations transactionally or via durable idempotent work queue.
- [ ] Consolidation updates provenance.
- [ ] Consolidation updates entity/relationship state.
- [ ] Consolidation updates topic/catalog relationships.
- [ ] Consolidation generates/refreshes embeddings.
- [ ] Consolidation records run state and outcome.
- [ ] Interrupted runs recover without duplicate semantic memories.
- [ ] Host shutdown timeout cannot corrupt state or block the host indefinitely.
- [ ] Add deterministic consolidation fallback.
- [ ] Add optional local model-backed consolidation/summarization strategy.
- [ ] Add tests for repeated consolidation idempotence.
- [ ] Add tests for crash/restart recovery.

**P8 exit:** session experience reliably becomes durable, indexed, future-usable memory.

---

## P9 — Automatic catalog, topic, entity, and relationship evolution

- [ ] Define catalog projection from semantic memory/provider state.
- [ ] Automatically create/update topic relationships during promotion.
- [ ] Support useful arbitrary-depth topic/subtopic hierarchy with hard bounds.
- [ ] Automatically maintain aliases from durable entity/topic evidence.
- [ ] Automatically maintain provider locations/retrieval hints.
- [ ] Represent current-work/continuity hints without polluting durable global memory.
- [ ] Update catalog atomically/idempotently after learning.
- [ ] Rebuild catalog from durable provider state.
- [ ] Prevent catalog summaries from becoming an unaudited second source of truth.
- [ ] Evaluate catalog recognition after newly learned memories.
- [ ] Add regression test: new topic learned in Session A is recognized from paraphrase in Session B.

**P9 exit:** learning changes not only storage but ReMem's ability to know what it knows.

---

## P10 — Improve retrieval quality while preserving architecture

Do this after memory formation is working; otherwise retrieval optimization measures a half-system.

- [ ] Implement hybrid lexical + vector fusion for supported providers.
- [ ] Evaluate reciprocal-rank fusion or equivalent fusion strategy.
- [ ] Add optional local cross-encoder reranking.
- [ ] Stamp/enforce embedding and reranker model identity/compatibility.
- [ ] Define reindex semantics for incompatible model changes.
- [ ] Rank semantic and episodic evidence intentionally rather than mixing them blindly.
- [ ] Tune freshness so recency does not override verified current semantic state incorrectly.
- [ ] Preserve provider/source attribution through reranking.
- [ ] Benchmark retrieval quality against current baseline.

**P10 exit:** retrieval quality improves measurably without turning ReMem into pure vector/transcript search.

---

## P11 — Working-memory synthesis

- [ ] Define structured synthesis input separating current semantic state, episodic evidence, conflicts, procedures, and tasks.
- [ ] Improve deterministic synthesis to prioritize current conclusions/decisions/procedures/unresolved work.
- [ ] Surface conflict/staleness explicitly.
- [ ] Preserve compact provenance adjacent to claims.
- [ ] Enforce hard output token budget.
- [ ] Add local model-backed synthesizer interface/implementation.
- [ ] Prevent synthesized text from being recaptured/promoted without independent evidence.
- [ ] Require explicit opt-in for remote model synthesis.
- [ ] Evaluate answer utility and token cost against extractive baseline.

**P11 exit:** injected memory reads like useful working context rather than a bag of retrieved excerpts.

---

## P12 — Explainability and operator UX for automatic memory

- [ ] `memory_explain` can report why recall happened/did not happen.
- [ ] `memory_explain` can report why recent experience was promoted/reviewed/rejected without exposing secrets/raw unsafe content.
- [ ] Provide a bounded "what did ReMem learn from this session?" view.
- [ ] Provide review tooling for queued ambiguous candidates.
- [ ] Provide explicit correction/update/forget paths with provenance/audit semantics.
- [ ] `memory_status` reports observation/consolidation health and backlog.
- [ ] `doctor` validates learning-loop dependencies, not only storage/retrieval.
- [ ] Document privacy implications of each automatic-learning option.

**P12 exit:** automatic memory is inspectable and correctable without requiring routine manual curation.

---

## P13 — Local-first privacy verification

- [ ] Document a formal no-remote-memory-transport default invariant.
- [ ] Inventory every network-capable code path.
- [ ] Distinguish package/model download from sending memory/session content.
- [ ] Add tests or instrumentation proving default recall/learning does not initiate remote memory transport.
- [ ] Ensure local embedding inference remains local after model assets are present.
- [ ] Require explicit configuration for remote providers.
- [ ] Require explicit configuration for remote planner/extractor/synthesizer models.
- [ ] Prevent a newly installed remote-capable provider from receiving data until enabled for a scope.
- [ ] Redact secrets before persistence and logs.
- [ ] Document threat model for malicious provider/retrieved content and memory poisoning.

**P13 exit:** a user can reasonably verify that default ReMem memory stays on the machine.

---

## P14 — Provider ecosystem after closed-loop recovery

Only begin broad provider expansion once P1–P9 are substantially complete.

- [ ] Session-history provider with explicit host support and bounded historical retrieval.
- [ ] Obsidian-specific provider behavior where it adds value beyond generic Markdown.
- [ ] Generic MCP memory provider contract/adapter.
- [ ] Mem0 adapter.
- [ ] Cognee adapter.
- [ ] Define import vs live-provider semantics; do not silently copy external systems of record.
- [ ] Define provider write capability/policy separately from read capability.
- [ ] Add provider contract conformance tests.

**P14 exit:** ReMem orchestrates heterogeneous stores without weakening its core learning/recall model.

---

## P15 — Post-recovery product expansion

These are deliberately after the core memory lifecycle.

- [ ] Scheduled backup/retention policy.
- [ ] Optional encrypted backup/export.
- [ ] Explicit opt-in sync/export architecture.
- [ ] Rich dashboard/TUI if operator demand justifies it.
- [ ] Additional host adapters.
- [ ] More advanced organizational/team scopes.
- [ ] Institutional-memory UX improvements using generic policy infrastructure.
- [ ] Performance work based on measured bottlenecks.

---

# Cross-cutting verification checklist

Every PR touching the memory lifecycle should consider these checks:

- [ ] Does it preserve provenance?
- [ ] Does it preserve scope boundaries?
- [ ] Does it treat retrieved/tool/model content as untrusted evidence?
- [ ] Can it accidentally promote its own generated/retrieved context?
- [ ] Is the operation bounded in time/memory/context size?
- [ ] Does failure leave the host usable?
- [ ] Is durable mutation idempotent or transactionally safe?
- [ ] Can a restart leave partial state that looks successful?
- [ ] Does it keep memory local by default?
- [ ] Does it improve or preserve the Session A / Session B acceptance scenario?
- [ ] Is generic infrastructure being extended rather than duplicated for one domain?

# Milestone definition: "ReMem actually remembers"

This milestone is complete when all of the following are true:

- [ ] P1 closed-loop regression passes reliably.
- [ ] Significant ordinary session work is observed without explicit memory commands.
- [ ] Episodic evidence is durable and retrievable.
- [ ] Safe semantic memory is automatically formed.
- [ ] Ambiguous/conflicting memory is review-gated.
- [ ] Semantic state handles supersession/staleness correctly.
- [ ] Consolidation updates catalog/index state.
- [ ] Fresh sessions automatically recognize and recall relevant prior work.
- [ ] Unrelated prompts remain clean.
- [ ] Default operation keeps memory local.
- [ ] OpenCode v2 real-runtime E2E demonstrates the full loop.

Until this milestone is complete, work that does not materially advance or protect it should normally be considered lower priority.

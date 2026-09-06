# ReMem Target Architecture

> **Status:** Normative target-state architecture.
>
> This document describes the architecture ReMem is trying to reach. `docs/architecture.md` may describe implementation details and historical/current state; this document answers **what the finished system should be**. See `PRODUCT-VISION.md` for product behavior and `IMPLEMENTATION-PLAN.md` for the gap-closing work.

## Architectural objective

ReMem is a host-independent, local-first memory orchestration and learning system for AI agents.

It has two connected loops:

1. **Learning loop:** experience becomes safe, scoped, evidence-backed durable memory.
2. **Recall loop:** durable memory is recognized, selectively retrieved, synthesized, and injected when useful.

Neither loop is sufficient by itself.

```text
                         +-------------------------+
                         |    recognition catalog  |
                         +------------+------------+
                                      |
                                      v
prompt/context -> recognition -> planning -> recall -> synthesis -> injection
      ^                                                       |
      |                                                       v
      |                                                 agent/session
      |                                                       |
      |                                                       v
      +-- catalog/index <- semantic memory <- consolidation <- observations
                                  ^                 |
                                  |                 +-> episodic memory
                                  +------ review / policy
```

## Architectural invariants

1. The orchestration core is host-independent.
2. Storage providers do not own orchestration policy.
3. Recall and learning are separate pipelines joined through durable state/catalog updates.
4. Semantic and episodic memory are distinct first-class concepts.
5. Provenance survives every transformation.
6. Scope/authorization is enforced before retrieval or mutation.
7. Retrieved/model-generated content is untrusted data and cannot self-promote.
8. Automatic behavior is bounded by explicit budgets, timeouts, and policy.
9. Augmentation/learning failure never breaks the host request.
10. Local operation does not silently transport memory off-machine.
11. Catalog state is a recognition index, not a second copy of all memory.
12. Durable state transitions are idempotent/auditable and recoverable after interruption.

## Major subsystems

### 1. Host adapters

Host adapters translate host-specific lifecycle events into normalized core contracts.

They provide:

- pre-dispatch prompt/context events;
- user-message observations;
- assistant completion observations where permitted;
- tool invocation/result observations where permitted;
- session/compaction lifecycle signals;
- verified task-resolution signals when the host can establish them;
- disposal/session-end boundaries.

They do **not** implement memory classification, consolidation, ranking, or provider-specific learning policy.

Primary hosts can include OpenCode v2, OpenCode v1 compatibility, Pi, and future agents.

### 2. Observation pipeline

The observation pipeline creates a normalized, bounded representation of significant session activity.

Target normalized observation categories include:

- user correction;
- user preference;
- decision;
- fact/discovery;
- hypothesis introduced/disproved;
- incident/failure observed;
- root cause verified;
- procedure attempted/succeeded/failed;
- task opened/resolved/blocked;
- project-state change;
- entity/relationship discovery;
- relevant assistant/tool evidence.

Observation is not equivalent to durable truth. Observations retain source, host/session/turn identity, timestamps, scope, trust classification, and evidence references.

The pipeline must avoid storing unrestricted transcripts as semantic memory. Episodic retention is bounded/configurable.

### 3. Episodic memory store

Episodic memory records material events/episodes so ReMem can reconstruct what happened.

Properties:

- append-oriented/immutable evidence where practical;
- source and turn/session provenance;
- event ordering;
- outcome/status;
- references to relevant tool evidence without treating tool text as trusted instructions;
- links to semantic memories derived from the episode;
- retention/compaction policy separate from semantic memory.

Episodic memory supports both direct recall and consolidation.

### 4. Candidate extraction

Candidate extraction identifies potentially durable semantic knowledge from observations/episodes.

The extractor can use staged strategies:

- deterministic rules for explicit/high-confidence signals;
- local semantic/classification models;
- optional local model-backed extraction;
- explicitly configured remote models only when privacy policy allows.

Candidate types include decisions, preferences, facts, procedures, project state, unresolved tasks, corrections, entities, relationships, and superseding information.

Every candidate points back to supporting observations/episodes.

### 5. Trust, scope, safety, and significance classification

Before promotion, candidates are classified for:

- scope: global/user/workspace/project/session and future organization/repository/branch scopes;
- source trust;
- sensitive-data risk;
- durability/significance;
- confidence;
- evidence sufficiency;
- whether the candidate is a current fact, historical event, hypothesis, or procedure;
- whether automatic promotion is permitted.

This is a policy boundary, not merely a regex filter.

### 6. Deduplication, conflict, and staleness engine

New candidates are compared against relevant existing semantic memory.

The engine identifies:

- exact duplicates;
- near duplicates;
- additive updates;
- superseding information;
- genuine contradictions;
- stale positions;
- procedure revisions;
- ambiguous conflicts requiring review.

It must never silently convert historical evidence into a new current truth.

### 7. Learning policy

Learning policy decides among:

- reject/expire;
- retain episodically only;
- auto-promote semantic memory;
- queue for human review.

Auto-promotion should be normal for high-confidence, low-risk, well-scoped knowledge. Human review is required for ambiguous/high-impact/conflicting/policy-sensitive cases, not every ordinary memory.

All promotion paths use shared lifecycle/audit/concurrency infrastructure. Specialized workflows (for example expert corrections or institutional positions) can add domain policy without duplicating the generic state machine.

### 8. Consolidation engine

Consolidation converts candidates and episodic evidence into durable semantic state.

Responsibilities:

- create/update/supersede/retire semantic records;
- preserve provenance;
- preserve unresolved conflict rather than invent consensus;
- derive/update summaries;
- update entities and relationships;
- update topic/catalog relationships;
- generate/refresh embeddings;
- record consolidation run/audit state;
- recover safely after interruption.

Consolidation can run incrementally during a session and at a session-end/background boundary. It should be idempotent.

### 9. Semantic memory store

Semantic memory represents current durable knowledge.

Canonical record classes include:

- fact;
- decision;
- preference;
- procedure;
- task/project state;
- note/position where appropriate.

Records contain scope, confidence, provenance, lifecycle/supersession state, timestamps, relationships, and embedding/index metadata.

PostgreSQL/pgvector is the default managed implementation, but the core contract remains provider-neutral.

### 10. Entity and relationship layer

Entities improve recognition and consolidation across wording changes.

Examples:

- project Phoenix;
- service Bedrock;
- repository `cgkades/remem`;
- database migration;
- person/team/tool identities where allowed.

Relationships can encode bounded facts such as project-has-service, procedure-applies-to-component, decision-supersedes-decision, memory-derived-from-episode, or task-blocked-by-issue.

This is not intended to become a general-purpose knowledge graph before the core lifecycle works.

### 11. Recognition catalog / memory map

The catalog is a compact projection over available memory/provider state.

It contains:

- provider roots/capabilities;
- topics/subtopics;
- entities and aliases;
- compact summaries;
- scopes;
- retrieval hints;
- provider locations;
- continuity/current-work hints.

It is automatically refreshed after relevant durable writes and can be rebuilt from provider state.

The catalog must remain bounded and useful as a recognition layer. It does not contain full memory bodies.

### 12. Retrieval planner

Planning remains staged:

- **Stage 0:** deterministic continuity, exact IDs, paths, aliases, explicit references.
- **Stage 1:** lexical + semantic catalog recognition.
- **Stage 2:** optional model planner for genuine ambiguity, bounded and policy-controlled.

Planner output explicitly says whether retrieval is warranted, why, which providers/topics/scopes to query, and with what budgets.

### 13. Provider router and recall

The router executes the plan against capability-based providers.

Target retrieval combines, where supported:

- lexical search;
- vector search;
- hybrid fusion;
- optional cross-encoder reranking;
- scope/relevance/freshness/importance weighting;
- episodic and semantic retrieval as distinct evidence classes.

Each provider has independent timeout/failure/output budgets. Results preserve provider/source identity.

### 14. Synthesis

Synthesis produces working memory, not new durable truth.

It should:

- deduplicate evidence;
- prefer current semantic state while retaining useful episodic provenance;
- identify conflict/staleness;
- include decisions, procedures, unresolved work, and relevant evidence;
- obey a hard context budget;
- retain source attribution;
- return nothing when memory is not useful.

Deterministic extraction remains a fallback. Local model-backed synthesis is a target. Remote synthesis requires explicit opt-in.

### 15. Context injection

The host adapter injects bounded working memory immediately before dispatch when possible.

Injected memory is:

- ephemeral where the host supports it;
- clearly attributed;
- treated as untrusted evidence;
- separated from trusted system policy;
- not automatically recaptured as new memory.

Tool-loop dispatches must not cause duplicate learning or confuse turn identity.

### 16. Explicit memory tools

Explicit tools remain useful escape hatches and diagnostics:

- search/recall;
- status;
- explain why recall/capture happened or did not happen;
- explicit remember/forget/update where policy allows;
- review operations.

They complement automatic memory behavior; they are not the primary UX.

## Default managed behavior

For a normal local managed installation, the intended defaults are:

- managed local PostgreSQL/pgvector;
- neural local embeddings after explicit model asset installation/download disclosure;
- automatic recall enabled;
- observation enabled with safety filters;
- safe automatic semantic promotion enabled;
- ambiguous/high-risk candidates review-gated;
- session-end/incremental consolidation enabled;
- no remote memory transport;
- bounded diagnostics without raw memory in logs.

Exact defaults may be tuned through evaluation, but the default product must actually form memory.

## Transactional consistency target

A semantic promotion should converge to a consistent state containing:

1. durable semantic record mutation;
2. provenance links;
3. entity/relationship updates as applicable;
4. topic/catalog relationships;
5. embedding/index state;
6. audit/consolidation record.

This may be one database transaction or an idempotent durable work queue, but partial failures must be detectable and recoverable.

## Privacy architecture

Remote communication is capability/configuration based and explicit.

The core should distinguish:

- local provider/model;
- remote provider/model;
- installation/model-asset download;
- memory export/sync.

A remote-capable component cannot silently receive prompts/session observations merely because it is installed.

Secrets/credentials are excluded or redacted before durable observation/candidate formation. Logs remain sanitized.

## Evaluation architecture

Evaluation must cover the closed loop, not just retrieval quality.

Required classes:

- recognition precision/recall;
- retrieval relevance;
- unrelated-prompt non-injection;
- memory formation precision;
- false durable-memory rate;
- conflict/supersession correctness;
- episodic provenance recovery;
- cross-session continuity;
- session-end consolidation;
- host failure/open behavior;
- privacy/no-network invariants;
- token/latency budgets.

The product-level Session A/Session B scenario in `PRODUCT-VISION.md` is the primary end-to-end acceptance test.

## Boundaries against architectural drift

Before adding a feature, ask:

1. Does it strengthen observation, learning, recognition, recall, synthesis, or safe operation of that loop?
2. Does it belong in generic core policy or a specialized domain module?
3. Is it being added before the closed-loop acceptance scenario works?
4. Does it duplicate lifecycle/review/concurrency infrastructure?
5. Does it couple the core to one host/provider/model unnecessarily?

If a specialized workflow requires a new memory lifecycle parallel to the generic lifecycle, that is a design smell. Extend generic policy/infrastructure first.

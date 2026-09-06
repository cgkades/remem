# ReMem Current-State Audit

> **Audit date:** 2026-09-06
>
> **Purpose:** Compare the current repository with `PRODUCT-VISION.md` and `TARGET-ARCHITECTURE.md`. This is a snapshot, not the normative target. Update it when major milestones land.

## Executive assessment

ReMem has **not** lost its original recall/control-plane architecture. The host-independent orchestration core, provider boundary, recognition/planning/recall sequence, bounded context injection, local PostgreSQL/pgvector provider, and failure/trust boundaries are substantial and worth preserving.

The project has, however, drifted in **product behavior and prioritization**. It has built a comparatively mature retrieval and operational substrate while the automatic learning loop remains incomplete and conservative. The result can successfully retrieve memories that already exist while still failing the more important product promise: naturally developing useful memory from ordinary agent work.

The central gap is:

> **ReMem built much of the machinery for using memory before completing the machinery for forming and maintaining memory.**

## High-level scorecard

These percentages are directional engineering assessments, not coverage metrics.

| Capability | Target | Current assessment | Status |
|---|---|---:|---|
| Host-independent orchestration | Core owns memory behavior | ~85% | Strong |
| Recognition/catalog | Automatically recognize likely prior context | ~80% | Strong foundation |
| Retrieval planning/routing | Bounded provider/topic-aware recall | ~80% | Strong foundation |
| Context injection | Automatic, bounded, attributed, safe | ~85% | Strong |
| Managed local storage | Durable local semantic store | ~85% | Strong |
| Semantic retrieval | Useful lexical/vector recall | ~70% | Functional, can improve |
| Synthesis | Compact coherent working memory | ~40% | Mostly extractive |
| Session observation | Understand significant session activity | ~35% | Narrow/incomplete |
| Episodic memory | Preserve what materially happened | ~15% | Major gap |
| Candidate extraction | Derive durable knowledge from work | ~35% | Narrow/deterministic |
| Conflict/staleness learning | Update what is currently known | ~35% | Pieces exist, not closed loop |
| Automatic consolidation | Safe routine memory formation | ~30% | Too review/manual oriented |
| Catalog evolution from learning | New learning improves future recognition | ~40% | Record entries exist; hierarchy weak |
| Closed-loop cross-session memory | Experience -> durable memory -> natural later recall | ~35% | Not yet product-complete |
| External provider ecosystem | Multiple heterogeneous systems of record | ~30% | Markdown/Postgres dominate |

## What is on track

### 1. The core recall architecture

The repository still explicitly implements the intended sequence:

```text
recognition -> retrieval planning -> recall -> synthesis -> context injection
```

This is the correct architectural center. ReMem has not collapsed into a vector-search wrapper.

### 2. Host independence

The core is separated from OpenCode-specific message types and host adapters. OpenCode v2 is the primary integration, with isolated compatibility/integration work for other hosts. This is consistent with the target architecture.

### 3. Provider boundary

PostgreSQL is implemented as the managed/default provider rather than becoming the orchestration engine. Markdown and PostgreSQL share provider contracts. This preserves the future ability to add session, Obsidian, MCP, Mem0, Cognee, and other adapters without rewriting the core.

### 4. Safe bounded recall

The current system includes important production-quality properties:

- scope validation;
- provider timeouts and independent failures;
- ranking and deduplication;
- token budgets;
- provenance/attribution;
- untrusted-memory context boundaries;
- fail-open augmentation;
- fail-closed integrity/scope behavior;
- structured/sanitized diagnostics.

These are not wasted work. They are the substrate the learning loop should feed.

### 5. Managed local storage

The managed PostgreSQL/pgvector stack, migrations, CRUD/supersession, backup/restore, health checks, and neural embedding support are useful foundations for semantic and episodic memory.

### 6. Real-runtime testing

Recent work strengthened OpenCode runtime E2E coverage, including automatic recall against a reachable PostgreSQL provider and host-hook behavior. This increases confidence that the recall path works at the actual host boundary.

## Where behavior diverged from the product vision

### 1. Capture is not the same as observation

The current capture path is primarily driven by deterministic classification of user text. It recognizes patterns such as explicit corrections, preferences, decisions, facts, project-state statements, and explicit remember requests.

This is useful, but a real agent session contains important knowledge that is not expressed as one durable user sentence:

- a tool error establishes a failure mode;
- several tests disprove a hypothesis;
- the assistant discovers a root cause;
- a code change plus test result establishes a successful procedure;
- a task becomes blocked/unblocked;
- a decision emerges from several turns rather than one phrase.

The target needs normalized session observation across user, assistant, tool, and lifecycle events, with trust/evidence boundaries.

### 2. Episodic memory is not first-class enough

The system needs a durable answer to "what actually happened?" independent of the current semantic conclusion.

Current candidate/provenance structures preserve useful source information, but there is not yet a general bounded episodic session-trace/episode layer that supports later evidence recall and consolidation.

Without this, consolidation either loses evidence or must infer too much from isolated captured statements.

### 3. Automatic learning is too conservative to be the normal UX

Current configuration defaults capture off, and automatic promotion is separately opt-in. Review-oriented candidate workflows are sophisticated, but ordinary low-risk memory formation should not require the user to operate a review system.

The desired default is conservative **automatic** learning, with review reserved for ambiguous, conflicting, high-impact, or policy-sensitive cases.

### 4. Consolidation is not yet a complete background/session lifecycle

The repository has consolidation primitives and durable run/recovery concepts, but the target behavior is broader:

- collect meaningful observations/episodes;
- extract multiple candidate types;
- compare against current semantic state;
- resolve duplicates/supersession safely;
- queue genuine conflicts for review;
- promote safe candidates;
- update entities/topics/catalog/embeddings;
- do this incrementally and/or at session end;
- recover idempotently after interruption.

This is the missing "dreaming"/reflection loop.

### 5. Catalog evolution is underdeveloped

Managed writes can create records/catalog entries and embeddings, but arbitrary topic/subtopic/entity relationship population remains incomplete. The recognition catalog should become better organized as the system learns.

The catalog is central because ReMem's differentiation is not merely storing memories; it is knowing what it might know before expensive recall.

### 6. Synthesis is still primitive

Deterministic extractive synthesis is a safe fallback, but the target working-memory synthesis should combine semantic state and episodic evidence, surface unresolved conflict, prioritize current decisions/procedures/tasks, and fit a strict context budget.

A local model-backed strategy is appropriate once evaluation and privacy boundaries are defined.

### 7. Provider breadth is secondary but incomplete

The original vision included heterogeneous memory systems. Current meaningful providers are predominantly PostgreSQL and Markdown. This is a real gap, but it should remain lower priority than closing the learning loop.

## Priority drift observed

The repository has invested meaningful effort in:

- specialized expert-correction review;
- institutional-memory behavior;
- concurrency and replay gates for those workflows;
- OpenCode v1 compatibility;
- Pi host support;
- packaging/publishing;
- embedding hardening;
- extensive host E2E fidelity.

Much of this work is technically sound. The issue is sequencing: specialized workflows and distribution maturity advanced while the generic memory-formation loop was still incomplete.

The correction and institutional systems also create pressure toward parallel domain-specific lifecycle infrastructure. The target architecture should instead share generic candidate/review/audit/concurrency/promotion machinery and allow domain policies to extend it.

## Documentation drift

The repository contains useful architecture, MVP, roadmap, integration, and memory-model documents, but several mix historical state, target state, and deferred work. That makes them unsafe as the sole instructions for autonomous coding agents.

Examples observed during this audit include stale MVP/roadmap statements about automatic learning and publishing status relative to newer implementation/merged work.

The new documentation hierarchy should be:

1. `PRODUCT-VISION.md` — normative behavior and product invariants.
2. `TARGET-ARCHITECTURE.md` — normative finished architecture.
3. `IMPLEMENTATION-PLAN.md` — executable checklist to close the gap.
4. `CURRENT-STATE-AUDIT.md` — dated snapshot of where implementation currently stands.
5. Existing detailed docs/ADRs — implementation detail and accepted decisions, reconciled over time.

Agents should not infer target behavior solely from `mvp.md` or `future-roadmap.md`.

## Components to preserve

Do **not** rewrite these merely to make the project feel cleaner:

- provider contract and router separation;
- PostgreSQL managed/external provider architecture;
- migrations/provenance/scope foundations;
- recognition/planner staging;
- host-independent core boundary;
- OpenCode v2 pre-dispatch injection;
- untrusted-memory separation;
- failure isolation/timeouts/budgets;
- neural embedding abstraction/model identity work;
- existing consolidation recovery/concurrency primitives where they can be generalized;
- real-runtime E2E infrastructure.

The shortest path back to the product vision is to connect a stronger learning loop to this substrate.

## Components to generalize or contain

### Institutional memory

Institutional positions/procedures can remain a domain feature, but applicability/review logic should not leak into generic retrieval or create a second orchestration architecture. Prefer generic retrieval/learning policies with institutional extensions.

### Correction workflow

Expert corrections have special evidence/replay requirements, but candidate lifecycle, audit history, locking/CAS, review status, retention, and promotion should converge with generic candidate infrastructure.

### Host-specific learning

OpenCode/Pi adapters should emit normalized observations. They should not each grow their own memory-learning implementation.

## What should be deprioritized until the closed loop works

Unless required to maintain current users/releases, avoid making these the primary roadmap:

- additional host integrations;
- broad new provider integrations;
- UI/dashboard work;
- more specialized memory domains;
- packaging polish beyond necessary reliability;
- advanced enterprise policy;
- elaborate knowledge-graph functionality;
- cloud sync/export.

## Definition of recovery

The project is "back on track" when the Session A / Session B acceptance scenario in `PRODUCT-VISION.md` passes reliably:

- ordinary work creates useful episodic evidence;
- durable conclusions/procedures/tasks are formed automatically when safe;
- a fresh session naturally recognizes the project/topic;
- the right memory is recalled without explicit memory commands;
- disproven/stale information is not presented as current truth;
- unrelated prompts remain clean;
- all of this happens locally by default.

At that point, provider breadth and product expansion can resume without masking a missing core loop.

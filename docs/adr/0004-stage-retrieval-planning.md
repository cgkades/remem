# ADR 0004: Stage Retrieval Planning

- Status: Accepted
- Date: 2026-09-01

## Context

Calling an LLM or every provider on every turn increases cost, latency, disclosure, and irrelevant
injection. Pure vector similarity is not a sufficient relevance decision.

## Decision

Planning proceeds from deterministic continuity and catalog signals, to inexpensive lexical or
semantic routing, and only then to an optional model planner when ambiguity justifies it. The MVP
implements deterministic and lexical stages only.

## Consequences

- Common decisions are fast, local, and explainable.
- Thresholds require behavioral evaluation.
- Some subtle references will be missed until semantic or model stages are added.
- A model planner remains replaceable and optional.

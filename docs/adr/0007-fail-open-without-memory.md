# ADR 0007: Fail Open Without Memory Enhancement

- Status: Accepted
- Date: 2026-09-01

## Context

Memory is an augmentation to a coding agent. A provider outage, corrupt note, timeout, planner bug,
or compatibility change must not make OpenCode unusable.

## Decision

Put failure boundaries around configuration, catalog loading, planning, each provider request,
ranking, synthesis, logging, and experimental hooks. On failure, omit the affected enhancement and
continue the prompt whenever OpenCode permits it. Record sanitized diagnostics separately.

## Consequences

- OpenCode remains usable during memory failures.
- Missing context can reduce answer quality without being obvious unless diagnostics are checked.
- Tests must cover failure paths as primary behavior.
- Remem must not inject error text as remembered truth.
- Irrecoverable host errors outside plugin control may still abort a request.

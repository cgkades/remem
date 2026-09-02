# ADR 0011: Integrate with the OpenCode v2 Context Hook

- Status: Accepted
- Date: 2026-09-01
- Supersedes: [ADR 0005](0005-inject-context-at-model-dispatch.md)

## Context

OpenCode v1 lacks a non-experimental hook for ephemeral context immediately before every model
dispatch, so the MVP augments `UserMessage.system` during prompt admission. OpenCode v2 provides the
official `ctx.session.hook('context')` API, which runs before dispatch and on each tool-loop model
call. OpenCode v2 is current beta, not stable, as of 2026-09-01.

## Decision

Make the v2 context hook the primary OpenCode integration. Run recognition and recall for each hook
invocation and return bounded context ephemerally, without persisting Remem augmentation into the
conversation. Keep all v2 types and lifecycle assumptions in the OpenCode adapter. Retain the v1
`chat.message` implementation as an isolated compatibility adapter rather than emulating either
version in the orchestration core.

## Alternatives

- Continue using v1 prompt admission in v2: rejected because it can be stale across tool-loop calls
  and persists augmentation with the admitted turn.
- Patch provider requests directly: rejected because it couples Remem to model providers.

## Consequences

- Recall can reflect the latest tool-loop context at every model dispatch.
- Ephemeral memory is not mistaken for user-authored or durable conversation content.
- The beta API may change, so version pinning, contract tests, and fail-open mismatch handling are
  required.
- A hook failure returns no Remem context and must not abort a dispatch when OpenCode permits it.
- v1 behavior and retirement remain independently testable and documented.

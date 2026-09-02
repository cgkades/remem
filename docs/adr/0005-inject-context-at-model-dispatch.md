# ADR 0005: Inject Context for Model Dispatch

- Status: Superseded by [ADR 0011](0011-integrate-with-the-opencode-v2-context-hook.md)
- Date: 2026-09-01

## Context

Memory selected too early can become stale before a model call, while memory inserted into ordinary
conversation text can be mistaken for user-authored content. The ideal boundary is the assembled
context immediately before model dispatch.

OpenCode `v1.18.26` has no non-experimental hook that mutates the fully assembled system context at
every dispatch. Its non-experimental `chat.message` hook can mutate `UserMessage.system`, which
OpenCode persists and includes when assembling model requests for that turn. Direct dispatch-time
transform hooks remain experimental. OpenCode does not publish a broader stability guarantee for
the non-experimental hook surface.

## Decision

Perform recognition and recall in `chat.message`, then attach the bounded catalog and working memory
to `UserMessage.system`. Treat this as dispatch context, not conversation content. Isolate any
experimental compaction or future dispatch hook behind the OpenCode compatibility adapter.

## Consequences

- The MVP uses a non-experimental, typed hook and remains model-provider independent.
- Tool-loop calls retain the turn's memory context.
- Synthetic messages do not trigger fresh retrieval.
- Compaction continuity needs the isolated experimental hook until OpenCode provides a stable one.
- The adapter can move to a stable dispatch hook later without changing the orchestration core.

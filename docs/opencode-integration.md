# OpenCode Integration

## Research Snapshot

This integration was verified against OpenCode `v1.18.26` and
`@opencode-ai/plugin@1.18.26` on 2026-09-01. The relevant release source and the `dev` branch were
equivalent at commit
[`8e0f1c2`](https://github.com/anomalyco/opencode/commit/8e0f1c253b6b7292b419505af849d06747c0e049).

Primary references:

- [official plugin documentation](https://opencode.ai/docs/plugins/)
- [`@opencode-ai/plugin` hook declarations](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/plugin/src/index.ts)
- [prompt admission and loop](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/opencode/src/session/prompt.ts)
- [model request preparation](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/opencode/src/session/llm/request.ts)
- [compaction implementation](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/opencode/src/session/compaction.ts)
- [SDK documentation](https://opencode.ai/docs/sdk/)

OpenCode does not publish a separate plugin-hook stability policy. Remem pins its tested minimum and
keeps host-specific code in `src/integration/opencode.ts`.

## Plugin Shape

An OpenCode plugin exports a function of type `Plugin`:

```ts
type Plugin = (input: PluginInput, options?: Record<string, unknown>) => Promise<Hooks>
```

`PluginInput` provides the SDK `client`, `project`, current `directory`, `worktree`, `serverUrl`, and
Bun shell helper. Remem uses `worktree` for workspace-relative provider paths and `directory` for
current prompt context. It does not invoke the shell helper.

Plugins can be configured as npm package strings, local files, or `[plugin, options]` tuples. Local
and global plugins are loaded once at startup, so configuration changes require an OpenCode restart.

## Hooks Used

| Hook | Stability | Remem use |
| --- | --- | --- |
| `chat.message` | stable | Read the admitted prompt, plan recall, and append bounded context to `output.message.system` |
| `tool` | stable | Register `memory_search` and `memory_status` |
| `event` | stable | Reserved for future session observation; not used for durable capture in the MVP |
| `experimental.session.compacting` | experimental | Add catalog-only continuity guidance to compaction context |

Remem does not use `chat.params` for context. That stable hook modifies sampling and provider
options, not messages. Provider-specific request-option tricks would break model portability.

## Prompt Lifecycle

For a normal user prompt, current OpenCode behavior is:

1. resolve agent, model, and user parts;
2. await `chat.message`;
3. validate and persist the modified user message;
4. load active history and resolve tools;
5. run `experimental.chat.messages.transform`;
6. assemble environment and instructions;
7. assemble the system input, including `UserMessage.system`;
8. run `experimental.chat.system.transform`;
9. run `chat.params` and `chat.headers`; and
10. dispatch to the provider.

Tool-loop dispatches reuse the admitted user message, so Remem's stable `UserMessage.system`
injection remains available throughout that turn.

## Why Stable Prompt Admission

As of the research snapshot, there is no stable hook that mutates the complete assembled system or
message list immediately before every model dispatch. The dispatch-time hooks are still named
`experimental.chat.system.transform` and `experimental.chat.messages.transform`.

Remem therefore performs retrieval in stable `chat.message` and writes to the supported
`UserMessage.system` field. This is persisted by OpenCode and consumed while assembling the provider
request. It also avoids another LLM call and provides a session ID and the actual admitted parts.

The trade-off is that `chat.message` does not run for every synthetic message and the system field is
not serialized as ordinary conversation content during compaction. The compaction compatibility
hook addresses the latter with catalog-only guidance.

## Compaction

`experimental.session.compacting` receives `sessionID` and mutable `output.context` plus an optional
replacement prompt. Remem appends a compact instruction and catalog; it does not replace OpenCode's
prompt. The guidance tells the compactor to preserve memory references without promoting ephemeral
turn details to durable facts.

There is no stable compaction mutation hook in `v1.18.26`. The integration is isolated and covered
by tests so it can be replaced when a stable hook ships. Disabling or losing this hook must not
break normal prompts.

OpenCode emits `session.compacted` after successful compaction. Event handlers are not awaited by
the plugin dispatcher, so future consolidation work triggered from events must be idempotent,
bounded, and independently durable.

## Session and Message Events

Current events include `session.created`, `session.updated`, `session.status`, `session.compacted`,
`session.diff`, `session.error`, `message.updated`, and `message.part.updated`. The older
`session.idle` event is deprecated in favor of `session.status`.

The SDK also exposes session listing, message history, individual messages, status, fork, prompt,
and summarize/compaction operations. The MVP does not read historical sessions automatically. A
future session provider will normalize those records behind `MemoryProvider`.

## Tools

OpenCode plugin tools use the `tool()` helper and schema definitions from `@opencode-ai/plugin`.
Execution receives session, directory, worktree, abort signal, and permission helpers. Remem tools
are read-only in the MVP and return bounded text.

## Configuration

OpenCode passes tuple options as an untyped record. Remem validates and defaults its own options.
Invalid provider entries are disabled with sanitized diagnostics; they do not throw from plugin
initialization.

Example:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-remem",
      {
        "providers": [
          {
            "type": "markdown",
            "id": "notes",
            "paths": ["~/notes", ".remem/memory"],
            "exclude": ["private/**", "**/.trash/**"],
            "scope": "workspace"
          }
        ],
        "budgets": {
          "catalogTokens": 600,
          "recallTokens": 1400,
          "perProviderTokens": 900
        },
        "debug": false
      }
    ]
  ]
}
```

## Compatibility Policy

- Core orchestration imports no OpenCode types.
- Stable hooks are preferred whenever they can express the behavior.
- Experimental APIs are isolated in one module and never required for basic prompt operation.
- Remem tests against its declared minimum and latest OpenCode plugin package in CI when practical.
- Hook mismatches fail open and surface a diagnostic without memory content.

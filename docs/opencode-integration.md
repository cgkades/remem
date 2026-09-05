# OpenCode Integration

## Current Adapter

The primary adapter is built against the current OpenCode v2 beta plugin package
`@opencode-ai/plugin@0.0.0-beta-18743`. It uses `ctx.session.hook("context")`, the official v2
pre-dispatch model-context hook. The API is still beta as of 2026-09-01, so the exact dependency is
pinned and isolated from the orchestration core under `src/hosts/opencode/v2.ts`.

Primary references:

- [official v2 plugin documentation](https://opencode.ai/v2/docs/build/plugins)
- the installed v2 `SessionHooks.context` declaration;
- [ADR 0011](adr/0011-integrate-with-the-opencode-v2-context-hook.md); and
- [ADR 0015](adr/0015-treat-retrieved-memory-as-untrusted-data.md).

OpenCode does not publish a separate beta hook stability policy. Adapter mismatch or setup failure is
logged without memory content and returns no registration rather than preventing OpenCode startup.

## v2 Plugin Shape

OpenCode v2 loads a `Plugin.define()` object with an ID and `setup(context)` method. Remem's package
root default export is this v2 plugin. Setup receives location, plugin options, session hooks, tool
registration, and disposal APIs.

```ts
Plugin.define({
  id: "agentic-remem",
  async setup(ctx) {
    const registration = await ctx.session.hook("context", async (event) => {
      // Run bounded recognition and recall.
    })
    return () => registration.dispose()
  },
})
```

Remem uses `context.location.directory`, `context.location.project.directory`, and project ID to
construct the provider scope. It does not invoke a shell from the prompt path.

## Dispatch Boundary

The `context` hook runs immediately before each model dispatch, including tool-loop calls. Remem
finds the latest non-synthetic user text in the assembled messages, performs bounded recall, and
mutates only the in-flight event:

1. append a trusted system part that says Remem memory is untrusted evidence without tool, secret,
   policy, or write authority;
2. append the actual catalog and recall as an ordinary user message;
3. label that message with `source: "remem"`, `ephemeral: true`, and
   `trust: "untrusted-memory-data"` metadata.

Retrieved memory is never copied into the trusted policy. The hook event is ephemeral, so Remem does
not persist its augmentation into conversation history or automatically turn it into durable memory.

All hook, catalog, semantic, and provider failures are caught. The dispatch continues without Remem
augmentation. This is the host side of [ADR 0007](adr/0007-fail-open-without-memory.md).

## v2 Tools

The v2 adapter registers:

- `memory_search`: explicit bounded search across all providers or one provider ID;
- `memory_status`: provider capabilities, sanitized health, catalog counts, budgets, and latest trace;
- `memory_explain`: the latest sanitized retrieval decision for the current session;
- `memory_submit_correction`: submits an expert correction for review (see
  [Correction Candidate Review Workflow](correction-workflow.md)); it only
  queues a candidate for diagnosis and validation, it never writes to memory;
- `memory_review_status`: read-only, redacted correction-candidate status and
  diagnostics — never the untrusted correction text or proposed memory body.

These tools are read-only with respect to active memory. `MemoryManager` CRUD
and correction-candidate approve/reject/requestChanges are not exposed to
OpenCode; see [Correction Candidate Review Workflow](correction-workflow.md)
for how a human reviews and approves a correction out of band (currently the
`remem correction-review` CLI command).

## v2 Configuration

The v2 key is `plugins`, plural. An entry can be a package string or an object with `package` and
`options`. Because `agentic-remem` is not published yet, source installations must point to the
built package-root entry:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "file:///absolute/path/to/remem/dist"
    }
  ]
}
```

When no inline `providers` option is present, Remem loads the application configuration created by
`remem init`. An entry with explicit provider options looks like this:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "file:///absolute/path/to/remem/dist",
      "options": {
        "providers": [
          {
            "type": "markdown",
            "id": "notes",
            "paths": [".remem/memory"],
            "scope": "workspace"
          }
        ],
        "debug": false
      }
    }
  ]
}
```

Providing `options.providers`, including an empty array, takes precedence over the installed app
configuration. Relative Markdown paths resolve from the OpenCode worktree. Restart OpenCode after
changing plugin configuration.

`remem init --opencode` currently writes the bare package name `agentic-remem` to the platform
OpenCode config. Use it only when that package is resolvable by OpenCode; source-only users should
configure the file URL manually.

## OpenCode 1.18.27 Compatibility

The v1 adapter is isolated in `src/hosts/opencode/v1.ts` and depends on the aliased
`@opencode-ai/plugin@1.18.26` declarations. It is runtime-tested against OpenCode `1.18.27`.
OpenCode v1 resolves this package's `./server` export from the package-root specifier, so a published
install uses the legacy singular key: `{ "plugin": ["agentic-remem"] }`. A source build can use
`{ "plugin": ["file:///absolute/path/to/remem/dist/server.js"] }`. `remem init --opencode-v1`
writes the package form; `remem init --opencode` remains the v2 setup command.

Use the package export `./server` for the legacy `{ id, server }` module or `./opencode/v1` for the
direct adapter. `dist/server.js` is the corresponding source-build entry.

v1 performs recall during `chat.message` and appends catalog and memory data to
`UserMessage.system`. This is persisted for the admitted turn and reused in that turn's tool loop,
but it is a weaker instruction/data boundary than v2. Its optional
`experimental.session.compacting` hook adds catalog-only continuity guidance. Hook failure still
fails open.

The v1 compatibility contract is based on the official OpenCode `v1.18.26` plugin declarations at commit
[`774cc7c`](https://github.com/anomalyco/opencode/commit/774cc7c1914e4329eefde5a669f938b0cf566661) and is
runtime-tested against `v1.18.27`:

- [`chat.message` and hook declarations](https://github.com/anomalyco/opencode/blob/v1.18.26/packages/plugin/src/index.ts)
- [prompt admission and dispatch preparation](https://github.com/anomalyco/opencode/blob/v1.18.26/packages/opencode/src/session/prompt.ts)

## Entry Points

- `agentic-remem` or `agentic-remem/opencode/v2`: current v2 plugin.
- `agentic-remem/server`: isolated v1 `{ id, server }` module (the OpenCode v1 package-loader entry).
- `agentic-remem/opencode/v1`: isolated direct v1 adapter.
- `agentic-remem/core`: host-independent library API.
- `dist/`: source-build v2 plugin directory.
- `dist/server.js`: source-build v1 server entry.

## Compatibility Policy

- Core orchestration imports no OpenCode types.
- v2 beta and v1 release dependencies are pinned separately.
- v2 is primary; v1 compatibility can be retired without changing the core.
- The package declares Node.js `>=22` and OpenCode `>=1.18.26`; v1.18.27 is the tested v1 runtime.
- CI exercises the package on Node.js 22 and 24 with PostgreSQL/pgvector integration tests.
- A Linux Node.js 22 E2E job packages Remem, installs the pinned
  `@opencode-ai/cli@0.0.0-beta-18743` runtime, and drives its HTTP API against a local deterministic
  OpenAI-compatible mock. It verifies plugin loading, dispatch injection, tool-loop continuity,
  transcript isolation, unrelated-prompt isolation, and fail-open behavior with an unavailable
  PostgreSQL provider. The mock also closes several mock-fidelity gaps that earlier revisions left
  untested (issue #8): it streams tool-call `function.arguments` as incremental deltas across
  multiple SSE chunks rather than one complete blob, and it emits a final usage-only SSE frame when
  a request opts into `stream_options.include_usage` (only after a `stop` finish — empirically, the
  live runtime mishandles that frame immediately following a `tool_calls` finish) — the suite
  confirms the client actually surfaces those usage numbers as message token counts, not merely
  that it tolerates the frame. It returns a simulated non-2xx provider error for a dedicated prompt;
  the response is shaped as an SSE error frame over `text/event-stream` specifically because a
  plain `application/json` error body (closer to what many real OpenAI-compatible providers send)
  made the live client hang instead of surfacing an error, and the suite confirms the failure
  surfaces (asynchronously) as the assistant message's terminal `error` field. It also records each
  request's `Authorization` header so the suite can confirm the configured provider credential
  (`REMEM_E2E_MOCK_KEY`) actually reaches the provider as a `Bearer` token, across every scenario's
  dispatches. When
  `REMEM_TEST_DATABASE_URL` is set (CI always sets it; local runs can
  point it at `npm run test:postgres:up`'s instance), it also settles two open questions
  empirically against a real, reachable PostgreSQL provider rather than the forced-outage
  fixture: it seeds a stale embedding, sends one prompt with capture enabled, and confirms both
  of `RememPlugin.setup()`'s independently-registered `"prompt"` hooks (the capture-enqueue hook
  and the re-embed trigger) actually fire — a candidate memory is enqueued and the stale row is
  re-embedded — rather than the second registration silently replacing the first (issue #13); and
  it writes a memory directly through a real `PostgresMemoryProvider`, sends a separate prompt
  that should recall it, and confirms the memory is actually retrieved and injected into
  dispatch (issue #9), since the suite's only prior PostgreSQL coverage was the fail-open path
  for an unreachable provider. Run it locally with `npm run test:opencode-v2`, or in a Linux
  container (native arm64 on Apple Silicon, no emulation needed — the beta runtime ships
  `@opencode-ai/cli-linux-arm64`) with `npm run test:opencode-v2:docker`. The beta pin is updated
  deliberately only after local and CI validation; the test retries npm installation three times
  with exponential backoff for transient registry failures, but a removed beta requires a new
  validated pin.
- Hook mismatches fail open and surface a diagnostic without memory content.
- No adapter automatically reads or writes historical sessions.

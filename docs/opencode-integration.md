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
  id: "opencode-remem",
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
- `memory_explain`: the latest sanitized retrieval decision for the current session.

These tools are read-only. `MemoryManager` CRUD is not exposed to OpenCode.

## v2 Configuration

The v2 key is `plugins`, plural. An entry can be a package string or an object with `package` and
`options`. Because `opencode-remem` is not published yet, source installations must point to the
built package-root entry:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "file:///absolute/path/to/remem/dist/index.js"
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
      "package": "file:///absolute/path/to/remem/dist/index.js",
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

`remem init --opencode` currently writes the bare package name `opencode-remem` to the platform
OpenCode config. Use it only when that package is resolvable by OpenCode; source-only users should
configure the file URL manually.

## OpenCode 1.18.26 Compatibility

The v1 adapter is isolated in `src/hosts/opencode/v1.ts` and depends on the aliased
`@opencode-ai/plugin@1.18.26`. Use the package export `./server` for the legacy `{ id, server }`
module or `./opencode/v1` for the direct adapter. `dist/server.js` is the corresponding source-build
entry.

v1 performs recall during `chat.message` and appends catalog and memory data to
`UserMessage.system`. This is persisted for the admitted turn and reused in that turn's tool loop,
but it is a weaker instruction/data boundary than v2. Its optional
`experimental.session.compacting` hook adds catalog-only continuity guidance. Hook failure still
fails open.

The v1 compatibility contract is pinned to the official OpenCode `v1.18.26` release at commit
[`774cc7c`](https://github.com/anomalyco/opencode/commit/774cc7c1914e4329eefde5a669f938b0cf566661):

- [`chat.message` and hook declarations](https://github.com/anomalyco/opencode/blob/v1.18.26/packages/plugin/src/index.ts)
- [prompt admission and dispatch preparation](https://github.com/anomalyco/opencode/blob/v1.18.26/packages/opencode/src/session/prompt.ts)

## Entry Points

- `opencode-remem` or `opencode-remem/opencode/v2`: current v2 plugin.
- `opencode-remem/server`: isolated v1 `{ id, server }` module.
- `opencode-remem/opencode/v1`: isolated direct v1 adapter.
- `opencode-remem/core`: host-independent library API.
- `dist/index.js`: source-build v2 entry.
- `dist/server.js`: source-build v1 server entry.

## Compatibility Policy

- Core orchestration imports no OpenCode types.
- v2 beta and v1 release dependencies are pinned separately.
- v2 is primary; v1 compatibility can be retired without changing the core.
- The package declares Node.js `>=22` and OpenCode `>=1.18.26`.
- CI exercises the package on Node.js 22 and 24 with PostgreSQL/pgvector integration tests.
- Hook mismatches fail open and surface a diagnostic without memory content.
- No adapter automatically reads or writes historical sessions.

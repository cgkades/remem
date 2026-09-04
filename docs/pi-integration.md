# Pi Integration

## Current Adapter

The Pi adapter lives at `src/hosts/pi/index.ts` (host-location derivation split out into
`src/hosts/pi/location.ts`). It is a [Pi](https://github.com/earendil-works/pi-coding-agent)
extension: a module whose default export is `function(pi: ExtensionAPI)`. Unlike the OpenCode v1/v2
adapters, it does not depend on Pi's runtime package at runtime -- it only imports Pi's published
types (`@earendil-works/pi-coding-agent`, `typebox`) for compile-time shape checking, matching how
Pi expects extensions to treat its own bundled packages (see
[Pi's packages doc](https://github.com/earendil-works/pi-coding-agent) `peerDependencies`
guidance). Both packages are listed as optional peer dependencies in `package.json` and only need
to be resolvable at extension-load time, which Pi itself guarantees since it bundles them.

Primary references:

- [Pi extensions documentation](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/extensions.md)
- [Pi packages documentation](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/packages.md)
- [ADR 0015](adr/0015-treat-retrieved-memory-as-untrusted-data.md) (shared with the OpenCode
  adapters -- the trust boundary described there applies here too).

Like the OpenCode adapters, adapter mismatch or setup failure is logged without memory content;
Pi keeps running without Remem augmentation. This is the host side of
[ADR 0007](adr/0007-fail-open-without-memory.md).

## Event Mapping

Pi's extension API has no session-scoped registration/dispose handles the way OpenCode's
`context.session.hook(...)` does -- `pi.on(...)` registrations live for the whole extension module,
not one session. The adapter therefore keeps a single closure-held, mutable session state object:
it is (re)built on every `session_start` and torn down on every `session_shutdown`, and every other
handler below no-ops if that state is unset (before the first `session_start`, or after
`session_shutdown` has already run for the current session). This also correctly handles Pi's
`/new`, `/resume`, and `/fork` flows, which re-fire `session_shutdown` then `session_start` against
the same long-lived extension instance.

| Concern                                                    | Pi event                 | Behavior                                                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build orchestrator, providers, embedding model             | `session_start`          | Reads Remem's own installed app configuration (see [Plugin Configuration](#plugin-configuration) below); logs and no-ops on failure rather than blocking Pi startup.                               |
| Inject recalled memory before the agent runs               | `before_agent_start`     | Calls `orchestrator.processPrompt(...)`, returning an injected `message` with the same untrusted-memory attribution used by the OpenCode adapters (`TRUSTED_REMEM_INSTRUCTION`).                   |
| `memory_search` / `memory_status` / `memory_explain` tools | `pi.registerTool(...)`   | Registered once at extension load; each handler reads current session state through the closure and fails open when state is unset or the orchestrator call throws.                                |
| Capture explicit user statements                           | `input`                  | Fire-and-forget `CaptureCoordinator.enqueue(...)`, gated by the existing `capture.enabled` config flag (disabled by default, unchanged).                                                           |
| Background reembed-on-input                                | `input`                  | Mirrors `src/hosts/opencode/v2.ts`'s `shouldAttemptReembed`/`reembedStale()` fire-and-forget pattern, using the same 5-minute cooldown.                                                            |
| Compaction-time context injection                          | `session_before_compact` | Gated behind `config.compaction` (off by default), mirroring OpenCode v1's `experimental.session.compacting` hook; returns a `compaction` result built from `orchestrator.compactionContext(...)`. |
| Lifecycle / teardown                                       | `session_shutdown`       | Disposes the capture coordinator and providers, then clears the session state.                                                                                                                     |

## Pi Tools

The adapter registers, via `pi.registerTool(...)` with `typebox` parameter schemas:

- `memory_search`: `{ query: string (required), provider?: string }` -> explicit bounded search
  across all providers or one provider ID;
- `memory_status`: no args -> provider capabilities, sanitized health, catalog counts, budgets, and
  latest trace;
- `memory_explain`: no args -> the latest sanitized retrieval decision for the current session.

These are the same three tools and behavior as the OpenCode adapters' `memory_search`,
`memory_status`, and `memory_explain` (OpenCode v2 additionally exposes correction-review tools not
yet part of the Pi adapter). They are read-only; `MemoryManager` CRUD is not exposed to Pi.

Unlike OpenCode's plugin-registered tools (see
[issue #11](https://github.com/cgkades/remem/issues/11) and `BARE_CALLABLE_TOOL_OPTIONS` in
`src/hosts/opencode/v2.ts`), Pi tools registered via `pi.registerTool(...)` are directly callable by
name with no equivalent `codemode` workaround -- there is only one tool-execution path in Pi's
extension API.

## Host Location and `projectId` Derivation

Pi's `ExtensionContext` has no built-in equivalent of OpenCode's `context.location.project`. The
adapter (`src/hosts/pi/location.ts`, `deriveHostLocation`) derives the three `HostLocation` fields
Remem needs as follows:

- **`directory`**: `ctx.cwd`, resolved to an absolute path -- the specific directory Pi is running
  in for this session.
- **`worktree`**: the git worktree root for `cwd` (`git rev-parse --show-toplevel`), or `cwd` itself
  outside a git repository. This can differ from `directory` when `cwd` is a subdirectory of the
  worktree.
- **`projectId`**: a stable hash of the _shared_ git directory (`git rev-parse --git-common-dir`,
  resolved to an absolute path) -- not the worktree root. Using the common git directory means every
  linked worktree of the same repository resolves to the same `projectId`, so `MemoryScope:
"project"` memory (see `src/types.ts`) is addressed consistently no matter which worktree or
  session touches it. Outside a git repository, `cwd` is hashed instead so the adapter degrades
  gracefully rather than throwing.

Both git lookups run independently and fail closed (falling back to `cwd`) if `git` is unavailable
or the directory is not a git repository, so a missing git binary never prevents the extension from
loading.

## Plugin Configuration

Pi has no options-passing convention for extensions analogous to OpenCode's plugin `options` object.
The adapter always reads Remem's own installed app configuration directly (the same file `remem
init`, `remem status`, and the CLI commands use) via `loadInstalledPluginOptions(undefined)`. There
is currently no way to pass inline provider configuration to the Pi adapter the way OpenCode v2's
plugin `options.providers` allows -- run `remem init` (with `--pi` to also register the extension;
see below) to configure providers, capture, and compaction, then restart Pi.

## Installing the Extension

`opencode-remem` declares itself as a [Pi package](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/packages.md)
via `package.json#pi.extensions`, pointing at the built `dist/hosts/pi/index.js`. `remem init --pi`
adds this package's own installed root directory as a local-path entry to Pi's global `packages`
setting (`~/.pi/agent/settings.json` by default, or `${PI_CODING_AGENT_DIR}/settings.json` when that
environment variable is set):

```json
{
  "packages": ["/absolute/path/to/opencode-remem"]
}
```

Pi auto-discovers `pi.extensions` from that local package's `package.json`, so nothing needs to
duplicate or hardcode the `dist/hosts/pi/index.js` path. `remem init --pi` is additive: it preserves
any existing `packages` entries and can be combined with `--opencode` to configure both hosts from
one `remem init` invocation. `remem status` and `remem doctor` report whether the Pi integration is
configured and, once `remem doctor` can read the settings file, whether this package's path is
actually present in `packages`.

Restart Pi (or run `/reload`) after changing its settings for the extension change to take effect.

## Entry Points

- `opencode-remem/pi`: the Pi extension (`export default function(pi: ExtensionAPI)`).
- `opencode-remem/core`: host-independent library API (shared with the OpenCode adapters).
- `dist/hosts/pi/index.js`: source-build entry Pi's package loader discovers via
  `package.json#pi.extensions`.

## Testing

Unit tests (`tests/pi-integration.test.ts`, run via `npm run test:pi`) exercise the adapter against a
hand-rolled fake `ExtensionAPI`/`ExtensionContext`.

An end-to-end test (`tests/pi.e2e.mjs`, run via `npm run test:pi:e2e`) drives the real `pi` CLI binary
against a local, deterministic OpenAI-compatible mock model server -- no real provider credentials
are used or required. It overrides `HOME` for the spawned `pi` process to a scratch directory, so it
never reads or writes an operator's real `~/.pi/agent` state (settings, sessions, auth). It verifies:

- the first request to the model contains the injected, attributed memory context (the
  `before_agent_start` hook fired and the untrusted-evidence framing is present);
- a subsequent request contains a real `memory_status` tool result from the actual orchestrator
  (`pi.registerTool` round-tripped through Pi's tool-execution path, not a stub).

Run it in a Linux container (`npm run test:pi:e2e:docker`, `docker/pi-e2e.Dockerfile`) for full
isolation from the host, including from any `pi` CLI version already installed locally -- the
container pins its own. This mirrors the existing `test:opencode-v2`/`test:opencode-v2:docker`
pattern in `docs/opencode-integration.md`.

## Compatibility Policy

- Core orchestration imports no Pi types; `src/hosts/pi/index.ts` and `src/hosts/pi/location.ts` are
  the only files that reference Pi's extension shape, and only via `import type`.
- `@earendil-works/pi-coding-agent` and `typebox` are optional peer dependencies, matching Pi's own
  guidance for extensions that import its bundled packages; adding the Pi adapter never adds a hard
  runtime dependency on Pi itself.
- Adding the Pi adapter does not change OpenCode v1/v2 behavior, config schema defaults, or public
  exports.
- Hook mismatches fail open and surface a diagnostic without memory content, mirroring the OpenCode
  adapters.
- No adapter automatically reads or writes historical Pi sessions.

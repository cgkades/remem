# Security Model

## Assets

Remem can handle source code context, project plans, personal preferences, operational notes,
incident history, paths, and provider credentials. The memory catalog itself may reveal sensitive
project names even when note bodies are not injected.

## Trust Boundaries

- The OpenCode process and configured local user are trusted to read configured memory sources.
- Memory providers are independent trust domains.
- Provider content is untrusted data, including Markdown instructions and MCP tool output.
- Remote model and memory services are external processors.
- The primary model receives only context selected under configured budgets and exclusions.

## Threats

### Unintended Disclosure

A broad scope or path could expose one project's memory in another workspace. Remem resolves and
enforces scope owners, defaults to a worktree-local directory, and applies configured path
exclusions before indexing. Project/session Markdown notes require a matching `scope-id`; external
workspace roots require one as well.

Explicitly malformed provider lists or scope values fail closed by disabling the affected provider
or note and emitting a sanitized diagnostic. Defaults apply only when the setting is omitted.

### Prompt Injection in Memory

Stored Markdown can contain instructions intended to control the agent. Remem wraps retrieved text
as attributed memory data and system guidance says to treat it as potentially stale source material,
not higher-priority instructions. The MVP does not execute links, commands, or embedded code.

### Secret Persistence

Future capture must redact or reject secrets before writes. The MVP has no automatic writes. Users
should exclude secret directories and avoid placing credentials in memory notes. Configuration
should use environment-backed provider credentials rather than note frontmatter.

### Path Traversal and Symlinks

The Markdown adapter starts from explicitly configured roots, ignores non-Markdown files, applies
relative path exclusions, and does not follow symbolic links during recursive discovery. Absolute
roots are allowed because users may intentionally attach an Obsidian vault.

### Remote Exfiltration

The Markdown MVP makes no network calls and has no telemetry. A future remote provider or
model-backed planner/synthesizer must be explicitly enabled and document what data leaves the
machine. Local retrieval must remain possible without those features.

### Denial of Service

Large trees, files, provider outputs, and slow backends can consume resources. Adapters enforce file
and result limits, provider requests have timeouts, outputs are token-budgeted, and failures settle
independently.

### Poisoning and Stale Knowledge

Similarity does not establish truth. Remem preserves provenance, freshness, and conflicts. It does
not silently reconcile contradictory records or promote retrieved synthesis into durable memory.

## Logging

Normal logs include event names, provider IDs, counts, durations, budgets, and sanitized error
classes. They do not include prompts or memory bodies. Debug mode may include matched catalog titles
and query terms; users should treat debug output as sensitive and disable it by default.

Provider errors are sanitized before logging. Health results must never include tokens or sample
records.

## Exclusions and Redaction

The MVP supports provider path exclusions. Planned policy layers include:

- glob and metadata exclusions;
- pre-retrieval and pre-write redaction;
- provider-specific field allowlists;
- secret-scanner integration;
- scope access policies; and
- audit records for remote processing and writes.

Redaction should occur before remote calls, not only before final context injection.

## Data Retention and Deletion

The MVP reads provider-owned Markdown and retains only an in-memory index and bounded diagnostics.
It creates no hidden memory database. Index and catalog snapshots expire after 30 seconds; explicit
refresh also invalidates them. Deleting a source file becomes visible after either event.

Future adapters must document deletion semantics, caches, backups, and whether provider deletion is
hard, soft, or eventually consistent. `memory_forget` must show the target source and scope before a
destructive operation.

## Safe Defaults

- local worktree provider only;
- no telemetry;
- no network calls;
- no automatic writes;
- no full-content normal logs;
- bounded files, results, and injected tokens;
- provider failures do not block OpenCode; and
- debug mode disabled.

## Residual Risks

System-context labeling and metadata escaping reduce but cannot eliminate prompt injection from
recalled data. The UTF-8 byte budget deliberately underfills most model token budgets. A user who
configures broad global paths grants Remem access
to them. Experimental OpenCode compaction hooks may change before stabilization.

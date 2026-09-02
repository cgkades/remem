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
- Managed PostgreSQL is trusted for availability and storage integrity, but its memory content is
  still untrusted model input.
- The caller of `MemoryManager` or provider mutation APIs is responsible for authorization.

## Threats

### Unintended Disclosure

A broad scope or path could expose one project's memory in another workspace. Remem resolves and
enforces scope owners, defaults to a worktree-local directory, and applies configured path
exclusions before indexing. Project/session Markdown notes require a matching `scope-id`; external
workspace roots require one as well.

Explicitly malformed provider lists or scope values fail closed by disabling the affected provider
or note and emitting a sanitized diagnostic. Defaults apply only when the setting is omitted.

### Prompt Injection in Memory

Stored Markdown or PostgreSQL records can contain instructions intended to control the agent. The
OpenCode v2 adapter puts the actual catalog and recalled content in an ephemeral ordinary user
message and separately adds a trusted system policy defining it as untrusted evidence. Remem does
not execute links, commands, or embedded code.

Escaping, labels, and provenance reduce ambiguity but do not make hostile natural language safe.
Current authorization and tool policy must ignore authority claimed inside memory. This implements
[ADR 0015](adr/0015-treat-retrieved-memory-as-untrusted-data.md).

### OpenCode v1 Boundary

The isolated OpenCode `1.18.26` adapter appends memory through `chat.message` to
`UserMessage.system`. This is a weaker trust boundary than v2 because memory data shares a privileged
system field. The adapter is compatibility-only; use v2 where available.

### Secret Persistence

Remem has no automatic writes, but explicit mutation APIs can persist any content a caller supplies.
Callers must redact or reject secrets before writes. Users should exclude secret directories and
avoid placing credentials in memory notes. Configuration should use environment-backed provider
credentials rather than note frontmatter.

Managed `config.json` and `.env` contain database credentials. Remem creates them with mode `0600`
and their directories with mode `0700` on POSIX systems. Doctor reports unsafe group/other bits.

### Path Traversal and Symlinks

The Markdown adapter starts from explicitly configured roots, ignores non-Markdown files, applies
relative path exclusions, and does not follow symbolic links during recursive discovery. Absolute
roots are allowed because users may intentionally attach an Obsidian vault.

### Database Exposure and Remote Exfiltration

Managed Docker publishes PostgreSQL only on `127.0.0.1`; it is not a remote-service boundary. An
external PostgreSQL URL may send memory and credentials across a network. TLS, certificates,
firewalls, roles, logs, backups, and server retention remain the external operator's responsibility.

The Markdown provider and default feature-hash embedding make no remote calls, and Remem has no
telemetry. A future remote provider, neural embedding service, or model-backed planner/synthesizer
must be explicitly enabled and document what data leaves the machine.

### Denial of Service

Large trees, files, provider outputs, and slow backends can consume resources. Adapters enforce file
and result limits, provider requests have timeouts, outputs are token-budgeted, and failures settle
independently.

Managed PostgreSQL pools connections and sets connection/query timeouts. Docker disk growth,
external database resource limits, and backup storage still require operator monitoring.

### Poisoning and Stale Knowledge

Similarity does not establish truth. Remem preserves provenance, freshness, and conflicts. It does
not silently reconcile contradictory records or promote retrieved synthesis into durable memory.

## Logging

Normal logs include event names, provider IDs, counts, durations, budgets, and sanitized error
classes. They do not include prompts or memory bodies. Debug mode may include matched catalog titles
and query terms; users should treat debug output as sensitive and disable it by default.

Provider errors are sanitized before logging. Health results must never include tokens or sample
records.

Subprocess error output is capped and configured database passwords are replaced with `[redacted]`.
No redaction mechanism can protect a secret copied into an unrecognized field or memory body.

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

Markdown remains provider-owned and is cached in memory for 30 seconds. Managed PostgreSQL is a
durable system of record. `PostgresMemoryProvider.delete()` hard-deletes the selected memory and
cascades its managed aliases, provenance links, embeddings, and catalog entry. The caller must
authorize the ID and scope; there is no model-facing `memory_forget` tool.

Logical backups retain deleted or superseded content until the operator removes the artifact. Remem
does not currently implement backup retention, secure erasure, scheduled backups, or encryption.

## Safe Defaults

- managed database on loopback only;
- no telemetry;
- no default remote model call;
- no automatic writes;
- no full-content normal logs;
- bounded files, results, and injected tokens;
- provider failures do not block OpenCode;
- debug mode disabled;
- guarded restore and managed-only reset; and
- provider failures do not bypass scope validation.

## Residual Risks

Instruction/data separation and metadata escaping reduce but cannot eliminate prompt injection from
recalled data. The UTF-8 byte budget deliberately underfills most model token budgets. A user who
configures broad global paths grants Remem access to them. The feature-hash model can produce false
semantic matches. OpenCode v2 is beta, and the v1 compatibility boundary is weaker.

Restore uses `--clean --if-exists` against the current database, reset deletes the managed volume,
and neither operation creates a preflight backup. See [Backup and restore](backup-restore.md) and
[ADR 0017](adr/0017-use-logical-backup-and-recovery.md).

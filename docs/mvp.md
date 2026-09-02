# MVP

## Hypothesis

A small recognition catalog plus deterministic provider routing can recover useful project context
without an embedding database, an LLM call per turn, or indiscriminate context injection.

## Included

- OpenCode plugin initialization and options validation.
- Stable prompt admission through `chat.message`.
- Worktree-aware Markdown provider with conservative frontmatter support.
- Catalog generation from note metadata.
- Deterministic continuity signals and lexical catalog matching.
- Structured retrieval plans.
- Independent provider failure handling and timeouts.
- Result ranking, exact-content deduplication, provenance, and token budgets.
- Deterministic context synthesis.
- Structured diagnostics and read-only memory tools.
- Experimental compaction continuity isolated in the OpenCode adapter.
- Behavioral tests and CI.

## Not Included

- Embeddings or vector storage.
- An LLM planner or synthesizer.
- Mem0, Cognee, MCP, or OpenCode session adapters.
- Automatic candidate capture or provider writes.
- Consolidation/dreaming.
- Semantic contradiction resolution.
- A `/memory` TUI command or graphical dashboard.
- Exact model-specific tokenizers.

## Acceptance Scenarios

Given this memory:

```markdown
# Project Phoenix

Database migration is PostgreSQL 14 to PostgreSQL 17.
Decision: use logical replication.
Previous blocker: extension compatibility.
```

When the user says:

```text
Let's continue the Phoenix database work.
```

the model context contains a compact catalog hint and attributed Phoenix details.

When the user says:

```text
Can you explain a Python list comprehension?
```

the catalog remains bounded recognition context, but Phoenix details are not included as retrieved
working memory.

If the Markdown directory is missing, unreadable, or malformed, OpenCode still receives the user
prompt and can answer without memory augmentation.

## Success Metrics

- The acceptance scenarios pass as behavioral tests.
- No automatic retrieval occurs below the configured confidence threshold.
- Injected catalog and recall remain within their independent budgets.
- Every recalled item has provider and source attribution.
- One failed provider does not discard another provider's result.
- No network call or durable write occurs in the default configuration.
- Lint, formatting, typecheck, tests, and build pass in CI.

## Exit Criteria

The MVP is complete when it demonstrates recognition, planned Markdown recall, bounded synthesis,
and OpenCode context injection as separate testable components. More backends are not an MVP exit
criterion.

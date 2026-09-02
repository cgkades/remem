# Future Roadmap

## Phase 1: Harden the MVP

- Gather real-world precision and latency traces.
- Add catalog refresh strategies and filesystem watching.
- Improve Markdown chunking, Obsidian aliases, wikilinks, and frontmatter parsing.
- Add provider conformance tests and richer conflict fixtures.
- Track exact token use where OpenCode exposes a model tokenizer.
- Stabilize configuration and publish `opencode-remem`.

## Phase 2: Provider Ecosystem

- Obsidian-specific indexing over the Markdown source of truth.
- Mem0 adapter with explicit remote-processing policy.
- Confirm whether "Congee" means Cognee, then design its adapter against the stable API.
- Generic MCP tool-backed provider.
- OpenCode prior-session provider using stable SDK history APIs.
- Provider reliability and scope-policy configuration.

## Phase 3: Smarter Planning and Synthesis

- Optional local embedding router.
- Ambiguity-gated small-model planner.
- Model-backed synthesis behind explicit privacy and cost controls.
- Temporal and supersession-aware ranking.
- Conflict grouping without automatic reconciliation.
- Query expansion informed by catalog aliases and project state.

No phase should make an LLM call mandatory for every prompt.

## Phase 4: Observation and Candidates

- Observe explicit user corrections, decisions, solved failures, preferences, and unresolved tasks.
- Extract candidates without writing durable memory by default.
- Provide a review queue with source message references.
- Add configurable redaction and secret scanning.
- Distinguish episodic candidates from proposed durable knowledge.

## Phase 5: Consolidation

- Session-bound and background consolidation jobs.
- Idempotent topic summaries and catalog updates.
- Duplicate merge and supersession proposals.
- Promotion and demotion based on recurrence and review.
- Reversible writes with provenance and audit records.
- Optional second-pass review for high-impact changes.

## Phase 6: User Experience and Evaluation

- `/memory`, `/memory explain`, and provider health views if OpenCode exposes stable command APIs.
- Explain the previous retrieval decision and budget allocation.
- Evaluation harness with redacted datasets and precision/context-cost dashboards.
- Cross-model testing for Anthropic, OpenAI, Bedrock, Gemini, and local models.
- Team and organization scopes with explicit access controls.

## Non-Goals

Remem should not become a mandatory hosted service, a universal vector database, a transcript dump,
or a replacement for provider-owned knowledge systems.

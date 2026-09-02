# ADR 0001: Orchestrate Memory Instead of Owning All Storage

- Status: Accepted
- Date: 2026-09-01
- Refined by: [ADR 0008](0008-manage-a-default-store-while-remaining-an-orchestrator.md)

## Context

OpenCode users already keep knowledge in Markdown, Obsidian, Mem0, Cognee, MCP servers, databases,
and prior sessions. Replacing all of them would create another silo and make retrieval policy
inseparable from storage migration.

## Decision

Remem is a memory orchestration layer. It owns recognition, planning, cross-provider recall,
synthesis, budgets, injection, and diagnostics. Providers retain ownership of detailed records.

The Markdown provider is a reference adapter, not a declaration that Remem is primarily a Markdown
store.

## Consequences

- Existing sources can be adopted incrementally.
- Cross-provider normalization and conflict handling become core concerns.
- Provider consistency cannot be assumed.
- Remem must operate when some or all providers are unavailable.
- Durable writes and migrations are provider-specific.
- ADR 0008 refines this decision by making a Remem-managed local store the default provider without
  making it the only provider or moving storage concerns into the orchestration core.

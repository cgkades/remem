# ADR 0014: Support Bounded Synthesis Strategies

- Status: Accepted
- Date: 2026-09-01

## Context

Extractive synthesis is predictable and private but can be verbose. Model synthesis can compress and
organize evidence, but may disclose data, invent reconciliation, increase cost, or become
unavailable. One strategy cannot satisfy every deployment.

## Decision

Define one synthesis contract with deterministic extractive, optional local-model, and explicitly
configured external-model strategies. Every strategy receives bounded attributed records and must
return bounded output with provenance, stale and conflict labels, and omission metadata.
Deterministic extraction is the default and fallback.

## Alternatives

- Always use extraction: safe, but leaves useful compression unavailable.
- Always use an external model: rejected because it violates local-first defaults and availability.
- Let each provider synthesize: rejected because budgets and cross-provider provenance would diverge.

## Consequences

- Strategy selection can reflect privacy, resource, latency, and cost policy.
- External processing requires explicit consent and disclosure of what leaves the machine.
- Model output is untrusted and cannot silently resolve contradictions or authorize durable writes.
- Timeout, malformed output, or budget failure falls back to extraction, catalog only, or no
  augmentation without blocking the host.

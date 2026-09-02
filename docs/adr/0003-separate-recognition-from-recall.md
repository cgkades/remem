# ADR 0003: Separate Recognition Memory from Recall Memory

- Status: Accepted
- Date: 2026-09-01

## Context

An agent cannot retrieve what it does not know exists, but placing all known detail in every context
causes pollution and cost. Search alone also fails when a vague reference lacks enough terms.

## Decision

Maintain a small, aggressively budgeted catalog of topics, aliases, provider locations, and
retrieval hints. Keep detailed source material in provider-owned recall memory and fetch it only
when planning warrants retrieval.

## Consequences

- The model can recognize likely prior knowledge at low context cost.
- Catalog quality and refresh become first-class concerns.
- The catalog is explicitly incomplete; absence cannot imply no memory exists.
- Detail can grow without growing always-visible context at the same rate.

# ADR 0012: Use a Hierarchical Provider and Topic Catalog

- Status: Accepted
- Date: 2026-09-01

## Context

A flat catalog grows linearly in every prompt, obscures provider and scope boundaries, and gives
vague references too little structure. Putting detailed records in the catalog would solve neither
budget pressure nor source ownership.

## Decision

Represent recognition memory as a bounded hierarchy of provider roots, topics, and subtopics. Nodes
carry stable identity, parent, aliases, scope, compact summary, retrieval hints, and one or more
provider locations. Render only relevant branches and a small set of roots; fetch detailed records
from providers after planning.

Implementation status: provider descriptors and topic entries provide the first two levels. Catalog
entries can retain parent identity and the managed schema has topic relationships, but managed writes
do not yet populate arbitrary subtopic branches and the renderer does not traverse them.

## Alternatives

- Keep a flat list: simple, but expensive and ambiguous as providers and topics grow.
- Build one global knowledge graph: expressive, but too complex and likely to erase provider
  ownership for the current requirements.
- Inject detailed summaries for every topic: rejected because recognition becomes unbounded recall.

## Consequences

- Recognition can narrow from provider to topic without exposing all details.
- Cross-provider topics can retain multiple attributed locations.
- Parent changes, aliases, cycles, orphan handling, and catalog versioning need explicit rules.
- Absence from a rendered branch never proves that no memory exists.
- If hierarchy loading fails, Remem uses a valid bounded snapshot or skips automatic recognition.

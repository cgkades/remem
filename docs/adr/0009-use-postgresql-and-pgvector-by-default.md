# ADR 0009: Use PostgreSQL and pgvector by Default

- Status: Accepted
- Date: 2026-09-01

## Context

The default store needs transactional records, scopes, provenance, hierarchical relationships,
lexical retrieval, vector similarity, and a mature recovery path. Splitting these concerns across a
document database and a vector service would add lifecycle and consistency failures.

## Decision

Use PostgreSQL as the managed provider's durable store and pgvector for embeddings. Keep canonical
content, scope, provenance, catalog edges, and migration state relational; use PostgreSQL full-text
indexes for lexical retrieval and vector indexes for semantic candidate selection. Access remains
behind the provider adapter.

## Alternatives

- SQLite plus a vector extension: simpler to embed, but extension portability, concurrent writes,
  and operational recovery are less predictable for the accepted learning path.
- A standalone vector database: strong vector search, but weaker transactional joins and another
  service for canonical metadata.
- Markdown only: transparent and portable, but insufficient as the managed semantic default.

## Consequences

- One transactional system can keep records, provenance, topics, and index state consistent.
- PostgreSQL and pgvector installation, upgrades, tuning, and disk use become product concerns.
- Embedding similarity remains a retrieval signal and never a truth or authorization decision.
- A database outage fails open at the host boundary, but the provider fails closed on invalid scope,
  credentials, extension state, or schema integrity.

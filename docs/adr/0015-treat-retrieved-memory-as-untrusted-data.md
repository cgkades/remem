# ADR 0015: Treat Retrieved Memory as Untrusted Data

- Status: Accepted
- Date: 2026-09-01

## Context

Memory can contain stale claims, malicious prompt injection, copied web text, poisoned provider
results, or instructions that were legitimate only in an earlier context. Attribution does not make
content authoritative.

## Decision

Treat provider records, catalog text, tool output, embeddings, and generated synthesis as untrusted
data. Enforce authorization and scope before retrieval, bound and attribute every result, and place
memory in a clearly delimited context section that grants it no authority to run tools, reveal
secrets, change policy, override the user, or write durable memory. Sanitize diagnostics and omit raw
memory from normal logs.

## Alternatives

- Trust records from the managed database: rejected because trusted storage can still hold untrusted
  content.
- Attempt to remove every malicious phrase: rejected because natural-language filtering is not a
  complete prompt-injection defense.
- Inject memory as ordinary user text: rejected because authorship and instruction priority become
  ambiguous.

## Consequences

- The context format and model guidance must preserve a visible instruction/data boundary.
- Tool execution and learning require independent current authorization, never authority quoted from
  memory.
- Suspicious content can be labeled or omitted, with provenance retained in diagnostics.
- If safe bounding, attribution, or scope validation fails, Remem omits the affected memory and the
  host continues without augmentation.

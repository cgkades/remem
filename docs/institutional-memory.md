# Institutional Memory

Institutional memory is curated data for approved organizational guidance. It
uses the existing `MemoryWrite` envelope for `title`, `scope`, `provenance`,
importance, relationships, and provider storage. Generic memories remain
unchanged when they omit `institutional` metadata.

## Position

A position is an approved stance or constraint. Write it with
`type: "decision"` and an `institutional` object with `role: "position"`.
The metadata requires a stable ID, owner or authority, source references,
boundary conditions, deterministic applicability conditions, and review data.
The enclosing memory must include attributable provenance.

## Procedure

A procedure is an ordered, fact-free method that applies positions. Write it
with `type: "procedure"` and `role: "procedure"`. It requires ordered steps,
referenced position IDs, required evidence, completion criteria, escalation
conditions, applicability conditions, and review data. Its stored `content`
is exactly the numbered step instructions; position facts remain in referenced
positions rather than being copied into the procedure.

## Validation

`validateInstitutionalMemories` validates a complete curated collection before
persistence or retrieval routing. It deterministically rejects duplicate IDs,
missing provenance or references, invalid applicability conditions, unreviewed
or expired records, malformed procedures, and dependency cycles. Its `asOf` option makes
review and expiry decisions reproducible in tests and batch jobs.

Applicability conditions are intentionally declarative:

```ts
{
  match: "all",
  conditions: [
    { id: "project", kind: "context", field: "projectId", value: "remem" },
    { id: "release", kind: "topic", value: "production-change" },
  ],
}
```

The next retrieval slice evaluates these conditions before semantic matching.
Institutional content remains inert data and does not grant permission to run

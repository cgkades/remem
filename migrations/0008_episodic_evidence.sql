-- Phase 3 (TASK-010) of plan/feature-memory-recovery-1.md: extends the
-- existing remem.session_events table as the canonical episodic evidence
-- store, per the plan's storage decision ("extend remem.session_events...
-- rather than create a competing raw-trace pipeline"). Legacy rows (written
-- by the existing capture/consolidation path) have all new columns NULL and
-- remain fully usable by existing candidate paths; nothing here rewrites or
-- reinterprets them.
--
-- New columns carry the normalized identity/origin/role, safe text,
-- evidence references, canonical hash, and schema version described in the
-- plan's Phase 2 EvidenceEnvelope contract (src/observation-admission.ts).
-- `evidence_id`/`content_hash` are the envelope's own derived `id`/
-- `contentHash` (SHA-256 hex digests, not UUIDs) -- kept as a separate `text`
-- column rather than reusing the existing `id uuid PRIMARY KEY`, so the
-- existing column's type and `candidate_memories.session_event_id`'s foreign
-- key are untouched.
ALTER TABLE remem.session_events
  ADD COLUMN provider_id text,
  ADD COLUMN host text,
  ADD COLUMN role text CHECK (role IS NULL OR role IN ('user', 'assistant', 'tool', 'system')),
  ADD COLUMN origin text
    CHECK (origin IS NULL OR origin IN ('direct-user', 'host-observed', 'retrieved', 'extension', 'unknown')),
  ADD COLUMN turn_id text,
  ADD COLUMN message_id text,
  ADD COLUMN safe_text text NOT NULL DEFAULT '',
  ADD COLUMN evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN evidence_id text,
  ADD COLUMN content_hash text,
  ADD COLUMN schema_version integer;

-- Matches the existing generated-tsvector convention used by
-- remem.memories.search_vector (migrations/0001_initial_schema.sql).
ALTER TABLE remem.session_events
  ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(safe_text, ''))
  ) STORED;

-- Same identity (provider + evidence_id) can appear at most once. Legacy
-- rows (evidence_id IS NULL) are excluded from this constraint entirely --
-- a partial unique index, not a table-wide one, so any number of legacy
-- rows with NULL evidence_id remain unaffected.
CREATE UNIQUE INDEX session_events_evidence_identity_idx
  ON remem.session_events (provider_id, evidence_id)
  WHERE evidence_id IS NOT NULL;

-- Scoped lookup for TASK-011's episode search: only rows belonging to the
-- new evidence-admission path (evidence_id IS NOT NULL) are indexed here,
-- keeping this index small and irrelevant to legacy session_events queries.
CREATE INDEX session_events_evidence_scope_idx
  ON remem.session_events (provider_id, project_id, occurred_at DESC)
  WHERE evidence_id IS NOT NULL;

-- Full-text index over the envelope's safe (already screened) narrative
-- text, for TASK-011's lexical episode search. Legacy rows have
-- safe_text = '' (the column default), so they contribute an empty,
-- harmless tsvector rather than participating in evidence search.
CREATE INDEX session_events_safe_text_fts_idx
  ON remem.session_events USING GIN (search_vector);

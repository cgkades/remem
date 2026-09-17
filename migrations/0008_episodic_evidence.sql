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
--
-- Plain ADD COLUMN (no inline CHECK) here is metadata-only in PostgreSQL for
-- nullable columns and NOT NULL columns with a constant DEFAULT -- no table
-- rewrite, no per-row validation scan.
ALTER TABLE remem.session_events
  ADD COLUMN provider_id text,
  ADD COLUMN host text,
  ADD COLUMN role text,
  ADD COLUMN origin text,
  ADD COLUMN turn_id text,
  ADD COLUMN message_id text,
  ADD COLUMN safe_text text,
  ADD COLUMN evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN evidence_id text,
  ADD COLUMN content_hash text,
  ADD COLUMN schema_version integer;

-- CHECK constraints added NOT VALID (metadata-only) then validated in a
-- separate statement (SHARE UPDATE EXCLUSIVE, not blocking reads/writes),
-- rather than inline on ADD COLUMN, which would force an immediate full
-- validation scan of the table under the same lock as the column addition.
ALTER TABLE remem.session_events
  ADD CONSTRAINT session_events_role_check
    CHECK (role IS NULL OR role IN ('user', 'assistant', 'tool', 'system')) NOT VALID,
  ADD CONSTRAINT session_events_origin_check
    CHECK (origin IS NULL OR origin IN ('direct-user', 'host-observed', 'retrieved', 'extension', 'unknown')) NOT VALID,
  ADD CONSTRAINT session_events_evidence_kind_check
    CHECK (kind IN ('user-correction', 'decision', 'preference', 'incident-resolved', 'fact-discovered',
                     'task-opened', 'task-resolved', 'project-state', 'turn-completed', 'tool-result', 'lifecycle'))
    NOT VALID,
  -- Ties the evidence-admission columns together: any row with evidence_id
  -- set must also carry provider_id/content_hash/schema_version/role/origin
  -- (all otherwise-nullable for legacy-row compatibility), so a future bug
  -- or manual data fix-up cannot silently produce a half-populated evidence
  -- row that application code assumes is fully populated. role/origin are
  -- included here, not just the identity columns, because a downstream
  -- consumer (TASK-011's searchEpisodes) relies on every evidence row
  -- exposing a non-null role/origin so a caller can label an unclassified
  -- or historical/untrusted result -- a row that slipped past this check
  -- with a null role would silently defeat that guarantee.
  ADD CONSTRAINT session_events_evidence_identity_complete_check
    CHECK (
      evidence_id IS NULL
      OR (provider_id IS NOT NULL AND content_hash IS NOT NULL AND schema_version IS NOT NULL
          AND role IS NOT NULL AND origin IS NOT NULL)
    ) NOT VALID;

ALTER TABLE remem.session_events
  VALIDATE CONSTRAINT session_events_role_check,
  VALIDATE CONSTRAINT session_events_origin_check,
  VALIDATE CONSTRAINT session_events_evidence_kind_check,
  VALIDATE CONSTRAINT session_events_evidence_identity_complete_check;

-- Matches the existing generated-tsvector convention used by
-- remem.memories.search_vector (migrations/0001_initial_schema.sql).
--
-- Known operational tradeoff: adding a GENERATED ... STORED column via
-- ALTER TABLE requires PostgreSQL to rewrite the entire table (there is no
-- fast metadata-only path for generated columns, unlike a plain ADD COLUMN
-- with a constant default), holding an ACCESS EXCLUSIVE lock on
-- remem.session_events for the duration -- as could the two CREATE INDEX
-- statements below, since this migration runner (src/storage/migrations.ts)
-- wraps each migration file in one transaction and cannot use
-- CREATE INDEX CONCURRENTLY (which is not allowed inside a transaction
-- block). On a very large existing session_events table this is a real,
-- if brief, unavailability window for that table, not merely a metadata
-- change. Tracked as GitHub issue #87 (batched/CONCURRENTLY-capable
-- migration runner support) rather than solved in this migration;
-- acceptable for the current scale of installations, but must be
-- revisited before this pattern is reused against a table with
-- significant production row counts.
ALTER TABLE remem.session_events
  ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(safe_text, ''))
  ) STORED;

-- Same identity (provider + project + evidence_id) can appear at most once.
-- project_id is included here as defense-in-depth even though
-- deriveEvidenceId (src/observation-admission.ts) already folds projectId
-- into the derived id -- so DB-level identity scoping does not depend
-- entirely on that upstream invariant continuing to hold. Legacy rows
-- (evidence_id IS NULL) are excluded from this constraint entirely -- a
-- partial unique index, not a table-wide one, so any number of legacy rows
-- with NULL evidence_id remain unaffected.
CREATE UNIQUE INDEX session_events_evidence_identity_idx
  ON remem.session_events (provider_id, project_id, evidence_id)
  WHERE evidence_id IS NOT NULL;

-- Scoped lookup for TASK-011's episode search: only rows belonging to the
-- new evidence-admission path (evidence_id IS NOT NULL) are indexed here,
-- keeping this index small and irrelevant to legacy session_events queries.
CREATE INDEX session_events_evidence_scope_idx
  ON remem.session_events (provider_id, project_id, occurred_at DESC)
  WHERE evidence_id IS NOT NULL;

-- Full-text index over the envelope's safe (already screened) narrative
-- text, for TASK-011's lexical episode search. safe_text is nullable
-- (NULL means "this envelope had no text payload at all", distinct from
-- an explicitly empty string) -- coalesce(safe_text, '') in the generated
-- column above handles both legacy rows and text-less evidence rows
-- identically, contributing an empty, harmless tsvector.
CREATE INDEX session_events_safe_text_fts_idx
  ON remem.session_events USING GIN (search_vector);

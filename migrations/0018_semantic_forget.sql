-- Explicit semantic target confirmation is separate from episode forgetting.
ALTER TABLE remem.forget_tombstones DROP CONSTRAINT forget_tombstones_target_kind_check;
ALTER TABLE remem.forget_tombstones ADD CONSTRAINT forget_tombstones_target_kind_check
  CHECK (target_kind IN ('evidence','candidate','memory','source'));
CREATE TABLE remem.semantic_forget_previews (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL REFERENCES remem.providers(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  memory_id uuid NOT NULL,
  signature text NOT NULL,
  candidate_count integer NOT NULL,
  source_count integer NOT NULL,
  retained_shared_source_count integer NOT NULL,
  evidence_count integer NOT NULL,
  retained_evidence_count integer NOT NULL,
  embedding_count integer NOT NULL,
  catalog_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX semantic_forget_previews_expiry_idx ON remem.semantic_forget_previews(expires_at);

-- Older callers must not revive the selected row/claim after upgrading this
-- database. Restore reapplies preserved decisions after its schema migration.
CREATE FUNCTION remem.guard_semantic_forget_memory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM remem.forget_tombstones t WHERE t.provider_id=NEW.provider_id
      AND t.target_kind='memory' AND t.target_id=NEW.id::text) THEN
    RAISE EXCEPTION 'memory was explicitly forgotten';
  END IF;
  IF EXISTS (SELECT 1 FROM remem.forget_tombstones t WHERE t.provider_id=NEW.provider_id
      AND t.target_kind='candidate' AND t.target_id IN
        (NEW.metadata->'consolidation'->>'candidateId',NEW.metadata->'consolidation'->>'lastCandidateId')) THEN
    RAISE EXCEPTION 'candidate was explicitly forgotten';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER semantic_forget_memory_guard BEFORE INSERT OR UPDATE ON remem.memories
  FOR EACH ROW EXECUTE FUNCTION remem.guard_semantic_forget_memory();
CREATE FUNCTION remem.guard_semantic_forget_candidate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM remem.forget_tombstones t WHERE t.target_kind='candidate'
      AND t.target_id=NEW.id::text AND (NEW.metadata->>'providerId' IS NULL
        OR t.provider_id=NEW.metadata->>'providerId')) THEN
    RAISE EXCEPTION 'candidate was explicitly forgotten';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER semantic_forget_candidate_guard BEFORE INSERT OR UPDATE ON remem.candidate_memories
  FOR EACH ROW EXECUTE FUNCTION remem.guard_semantic_forget_candidate();

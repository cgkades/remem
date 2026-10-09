-- Body-free associations survive deletion of candidate/evidence/memory bodies.
CREATE TABLE remem.candidate_lineage (
  provider_id text NOT NULL,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  candidate_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','approved','promoted','rejected','expired','forgotten')),
  memory_id uuid,
  observation_ids uuid[] NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  action text NOT NULL,
  actor text NOT NULL,
  policy_version text NOT NULL DEFAULT 'deterministic-consolidation-v1',
  extractor_version text NOT NULL DEFAULT 'legacy-or-capture-v1',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, scope_kind, scope_key, candidate_id)
);
CREATE INDEX candidate_lineage_memory_idx ON remem.candidate_lineage (memory_id);
CREATE INDEX candidate_lineage_observations_idx ON remem.candidate_lineage USING gin (observation_ids);
CREATE TABLE remem.candidate_lineage_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id text NOT NULL,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  candidate_id uuid NOT NULL,
  revision integer NOT NULL,
  state text NOT NULL,
  memory_id uuid,
  action text NOT NULL,
  actor text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, scope_kind, scope_key, candidate_id, revision)
);
CREATE FUNCTION remem.audit_candidate_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO remem.candidate_lineage_audit
    (provider_id, scope_kind, scope_key, candidate_id, revision, state, memory_id, action, actor)
  VALUES (NEW.provider_id, NEW.scope_kind, NEW.scope_key, NEW.candidate_id, NEW.revision,
    NEW.state, NEW.memory_id, NEW.action, NEW.actor);
  RETURN NEW;
END $$;
CREATE FUNCTION remem.bump_candidate_lineage_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER candidate_lineage_revision BEFORE UPDATE ON remem.candidate_lineage
  FOR EACH ROW EXECUTE FUNCTION remem.bump_candidate_lineage_revision();
CREATE TRIGGER candidate_lineage_audit AFTER INSERT OR UPDATE ON remem.candidate_lineage
  FOR EACH ROW EXECUTE FUNCTION remem.audit_candidate_lineage();

-- Retain only observable old associations. Intermediate merges absent from
-- retained metadata cannot be reconstructed and are intentionally not invented.
INSERT INTO remem.candidate_lineage
  (provider_id, scope_kind, scope_key, candidate_id, state, memory_id, action, actor)
SELECT provider_id, scope_kind, COALESCE(scope_id, ''), candidate_id::uuid,
  'promoted', min(id::text)::uuid, 'legacy-retained-association', 'migration'
FROM (
  SELECT m.*, value AS candidate_id FROM remem.memories m,
    LATERAL unnest(ARRAY[m.metadata->'consolidation'->>'candidateId',
      m.metadata->'consolidation'->>'lastCandidateId']) value
) retained
WHERE candidate_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
GROUP BY provider_id, scope_kind, COALESCE(scope_id, ''), candidate_id
HAVING count(DISTINCT id) = 1;
INSERT INTO remem.candidate_lineage
  (provider_id, scope_kind, scope_key, candidate_id, state, observation_ids, action, actor)
SELECT metadata->>'providerId', scope_kind, COALESCE(scope_id, ''), id,
  CASE WHEN status = 'consolidating' THEN 'approved' ELSE status END,
  CASE WHEN session_event_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[session_event_id] END,
  'legacy-candidate', 'migration'
FROM remem.candidate_memories WHERE metadata->>'providerId' IS NOT NULL
ON CONFLICT (provider_id, scope_kind, scope_key, candidate_id) DO UPDATE SET
  observation_ids = EXCLUDED.observation_ids,
  action = 'legacy-candidate-evidence', actor = 'migration';

-- Candidate bodies may be deleted by explicit forget/restore suppression.
-- Their association tombstones prevent re-extraction from resurrecting them.
CREATE FUNCTION remem.retire_candidate_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE remem.candidate_lineage SET state = 'forgotten', action = 'candidate-forgotten', actor = 'retention'
    WHERE candidate_id = OLD.id AND provider_id = OLD.metadata->>'providerId'
      AND scope_kind = OLD.scope_kind AND scope_key = COALESCE(OLD.scope_id, '')
      AND state <> 'forgotten';
  RETURN OLD;
END $$;
CREATE TRIGGER candidate_lineage_retire BEFORE DELETE ON remem.candidate_memories
  FOR EACH ROW EXECUTE FUNCTION remem.retire_candidate_lineage();
CREATE FUNCTION remem.retire_memory_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE remem.candidate_lineage SET state = 'expired', action = 'memory-deleted', actor = 'retention'
    WHERE memory_id = OLD.id AND provider_id = OLD.provider_id AND state = 'promoted';
  RETURN OLD;
END $$;
CREATE TRIGGER memory_lineage_retire BEFORE DELETE ON remem.memories
  FOR EACH ROW EXECUTE FUNCTION remem.retire_memory_lineage();

CREATE FUNCTION remem.expire_candidate_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'expired' AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE remem.candidate_lineage SET state='expired', action='candidate-expired', actor='retention'
      WHERE candidate_id=NEW.id AND provider_id=NEW.metadata->>'providerId'
        AND scope_kind=NEW.scope_kind AND scope_key=COALESCE(NEW.scope_id,'') AND state <> 'forgotten';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER candidate_lineage_expire AFTER UPDATE OF status ON remem.candidate_memories
  FOR EACH ROW EXECUTE FUNCTION remem.expire_candidate_lineage();

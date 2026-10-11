-- Fixed reason/host counters contain no rejected source text or event identity.
CREATE TABLE remem.learning_capture_gaps (
  provider_id text NOT NULL REFERENCES remem.providers(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  host text NOT NULL CHECK (host IN ('opencode-v1','opencode-v2','pi','other')),
  reason text NOT NULL CHECK (reason IN ('malformed-envelope','invalid-identity-field',
    'unsupported-identity','foreign-scope','origin-not-enabled','too-many-evidence-refs',
    'payload-too-large','payload-too-complex','unscreenable-content','identity-collision',
    'queue-full','replay-rejected','collision','forgotten','persistence-failed','shutdown-timeout','other')),
  count integer NOT NULL CHECK (count BETWEEN 1 AND 2147483647),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id,project_id,host,reason)
);
CREATE INDEX candidate_lineage_recent_idx
  ON remem.candidate_lineage (provider_id,scope_kind,scope_key,updated_at DESC,candidate_id);
ALTER TABLE remem.candidate_lineage ADD COLUMN confidence double precision
  CHECK (confidence BETWEEN 0 AND 1);
-- Snapshot only numeric confidence from an existing same-provider candidate.
-- Legacy/rejected claims without a retained candidate remain explicitly unknown.
CREATE FUNCTION remem.snapshot_learning_confidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE value double precision;
BEGIN
  SELECT confidence INTO value FROM remem.candidate_memories
    WHERE id=NEW.candidate_id AND metadata->>'providerId'=NEW.provider_id
      AND scope_kind=NEW.scope_kind AND COALESCE(scope_id,'')=NEW.scope_key;
  IF value BETWEEN 0 AND 1 THEN NEW.confidence := value; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER learning_confidence BEFORE INSERT OR UPDATE ON remem.candidate_lineage
  FOR EACH ROW EXECUTE FUNCTION remem.snapshot_learning_confidence();
UPDATE remem.candidate_lineage l SET confidence=c.confidence
  FROM remem.candidate_memories c WHERE c.id=l.candidate_id
    AND c.metadata->>'providerId'=l.provider_id AND c.scope_kind=l.scope_kind
    AND COALESCE(c.scope_id,'')=l.scope_key AND c.confidence BETWEEN 0 AND 1;

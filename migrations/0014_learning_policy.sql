-- Policy snapshots are body-free and survive evidence/candidate retention.
ALTER TABLE remem.candidate_lineage
  ADD COLUMN policy_outcome text CHECK (policy_outcome IN ('reject','episodic-only','auto-promote','require-review')),
  ADD COLUMN policy_reason text;
ALTER TABLE remem.candidate_lineage_audit
  ADD COLUMN policy_version text,
  ADD COLUMN extractor_version text,
  ADD COLUMN policy_outcome text,
  ADD COLUMN policy_reason text;
CREATE OR REPLACE FUNCTION remem.audit_candidate_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO remem.candidate_lineage_audit
    (provider_id,scope_kind,scope_key,candidate_id,revision,state,memory_id,action,actor,
     policy_version,extractor_version,policy_outcome,policy_reason)
  VALUES (NEW.provider_id,NEW.scope_kind,NEW.scope_key,NEW.candidate_id,NEW.revision,NEW.state,
    NEW.memory_id,NEW.action,NEW.actor,NEW.policy_version,NEW.extractor_version,NEW.policy_outcome,NEW.policy_reason);
  RETURN NEW;
END $$;

-- The new host verifier reads ingestion order, not source timestamps. This
-- partial index avoids sorting an entire project for each bounded window.
CREATE INDEX session_events_learning_window_idx
  ON remem.session_events (provider_id,project_id,host,session_id,created_at DESC,id DESC)
  WHERE evidence_id IS NOT NULL;

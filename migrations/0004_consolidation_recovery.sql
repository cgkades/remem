ALTER TABLE remem.candidate_memories
  DROP CONSTRAINT candidate_memories_status_check;

ALTER TABLE remem.candidate_memories
  ADD CONSTRAINT candidate_memories_status_check
  CHECK (status IN ('pending', 'approved', 'consolidating', 'rejected', 'promoted', 'expired'));

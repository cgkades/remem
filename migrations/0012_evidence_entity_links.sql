-- Phase 3 (TASK-061): explicit, scoped links are the only input to
-- supersession review. This table intentionally does not infer an entity from
-- episode text: later reviewed extraction work may create links, but a model
-- or query result can never silently expand the deletion candidate set.
CREATE TABLE remem.evidence_entities (
  session_event_id uuid NOT NULL REFERENCES remem.session_events(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES remem.entities(id) ON DELETE CASCADE,
  PRIMARY KEY (session_event_id, entity_id)
);

CREATE INDEX evidence_entities_entity_event_idx
  ON remem.evidence_entities (entity_id, session_event_id);

-- TASK-061 only considers human-approved/promoted decision candidates. The
-- partial index keeps that narrow join from scanning rejected/pending/non-
--decision candidates as evidence volumes grow.
CREATE INDEX candidate_memories_reviewed_decision_event_idx
  ON remem.candidate_memories (session_event_id)
  WHERE type = 'decision' AND status IN ('approved', 'promoted');

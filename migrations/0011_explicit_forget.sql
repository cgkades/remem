-- Phase 3 (TASK-013): explicit privacy forgetting is a separate, human-
-- confirmed operation. These rows intentionally contain only identifiers,
-- scope, timestamps, and target ids -- never episode/candidate/memory bodies.
-- A preview expires quickly and must be confirmed by its opaque id; it is not
-- a standing authorization to delete later state.
CREATE TABLE remem.forget_previews (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL REFERENCES remem.providers(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  evidence_id text NOT NULL,
  session_event_id uuid NOT NULL,
  candidate_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX forget_previews_expiry_idx ON remem.forget_previews (expires_at);

-- Tombstones prevent replayed host events and an older backup restored into
-- this database from reintroducing a forgotten item. `target_id` is an
-- opaque evidence hash or UUID, never the underlying memory content.
CREATE TABLE remem.forget_tombstones (
  provider_id text NOT NULL REFERENCES remem.providers(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('evidence', 'candidate')),
  target_id text NOT NULL,
  -- Deliberately not a foreign key: previews expire and may be absent from an
  -- older backup, while the privacy tombstone must survive either condition.
  preview_id uuid NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, project_id, target_kind, target_id)
);

CREATE INDEX forget_tombstones_preview_idx ON remem.forget_tombstones (preview_id);

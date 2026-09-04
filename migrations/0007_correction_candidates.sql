CREATE TABLE remem.correction_candidates (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  state text NOT NULL CHECK (
    state IN ('pending_validation', 'validated', 'needs_changes', 'rejected', 'applied')
  ),
  correction jsonb NOT NULL,
  root_cause text,
  root_cause_reason text,
  affected_memory_ids text[] NOT NULL DEFAULT '{}',
  impacted_memory_ids text[] NOT NULL DEFAULT '{}',
  mutation jsonb,
  structural_validation jsonb,
  replay jsonb,
  reviewer_decision jsonb,
  applied_memory_id text,
  audit jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX correction_candidates_state_idx
  ON remem.correction_candidates (provider_id, state, updated_at DESC);

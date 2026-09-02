CREATE TABLE remem.session_events (
  id uuid PRIMARY KEY,
  session_id text NOT NULL,
  project_id text NOT NULL,
  kind text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE remem.candidate_memories (
  id uuid PRIMARY KEY,
  session_event_id uuid REFERENCES remem.session_events(id) ON DELETE SET NULL,
  type text NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  scope_kind text NOT NULL,
  scope_id text,
  confidence double precision CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'promoted', 'expired')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);

CREATE TABLE remem.consolidation_records (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  input_memory_ids uuid[] NOT NULL DEFAULT '{}',
  output_memory_ids uuid[] NOT NULL DEFAULT '{}',
  summary text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX session_events_session_idx ON remem.session_events (session_id, occurred_at DESC);
CREATE INDEX candidate_memories_status_idx ON remem.candidate_memories (status, created_at);
CREATE INDEX consolidation_records_status_idx ON remem.consolidation_records (status, started_at DESC);

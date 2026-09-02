CREATE TABLE remem.embedding_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  model text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions = 384),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Legacy vectors have unknown space identity and remain NULL until rebuilt.
ALTER TABLE remem.memory_embeddings ADD COLUMN fingerprint text;
ALTER TABLE remem.catalog_entries ADD COLUMN embedding_fingerprint text;
ALTER TABLE remem.embedding_settings ADD COLUMN fingerprint text;

CREATE TABLE remem.embedding_reindex_stage (
  memory_id uuid NOT NULL REFERENCES remem.memories(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  model text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions = 384),
  source_version timestamptz NOT NULL,
  embedding vector(384) NOT NULL,
  catalog_embedding vector(384) NOT NULL,
  PRIMARY KEY (memory_id, fingerprint)
);
CREATE TABLE remem.embedding_reindex_generations (
  provider_id text NOT NULL REFERENCES remem.providers(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  state text NOT NULL CHECK (state IN ('building', 'completed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (provider_id, fingerprint)
);

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE remem.providers (
  id text PRIMARY KEY,
  kind text NOT NULL,
  name text NOT NULL,
  summary text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE remem.sources (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL REFERENCES remem.providers(id) ON DELETE CASCADE,
  kind text NOT NULL,
  uri text,
  external_id text,
  observed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, external_id)
);

CREATE TABLE remem.memories (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL REFERENCES remem.providers(id) ON DELETE CASCADE,
  source_id uuid REFERENCES remem.sources(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('semantic', 'episodic', 'decision', 'preference', 'procedure', 'task', 'other')),
  title text NOT NULL CHECK (length(title) > 0),
  content text NOT NULL CHECK (length(content) > 0),
  summary text NOT NULL DEFAULT '',
  scope_kind text NOT NULL CHECK (scope_kind IN ('global', 'workspace', 'project', 'session')),
  scope_id text,
  freshness text NOT NULL DEFAULT 'current' CHECK (freshness IN ('current', 'stale', 'superseded', 'unknown')),
  confidence double precision CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  importance double precision NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  unresolved boolean NOT NULL DEFAULT false,
  superseded_by uuid REFERENCES remem.memories(id) ON DELETE SET NULL,
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(content, '')), 'C')
  ) STORED,
  CHECK ((scope_kind = 'global' AND scope_id IS NULL) OR (scope_kind <> 'global' AND scope_id IS NOT NULL))
);

CREATE TABLE remem.memory_aliases (
  memory_id uuid NOT NULL REFERENCES remem.memories(id) ON DELETE CASCADE,
  alias text NOT NULL,
  PRIMARY KEY (memory_id, alias)
);

CREATE TABLE remem.memory_provenance (
  id uuid PRIMARY KEY,
  memory_id uuid NOT NULL REFERENCES remem.memories(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES remem.sources(id) ON DELETE RESTRICT,
  captured_at timestamptz NOT NULL,
  original boolean NOT NULL,
  note text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE remem.memory_tags (
  memory_id uuid NOT NULL REFERENCES remem.memories(id) ON DELETE CASCADE,
  tag text NOT NULL,
  PRIMARY KEY (memory_id, tag)
);

CREATE TABLE remem.topics (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  summary text NOT NULL DEFAULT '',
  parent_id uuid REFERENCES remem.topics(id) ON DELETE SET NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, parent_id)
);

CREATE TABLE remem.memory_topics (
  memory_id uuid NOT NULL REFERENCES remem.memories(id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES remem.topics(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, topic_id)
);

CREATE TABLE remem.entities (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL DEFAULT 'other',
  aliases text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, type)
);

CREATE TABLE remem.memory_entities (
  memory_id uuid NOT NULL REFERENCES remem.memories(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES remem.entities(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, entity_id)
);

CREATE TABLE remem.relationships (
  id uuid PRIMARY KEY,
  source_memory_id uuid NOT NULL REFERENCES remem.memories(id) ON DELETE CASCADE,
  target_memory_id uuid REFERENCES remem.memories(id) ON DELETE CASCADE,
  target_entity_id uuid REFERENCES remem.entities(id) ON DELETE CASCADE,
  type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((target_memory_id IS NOT NULL)::int + (target_entity_id IS NOT NULL)::int = 1)
);

CREATE TABLE remem.memory_embeddings (
  memory_id uuid PRIMARY KEY REFERENCES remem.memories(id) ON DELETE CASCADE,
  model text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions = 384),
  embedding vector(384) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE remem.catalog_entries (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL REFERENCES remem.providers(id) ON DELETE CASCADE,
  memory_id uuid UNIQUE REFERENCES remem.memories(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES remem.catalog_entries(id) ON DELETE SET NULL,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  aliases text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  scope_kind text NOT NULL CHECK (scope_kind IN ('global', 'workspace', 'project', 'session')),
  scope_id text,
  importance double precision NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  unresolved boolean NOT NULL DEFAULT false,
  source text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX memories_search_vector_idx ON remem.memories USING gin (search_vector);
CREATE INDEX memories_scope_idx ON remem.memories (scope_kind, scope_id);
CREATE INDEX memories_freshness_idx ON remem.memories (freshness, updated_at DESC);
CREATE INDEX memory_embeddings_cosine_idx ON remem.memory_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX catalog_provider_idx ON remem.catalog_entries (provider_id, scope_kind, scope_id);

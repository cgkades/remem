ALTER TABLE remem.catalog_entries
  ADD COLUMN embedding_model text,
  ADD COLUMN embedding_dimensions integer CHECK (embedding_dimensions IS NULL OR embedding_dimensions = 384),
  ADD COLUMN embedding vector(384);

CREATE INDEX catalog_embedding_cosine_idx
  ON remem.catalog_entries USING hnsw (embedding vector_cosine_ops);

CREATE TABLE remem.entities_v2 (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL REFERENCES remem.providers(id) ON DELETE CASCADE,
  scope_kind text NOT NULL CHECK (scope_kind IN ('global', 'workspace', 'project', 'session')),
  scope_id text NOT NULL DEFAULT '',
  name text NOT NULL,
  type text NOT NULL DEFAULT 'other',
  aliases text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, scope_kind, scope_id, name, type)
);

WITH scoped_entities AS (
  SELECT DISTINCT e.id AS old_id, e.name, e.type, e.aliases, e.metadata, e.created_at,
    e.updated_at, m.provider_id, m.scope_kind, coalesce(m.scope_id, '') AS scope_id
  FROM remem.entities e
  JOIN remem.memory_entities me ON me.entity_id = e.id
  JOIN remem.memories m ON m.id = me.memory_id
  UNION
  SELECT DISTINCT e.id AS old_id, e.name, e.type, e.aliases, e.metadata, e.created_at,
    e.updated_at, m.provider_id, m.scope_kind, coalesce(m.scope_id, '') AS scope_id
  FROM remem.entities e
  JOIN remem.relationships r ON r.target_entity_id = e.id
  JOIN remem.memories m ON m.id = r.source_memory_id
)
INSERT INTO remem.entities_v2
  (id, provider_id, scope_kind, scope_id, name, type, aliases, metadata, created_at, updated_at)
SELECT DISTINCT ON (provider_id, scope_kind, scope_id, name, type)
  md5(old_id::text || ':' || provider_id || ':' || scope_kind || ':' || scope_id)::uuid,
  provider_id, scope_kind, scope_id, name, type, aliases, metadata, created_at, updated_at
FROM scoped_entities
ORDER BY provider_id, scope_kind, scope_id, name, type, old_id;

CREATE TABLE remem.memory_entities_v2 (
  memory_id uuid NOT NULL REFERENCES remem.memories(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES remem.entities_v2(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, entity_id)
);

INSERT INTO remem.memory_entities_v2 (memory_id, entity_id)
SELECT me.memory_id, replacement.id
FROM remem.memory_entities me
JOIN remem.memories m ON m.id = me.memory_id
JOIN remem.entities original ON original.id = me.entity_id
JOIN remem.entities_v2 replacement
  ON replacement.provider_id = m.provider_id
  AND replacement.scope_kind = m.scope_kind
  AND replacement.scope_id = coalesce(m.scope_id, '')
  AND replacement.name = original.name
  AND replacement.type = original.type;

ALTER TABLE remem.relationships
  DROP CONSTRAINT relationships_target_entity_id_fkey;

UPDATE remem.relationships relationship
SET target_entity_id = replacement.id
FROM remem.memories memory, remem.entities original, remem.entities_v2 replacement
WHERE relationship.source_memory_id = memory.id
  AND relationship.target_entity_id = original.id
  AND replacement.provider_id = memory.provider_id
  AND replacement.scope_kind = memory.scope_kind
  AND replacement.scope_id = coalesce(memory.scope_id, '')
  AND replacement.name = original.name
  AND replacement.type = original.type;

DROP TABLE remem.memory_entities;
DROP TABLE remem.entities;
ALTER TABLE remem.entities_v2 RENAME TO entities;
ALTER TABLE remem.memory_entities_v2 RENAME TO memory_entities;

ALTER TABLE remem.relationships
  ADD CONSTRAINT relationships_target_entity_id_fkey
  FOREIGN KEY (target_entity_id) REFERENCES remem.entities(id) ON DELETE CASCADE;

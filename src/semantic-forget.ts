import { createHash } from "node:crypto"
import type { PoolClient } from "pg"

/** Separate operator authority: evidence confirmation never authorizes this. */
export interface SemanticForgetPreview {
  id: string
  target: "semantic-memory"
  providerId: string
  projectId: string
  memoryId: string
  semanticMemoryCount: 1
  candidateCount: number
  sourceCount: number
  retainedSharedSourceCount: number
  evidenceCount: number
  retainedEvidenceCount: number
  embeddingCount: number
  catalogCount: number
  createdAt: string
  expiresAt: string
}
export interface SemanticForgetSnapshot {
  signature: string
  candidateIds: string[]
  sourceIds: string[]
  sharedSourceIds: string[]
  evidenceIds: string[]
  evidenceTargets: { rowId: string; evidenceId: string }[]
  retainedEvidenceCount: number
  embeddingCount: number
  catalogCount: number
}
/** The signature includes bodies only as server-side digests; previews and
 * durable audit contain no text. Associations are bounded or fail closed. */
export async function semanticForgetSnapshot(
  client: PoolClient,
  providerId: string,
  projectId: string,
  memoryId: string,
): Promise<SemanticForgetSnapshot | undefined> {
  const memory = await client.query<{ signature: string }>(
    `SELECT encode(sha256(convert_to(row_to_json(m)::text,'UTF8')),'hex') signature
     FROM remem.memories m WHERE id=$1 AND provider_id=$2 AND scope_kind='project' AND scope_id=$3 FOR UPDATE`,
    [memoryId, providerId, projectId],
  )
  if (!memory.rows[0]) return undefined
  const candidates = await client.query<{
    id: string
    signature: string
    observation_ids: string[]
  }>(
    `SELECT l.candidate_id id,l.observation_ids,
       encode(sha256(convert_to(row_to_json(l)::text || COALESCE(row_to_json(c)::text,''),'UTF8')),'hex') signature
     FROM remem.candidate_lineage l LEFT JOIN remem.candidate_memories c ON c.id=l.candidate_id
     WHERE l.provider_id=$1 AND l.scope_kind='project' AND l.scope_key=$2 AND l.memory_id=$3
     ORDER BY l.candidate_id LIMIT 101`,
    [providerId, projectId, memoryId],
  )
  const sources = await client.query<{ id: string; shared: boolean; signature: string }>(
    `SELECT s.id,EXISTS (SELECT 1 FROM remem.memory_provenance p WHERE p.source_id=s.id AND p.memory_id<>$1)
       OR EXISTS (SELECT 1 FROM remem.memories m WHERE m.source_id=s.id AND m.id<>$1) shared,
       encode(sha256(convert_to(row_to_json(s)::text,'UTF8')),'hex') signature
     FROM remem.sources s WHERE s.provider_id=$2 AND (s.id IN (SELECT source_id FROM remem.memory_provenance WHERE memory_id=$1)
       OR s.id=(SELECT source_id FROM remem.memories WHERE id=$1)) ORDER BY s.id LIMIT 101`,
    [memoryId, providerId],
  )
  const provenance = await client.query<{ signature: string }>(
    `SELECT encode(sha256(convert_to(row_to_json(p)::text,'UTF8')),'hex') signature FROM remem.memory_provenance p
     WHERE memory_id=$1 ORDER BY id LIMIT 101`,
    [memoryId],
  )
  if ([candidates.rows.length, sources.rows.length, provenance.rows.length].some((n) => n > 100))
    throw new Error("semantic forget associations exceed bounded preview")
  const counts = await client.query<{ embeddings: number; catalog: number }>(
    `SELECT (SELECT count(*)::int FROM remem.memory_embeddings WHERE memory_id=$1) +
      (SELECT count(*)::int FROM remem.embedding_reindex_stage WHERE memory_id=$1) embeddings,
      (SELECT count(*)::int FROM remem.catalog_entries WHERE memory_id=$1) catalog`,
    [memoryId],
  )
  const evidenceIds = [...new Set(candidates.rows.flatMap((c) => c.observation_ids))].sort()
  if (evidenceIds.length > 1600)
    throw new Error("semantic forget evidence links exceed bounded preview")
  const evidence = await client.query<{
    row_id: string
    evidence_id: string
    shared: boolean
    signature: string
  }>(
    `SELECT e.id row_id,e.evidence_id,
       EXISTS (SELECT 1 FROM remem.candidate_lineage l WHERE l.provider_id=$1
          AND l.observation_ids @> ARRAY[e.id] AND l.memory_id IS DISTINCT FROM $3) OR
       EXISTS (SELECT 1 FROM remem.candidate_memories c WHERE c.session_event_id=e.id
          AND NOT (c.id=ANY($5::uuid[]))) OR
       EXISTS (SELECT 1 FROM remem.evidence_entities ee WHERE ee.session_event_id=e.id) OR
       EXISTS (SELECT 1 FROM remem.session_events other WHERE other.id<>e.id
          AND NOT (other.id=ANY($4::uuid[])) AND other.evidence_refs @>
          jsonb_build_array(jsonb_build_object('providerId',e.provider_id,'eventId',e.evidence_id))) shared,
       encode(sha256(convert_to(row_to_json(e)::text,'UTF8')),'hex') signature
     FROM remem.session_events e WHERE e.provider_id=$1 AND e.project_id=$2 AND e.id=ANY($4::uuid[]) AND e.evidence_id IS NOT NULL ORDER BY e.id`,
    [providerId, projectId, memoryId, evidenceIds, candidates.rows.map((c) => c.id)],
  )
  const preserveEvidence = sources.rows.some((s) => s.shared)
  const evidenceTargets = evidence.rows
    .filter((e) => !preserveEvidence && !e.shared)
    .map((e) => ({ rowId: e.row_id, evidenceId: e.evidence_id }))
  const projections = await client.query<{ kind: string; id: string; signature: string }>(
    `SELECT kind,id,encode(sha256(convert_to(body,'UTF8')),'hex') signature FROM (
       SELECT 'alias' kind,alias id,row_to_json(a)::text body FROM remem.memory_aliases a WHERE memory_id=$1
       UNION ALL SELECT 'tag',tag,row_to_json(t)::text FROM remem.memory_tags t WHERE memory_id=$1
       UNION ALL SELECT 'entity',entity_id::text,row_to_json(e)::text FROM remem.memory_entities e WHERE memory_id=$1
       UNION ALL SELECT 'relationship',id::text,row_to_json(r)::text FROM remem.relationships r WHERE source_memory_id=$1 OR target_memory_id=$1
       UNION ALL SELECT 'catalog',id::text,row_to_json(c)::text FROM remem.catalog_entries c WHERE memory_id=$1
       UNION ALL SELECT 'embedding',model,row_to_json(v)::text FROM remem.memory_embeddings v WHERE memory_id=$1
       UNION ALL SELECT 'embedding-stage',fingerprint,row_to_json(v)::text FROM remem.embedding_reindex_stage v WHERE memory_id=$1
     ) projections ORDER BY kind,id LIMIT 1001`,
    [memoryId],
  )
  if (projections.rows.length > 1000)
    throw new Error("semantic forget projection exceeds bounded preview")
  const parts = [
    memory.rows[0].signature,
    candidates.rows,
    sources.rows,
    provenance.rows,
    counts.rows,
    evidence.rows,
    projections.rows,
  ]
  return {
    signature: createHash("sha256").update(JSON.stringify(parts)).digest("hex"),
    candidateIds: candidates.rows.map((c) => c.id),
    sourceIds: sources.rows.filter((s) => !s.shared).map((s) => s.id),
    sharedSourceIds: sources.rows.filter((s) => s.shared).map((s) => s.id),
    evidenceIds,
    evidenceTargets,
    retainedEvidenceCount: evidence.rows.length - evidenceTargets.length,
    embeddingCount: counts.rows[0]?.embeddings ?? 0,
    catalogCount: counts.rows[0]?.catalog ?? 0,
  }
}

/** Also applied after restoring an older backup into this same database. */
export async function suppressForgottenSemanticBodies(client: PoolClient): Promise<void> {
  await client.query(`UPDATE remem.candidate_lineage l SET state='forgotten',action='semantic-privacy-restore-suppressed',actor='operator'
    WHERE EXISTS (SELECT 1 FROM remem.forget_tombstones t WHERE t.target_kind='memory'
      AND t.provider_id=l.provider_id AND t.target_id=l.memory_id::text)
      AND (l.state<>'forgotten' OR l.action<>'semantic-privacy-restore-suppressed')`)
  await client.query(`DELETE FROM remem.memories m USING remem.forget_tombstones t
    WHERE t.target_kind='memory' AND m.id::text=t.target_id AND m.provider_id=t.provider_id`)
  await client.query(`DELETE FROM remem.sources s USING remem.forget_tombstones t
    WHERE t.target_kind='source' AND s.id::text=t.target_id AND s.provider_id=t.provider_id
      AND NOT EXISTS (SELECT 1 FROM remem.memory_provenance p WHERE p.source_id=s.id)
      AND NOT EXISTS (SELECT 1 FROM remem.memories m WHERE m.source_id=s.id)`)
}

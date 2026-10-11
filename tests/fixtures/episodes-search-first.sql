WITH query AS (SELECT plainto_tsquery('simple', $3) AS terms),
       matched AS MATERIALIZED (
         SELECT e.*, ts_rank_cd(e.search_vector, query.terms) AS search_rank,
           CASE WHEN $6::boolean AND e.payload->>'status'='completed'
             AND (e.payload->'result'->>'exit' IS NULL OR e.payload->'result'->>'exit'='0')
             THEN 0 ELSE 1 END AS outcome_rank
         FROM remem.session_events e, query
         WHERE e.provider_id=$1 AND e.project_id=$2 AND e.evidence_id IS NOT NULL
           AND e.search_vector @@ query.terms AND e.role=ANY($5::text[])
           AND (NOT $6::boolean OR e.session_id <> $7::text)
         ORDER BY search_rank DESC, outcome_rank, e.occurred_at DESC, e.id
         LIMIT $4
       )
       SELECT matched.id, matched.session_id, matched.project_id, matched.provider_id, matched.kind,
              matched.occurred_at, matched.host, matched.role, matched.origin, matched.turn_id,
              matched.message_id, matched.safe_text, matched.payload, matched.evidence_refs,
              matched.evidence_id, matched.content_hash, matched.schema_version,
              preceding.id AS preceding_id, following.id AS following_id
       FROM matched
       LEFT JOIN LATERAL (
         SELECT e.id FROM remem.session_events e
         WHERE $8::boolean AND e.provider_id=$1 AND e.project_id=$2
           AND e.session_id=matched.session_id AND e.evidence_id IS NOT NULL
           AND (e.occurred_at,e.id) < (matched.occurred_at,matched.id)
         ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1
       ) preceding ON true
       LEFT JOIN LATERAL (
         SELECT e.id FROM remem.session_events e
         WHERE $8::boolean AND e.provider_id=$1 AND e.project_id=$2
           AND e.session_id=matched.session_id AND e.evidence_id IS NOT NULL
           AND (e.occurred_at,e.id) > (matched.occurred_at,matched.id)
         ORDER BY e.occurred_at,e.id LIMIT 1
       ) following ON true
       ORDER BY matched.search_rank DESC, matched.outcome_rank, matched.occurred_at DESC, matched.id

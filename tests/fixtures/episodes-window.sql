WITH scope AS (
         SELECT id, session_id, project_id, provider_id, kind, occurred_at, host, role, origin,
                turn_id, message_id, safe_text, payload, evidence_refs, evidence_id,
                content_hash, schema_version, search_vector,
                -- Partition by the full (provider_id, project_id, session_id)
                -- isolation boundary, not session_id alone. These columns are
                -- constant across the CTE (pinned by the WHERE below), so this
                -- does not change the computed neighbors today -- it encodes
                -- the cross-project/provider isolation invariant explicitly so
                -- a future edit that broadens the WHERE clause (or reuses this
                -- window outside the scoped CTE) cannot silently leak a
                -- neighbor across projects. session_events_evidence_scope_idx
                -- covers this ordering.
                LAG(id) OVER (PARTITION BY provider_id, project_id, session_id ORDER BY occurred_at, id) AS preceding_id,
                LEAD(id) OVER (PARTITION BY provider_id, project_id, session_id ORDER BY occurred_at, id) AS following_id
         FROM remem.session_events
         WHERE provider_id = $1 AND project_id = $2 AND evidence_id IS NOT NULL
       ),
       query AS (SELECT plainto_tsquery('simple', $3) AS terms)
       SELECT scope.id, scope.session_id, scope.project_id, scope.provider_id, scope.kind,
              scope.occurred_at, scope.host, scope.role, scope.origin, scope.turn_id,
              scope.message_id, scope.safe_text, scope.payload, scope.evidence_refs,
              scope.evidence_id, scope.content_hash, scope.schema_version,
              scope.preceding_id, scope.following_id
       FROM scope, query
       WHERE scope.search_vector @@ query.terms AND scope.role = ANY($5::text[])
         AND (NOT $6::boolean OR scope.session_id <> $7::text)
       ORDER BY ts_rank_cd(scope.search_vector, query.terms) DESC,
         CASE WHEN $6::boolean AND scope.payload->>'status'='completed'
           AND (scope.payload->'result'->>'exit' IS NULL OR scope.payload->'result'->>'exit'='0')
           THEN 0 ELSE 1 END,
         scope.occurred_at DESC, scope.id
       LIMIT $4

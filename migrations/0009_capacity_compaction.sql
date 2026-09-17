-- Phase 3 (TASK-012/TASK-060) of plan/feature-memory-recovery-1.md: adds
-- the storage needed for the approved two-tier soft/hard capacity policy
-- (decision 6, approved 2026-09-16) -- no age-based deletion of any kind;
-- retention is governed entirely by size pressure, in two tiers per
-- provider/project:
--   - Soft limit (default 1 GiB logical bytes): 60+-day-old eligible
--     entries become compaction candidates. Compaction shrinks content, it
--     never removes a row.
--   - Hard limit (default 2 GiB logical bytes): only past this does
--     anything get *removed*, oldest-eligible-first, and only after
--     compaction has already run.
--
-- Two additions:
--
-- 1. `remem.session_events` gains `compacted_at` (when this row's safe_text
--    was last reduced by compaction, distinct from TASK-059's
--    admission-time bulk-artifact reduction) and `compacted_at_level`
--    (which ordered compaction-aggressiveness level produced the current
--    safe_text -- an index into src/capacity.ts's `COMPACTION_LEVELS`).
--    Both nullable and NULL for every existing/legacy row: nothing here
--    touches existing data. `compacted_at_level` lets a later escalation to
--    a more aggressive level find rows that were already compacted at a
--    *lower* level and are therefore eligible for further reduction,
--    without re-processing rows already at (or above) the target level.
--
-- 2. `remem.capacity_state`: one row per (provider_id, project_id),
--    tracking the current compaction-aggressiveness level and the state
--    needed to decide whether "the soft-to-hard gap keeps closing despite
--    the current level running" (decision 6's escalation trigger) --
--    specifically the total logical bytes observed at the last check, so
--    escalation is a deterministic function of *sustained* lack of
--    improvement across checks, never a single bad reading, and never
--    silent (the current level is a plain readable column, not inferred).

ALTER TABLE remem.session_events
  ADD COLUMN compacted_at timestamptz,
  ADD COLUMN compacted_at_level smallint;

CREATE TABLE remem.capacity_state (
  provider_id text NOT NULL,
  project_id text NOT NULL,
  compaction_level smallint NOT NULL DEFAULT 0,
  last_total_bytes bigint NOT NULL DEFAULT 0,
  consecutive_no_improvement smallint NOT NULL DEFAULT 0,
  last_checked_at timestamptz,
  last_compacted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, project_id)
);

-- No new index needed here: migration 0008's
-- session_events_evidence_scope_idx ON (provider_id, project_id,
-- occurred_at DESC) WHERE evidence_id IS NOT NULL already supports both
-- "find compaction-eligible rows for provider/project" (occurred_at range
-- scan) and the oldest-eligible-first eviction ordering -- a B-tree index
-- serves an ascending scan just as well as descending, so a second,
-- functionally redundant index here would only add write amplification on
-- every session_events insert/update for no query-plan benefit.

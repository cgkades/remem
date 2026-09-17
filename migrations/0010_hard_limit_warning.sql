-- Phase 3 (TASK-062) of plan/feature-memory-recovery-1.md: session-start
-- hard-limit capacity warning. Adds the one column needed to throttle a
-- repeated warning across sessions -- everything else (current total
-- bytes, hard limit) is already computable from TASK-012's
-- remem.capacity_state/remem.session_events.
--
-- Plain ADD COLUMN, nullable, no default: metadata-only, no table rewrite,
-- no validation scan. NULL means "never warned" (distinct from "warned a
-- long time ago"), matching the same "absent, not zero" pattern
-- remem.capacity_state's other columns already use for "never checked."

ALTER TABLE remem.capacity_state
  ADD COLUMN last_hard_limit_warning_at timestamptz;

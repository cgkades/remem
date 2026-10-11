-- Progress/leases live on retained canonical sources; no additional scheduler
-- or raw transcript copy. Expired claims become eligible for bounded retry.
ALTER TABLE remem.session_events
  ADD COLUMN extraction_version text,
  ADD COLUMN extraction_claim_token uuid,
  ADD COLUMN extraction_claim_until timestamptz,
  ADD COLUMN extraction_attempts integer NOT NULL DEFAULT 0 CHECK (extraction_attempts >= 0),
  ADD COLUMN extracted_at timestamptz;

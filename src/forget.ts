/**
 * Serializes a privacy-forget confirmation with `pg_restore --clean`.
 * The lock is intentionally process-independent: both operations can be
 * launched by separate Remem CLI/provider instances against the same DB.
 */
export const FORGET_RESTORE_ADVISORY_LOCK = 7_263_663_296

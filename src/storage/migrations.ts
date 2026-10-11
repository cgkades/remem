import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import type { Pool, PoolClient } from "pg"

const MIGRATION_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/u
const MIGRATION_LOCK = 7_263_663_295
const CONCURRENT_MARKER = "-- remem:concurrent-index"

interface ConcurrentIndex {
  name: string
  definition: string
}

export interface MigrationOptions {
  /** Explicit operator opt-in; host startup never enables this. */
  allowNonTransactional?: boolean
  /** Bound lock waits and concurrent DDL; ordinary migration SQL is unchanged. */
  lockTimeoutMs?: number
  statementTimeoutMs?: number
}

function concurrentIndex(sql: string): ConcurrentIndex | undefined {
  if (!sql.trimStart().startsWith(CONCURRENT_MARKER)) return undefined
  // One narrowly supported operation per immutable file. No arbitrary SQL,
  // IF NOT EXISTS, expressions, custom opclasses or search_path dependence.
  const body = sql.trim().slice(CONCURRENT_MARKER.length).trim()
  const match =
    /^CREATE (UNIQUE )?INDEX CONCURRENTLY ([a-z][a-z0-9_]{0,62}) ON remem\.([a-z][a-z0-9_]{0,62})\s*\(([a-zA-Z0-9_,\s]+)\)(?: WHERE ([a-z][a-z0-9_]{0,62}) IS NOT NULL)?;?$/u.exec(
      body,
    )
  if (!match?.[2] || !match[3] || !match[4])
    throw new MigrationIntegrityError("concurrent migration requires one supported index statement")
  const columns = match[4].split(",").map((column) => column.trim())
  if (
    columns.length > 32 ||
    columns.some((column) => !/^[a-z][a-z0-9_]{0,62}(?: (?:ASC|DESC))?$/u.test(column))
  )
    throw new MigrationIntegrityError("unsupported concurrent index columns")
  return {
    name: match[2],
    definition: `CREATE ${match[1] ?? ""}INDEX ${match[2]} ON remem.${match[3]} USING btree (${columns.map((column) => column.replace(/ ASC$/u, "")).join(", ")})${match[5] ? ` WHERE (${match[5]} IS NOT NULL)` : ""}`,
  }
}

export interface Migration {
  version: number
  name: string
  file: string
  checksum: string
  sql: string
  concurrentIndex?: ConcurrentIndex | undefined
}

export interface MigrationResult {
  applied: number[]
  currentVersion: number
  total: number
}

export class MigrationIntegrityError extends Error {
  override readonly name = "MigrationIntegrityError"
}

interface AppliedMigration {
  version: number
  name: string
  checksum: string
}

function verifyAppliedMigrations(
  migrations: Migration[],
  appliedMigrations: AppliedMigration[],
): void {
  for (const [index, applied] of appliedMigrations.entries()) {
    if (applied.version !== index + 1) {
      throw new MigrationIntegrityError("applied migrations do not form a contiguous prefix")
    }
    const expected = migrations.find((migration) => migration.version === applied.version)
    if (!expected) {
      throw new MigrationIntegrityError(`database has unknown migration ${applied.version}`)
    }
    if (expected.name !== applied.name || expected.checksum !== applied.checksum) {
      throw new MigrationIntegrityError(`migration ${applied.version} checksum mismatch`)
    }
  }
}

function defaultMigrationDirectory(): string {
  return fileURLToPath(new URL("../../migrations/", import.meta.url))
}

export async function loadMigrations(
  directory = defaultMigrationDirectory(),
): Promise<Migration[]> {
  const files = (await readdir(directory)).filter((file) => MIGRATION_PATTERN.test(file)).sort()
  const migrations = await Promise.all(
    files.map(async (file) => {
      const match = MIGRATION_PATTERN.exec(file)
      if (!match?.[1] || !match[2]) throw new MigrationIntegrityError(`invalid migration: ${file}`)
      const sql = await readFile(path.join(directory, file), "utf8")
      return {
        version: Number.parseInt(match[1], 10),
        name: match[2],
        file,
        checksum: createHash("sha256").update(sql).digest("hex"),
        sql,
        concurrentIndex: concurrentIndex(sql),
      }
    }),
  )

  for (let index = 0; index < migrations.length; index++) {
    const migration = migrations[index]
    if (!migration || migration.version !== index + 1) {
      throw new MigrationIntegrityError("migrations must form a contiguous sequence starting at 1")
    }
  }
  return migrations
}

interface MigrationProgress extends AppliedMigration {
  index_name: string
}

async function readProgress(client: Pick<PoolClient, "query">): Promise<MigrationProgress[]> {
  const exists = await client.query<{ relation: string | null }>(
    "SELECT to_regclass('remem.schema_migration_progress')::text AS relation",
  )
  if (!exists.rows[0]?.relation) return []
  return (
    await client.query<MigrationProgress>(
      "SELECT version, name, checksum, index_name FROM remem.schema_migration_progress ORDER BY version",
    )
  ).rows
}

function verifyProgress(
  migrations: Migration[],
  applied: AppliedMigration[],
  progress: MigrationProgress[],
): void {
  if (progress.length > 1) throw new MigrationIntegrityError("multiple unfinished migrations")
  for (const row of progress) {
    const expected = migrations[applied.length]
    if (
      !expected ||
      row.version !== expected.version ||
      row.name !== expected.name ||
      row.checksum !== expected.checksum ||
      row.index_name !== expected.concurrentIndex?.name
    )
      throw new MigrationIntegrityError("unfinished migration checksum or identity mismatch")
  }
}

async function applyConcurrentIndex(
  client: PoolClient,
  migration: Migration,
  options: MigrationOptions,
): Promise<void> {
  const index = migration.concurrentIndex!
  if (!options.allowNonTransactional)
    throw new MigrationIntegrityError(
      `migration ${migration.version} requires remem migrate --allow-nontransactional`,
    )
  const progress = await readProgress(client)
  const result = await client.query<{ definition: string; valid: boolean; ready: boolean }>(
    `SELECT pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid AS valid, i.indisready AS ready
     FROM pg_index i WHERE i.indexrelid=to_regclass($1)`,
    ["remem." + index.name],
  )
  const existing = result.rows[0]
  if (existing && (progress.length === 0 || existing.definition !== index.definition))
    throw new MigrationIntegrityError(
      "concurrent index already exists without matching migration ownership",
    )
  // A relation with the name that is not an index must never be dropped.
  if (
    !existing &&
    (
      await client.query<{ relation: string | null }>("SELECT to_regclass($1)::text AS relation", [
        "remem." + index.name,
      ])
    ).rows[0]?.relation
  )
    throw new MigrationIntegrityError("concurrent index name is occupied by another relation")
  await client.query(`CREATE TABLE IF NOT EXISTS remem.schema_migration_progress (
    version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
    index_name text NOT NULL, started_at timestamptz NOT NULL DEFAULT now()
  )`)
  await client.query(
    `INSERT INTO remem.schema_migration_progress (version,name,checksum,index_name)
     VALUES ($1,$2,$3,$4) ON CONFLICT (version) DO NOTHING`,
    [migration.version, migration.name, migration.checksum, index.name],
  )
  const lockMs = options.lockTimeoutMs ?? 5000
  const statementMs = options.statementTimeoutMs ?? 600000
  await client.query(
    "SELECT set_config('lock_timeout',$1,false), set_config('statement_timeout',$2,false)",
    [String(lockMs), String(statementMs)],
  )
  try {
    if (existing && (!existing.valid || !existing.ready))
      await client.query(`DROP INDEX CONCURRENTLY remem.${index.name}`)
    if (!existing || !existing.valid || !existing.ready)
      await client.query(
        migration.sql
          .slice(migration.sql.indexOf(CONCURRENT_MARKER) + CONCURRENT_MARKER.length)
          .trim(),
      )
    const checked = await client.query<{ definition: string; valid: boolean; ready: boolean }>(
      `SELECT pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid AS valid, i.indisready AS ready
       FROM pg_index i WHERE i.indexrelid=to_regclass($1)`,
      ["remem." + index.name],
    )
    const built = checked.rows[0]
    if (!built?.valid || !built.ready || built.definition !== index.definition)
      throw new MigrationIntegrityError("concurrent index validation failed")
    await client.query("BEGIN")
    try {
      await client.query(
        "INSERT INTO remem.schema_migrations (version,name,checksum) VALUES ($1,$2,$3)",
        [migration.version, migration.name, migration.checksum],
      )
      await client.query("DELETE FROM remem.schema_migration_progress WHERE version=$1", [
        migration.version,
      ])
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    }
  } finally {
    await client.query("RESET lock_timeout; RESET statement_timeout").catch(() => undefined)
  }
}

async function bootstrap(client: PoolClient): Promise<void> {
  await client.query("CREATE SCHEMA IF NOT EXISTS remem")
  await client.query(`
    CREATE TABLE IF NOT EXISTS remem.schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)
}

export async function runMigrations(
  pool: Pool,
  directory = defaultMigrationDirectory(),
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  for (const value of [options.lockTimeoutMs, options.statementTimeoutMs])
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647))
      throw new TypeError("migration timeouts must be positive bounded milliseconds")
  const migrations = await loadMigrations(directory)
  const client = await pool.connect()
  const appliedNow: number[] = []
  let failure: Error | undefined
  const connectionError = (error: Error) => {
    failure = error
  }
  client.on("error", connectionError)
  try {
    // A blocking SELECT pg_advisory_lock holds a virtual transaction while
    // waiting. CREATE INDEX CONCURRENTLY can wait for that same transaction,
    // deadlocking two migration runners. Poll outside an active SQL statement.
    const lockStarted = Date.now()
    while (
      !(
        await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1) AS acquired", [
          MIGRATION_LOCK,
        ])
      ).rows[0]?.acquired
    ) {
      if (Date.now() - lockStarted >= (options.lockTimeoutMs ?? 600000))
        throw new Error("migration advisory lock wait timed out")
      await delay(50)
    }
    await bootstrap(client)
    const result = await client.query<AppliedMigration>(
      "SELECT version, name, checksum FROM remem.schema_migrations ORDER BY version",
    )
    verifyAppliedMigrations(migrations, result.rows)
    verifyProgress(migrations, result.rows, await readProgress(client))

    for (const migration of migrations.slice(result.rows.length)) {
      if (migration.concurrentIndex) {
        await applyConcurrentIndex(client, migration, options)
        appliedNow.push(migration.version)
        continue
      }
      await client.query("BEGIN")
      try {
        await client.query(migration.sql)
        await client.query(
          "INSERT INTO remem.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
          [migration.version, migration.name, migration.checksum],
        )
        await client.query("COMMIT")
        appliedNow.push(migration.version)
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined)
        throw error
      }
    }

    return {
      applied: appliedNow,
      currentVersion: migrations.at(-1)?.version ?? 0,
      total: migrations.length,
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error("migration failed")
    throw error
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK])
      .catch((error: unknown) => {
        failure ??= error instanceof Error ? error : new Error("migration unlock failed")
      })
    client.release(failure)
    client.off("error", connectionError)
  }
}

export async function migrationStatus(
  pool: Pool,
  directory = defaultMigrationDirectory(),
): Promise<{
  currentVersion: number
  latestVersion: number
  pending: number[]
  unfinished: number[]
}> {
  const migrations = await loadMigrations(directory)
  const result = await pool.query<AppliedMigration>(
    "SELECT version, name, checksum FROM remem.schema_migrations ORDER BY version",
  )
  verifyAppliedMigrations(migrations, result.rows)
  const progress = await readProgress(pool)
  verifyProgress(migrations, result.rows, progress)
  const applied = new Set(result.rows.map((row) => row.version))
  return {
    unfinished: progress.map((row) => row.version),
    currentVersion: result.rows.at(-1)?.version ?? 0,
    latestVersion: migrations.at(-1)?.version ?? 0,
    pending: migrations
      .filter((migration) => !applied.has(migration.version))
      .map(({ version }) => version),
  }
}

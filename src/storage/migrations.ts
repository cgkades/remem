import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Pool, PoolClient } from "pg"

const MIGRATION_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/u
const MIGRATION_LOCK = 7_263_663_295

export interface Migration {
  version: number
  name: string
  file: string
  checksum: string
  sql: string
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
): Promise<MigrationResult> {
  const migrations = await loadMigrations(directory)
  const client = await pool.connect()
  const appliedNow: number[] = []
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK])
    await bootstrap(client)
    const result = await client.query<AppliedMigration>(
      "SELECT version, name, checksum FROM remem.schema_migrations ORDER BY version",
    )
    verifyAppliedMigrations(migrations, result.rows)

    for (const migration of migrations.slice(result.rows.length)) {
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
        await client.query("ROLLBACK")
        throw error
      }
    }

    return {
      applied: appliedNow,
      currentVersion: migrations.at(-1)?.version ?? 0,
      total: migrations.length,
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => undefined)
    client.release()
  }
}

export async function migrationStatus(
  pool: Pool,
  directory = defaultMigrationDirectory(),
): Promise<{ currentVersion: number; latestVersion: number; pending: number[] }> {
  const migrations = await loadMigrations(directory)
  const result = await pool.query<AppliedMigration>(
    "SELECT version, name, checksum FROM remem.schema_migrations ORDER BY version",
  )
  verifyAppliedMigrations(migrations, result.rows)
  const applied = new Set(result.rows.map((row) => row.version))
  return {
    currentVersion: result.rows.at(-1)?.version ?? 0,
    latestVersion: migrations.at(-1)?.version ?? 0,
    pending: migrations
      .filter((migration) => !applied.has(migration.version))
      .map(({ version }) => version),
  }
}

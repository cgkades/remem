import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { Pool } from "pg"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadMigrations, migrationStatus, runMigrations } from "../src/storage/migrations.js"

const databaseUrl = process.env.REMEM_TEST_DATABASE_URL
const integration = databaseUrl ? describe.sequential : describe.skip
const sql =
  "-- remem:concurrent-index\nCREATE INDEX CONCURRENTLY fixture_order_idx ON remem.fixture (scope_id, id DESC) WHERE scope_id IS NOT NULL;\n"

integration("resumable concurrent index migrations", () => {
  let pool: Pool
  let directory: string
  beforeEach(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 6 })
    directory = await mkdtemp(path.join(os.tmpdir(), "remem-concurrent-"))
    await pool.query("DROP SCHEMA IF EXISTS remem CASCADE")
    await writeFile(
      path.join(directory, "0001_fixture.sql"),
      "CREATE TABLE remem.fixture (id integer, scope_id text);",
    )
    await runMigrations(pool, directory)
    await writeFile(path.join(directory, "0002_index.sql"), sql)
  })
  afterEach(async () => {
    await pool.end()
    await rm(directory, { recursive: true, force: true })
  })

  it("requires operator opt-in and serializes two runners without duplicate application", async () => {
    await expect(runMigrations(pool, directory)).rejects.toThrow("--allow-nontransactional")
    expect((await migrationStatus(pool, directory)).currentVersion).toBe(1)
    const results = await Promise.all([
      runMigrations(pool, directory, { allowNonTransactional: true }),
      runMigrations(pool, directory, { allowNonTransactional: true }),
    ])
    expect(results.flatMap((result) => result.applied)).toEqual([2])
    expect(await migrationStatus(pool, directory)).toMatchObject({
      currentVersion: 2,
      pending: [],
      unfinished: [],
    })
  })

  it("rejects arbitrary SQL, extra statements and unsafe index identifiers", async () => {
    for (const body of [
      sql + "DROP TABLE remem.fixture;",
      "-- remem:concurrent-index\nVACUUM remem.fixture;",
      "-- remem:concurrent-index\nCREATE INDEX CONCURRENTLY fixture_order_idx ON public.fixture (id);",
      "-- remem:concurrent-index\nCREATE INDEX CONCURRENTLY fixture_order_idx ON remem.fixture ((lower(scope_id)));",
      sql.replace("CONCURRENTLY", "CONCURRENTLY IF NOT EXISTS"),
    ]) {
      await writeFile(path.join(directory, "0002_index.sql"), body)
      await expect(loadMigrations(directory)).rejects.toThrow()
    }
  })

  it("refuses unowned indexes and checksum changes after interruption", async () => {
    await pool.query("CREATE INDEX fixture_order_idx ON remem.fixture (id)")
    await expect(runMigrations(pool, directory, { allowNonTransactional: true })).rejects.toThrow(
      "ownership",
    )
    expect(
      (
        await pool.query<{ definition: string }>(
          "SELECT pg_get_indexdef('remem.fixture_order_idx'::regclass) AS definition",
        )
      ).rows[0]?.definition,
    ).toContain("(id)")
    await pool.query("DROP INDEX remem.fixture_order_idx")
    await runMigrations(pool, directory, { allowNonTransactional: true })
    await writeFile(path.join(directory, "0002_index.sql"), sql + "\n")
    await expect(runMigrations(pool, directory, { allowNonTransactional: true })).rejects.toThrow(
      "checksum",
    )
  })

  it("recovers a built index after ledger failure without rebuilding it", async () => {
    await pool.query(`CREATE FUNCTION remem.fail_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.version=2 THEN RAISE EXCEPTION 'simulated ledger failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER fail_ledger BEFORE INSERT ON remem.schema_migrations
      FOR EACH ROW EXECUTE FUNCTION remem.fail_ledger();`)
    await expect(runMigrations(pool, directory, { allowNonTransactional: true })).rejects.toThrow(
      "ledger failure",
    )
    await pool.query("DROP TRIGGER fail_ledger ON remem.schema_migrations")
    const oid = (
      await pool.query<{ oid: number }>("SELECT 'remem.fixture_order_idx'::regclass::oid AS oid")
    ).rows[0]?.oid
    expect(oid).toBeDefined()
    expect(await migrationStatus(pool, directory)).toMatchObject({
      currentVersion: 1,
      unfinished: [2],
    })
    await writeFile(path.join(directory, "0002_index.sql"), sql + "\n")
    await expect(migrationStatus(pool, directory)).rejects.toThrow("unfinished migration checksum")
    await writeFile(path.join(directory, "0002_index.sql"), sql)
    await runMigrations(pool, directory, { allowNonTransactional: true })
    expect(
      (await pool.query<{ oid: number }>("SELECT 'remem.fixture_order_idx'::regclass::oid AS oid"))
        .rows[0]?.oid,
    ).toBe(oid)
  })

  it("bounds DDL lock waits, leaves a resumable record and permits ordinary writes", async () => {
    const writer = await pool.connect()
    try {
      await writer.query("BEGIN")
      await writer.query("INSERT INTO remem.fixture VALUES (1,'scope')")
      await expect(
        runMigrations(pool, directory, {
          allowNonTransactional: true,
          lockTimeoutMs: 50,
          statementTimeoutMs: 1000,
        }),
      ).rejects.toThrow()
      // CREATE INDEX CONCURRENTLY must not block an independent ordinary writer.
      await pool.query("SET statement_timeout='1s'")
      await pool.query("INSERT INTO remem.fixture VALUES (2,'scope')")
      expect((await migrationStatus(pool, directory)).unfinished).toEqual([2])
      await writer.query("COMMIT")
      await runMigrations(pool, directory, { allowNonTransactional: true })
    } finally {
      await writer.query("ROLLBACK")
      writer.release()
    }
  })

  it("recovers after backend termination during a build, rejecting definition drift", async () => {
    const writer = await pool.connect()
    await writer.query("BEGIN")
    await writer.query("INSERT INTO remem.fixture VALUES (1,'scope')")
    const attempt = runMigrations(pool, directory, {
      allowNonTransactional: true,
      lockTimeoutMs: 5000,
    }).then(
      () => null,
      (error: unknown) => error,
    )
    try {
      let pid: number | undefined
      for (let i = 0; i < 100; i++) {
        const active = await pool.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query LIKE 'CREATE INDEX CONCURRENTLY fixture_order_idx%' AND wait_event IS NOT NULL",
        )
        pid = active.rows[0]?.pid
        if (pid) break
        await delay(20)
      }
      expect(pid).toBeDefined()
      const independentWriter = await pool.connect()
      try {
        await independentWriter.query("BEGIN")
        await independentWriter.query("SET LOCAL statement_timeout='1s'")
        await independentWriter.query("INSERT INTO remem.fixture VALUES (3,'scope')")
        await independentWriter.query("COMMIT")
      } finally {
        await independentWriter.query("ROLLBACK")
        independentWriter.release()
      }
      await pool.query("SELECT pg_terminate_backend($1)", [pid])
      expect(await attempt).toBeInstanceOf(Error)
      expect((await migrationStatus(pool, directory)).unfinished).toEqual([2])
      await writer.query("COMMIT")
      // A changed relation cannot acquire ownership from a persisted receipt.
      await pool.query("DROP INDEX IF EXISTS remem.fixture_order_idx")
      await pool.query("CREATE INDEX fixture_order_idx ON remem.fixture (id)")
      await expect(runMigrations(pool, directory, { allowNonTransactional: true })).rejects.toThrow(
        "ownership",
      )
      await pool.query("DROP INDEX remem.fixture_order_idx")
      await runMigrations(pool, directory, { allowNonTransactional: true })
    } finally {
      await writer.query("ROLLBACK")
      writer.release()
      await attempt
    }
  })
})

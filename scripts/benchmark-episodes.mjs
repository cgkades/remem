// Query-plan comparison over temporary synthetic histories; never reads or alters installed memory.
import assert from "node:assert/strict"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import process from "node:process"
import { performance } from "node:perf_hooks"
import { Pool } from "pg"

const connectionString = process.env.REMEM_TEST_DATABASE_URL
if (!connectionString) throw new Error("REMEM_TEST_DATABASE_URL is required")
const root = fileURLToPath(new URL("..", import.meta.url))
const baseline = await readFile(path.join(root, "tests/fixtures/episodes-window.sql"), "utf8")
const candidate = await readFile(
  path.join(root, "tests/fixtures/episodes-search-first.sql"),
  "utf8",
)
const scoped = (sql) => sql.replaceAll("remem.session_events", "pg_temp.episode_benchmark")
const pool = new Pool({ connectionString })
const client = await pool.connect()
const report = {
  workload: "temporary synthetic evidence",
  samples: 20,
  sizes: [],
  measurements: [],
}
function percentile(values) {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
}
function planNodes(plan) {
  return [plan["Node Type"], ...(plan.Plans ?? []).flatMap(planNodes)]
}
function identities(rows) {
  return rows.map((row) => [row.id, row.preceding_id, row.following_id])
}
async function measure(label, sql, params, size, queryName) {
  await client.query(scoped(sql), params)
  const durations = []
  for (let i = 0; i < report.samples; i++) {
    const started = performance.now()
    await client.query(scoped(sql), params)
    durations.push(performance.now() - started)
  }
  const explain = (
    await client.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + scoped(sql), params)
  ).rows[0]["QUERY PLAN"][0]
  const measurement = {
    size,
    queryName,
    label,
    p95Ms: percentile(durations),
    executionMs: explain["Execution Time"],
    planningMs: explain["Planning Time"],
    sharedHitBlocks: explain.Plan["Shared Hit Blocks"] ?? 0,
    localHitBlocks: explain.Plan["Local Hit Blocks"] ?? 0,
    localReadBlocks: explain.Plan["Local Read Blocks"] ?? 0,
    tempReadBlocks: explain.Plan["Temp Read Blocks"] ?? 0,
    tempWrittenBlocks: explain.Plan["Temp Written Blocks"] ?? 0,
    nodes: planNodes(explain.Plan),
    plan: explain.Plan,
  }
  report.measurements.push(measurement)
  process.stdout.write(
    "episode-benchmark " + JSON.stringify({ ...measurement, plan: undefined }) + "\n",
  )
}
try {
  await client.query(`CREATE TEMP TABLE episode_benchmark (
    id uuid PRIMARY KEY, session_id text NOT NULL, project_id text NOT NULL, provider_id text,
    kind text NOT NULL, occurred_at timestamptz NOT NULL, host text, role text, origin text,
    turn_id text, message_id text, safe_text text, payload jsonb, evidence_refs jsonb,
    evidence_id text, content_hash text, schema_version integer,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple',coalesce(safe_text,''))) STORED
  )`)
  await client.query(
    "CREATE INDEX episode_scope_idx ON episode_benchmark(provider_id,project_id,occurred_at DESC) WHERE evidence_id IS NOT NULL",
  )
  await client.query("CREATE INDEX episode_fts_idx ON episode_benchmark USING gin(search_vector)")
  for (const size of [5000, 50000]) {
    await client.query("TRUNCATE episode_benchmark")
    for (const [provider, project, count] of [
      ["benchmark", "project", size],
      ["foreign", "project", 1000],
      ["benchmark", "foreign", 1000],
    ]) {
      await client.query(
        `INSERT INTO episode_benchmark
        (id,session_id,project_id,provider_id,kind,occurred_at,host,role,origin,turn_id,message_id,
         safe_text,payload,evidence_refs,evidence_id,content_hash,schema_version)
        SELECT md5($1||$2||i::text)::uuid,'session'||floor((i-1)/500),$2,$1,'turn-completed',
          '2026-09-01'::timestamptz+floor(i/2)*interval '1 second','opencode-v2',
          CASE i%3 WHEN 0 THEN 'user' WHEN 1 THEN 'tool' ELSE 'assistant' END,'host-observed',
          'turn'||i,'message'||i,
          CASE WHEN i%997=0 THEN 'benchmarkneedle' ELSE 'routine investigation background artifact '||i END,
          '{"status":"completed","result":{"exit":0}}'::jsonb,'[]'::jsonb,
          md5($1||$2||i::text)||md5(i::text),repeat('a',64),1
        FROM generate_series(1,$3::integer) i`,
        [provider, project, count],
      )
    }
    await client.query("ANALYZE episode_benchmark")
    const tableBytes = Number(
      (await client.query("SELECT pg_relation_size('pg_temp.episode_benchmark') AS bytes")).rows[0]
        .bytes,
    )
    const existingIndexBytes = Number(
      (await client.query("SELECT pg_indexes_size('pg_temp.episode_benchmark') AS bytes")).rows[0]
        .bytes,
    )
    report.sizes.push({ size, tableBytes, existingIndexBytes })
    for (const queryName of ["benchmarkneedle", "routine", "absentmarker"]) {
      const params = [
        "benchmark",
        "project",
        queryName,
        10,
        ["user", "assistant", "tool", "system"],
        false,
        "session99",
      ]
      const expected = await client.query(scoped(baseline), params)
      const alternative = await client.query(scoped(candidate), [...params, true])
      assert.deepEqual(
        identities(alternative.rows),
        identities(expected.rows),
        "search-first ordering and neighbors",
      )
      for (const row of alternative.rows) assert.equal(row.provider_id, "benchmark")
      await measure("window", baseline, params, size, queryName)
      await measure("search-first", candidate, [...params, true], size, queryName)
    }
    const started = performance.now()
    await client.query(
      "CREATE INDEX episode_window_idx ON episode_benchmark(provider_id,project_id,session_id,occurred_at,id) WHERE evidence_id IS NOT NULL",
    )
    const indexBuildMs = performance.now() - started
    const compositeIndexBytes = Number(
      (await client.query("SELECT pg_relation_size('pg_temp.episode_window_idx') AS bytes")).rows[0]
        .bytes,
    )
    report.sizes.at(-1).compositeIndexBytes = compositeIndexBytes
    report.sizes.at(-1).indexBuildMs = indexBuildMs
    process.stdout.write("episode-benchmark-size " + JSON.stringify(report.sizes.at(-1)) + "\n")
    await client.query("ANALYZE episode_benchmark")
    for (const queryName of ["benchmarkneedle", "routine", "absentmarker"]) {
      const params = [
        "benchmark",
        "project",
        queryName,
        10,
        ["user", "assistant", "tool", "system"],
        false,
        "session99",
      ]
      await measure("window+composite-index", baseline, params, size, queryName)
      await measure("search-first+composite-index", candidate, [...params, true], size, queryName)
    }
    await client.query("DROP INDEX episode_window_idx")
  }
  const output = path.join(root, "artifacts", "episode-query-benchmark.json")
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + "\n")
} finally {
  client.release()
  await pool.end()
}

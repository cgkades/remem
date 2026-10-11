import { modelFingerprint } from "../storage/embedding-space.js"
import { constants } from "node:fs"
import { access, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Pool } from "pg"
import {
  DEFAULT_CAPACITY_LIMITS,
  compactionLevelAtIndex,
  capacityStatus as computeCapacityStatus,
} from "../capacity.js"
import { createProviders } from "../providers/factory.js"
import { PostgresMemoryProvider } from "../providers/postgres.js"
import { createEmbeddingModel } from "../storage/embedding-neural.js"
import { migrationStatus } from "../storage/migrations.js"
import {
  openCodeConfigPath,
  packageRoot,
  piSettingsPath,
  type RememPaths,
} from "../storage/paths.js"
import type { RememAppConfig } from "../storage/config-file.js"
import { managedCommand } from "./managed.js"
import type { ProcessRunner } from "./process.js"
import type { EmbeddingModel } from "../types.js"

export interface DoctorCheck {
  name: string
  status: "ok" | "warn" | "error"
  detail: string
}

export interface DoctorReport {
  healthy: boolean
  checks: DoctorCheck[]
}

export interface DoctorOptions {
  embeddingModel?: EmbeddingModel
}

function supportedVectorVersion(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number)
  return major > 0 || minor >= 8
}

async function checkPermissions(file: string, name: string): Promise<DoctorCheck> {
  try {
    const mode = (await stat(file)).mode & 0o777
    return mode & 0o077
      ? { name, status: "error", detail: `permissions are ${mode.toString(8)}; expected 600` }
      : { name, status: "ok", detail: `permissions ${mode.toString(8)}` }
  } catch {
    return { name, status: "error", detail: "file is missing or unreadable" }
  }
}

/**
 * TASK-012/TASK-060: surfaces the current soft/hard capacity status and
 * compaction-aggressiveness level for every provider/project that has any
 * episodic evidence, per the plan's "the current level must be visible via
 * `doctor`/`status`, never a silent escalation" requirement. There is no
 * statically configured list of projects to check (a project is a runtime
 * concept scoped by `MemoryContext`, not part of provider configuration),
 * so this discovers every distinct `(provider_id, project_id)` pair that
 * actually has evidence rows, rather than requiring one.
 *
 * Uses `DEFAULT_CAPACITY_LIMITS` -- a project configured with custom
 * per-project limits (via whatever options a caller passes to
 * `enforceCapacity`/`getCapacityStatus` directly) may show a different
 * over-soft/over-hard verdict here than it would under its actual
 * configured limits; this check is a reasonable default-limits snapshot,
 * not a substitute for a caller checking its own configured limits.
 */
export async function capacityChecks(pool: Pool): Promise<DoctorCheck[]> {
  // Single aggregate query rather than one DISTINCT scan plus two queries per
  // scope (a prior N+1): group the byte totals by scope and LEFT JOIN the
  // per-scope capacity_state so a scope with no state row still appears (its
  // compaction_level comes back null -> level defaults to 0/"conservative").
  const rows = await pool.query<{
    provider_id: string
    project_id: string
    total: string | null
    compaction_level: number | null
  }>(
    `SELECT se.provider_id,
            se.project_id,
            SUM(
              COALESCE(octet_length(se.safe_text), 0) +
              COALESCE(octet_length(se.payload::text), 0) +
              COALESCE(octet_length(se.evidence_refs::text), 0)
            )::bigint AS total,
            cs.compaction_level
     FROM remem.session_events se
     LEFT JOIN remem.capacity_state cs
       ON cs.provider_id = se.provider_id AND cs.project_id = se.project_id
     WHERE se.evidence_id IS NOT NULL
     GROUP BY se.provider_id, se.project_id, cs.compaction_level
     ORDER BY se.provider_id, se.project_id`,
  )
  const checks: DoctorCheck[] = []
  for (const scope of rows.rows) {
    const totalBytes = Number(scope.total ?? 0)
    const level = compactionLevelAtIndex(scope.compaction_level ?? 0)
    const status = computeCapacityStatus(totalBytes, level, DEFAULT_CAPACITY_LIMITS)
    checks.push({
      name: `capacity ${scope.provider_id}/${scope.project_id}`,
      status: status.overHard ? "error" : status.overSoft ? "warn" : "ok",
      detail:
        `${totalBytes} of ${DEFAULT_CAPACITY_LIMITS.softLimitBytes} (soft) / ` +
        `${DEFAULT_CAPACITY_LIMITS.hardLimitBytes} (hard) logical bytes; ` +
        `compaction level: ${level}` +
        (status.overHard
          ? " -- over hard limit"
          : status.overSoft
            ? " -- over soft limit, compaction-eligible"
            : ""),
    })
  }
  return checks
}

/**
 * Checks whether this installed package's own root directory is present in
 * Pi's `packages` setting at `piPath`. Parses the settings JSON and checks
 * array membership rather than a raw substring match on the file text:
 * `JSON.stringify` escapes path separators (e.g. `\` on Windows becomes
 * `\\`), so a `text.includes(root)` substring check would never match a
 * correctly configured settings file on Windows. Exported standalone so it
 * is unit-testable without a live PostgreSQL connection, unlike the rest of
 * `runDoctor`.
 */
export async function piIntegrationCheck(piPath: string): Promise<DoctorCheck> {
  const root = packageRoot(import.meta.url)
  try {
    const text = await readFile(piPath, "utf8")
    let configured = false
    try {
      const parsed: unknown = JSON.parse(text)
      const packages =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).packages
          : undefined
      configured = Array.isArray(packages) && packages.includes(root)
    } catch {
      configured = false
    }
    return {
      name: "Pi integration",
      status: configured ? "ok" : "warn",
      detail: configured ? `configured in ${piPath}` : `add ${root} to packages in ${piPath}`,
    }
  } catch {
    return {
      name: "Pi integration",
      status: "warn",
      detail: "run remem init --pi or configure the extension manually",
    }
  }
}

export async function openCodeIntegrationCheck(
  opencodePath: string,
  hostVersion: "v1" | "v2" = "v2",
): Promise<DoctorCheck> {
  const key = hostVersion === "v1" ? "plugin" : "plugins"
  const v1ServerEntry = pathToFileURL(
    path.join(packageRoot(import.meta.url), "dist", "server.js"),
  ).href
  try {
    const parsed: unknown = JSON.parse(await readFile(opencodePath, "utf8"))
    const plugins =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)[key]
        : undefined
    const configured =
      Array.isArray(plugins) &&
      plugins.some(
        (plugin) =>
          plugin === "agentic-remem" ||
          (hostVersion === "v1" && plugin === v1ServerEntry) ||
          (Array.isArray(plugin) && plugin[0] === "agentic-remem"),
      )
    return {
      name: "OpenCode integration",
      status: configured ? "ok" : "warn",
      detail: configured
        ? `OpenCode ${hostVersion} configured in ${opencodePath}`
        : `add agentic-remem to ${key} in ${opencodePath}`,
    }
  } catch {
    return {
      name: "OpenCode integration",
      status: "warn",
      detail: `run remem init --${hostVersion === "v1" ? "opencode-v1" : "opencode"} or configure the plugin manually`,
    }
  }
}

export async function runDoctor(
  config: RememAppConfig,
  paths: RememPaths,
  runner: ProcessRunner,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = []
  const embeddingModel =
    options.embeddingModel ??
    (await createEmbeddingModel({
      backend: config.embedding.provider === "neural" ? "neural" : "hash",
    }))
  checks.push(await checkPermissions(paths.configFile, "configuration permissions"))
  if (config.storage.mode === "managed") {
    checks.push(await checkPermissions(config.storage.environmentFile, "credential permissions"))
    try {
      await runner.run("docker", ["--version"])
      await runner.run("docker", ["compose", "version"])
      checks.push({ name: "Docker", status: "ok", detail: "Docker and Compose are available" })
    } catch {
      checks.push({ name: "Docker", status: "error", detail: "install and start Docker" })
    }
    try {
      const result = await managedCommand(runner, config.storage, ["ps", "--format", "json"])
      checks.push({
        name: "managed container",
        status: result.stdout.includes("healthy") ? "ok" : "warn",
        detail: result.stdout.includes("healthy")
          ? "PostgreSQL is healthy"
          : "container is not healthy",
      })
    } catch {
      checks.push({ name: "managed container", status: "error", detail: "run remem start" })
    }
  } else {
    checks.push({
      name: "database mode",
      status: "ok",
      detail: "external PostgreSQL; lifecycle remains operator-managed",
    })
  }

  try {
    await access(paths.dataDir, constants.R_OK | constants.W_OK)
    checks.push({ name: "data directory", status: "ok", detail: "readable and writable" })
  } catch {
    checks.push({ name: "data directory", status: "error", detail: "directory is not writable" })
  }

  const created = createProviders(config.providers, { worktree: process.cwd() }, { embeddingModel })
  for (const diagnostic of created.diagnostics) {
    checks.push({ name: "provider configuration", status: "error", detail: diagnostic })
  }
  for (const provider of created.providers) {
    try {
      const health = provider.health
        ? await provider.health()
        : { status: "healthy" as const, message: "no health probe exposed" }
      checks.push({
        name: `provider ${provider.id}`,
        status:
          health.status === "healthy" ? "ok" : health.status === "degraded" ? "warn" : "error",
        detail: health.message ?? health.status,
      })
    } catch (error) {
      checks.push({
        name: `provider ${provider.id}`,
        status: "error",
        detail: error instanceof Error ? error.name : "health probe failed",
      })
    } finally {
      if (provider instanceof PostgresMemoryProvider) await provider.close()
    }
  }

  const pool = new Pool({
    connectionString: config.storage.connectionString,
    max: 1,
    connectionTimeoutMillis: 2_000,
    query_timeout: 5_000,
  })
  try {
    const result = await pool.query<{
      version: string
      vector_version: string | null
    }>(`
      SELECT current_setting('server_version') AS version,
        (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector_version
    `)
    checks.push({
      name: "PostgreSQL connectivity",
      status: "ok",
      detail: `PostgreSQL ${result.rows[0]?.version ?? "unknown"}`,
    })
    checks.push(
      result.rows[0]?.vector_version
        ? {
            name: "pgvector",
            status: supportedVectorVersion(result.rows[0].vector_version) ? "ok" : "error",
            detail: supportedVectorVersion(result.rows[0].vector_version)
              ? `extension ${result.rows[0].vector_version}`
              : `extension ${result.rows[0].vector_version}; version 0.8 or newer is required`,
          }
        : { name: "pgvector", status: "error", detail: "CREATE EXTENSION vector is required" },
    )
    try {
      const status = await migrationStatus(pool)
      checks.push({
        name: "schema migrations",
        status: status.pending.length === 0 ? "ok" : "error",
        detail:
          status.pending.length === 0
            ? `schema version ${status.currentVersion}`
            : `pending migrations: ${status.pending.join(", ")}; ${status.unfinished.length ? `unfinished concurrent migration: ${status.unfinished.join(", ")}; inspect and retry remem migrate --allow-nontransactional` : "run remem migrate"}`,
      })
    } catch (error) {
      checks.push({
        name: "schema migrations",
        status: "error",
        detail: error instanceof Error ? error.message : "migration integrity check failed",
      })
    }
    await pool.query("CREATE TEMP TABLE remem_write_check (id integer) ON COMMIT DROP")
    checks.push({ name: "database writes", status: "ok", detail: "database is writable" })

    try {
      const backlog = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM remem.memories m
          LEFT JOIN remem.memory_embeddings me ON me.memory_id=m.id
          LEFT JOIN remem.catalog_entries ce ON ce.memory_id=m.id
          WHERE me.model IS DISTINCT FROM $1 OR me.dimensions IS DISTINCT FROM $2
            OR me.fingerprint IS DISTINCT FROM $3 OR me.fingerprint IS NULL
            OR (ce.memory_id IS NOT NULL AND (ce.embedding_fingerprint IS DISTINCT FROM $3 OR ce.embedding IS NULL))`,
        [embeddingModel.id, embeddingModel.dimensions, modelFingerprint(embeddingModel) ?? null],
      )
      const pending = Number(backlog.rows[0]?.count ?? 0)
      checks.push({
        name: "embedding backlog",
        status: pending === 0 ? "ok" : "warn",
        detail:
          pending === 0
            ? "all retained memories and catalog vectors have compatible embedding fingerprints"
            : `${pending} ${pending === 1 ? "memory" : "memories"} pending re-embedding; ` +
              "this drains automatically during normal use, or run `remem reembed` now",
      })
    } catch {
      // The main PostgreSQL connectivity check above already reports connection
      // failures; skip silently here rather than double-reporting.
    }

    try {
      const state = await pool.query<{ staged: string; claimed: string; interrupted: string }>(
        `
        SELECT (SELECT count(*)::text FROM remem.embedding_reindex_stage WHERE fingerprint=$1) AS staged,
          (SELECT count(*)::text FROM remem.memory_embeddings WHERE reembed_claim_id IS NOT NULL) AS claimed,
          (SELECT count(*)::text FROM remem.consolidation_records WHERE kind='embedding-reembed' AND status='started'
            AND started_at < now()-interval '15 minutes') AS interrupted`,
        [modelFingerprint(embeddingModel) ?? null],
      )
      const row = state.rows[0]
      checks.push({
        name: "embedding reindex recovery",
        status: Number(row?.staged) + Number(row?.claimed) > 0 ? "warn" : "ok",
        detail: `${row?.staged ?? 0} staged target vectors; ${row?.claimed ?? 0} claimed rows; ${row?.interrupted ?? 0} expired interrupted runs. Retry remem reembed until coverage.cutover is completed; expired claims recover after 15 minutes.`,
      })
    } catch {
      /* Pending schema/connectivity failures are reported above. */
    }

    try {
      checks.push(...(await capacityChecks(pool)))
    } catch {
      // Table may not exist yet on an unmigrated database (pre-TASK-012);
      // the main PostgreSQL connectivity/migration checks above already
      // report that condition.
    }

    try {
      const settings = await pool.query<{
        model: string
        dimensions: number
        fingerprint: string | null
      }>("SELECT model, dimensions, fingerprint FROM remem.embedding_settings WHERE id = true")
      const row = settings.rows[0]
      const matches =
        row?.model === embeddingModel.id &&
        row?.dimensions === embeddingModel.dimensions &&
        row?.fingerprint === modelFingerprint(embeddingModel)
      checks.push({
        name: "embedding settings persistence",
        status: row === undefined ? "warn" : matches ? "ok" : "warn",
        detail:
          row === undefined
            ? "no embedding_settings row found yet; it is written on first provider construction"
            : matches
              ? `recorded target matches configured fingerprint (${row.model}, ${row.dimensions} dimensions); settings persistence is not reindex completion`
              : `recorded model (${row.model}, ${row.dimensions}d) does not match active model ` +
                `(${embeddingModel.id}, ${embeddingModel.dimensions}d) — the write may be failing`,
      })
    } catch {
      // Table may not exist yet on an unmigrated database; the main PostgreSQL
      // connectivity/migration checks already report that condition.
    }
  } catch (error) {
    checks.push({
      name: "PostgreSQL connectivity",
      status: "error",
      detail: error instanceof Error ? error.name : "database unavailable",
    })
  } finally {
    await pool.end()
  }

  try {
    const embedding = await embeddingModel.embed("Remem doctor")
    const fellBack = embeddingModel.id !== config.embedding.model
    checks.push({
      name: "embedding configuration",
      status: embedding.length !== config.embedding.dimensions ? "error" : fellBack ? "warn" : "ok",
      detail: fellBack
        ? `configured model ${config.embedding.model} unavailable; fell back to ${embeddingModel.id}; ${embedding.length} dimensions`
        : `${embeddingModel.id}; ${embedding.length} dimensions`,
    })
  } catch {
    checks.push({ name: "embedding configuration", status: "error", detail: "embedding failed" })
  }

  const opencodePath = config.opencode?.configPath ?? openCodeConfigPath()
  checks.push(await openCodeIntegrationCheck(opencodePath, config.opencode?.hostVersion))

  const piPath = config.pi?.settingsPath ?? piSettingsPath()
  checks.push(await piIntegrationCheck(piPath))

  return { healthy: checks.every((check) => check.status !== "error"), checks }
}

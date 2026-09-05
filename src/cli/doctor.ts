import { constants } from "node:fs"
import { access, readFile, stat } from "node:fs/promises"
import { Pool } from "pg"
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
          plugin === "agentic-remem" || (Array.isArray(plugin) && plugin[0] === "agentic-remem"),
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
            : `pending migrations: ${status.pending.join(", ")}; run remem migrate`,
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
        `SELECT count(*)::text AS count FROM remem.memory_embeddings
          WHERE model <> $1 OR dimensions <> $2`,
        [embeddingModel.id, embeddingModel.dimensions],
      )
      const pending = Number(backlog.rows[0]?.count ?? 0)
      checks.push({
        name: "embedding backlog",
        status: pending === 0 ? "ok" : "warn",
        detail:
          pending === 0
            ? "all memories use the active embedding model"
            : `${pending} ${pending === 1 ? "memory" : "memories"} pending re-embedding; ` +
              "this drains automatically during normal use, or run `remem reembed` now",
      })
    } catch {
      // The main PostgreSQL connectivity check above already reports connection
      // failures; skip silently here rather than double-reporting.
    }

    try {
      const settings = await pool.query<{ model: string; dimensions: number }>(
        "SELECT model, dimensions FROM remem.embedding_settings WHERE id = true",
      )
      const row = settings.rows[0]
      const matches =
        row?.model === embeddingModel.id && row?.dimensions === embeddingModel.dimensions
      checks.push({
        name: "embedding settings persistence",
        status: row === undefined ? "warn" : matches ? "ok" : "warn",
        detail:
          row === undefined
            ? "no embedding_settings row found yet; it is written on first provider construction"
            : matches
              ? `recorded model matches active model (${row.model}, ${row.dimensions} dimensions)`
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

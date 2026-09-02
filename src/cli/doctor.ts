import { constants } from "node:fs"
import { access, readFile, stat } from "node:fs/promises"
import { Pool } from "pg"
import { createProviders } from "../providers/factory.js"
import { PostgresMemoryProvider } from "../providers/postgres.js"
import { LocalHashEmbeddingModel } from "../storage/embedding.js"
import { migrationStatus } from "../storage/migrations.js"
import { openCodeConfigPath, type RememPaths } from "../storage/paths.js"
import type { RememAppConfig } from "../storage/config-file.js"
import { managedCommand } from "./managed.js"
import type { ProcessRunner } from "./process.js"

export interface DoctorCheck {
  name: string
  status: "ok" | "warn" | "error"
  detail: string
}

export interface DoctorReport {
  healthy: boolean
  checks: DoctorCheck[]
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

export async function runDoctor(
  config: RememAppConfig,
  paths: RememPaths,
  runner: ProcessRunner,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = []
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

  const created = createProviders(config.providers, { worktree: process.cwd() })
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
            status: "ok",
            detail: `extension ${result.rows[0].vector_version}`,
          }
        : { name: "pgvector", status: "error", detail: "CREATE EXTENSION vector is required" },
    )
    const status = await migrationStatus(pool)
    checks.push({
      name: "schema migrations",
      status: status.pending.length === 0 ? "ok" : "error",
      detail:
        status.pending.length === 0
          ? `schema version ${status.currentVersion}`
          : `pending migrations: ${status.pending.join(", ")}; run remem migrate`,
    })
    await pool.query("CREATE TEMP TABLE remem_write_check (id integer) ON COMMIT DROP")
    checks.push({ name: "database writes", status: "ok", detail: "database is writable" })
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
    const model = new LocalHashEmbeddingModel()
    const embedding = await model.embed("Remem doctor")
    checks.push({
      name: "embedding configuration",
      status: embedding.length === config.embedding.dimensions ? "ok" : "error",
      detail: `${model.id}; ${embedding.length} dimensions`,
    })
  } catch {
    checks.push({ name: "embedding configuration", status: "error", detail: "embedding failed" })
  }

  const opencodePath = config.opencode?.configPath ?? openCodeConfigPath()
  try {
    const text = await readFile(opencodePath, "utf8")
    checks.push({
      name: "OpenCode integration",
      status: text.includes("opencode-remem") ? "ok" : "warn",
      detail: text.includes("opencode-remem")
        ? `configured in ${opencodePath}`
        : `add opencode-remem to plugins in ${opencodePath}`,
    })
  } catch {
    checks.push({
      name: "OpenCode integration",
      status: "warn",
      detail: "run remem init --opencode or configure the plugin manually",
    })
  }

  return { healthy: checks.every((check) => check.status !== "error"), checks }
}

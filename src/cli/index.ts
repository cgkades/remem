import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { Pool } from "pg"
import type { PostgresProviderConfig } from "../config.js"
import type { CandidateMemory } from "../observation.js"
import {
  readAppConfig,
  writeAppConfig,
  type ManagedStorageConfig,
  type RememAppConfig,
} from "../storage/config-file.js"
import { runMigrations } from "../storage/migrations.js"
import { openCodeConfigPath, rememPaths, type RememPaths } from "../storage/paths.js"
import { runDoctor } from "./doctor.js"
import { PostgresMemoryProvider } from "../providers/postgres.js"
import { createEmbeddingModel } from "../storage/embedding-neural.js"
import { withInstallLock } from "./lock.js"
import { composeArguments, managedCommand, writeManagedFiles } from "./managed.js"
import { NodeProcessRunner, type ProcessRunner } from "./process.js"

export interface CliDependencies {
  paths?: RememPaths
  runner?: ProcessRunner
  stdout?: (line: string) => void
  stderr?: (line: string) => void
  operationLockHeld?: boolean
}

interface ParsedArguments {
  command: string
  positionals: string[]
  flags: Map<string, string | true>
}

export const BACKUP_FLAGS = ["--format=custom", "--no-owner", "--schema=remem"] as const
export const RESTORE_FLAGS = [
  "--clean",
  "--if-exists",
  "--no-owner",
  "--schema=remem",
  "--single-transaction",
  "--exit-on-error",
] as const

function parseArguments(args: string[]): ParsedArguments {
  const [command = "help", ...rest] = args
  const flags = new Map<string, string | true>()
  const positionals: string[] = []
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index]
    if (!value?.startsWith("--")) {
      if (value) positionals.push(value)
      continue
    }
    const [rawName, inline] = value.slice(2).split("=", 2)
    if (!rawName) continue
    if (inline !== undefined) flags.set(rawName, inline)
    else if (rest[index + 1] && !rest[index + 1]?.startsWith("--")) {
      flags.set(rawName, rest[index + 1] as string)
      index++
    } else flags.set(rawName, true)
  }
  return { command, positionals, flags }
}

function stringFlag(parsed: ParsedArguments, name: string): string | undefined {
  const value = parsed.flags.get(name)
  return typeof value === "string" ? value : undefined
}

function hasFlag(parsed: ParsedArguments, name: string): boolean {
  return parsed.flags.has(name)
}

const CANDIDATE_STATUSES = [
  "pending",
  "approved",
  "consolidating",
  "rejected",
  "promoted",
  "expired",
] as const satisfies readonly CandidateMemory["status"][]

function isCandidateStatus(value: string): value is CandidateMemory["status"] {
  return (CANDIDATE_STATUSES as readonly string[]).includes(value)
}

function candidateStatusFlag(parsed: ParsedArguments): CandidateMemory["status"] | undefined {
  const status = stringFlag(parsed, "status")
  if (!status) return undefined
  if (!isCandidateStatus(status)) {
    throw new Error(`--status must be one of: ${CANDIDATE_STATUSES.join(", ")}`)
  }
  return status
}

async function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
  })
}

async function availablePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 100; port++) {
    if (await portAvailable(port)) return port
  }
  throw new Error("no loopback port is available for managed PostgreSQL")
}

async function migrate(config: RememAppConfig) {
  const pool = new Pool({
    connectionString: config.storage.connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
  })
  try {
    return await runMigrations(pool)
  } finally {
    await pool.end()
  }
}

async function configureOpenCode(configPath: string): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 })
  let value: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("OpenCode configuration must be a JSON object")
    }
    value = parsed as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const plugins: unknown[] = Array.isArray(value.plugins)
    ? Array.from(value.plugins as unknown[])
    : []
  if (!plugins.some((plugin) => plugin === "opencode-remem")) plugins.push("opencode-remem")
  value.plugins = plugins
  const temporary = `${configPath}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, configPath)
}

function appConfig(
  storage: RememAppConfig["storage"],
  capture: boolean,
  opencode?: RememAppConfig["opencode"],
): RememAppConfig {
  return {
    version: 1,
    storage,
    providers: [
      {
        type: "postgres",
        id: "remem-local",
        connectionString: storage.connectionString,
        primary: true,
        maxConnections: 5,
        catalogLimit: 2_000,
      },
    ],
    embedding: { provider: "neural", model: "bge-small-en-v1.5", dimensions: 384 },
    capture: { enabled: capture },
    ...(opencode ? { opencode } : {}),
  }
}

export function warnAboutNeuralDownload(
  config: Pick<RememAppConfig, "embedding">,
  output: (line: string) => void,
): void {
  if (config.embedding.provider === "neural") {
    output(
      `First use will download the ${config.embedding.model} embedding model (~30MB) from huggingface.co; this happens once. If blocked, see \`remem doctor\`.`,
    )
  }
}

async function initialize(
  parsed: ParsedArguments,
  paths: RememPaths,
  runner: ProcessRunner,
  output: (line: string) => void,
): Promise<RememAppConfig> {
  try {
    let existing = await readAppConfig(paths)
    output(`Remem is already initialized in ${paths.configDir}.`)
    if (hasFlag(parsed, "capture") && existing.capture?.enabled !== true) {
      existing = { ...existing, capture: { ...existing.capture, enabled: true } }
      await writeAppConfig(existing, paths)
    }
    if (hasFlag(parsed, "opencode") && !existing.opencode?.configured) {
      const configPath = openCodeConfigPath()
      await configureOpenCode(configPath)
      existing = { ...existing, opencode: { configured: true, configPath } }
      await writeAppConfig(existing, paths)
    }
    await start(existing, runner)
    await migrate(existing)
    return existing
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  await mkdir(paths.configDir, { recursive: true, mode: 0o700 })
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 })
  await mkdir(paths.backupDir, { recursive: true, mode: 0o700 })
  const configureHost = hasFlag(parsed, "opencode")
  const opencodePath = openCodeConfigPath()
  const mode = stringFlag(parsed, "mode") ?? "managed"
  let config: RememAppConfig

  if (mode === "external") {
    const connectionString = stringFlag(parsed, "database-url") ?? process.env.REMEM_DATABASE_URL
    if (!connectionString) {
      throw new Error("external mode requires --database-url or REMEM_DATABASE_URL")
    }
    config = appConfig(
      { mode: "external", connectionString },
      hasFlag(parsed, "capture"),
      configureHost ? { configured: true, configPath: opencodePath } : undefined,
    )
    warnAboutNeuralDownload(config, output)
  } else if (mode === "managed") {
    await runner.run("docker", ["--version"])
    await runner.run("docker", ["compose", "version"])
    const port = await availablePort(Number(stringFlag(parsed, "port") ?? 54_329))
    const password = randomBytes(32).toString("base64url")
    const database = "remem"
    const user = "remem"
    await writeManagedFiles(paths, { database, user, password, port })
    const storage: ManagedStorageConfig = {
      mode: "managed",
      connectionString: `postgres://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`,
      composeFile: paths.composeFile,
      environmentFile: paths.environmentFile,
      projectName: `remem-${createHash("sha256").update(paths.configDir).digest("hex").slice(0, 10)}`,
      database,
      user,
      port,
    }
    config = appConfig(
      storage,
      hasFlag(parsed, "capture"),
      configureHost ? { configured: true, configPath: opencodePath } : undefined,
    )
    warnAboutNeuralDownload(config, output)
  } else {
    throw new Error("--mode must be managed or external")
  }

  if (configureHost) await configureOpenCode(opencodePath)
  await writeAppConfig(config, paths)
  await start(config, runner)
  const migrated = await migrate(config)
  output(
    `Schema version ${migrated.currentVersion}; applied ${migrated.applied.length} migration(s).`,
  )
  return config
}

async function start(config: RememAppConfig, runner: ProcessRunner): Promise<void> {
  if (config.storage.mode === "managed") {
    await managedCommand(runner, config.storage, ["up", "-d", "--wait"])
  }
}

async function stop(config: RememAppConfig, runner: ProcessRunner): Promise<void> {
  if (config.storage.mode === "managed") {
    await managedCommand(runner, config.storage, ["down"])
  }
}

function findPrimaryPostgresConfig(config: RememAppConfig): PostgresProviderConfig {
  const provider = config.providers.find(
    (candidate): candidate is PostgresProviderConfig =>
      candidate.type === "postgres" && candidate.primary,
  )
  if (!provider) throw new Error("candidate management requires a primary PostgreSQL provider")
  return provider
}

function primaryPostgresProvider(config: RememAppConfig): PostgresMemoryProvider {
  // Intentionally defaults to LocalHashEmbeddingModel: candidates/review/consolidate
  // operate on text content, not semantic search, so they don't need the
  // configured neural embedding backend. Do not "fix" this to thread the
  // configured model through — it would add cost with no benefit here.
  return new PostgresMemoryProvider(findPrimaryPostgresConfig(config))
}

async function reembedProvider(config: RememAppConfig): Promise<PostgresMemoryProvider> {
  // Unlike candidates/review/consolidate, reembed's entire purpose is to
  // re-embed stale rows into the CONFIGURED embedding model — it must use
  // the real configured backend, not the hash default primaryPostgresProvider
  // intentionally uses for the text-only commands above.
  const embeddingModel = await createEmbeddingModel({
    backend: config.embedding.provider === "neural" ? "neural" : "hash",
  })
  return new PostgresMemoryProvider(findPrimaryPostgresConfig(config), { embeddingModel })
}

function postgresEnvironment(connectionString: string): NodeJS.ProcessEnv {
  const url = new URL(connectionString)
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: url.pathname.replace(/^\//u, ""),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    ...(url.searchParams.get("sslmode")
      ? { PGSSLMODE: url.searchParams.get("sslmode") ?? "" }
      : {}),
  }
}

async function backup(
  config: RememAppConfig,
  paths: RememPaths,
  runner: ProcessRunner,
  target?: string,
): Promise<string> {
  await mkdir(paths.backupDir, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replaceAll(":", "-")
  const outputFile = path.resolve(target ?? path.join(paths.backupDir, `remem-${stamp}.dump`))
  await mkdir(path.dirname(outputFile), { recursive: true, mode: 0o700 })
  if (config.storage.mode === "managed") {
    await runner.run(
      "docker",
      composeArguments(config.storage, [
        "exec",
        "-T",
        "postgres",
        "pg_dump",
        "-U",
        config.storage.user,
        "-d",
        config.storage.database,
        ...BACKUP_FLAGS,
      ]),
      { outputFile },
    )
  } else {
    const environment = postgresEnvironment(config.storage.connectionString)
    await runner.run("pg_dump", [...BACKUP_FLAGS], {
      env: environment,
      outputFile,
      redact: [environment.PGPASSWORD ?? ""],
    })
  }
  await chmod(outputFile, 0o600)
  return outputFile
}

async function restore(
  config: RememAppConfig,
  runner: ProcessRunner,
  source: string,
): Promise<void> {
  await access(source, constants.R_OK)
  const pool = new Pool({ connectionString: config.storage.connectionString, max: 1 })
  const client = await pool.connect()
  try {
    await client.query("SELECT pg_advisory_lock($1)", [7_263_663_296])
    if (config.storage.mode === "managed") {
      await runner.run(
        "docker",
        composeArguments(config.storage, [
          "exec",
          "-T",
          "postgres",
          "pg_restore",
          "-U",
          config.storage.user,
          "-d",
          config.storage.database,
          ...RESTORE_FLAGS,
        ]),
        { inputFile: source },
      )
    } else {
      const environment = postgresEnvironment(config.storage.connectionString)
      await runner.run("pg_restore", [...RESTORE_FLAGS, `--dbname=${environment.PGDATABASE}`], {
        env: environment,
        inputFile: source,
        redact: [environment.PGPASSWORD ?? ""],
      })
    }
    await migrate(config)
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [7_263_663_296]).catch(() => undefined)
    client.release()
    await pool.end()
  }
}

function usage(): string {
  return `Usage: remem <command> [options]

Commands:
  init [--mode managed|external] [--database-url URL] [--opencode] [--capture]
  start | stop | status | doctor | migrate
  candidates [--status STATUS]
  review <CANDIDATE_ID> --approve|--reject
  consolidate [--batch-size NUMBER]
  reembed [--batch-size NUMBER]
  backup [--output FILE]
  restore <FILE> --confirm
  reset --confirm`
}

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const parsed = parseArguments(args)
  const paths = dependencies.paths ?? rememPaths()
  const runner = dependencies.runner ?? new NodeProcessRunner()
  const output = dependencies.stdout ?? ((line: string) => process.stdout.write(`${line}\n`))
  const errorOutput = dependencies.stderr ?? ((line: string) => process.stderr.write(`${line}\n`))

  try {
    if (parsed.command === "help" || hasFlag(parsed, "help")) {
      output(usage())
      return 0
    }
    if (
      !dependencies.operationLockHeld &&
      new Set([
        "init",
        "start",
        "stop",
        "migrate",
        "backup",
        "restore",
        "reset",
        "review",
        "consolidate",
        "reembed",
      ]).has(parsed.command)
    ) {
      return await withInstallLock(paths, () =>
        runCli(args, {
          ...dependencies,
          paths,
          runner,
          stdout: output,
          stderr: errorOutput,
          operationLockHeld: true,
        }),
      )
    }
    if (parsed.command === "init") {
      const config = await initialize(parsed, paths, runner, output)
      const report = await runDoctor(config, paths, runner)
      output(`Remem initialized in ${paths.configDir}.`)
      output(`PostgreSQL: ${report.healthy ? "healthy" : "needs attention"}.`)
      if (!config.opencode?.configured)
        output("OpenCode: run remem init --opencode or configure the plugin manually.")
      return report.healthy ? 0 : 1
    }

    const config = await readAppConfig(paths)
    if (
      parsed.command === "candidates" ||
      parsed.command === "review" ||
      parsed.command === "consolidate" ||
      parsed.command === "reembed"
    ) {
      const provider =
        parsed.command === "reembed"
          ? await reembedProvider(config)
          : primaryPostgresProvider(config)
      try {
        if (parsed.command === "candidates") {
          output(
            JSON.stringify(await provider.listCandidates(candidateStatusFlag(parsed)), null, 2),
          )
          return 0
        }
        if (parsed.command === "review") {
          const id = parsed.positionals[0]
          if (!id) throw new Error("review requires a candidate id")
          const approve = hasFlag(parsed, "approve")
          const reject = hasFlag(parsed, "reject")
          if (approve === reject)
            throw new Error("review requires exactly one of --approve or --reject")
          await provider.reviewCandidate(id, approve ? "approved" : "rejected")
          output(`Candidate ${id} ${approve ? "approved" : "rejected"}.`)
          return 0
        }
        if (parsed.command === "reembed") {
          const batchSize = Number(stringFlag(parsed, "batch-size") ?? 25)
          if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
            throw new Error("--batch-size must be an integer from 1 to 1000")
          }
          output(JSON.stringify(await provider.reembedStale(batchSize), null, 2))
          return 0
        }
        const batchSize = Number(stringFlag(parsed, "batch-size") ?? 50)
        if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
          throw new Error("--batch-size must be an integer from 1 to 1000")
        }
        output(JSON.stringify(await provider.consolidateCandidates(batchSize), null, 2))
        return 0
      } finally {
        await provider.close()
      }
    }
    if (parsed.command === "start") {
      await start(config, runner)
      await migrate(config)
      output(config.storage.mode === "managed" ? "Remem started." : "External PostgreSQL is ready.")
      return 0
    }
    if (parsed.command === "stop") {
      await stop(config, runner)
      output(
        config.storage.mode === "managed"
          ? "Remem stopped."
          : "External PostgreSQL was not changed.",
      )
      return 0
    }
    if (parsed.command === "migrate") {
      const result = await migrate(config)
      output(
        `Schema version ${result.currentVersion}; applied ${result.applied.length} migration(s).`,
      )
      return 0
    }
    if (parsed.command === "doctor" || parsed.command === "status") {
      const report = await runDoctor(config, paths, runner)
      for (const check of report.checks) output(`[${check.status}] ${check.name}: ${check.detail}`)
      return report.healthy ? 0 : 1
    }
    if (parsed.command === "backup") {
      const artifact = await backup(config, paths, runner, stringFlag(parsed, "output"))
      output(`Backup written to ${artifact}.`)
      return 0
    }
    if (parsed.command === "restore") {
      const source = parsed.positionals[0] ?? stringFlag(parsed, "from")
      if (!source) throw new Error("restore requires a backup file")
      if (!hasFlag(parsed, "confirm")) throw new Error("restore requires --confirm")
      await restore(config, runner, path.resolve(source))
      output("Backup restored and schema verified.")
      return 0
    }
    if (parsed.command === "reset") {
      if (!hasFlag(parsed, "confirm")) throw new Error("reset requires --confirm")
      if (config.storage.mode !== "managed") {
        throw new Error("reset is disabled for operator-managed external PostgreSQL")
      }
      await managedCommand(runner, config.storage, ["down", "--volumes"])
      await start(config, runner)
      await migrate(config)
      output("Managed data was reset and an empty schema was created.")
      return 0
    }
    errorOutput(`Unknown command: ${parsed.command}`)
    errorOutput(usage())
    return 2
  } catch (error) {
    errorOutput(
      `Remem ${parsed.command} failed: ${error instanceof Error ? error.message : "unknown error"}`,
    )
    return 1
  }
}

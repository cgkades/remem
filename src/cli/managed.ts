import { chmod, mkdir, writeFile } from "node:fs/promises"
import type { ManagedStorageConfig } from "../storage/config-file.js"
import type { RememPaths } from "../storage/paths.js"
import type { ProcessRunner } from "./process.js"

export const MANAGED_POSTGRES_IMAGE = "pgvector/pgvector:0.8.1-pg16"

export function managedCompose(): string {
  const postgresUser = "$${POSTGRES_USER}"
  const postgresDatabase = "$${POSTGRES_DB}"
  return `services:
  postgres:
    image: ${MANAGED_POSTGRES_IMAGE}
    restart: unless-stopped
    environment:
      POSTGRES_DB: \${REMEM_POSTGRES_DB}
      POSTGRES_USER: \${REMEM_POSTGRES_USER}
      POSTGRES_PASSWORD: \${REMEM_POSTGRES_PASSWORD}
    ports:
      - "127.0.0.1:\${REMEM_POSTGRES_PORT}:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${postgresUser} -d ${postgresDatabase}"]
      interval: 2s
      timeout: 3s
      retries: 30
      start_period: 5s
    volumes:
      - remem-postgres-data:/var/lib/postgresql/data
volumes:
  remem-postgres-data:
`
}

export async function writeManagedFiles(
  paths: RememPaths,
  values: { database: string; user: string; password: string; port: number },
): Promise<void> {
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 })
  const environment = [
    `REMEM_POSTGRES_DB=${values.database}`,
    `REMEM_POSTGRES_USER=${values.user}`,
    `REMEM_POSTGRES_PASSWORD=${values.password}`,
    `REMEM_POSTGRES_PORT=${values.port}`,
    "",
  ].join("\n")
  await writeFile(paths.environmentFile, environment, { mode: 0o600, flag: "wx" })
  await writeFile(paths.composeFile, managedCompose(), { mode: 0o600, flag: "wx" })
  await chmod(paths.environmentFile, 0o600)
  await chmod(paths.composeFile, 0o600)
}

export function composeArguments(storage: ManagedStorageConfig, command: string[]): string[] {
  return [
    "compose",
    "--env-file",
    storage.environmentFile,
    "-f",
    storage.composeFile,
    "-p",
    storage.projectName,
    ...command,
  ]
}

export async function managedCommand(
  runner: ProcessRunner,
  storage: ManagedStorageConfig,
  command: string[],
) {
  return runner.run("docker", composeArguments(storage, command))
}

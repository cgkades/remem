import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  loadInstalledPluginOptions,
  readAppConfig,
  writeAppConfig,
  type RememAppConfig,
} from "../src/storage/config-file.js"
import { rememPaths } from "../src/storage/paths.js"

const roots: string[] = []

async function paths() {
  const root = await mkdtemp(path.join(os.tmpdir(), "remem-config-"))
  roots.push(root)
  return rememPaths({ REMEM_CONFIG_DIR: root, REMEM_DATA_DIR: path.join(root, "data") })
}

function config(mode: "managed" | "external", connectionString: string): RememAppConfig {
  return {
    version: 1,
    storage:
      mode === "managed"
        ? {
            mode,
            connectionString,
            composeFile: "/config/compose.yaml",
            environmentFile: "/config/.env",
            projectName: "remem-test",
            database: "remem",
            user: "remem",
            port: 54_329,
          }
        : { mode, connectionString },
    providers: [],
    embedding: { provider: "local-hash", model: "remem-local-hash-v1", dimensions: 384 },
  }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("installed configuration", () => {
  it("does not silently fall back when an installed config is malformed", async () => {
    const location = await paths()
    await mkdir(location.configDir, { recursive: true })
    await writeFile(location.configFile, "{not-json")
    vi.stubEnv("REMEM_CONFIG", location.configFile)

    await expect(loadInstalledPluginOptions(undefined)).rejects.toThrow()
  })

  it("applies database URL overrides only to external mode", async () => {
    const location = await paths()
    vi.stubEnv("REMEM_DATABASE_URL", "postgres://override/other")
    await writeAppConfig(config("managed", "postgres://managed/remem"), location)
    expect((await readAppConfig(location)).storage.connectionString).toBe(
      "postgres://managed/remem",
    )
    await writeAppConfig(config("external", "postgres://external/remem"), location)
    expect((await readAppConfig(location)).storage.connectionString).toBe(
      "postgres://override/other",
    )
  })
})

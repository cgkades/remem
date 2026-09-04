import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export interface RememPaths {
  configDir: string
  dataDir: string
  configFile: string
  composeFile: string
  environmentFile: string
  backupDir: string
}

export function rememPaths(environment: NodeJS.ProcessEnv = process.env): RememPaths {
  const home = os.homedir()
  let configDir: string
  let dataDir: string

  if (environment.REMEM_CONFIG_DIR) configDir = path.resolve(environment.REMEM_CONFIG_DIR)
  else if (process.platform === "win32") {
    configDir = path.join(environment.APPDATA ?? path.join(home, "AppData", "Roaming"), "Remem")
  } else if (process.platform === "darwin") {
    configDir = path.join(home, "Library", "Application Support", "Remem")
  } else {
    configDir = path.join(environment.XDG_CONFIG_HOME ?? path.join(home, ".config"), "remem")
  }

  if (environment.REMEM_DATA_DIR) dataDir = path.resolve(environment.REMEM_DATA_DIR)
  else if (process.platform === "win32") {
    dataDir = path.join(environment.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Remem")
  } else if (process.platform === "darwin") {
    dataDir = path.join(home, "Library", "Application Support", "Remem", "data")
  } else {
    dataDir = path.join(environment.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "remem")
  }

  const configFile = environment.REMEM_CONFIG
    ? path.resolve(environment.REMEM_CONFIG)
    : path.join(configDir, "config.json")
  return {
    configDir,
    dataDir,
    configFile,
    composeFile: path.join(configDir, "compose.yaml"),
    environmentFile: path.join(configDir, ".env"),
    backupDir: path.join(dataDir, "backups"),
  }
}

export function openCodeConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.OPENCODE_CONFIG) return path.resolve(environment.OPENCODE_CONFIG)
  const home = os.homedir()
  if (process.platform === "win32") {
    return path.join(
      environment.APPDATA ?? path.join(home, "AppData", "Roaming"),
      "opencode",
      "opencode.json",
    )
  }
  return path.join(
    environment.XDG_CONFIG_HOME ?? path.join(home, ".config"),
    "opencode",
    "opencode.json",
  )
}

/**
 * Resolves this installed remem package's own root directory (the directory
 * containing this package's `package.json`) at runtime, regardless of
 * whether the caller is running from `src/...` (tests) or the built
 * `dist/...` (production) -- both sit two directories below the package
 * root for `src/cli/index.ts`/`src/cli/doctor.ts` (see `tsconfig.build.json`
 * `rootDir`/`outDir`).
 */
export function packageRoot(fromFileUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(fromFileUrl)), "..", "..")
}

/**
 * Global Pi settings file path. Pi has no separate "config file" env var like
 * OpenCode's `OPENCODE_CONFIG`; it exposes `PI_CODING_AGENT_DIR` to relocate
 * its whole `~/.pi/agent` directory (see Pi's environment-variables.md),
 * under which `settings.json` lives.
 */
export function piSettingsPath(environment: NodeJS.ProcessEnv = process.env): string {
  const agentDir = environment.PI_CODING_AGENT_DIR
    ? path.resolve(environment.PI_CODING_AGENT_DIR)
    : path.join(os.homedir(), ".pi", "agent")
  return path.join(agentDir, "settings.json")
}

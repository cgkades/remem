import os from "node:os"
import path from "node:path"

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

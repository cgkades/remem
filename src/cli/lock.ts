import { mkdir, open, readFile, unlink } from "node:fs/promises"
import path from "node:path"
import type { RememPaths } from "../storage/paths.js"

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

export async function withInstallLock<Result>(
  paths: RememPaths,
  operation: () => Promise<Result>,
): Promise<Result> {
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 })
  const lockFile = path.join(paths.configDir, ".operation.lock")
  let handle
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      handle = await open(lockFile, "wx", 0o600)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      let owner = 0
      try {
        owner = Number.parseInt(await readFile(lockFile, "utf8"), 10)
      } catch {
        // A malformed lock is treated as active rather than removed unsafely.
      }
      if (!Number.isInteger(owner) || owner <= 0 || processIsRunning(owner)) {
        throw new Error(`another Remem operation is active (lock: ${lockFile})`, { cause: error })
      }
      await unlink(lockFile)
    }
  }
  if (!handle) throw new Error(`could not acquire Remem operation lock: ${lockFile}`)
  try {
    await handle.writeFile(String(process.pid))
    return await operation()
  } finally {
    await handle.close()
    await unlink(lockFile).catch(() => undefined)
  }
}

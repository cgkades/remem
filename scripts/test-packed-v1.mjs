import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"
const exec = promisify(execFile)
const root = await mkdtemp(path.join(os.tmpdir(), "remem-packed-native-v1-"))
try {
  const packed = await exec("npm", ["pack", "--json", "--pack-destination", root], {
    maxBuffer: 4 * 1024 * 1024,
  })
  const archive = JSON.parse(packed.stdout)[0].filename
  const install = path.join(root, "installed")
  await exec(
    "npm",
    ["install", "--prefix", install, "--no-audit", "--no-fund", path.join(root, archive)],
    { maxBuffer: 4 * 1024 * 1024 },
  )
  const test = await exec(process.execPath, ["tests/opencode-v1.e2e.mjs"], {
    env: {
      ...process.env,
      REMEM_E2E_PLUGIN_SPEC: pathToFileURL(
        path.join(install, "node_modules/agentic-remem/dist/server.js"),
      ).href,
    },
    maxBuffer: 4 * 1024 * 1024,
  })
  process.stdout.write(test.stdout)
} finally {
  await rm(root, { recursive: true, force: true })
}

import { spawn } from "node:child_process"
import process from "node:process"

const command = process.platform === "win32" ? "npx.cmd" : "npx"
const child = spawn(command, ["vitest", "run", "tests/curated-replay.test.ts"], {
  stdio: "inherit",
  env: {
    ...process.env,
    REMEM_REPLAY_RESULTS_PATH:
      process.env.REMEM_REPLAY_RESULTS_PATH ?? "artifacts/curated-replay-results.json",
  },
})

child.on("error", (error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})

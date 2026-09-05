import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, URL } from "node:url"

const repository = fileURLToPath(new URL("..", import.meta.url))
const temporary = await mkdtemp(path.join(os.tmpdir(), "remem-package-smoke-"))
const npmEnvironment = { ...process.env }
delete npmEnvironment.npm_config_allow_scripts
delete npmEnvironment.NPM_CONFIG_ALLOW_SCRIPTS
try {
  const packed = execFileSync("npm", ["pack", "--pack-destination", temporary], {
    cwd: repository,
    encoding: "utf8",
    env: npmEnvironment,
  })
    .trim()
    .split("\n")
    .at(-1)
  if (!packed) throw new Error("npm pack did not return an artifact")
  const application = path.join(temporary, "consumer")
  await mkdir(application)
  await writeFile(
    path.join(application, "package.json"),
    JSON.stringify({ name: "remem-type-smoke", private: true, type: "module" }),
  )
  execFileSync("npm", ["install", path.join(temporary, packed)], {
    cwd: application,
    env: npmEnvironment,
    stdio: "inherit",
  })
  const executable = path.join(application, "node_modules", ".bin", "remem")
  if (!((await stat(executable)).mode & 0o111)) {
    throw new Error("installed remem bin is not executable")
  }
  execFileSync(executable, ["--help"], { cwd: application, stdio: "inherit" })
  await writeFile(
    path.join(application, "index.ts"),
    [
      'import { LocalHashEmbeddingModel, type MemoryProvider } from "agentic-remem/core"',
      'import { runCli } from "agentic-remem/cli"',
      "const model = new LocalHashEmbeddingModel()",
      "const provider: MemoryProvider | undefined = undefined",
      "void model",
      "void provider",
      "void runCli",
    ].join("\n"),
  )
  await writeFile(
    path.join(application, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        skipLibCheck: false,
        strict: true,
        target: "ES2023",
      },
      include: ["index.ts"],
    }),
  )
  execFileSync(
    process.execPath,
    [path.join(repository, "node_modules/typescript/bin/tsc"), "-p", application],
    {
      cwd: application,
      stdio: "inherit",
    },
  )
  execFileSync(process.execPath, ["--input-type=module", "-e", 'import("agentic-remem/core")'], {
    cwd: application,
    stdio: "inherit",
  })
} finally {
  await rm(temporary, { recursive: true, force: true })
}

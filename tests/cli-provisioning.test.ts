import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { BACKUP_FLAGS, RESTORE_FLAGS, runCli, warnAboutNeuralDownload } from "../src/cli/index.js"
import { withInstallLock } from "../src/cli/lock.js"
import { managedCommand, managedCompose, writeManagedFiles } from "../src/cli/managed.js"
import { NodeProcessRunner, type ProcessRunner } from "../src/cli/process.js"
import { writeAppConfig, type RememAppConfig } from "../src/storage/config-file.js"
import { rememPaths } from "../src/storage/paths.js"

const temporaryDirectories: string[] = []

async function temporaryPaths() {
  const root = await mkdtemp(path.join(os.tmpdir(), "remem-cli-"))
  temporaryDirectories.push(root)
  return rememPaths({
    REMEM_CONFIG_DIR: path.join(root, "config"),
    REMEM_DATA_DIR: path.join(root, "data"),
  })
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("CLI provisioning", () => {
  it("generates a pinned loopback-only Compose stack and protected credentials", async () => {
    const paths = await temporaryPaths()
    await writeManagedFiles(paths, {
      database: "remem",
      user: "remem",
      password: "generated-secret",
      port: 54_329,
    })

    expect(managedCompose()).toContain("pgvector/pgvector:0.8.1-pg16")
    expect(managedCompose()).toContain("127.0.0.1:${REMEM_POSTGRES_PORT}:5432")
    expect(managedCompose()).toContain("pg_isready")
    expect(await readFile(paths.environmentFile, "utf8")).toContain(
      "REMEM_POSTGRES_PASSWORD=generated-secret",
    )
    expect((await stat(paths.environmentFile)).mode & 0o077).toBe(0)
    expect((await stat(paths.composeFile)).mode & 0o077).toBe(0)
  })

  it("keeps lifecycle calls behind a mockable process boundary", async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const runner: ProcessRunner = {
      run(command, args) {
        calls.push({ command, args })
        return Promise.resolve({ stdout: "", stderr: "" })
      },
    }
    await managedCommand(
      runner,
      {
        mode: "managed",
        connectionString: "postgres://redacted",
        composeFile: "/config/compose.yaml",
        environmentFile: "/config/.env",
        projectName: "remem",
        database: "remem",
        user: "remem",
        port: 54_329,
      },
      ["down"],
    )

    expect(calls).toEqual([
      {
        command: "docker",
        args: [
          "compose",
          "--env-file",
          "/config/.env",
          "-f",
          "/config/compose.yaml",
          "-p",
          "remem",
          "down",
        ],
      },
    ])
  })

  it("requires explicit confirmation before restore and never invokes a process", async () => {
    const paths = await temporaryPaths()
    const config: RememAppConfig = {
      version: 1,
      storage: { mode: "external", connectionString: "postgres://user:secret@localhost/remem" },
      providers: [],
      embedding: { provider: "local-hash", model: "remem-local-hash-v1", dimensions: 384 },
    }
    await writeAppConfig(config, paths)
    const backup = path.join(paths.dataDir, "backup.dump")
    await mkdir(paths.dataDir, { recursive: true })
    await writeFile(backup, "not-used")
    const calls: string[] = []
    const errors: string[] = []
    const code = await runCli(["restore", backup], {
      paths,
      runner: {
        run(command) {
          calls.push(command)
          return Promise.resolve({ stdout: "", stderr: "" })
        },
      },
      stdout: () => undefined,
      stderr: (line) => errors.push(line),
    })

    expect(code).toBe(1)
    expect(calls).toEqual([])
    expect(errors.join("\n")).toContain("requires --confirm")
    expect(errors.join("\n")).not.toContain("secret")
  })

  it("rejects an invalid candidate status before connecting to PostgreSQL", async () => {
    const paths = await temporaryPaths()
    const config: RememAppConfig = {
      version: 1,
      storage: { mode: "external", connectionString: "postgres://user:secret@localhost/remem" },
      providers: [
        {
          type: "postgres",
          id: "remem-local",
          connectionString: "postgres://user:secret@localhost/remem",
          primary: true,
          maxConnections: 1,
          catalogLimit: 10,
        },
      ],
      embedding: { provider: "local-hash", model: "remem-local-hash-v1", dimensions: 384 },
    }
    await writeAppConfig(config, paths)
    const errors: string[] = []

    expect(
      await runCli(["candidates", "--status", "invalid"], {
        paths,
        stderr: (line) => errors.push(line),
      }),
    ).toBe(1)
    expect(errors.join("\n")).toContain("--status must be one of")
  })

  it("redacts configured secrets from subprocess failures", async () => {
    const runner = new NodeProcessRunner()
    await expect(
      runner.run(
        process.execPath,
        ["-e", "process.stderr.write('database-secret'); process.exit(1)"],
        { redact: ["database-secret"] },
      ),
    ).rejects.toThrow("[redacted]")
  })

  it("uses schema-scoped backups and transactional restores", () => {
    expect(BACKUP_FLAGS).toContain("--schema=remem")
    expect(RESTORE_FLAGS).toEqual(
      expect.arrayContaining(["--schema=remem", "--single-transaction", "--exit-on-error"]),
    )
  })

  it("refuses to overwrite an existing backup artifact", async () => {
    const paths = await temporaryPaths()
    const output = path.join(paths.configDir, "existing.dump")
    await mkdir(paths.configDir, { recursive: true })
    await writeFile(output, "keep-this-backup")
    await expect(
      new NodeProcessRunner().run(process.execPath, ["-e", "process.stdout.write('new')"], {
        outputFile: output,
      }),
    ).rejects.toThrow()
    expect(await readFile(output, "utf8")).toBe("keep-this-backup")
  })

  it("warns about the one-time neural embedding model download", () => {
    const lines: string[] = []
    warnAboutNeuralDownload(
      { embedding: { provider: "neural", model: "bge-small-en-v1.5", dimensions: 384 } },
      (line) => lines.push(line),
    )

    const output = lines.join("\n")
    expect(output).toContain("bge-small-en-v1.5")
    expect(output).toContain("huggingface.co")
  })

  it("does not warn when the embedding backend is not neural", () => {
    const lines: string[] = []
    warnAboutNeuralDownload(
      { embedding: { provider: "local-hash", model: "remem-local-hash-v1", dimensions: 384 } },
      (line) => lines.push(line),
    )

    expect(lines).toEqual([])
  })

  it("serializes lifecycle operations per installation", async () => {
    const paths = await temporaryPaths()
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const first = withInstallLock(paths, () => blocked)
    await new Promise((resolve) => setTimeout(resolve, 10))

    await expect(withInstallLock(paths, () => Promise.resolve())).rejects.toThrow(
      "another Remem operation is active",
    )
    release?.()
    await first
  })
})

import { createReadStream, createWriteStream } from "node:fs"
import { spawn } from "node:child_process"
import { unlink } from "node:fs/promises"
import { pipeline } from "node:stream/promises"

export interface CommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  inputFile?: string
  outputFile?: string
  redact?: string[]
}

export interface CommandResult {
  stdout: string
  stderr: string
}

export interface ProcessRunner {
  run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult>
}

export class ProcessExecutionError extends Error {
  override readonly name = "ProcessExecutionError"

  constructor(command: string, code: number | null, detail: string) {
    super(`${command} exited with code ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`)
  }
}

function redacted(value: string, secrets: string[]): string {
  let result = value
  for (const secret of secrets.filter(Boolean)) result = result.replaceAll(secret, "[redacted]")
  return result.slice(-4_000)
}

export class NodeProcessRunner implements ProcessRunner {
  run(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: "pipe",
        shell: false,
      })
      let stdoutText = ""
      let stderrText = ""
      let streamError: Error | undefined
      let settled = false
      const capture = (current: string, chunk: Buffer) =>
        `${current}${chunk.toString("utf8")}`.slice(-64 * 1024)
      const inputFinished = options.inputFile
        ? pipeline(createReadStream(options.inputFile), child.stdin).catch((error: unknown) => {
            streamError = error instanceof Error ? error : new Error("failed to read process input")
            child.kill()
          })
        : (child.stdin.end(), Promise.resolve())
      const output = options.outputFile
        ? createWriteStream(options.outputFile, { mode: 0o600, flags: "wx" })
        : undefined
      let outputCreated = false
      output?.once("open", () => (outputCreated = true))
      const outputFinished = output
        ? pipeline(child.stdout, output).catch((error: unknown) => {
            streamError =
              error instanceof Error ? error : new Error("failed to write process output")
            child.kill()
          })
        : Promise.resolve()
      if (!output)
        child.stdout.on("data", (chunk: Buffer) => (stdoutText = capture(stdoutText, chunk)))
      child.stderr.on("data", (chunk: Buffer) => (stderrText = capture(stderrText, chunk)))
      child.once("error", (error) => {
        if (settled) return
        settled = true
        void (options.outputFile && outputCreated
          ? unlink(options.outputFile).catch(() => undefined)
          : undefined)
        reject(error)
      })
      const complete = async (code: number | null) => {
        if (settled) return
        await Promise.all([inputFinished, outputFinished])
        if (streamError) {
          settled = true
          if (options.outputFile && outputCreated)
            await unlink(options.outputFile).catch(() => undefined)
          reject(streamError)
          return
        }
        settled = true
        if (code === 0) {
          resolve({ stdout: stdoutText, stderr: stderrText })
          return
        }
        if (options.outputFile && outputCreated)
          await unlink(options.outputFile).catch(() => undefined)
        reject(new ProcessExecutionError(command, code, redacted(stderrText, options.redact ?? [])))
      }
      child.once("close", (code) => void complete(code))
    })
  }
}

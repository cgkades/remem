import { createReadStream, createWriteStream } from "node:fs"
import { spawn } from "node:child_process"

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
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      if (options.inputFile) createReadStream(options.inputFile).pipe(child.stdin)
      else child.stdin.end()
      const output = options.outputFile
        ? createWriteStream(options.outputFile, { mode: 0o600, flags: "wx" })
        : undefined
      const outputFinished = output
        ? new Promise<void>((resolveOutput, rejectOutput) => {
            output.once("finish", resolveOutput)
            output.once("error", rejectOutput)
          })
        : Promise.resolve()
      if (output) child.stdout.pipe(output)
      else child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
      child.once("error", reject)
      const complete = async (code: number | null) => {
        output?.end()
        try {
          await outputFinished
        } catch (error) {
          reject(error instanceof Error ? error : new Error("failed to write process output"))
          return
        }
        const stdoutText = Buffer.concat(stdout).toString("utf8")
        const stderrText = Buffer.concat(stderr).toString("utf8")
        if (code === 0) {
          resolve({ stdout: stdoutText, stderr: stderrText })
          return
        }
        reject(new ProcessExecutionError(command, code, redacted(stderrText, options.redact ?? [])))
      }
      child.once("close", (code) => void complete(code))
    })
  }
}

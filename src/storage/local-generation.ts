import { Worker } from "node:worker_threads"
import type { LocalLearningModelConfig } from "../config.js"
export interface GenerationResult {
  content: string
  identity: string
}
export interface LocalGenerator {
  generate: (evidence: string, signal: AbortSignal) => Promise<GenerationResult>
  dispose: () => Promise<void>
}
/** One serial caller per generator. Terminating the worker cancels model
 * loading/inference itself, not just the host's wait for a late result. */
export class LocalGenerationWorker implements LocalGenerator {
  private worker: Worker | undefined
  private ready: Promise<void> | undefined
  private id = 0
  constructor(private readonly config: LocalLearningModelConfig) {}
  private start(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL("./local-generation-worker.js", import.meta.url), {
      execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
      workerData: { modelPath: this.config.modelPath, maxNewTokens: this.config.maxNewTokens },
    })
    this.worker = worker
    this.ready = new Promise((resolve, reject) => {
      const ready = (message: unknown) => {
        if (
          message &&
          typeof message === "object" &&
          "ready" in message &&
          message.ready === true
        ) {
          worker.off("message", ready)
          resolve()
        }
      }
      worker.on("message", ready)
      worker.once("error", () => reject(new Error("local-model-load-failed")))
      worker.once("exit", () => reject(new Error("local-model-stopped")))
    })
    void this.ready.catch(() => undefined)
    return worker
  }
  async generate(evidence: string, signal: AbortSignal): Promise<GenerationResult> {
    signal.throwIfAborted()
    const worker = this.start(),
      id = ++this.id
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", abort)
        worker.off("message", message)
        worker.off("error", error)
        worker.off("exit", error)
      }
      const abort = () => {
        cleanup()
        void this.dispose()
        reject(new DOMException("Aborted", "AbortError"))
      }
      const error = () => {
        cleanup()
        reject(new Error("local-generation-failed"))
      }
      const message = (value: unknown) => {
        if (!value || typeof value !== "object" || !("id" in value) || value.id !== id) return
        cleanup()
        if (
          "content" in value &&
          typeof value.content === "string" &&
          "identity" in value &&
          typeof value.identity === "string"
        )
          resolve({ content: value.content, identity: value.identity })
        else reject(new Error("local-generation-failed"))
      }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) {
        abort()
        return
      }
      worker.on("message", message)
      worker.once("error", error)
      worker.once("exit", error)
      void this.ready!.then(() => {
        if (!signal.aborted) worker.postMessage({ id, evidence })
      }, error)
    })
  }
  async dispose(): Promise<void> {
    const worker = this.worker
    this.worker = undefined
    this.ready = undefined
    if (worker) await worker.terminate()
  }
}

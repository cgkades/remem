import { createHash } from "node:crypto"
import type { EvidenceCaptureCoordinator } from "../../evidence-capture.js"
import type { HostLocation } from "../opencode/shared.js"
import { memoryContext } from "../opencode/shared.js"

// Snapshot only bounded plain JSON without executing getters or toJSON.
function boundedInput(value: unknown): unknown {
  let nodes = 0,
    chars = 0
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 256 || depth > 8) throw new Error("unsupported-input")
    if (typeof item === "string") {
      chars += item.length
      if (chars > 40_000) throw new Error("unsupported-input")
      return item
    }
    if (
      item === null ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    )
      return item
    if (Array.isArray(item)) {
      if (item.length > 128) throw new Error("unsupported-input")
      return item.map((v) => visit(v, depth + 1))
    }
    if (
      !item ||
      typeof item !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(item) as object | null)
    )
      throw new Error("unsupported-input")
    const descriptors = Object.getOwnPropertyDescriptors(item)
    const entries = Object.entries(descriptors)
    if (entries.length > 128) throw new Error("unsupported-input")
    return Object.fromEntries(
      entries.map(([key, descriptor]) => {
        if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("unsupported-input")
        chars += key.length
        if (chars > 40_000) throw new Error("unsupported-input")
        return [key, visit(descriptor.value, depth + 1)]
      }),
    )
  }
  return visit(value, 0)
}

/** Native completion events only. Input provenance and call arguments are
 * paired in bounded transient state; dispatch transcripts are never sources. */
export class PiEvidenceAdapter {
  private pendingUser: string | undefined
  private turn: string | undefined
  private readonly calls = new Map<string, { tool: string; input: unknown; turnId: string }>()
  constructor(
    private readonly coordinator: EvidenceCaptureCoordinator,
    private readonly providerId: string,
    private readonly location: HostLocation,
  ) {}
  input(text: string, source: string): void {
    this.pendingUser = source === "interactive" && text.length <= 20_000 ? text : undefined
  }
  turnStarted(index: number, timestamp: number): void {
    this.turn =
      Number.isSafeInteger(index) &&
      index >= 0 &&
      Number.isFinite(timestamp) &&
      Math.abs(timestamp) <= 8.64e15
        ? `${index}:${timestamp}`
        : undefined
  }
  messageEnded(message: unknown, sessionId: string): void {
    if (!message || typeof message !== "object" || !("role" in message) || message.role !== "user")
      return
    const pending = this.pendingUser
    this.pendingUser = undefined
    if (
      !pending ||
      !("content" in message) ||
      !("timestamp" in message) ||
      typeof message.timestamp !== "number" ||
      !Number.isFinite(message.timestamp)
    )
      return
    const content = message.content
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((part: unknown) =>
                part &&
                typeof part === "object" &&
                "type" in part &&
                part.type === "text" &&
                "text" in part &&
                typeof part.text === "string"
                  ? part.text
                  : "",
              )
              .join("")
          : ""
    // A modified, injected or transformed user message gains no human authority.
    if (text !== pending) return
    if (Math.abs(message.timestamp) > 8.64e15) return
    const id = createHash("sha256")
      .update(String(message.timestamp) + "\0" + text)
      .digest("hex")
    this.coordinator.enqueue({
      providerId: this.providerId,
      host: "pi",
      context: memoryContext(this.location, sessionId),
      messageId: id,
      role: "user",
      origin: "direct-user",
      kind: "turn-completed",
      occurredAt: new Date(message.timestamp).toISOString(),
      payload: { text },
    })
  }
  toolStarted(id: string, tool: string, input: unknown): void {
    if (
      tool.startsWith("memory_") ||
      !id ||
      !this.turn ||
      this.calls.has(id) ||
      this.calls.size >= 32
    )
      return
    try {
      this.calls.set(id, { tool, input: boundedInput(input), turnId: this.turn })
    } catch {
      /* Unscreenable arguments are unsupported. */
    }
  }
  toolEnded(id: string, tool: string, result: unknown, isError: boolean, sessionId: string): void {
    const call = this.calls.get(id)
    this.calls.delete(id)
    if (
      !call ||
      call.tool !== tool ||
      !result ||
      typeof result !== "object" ||
      !("content" in result) ||
      !Array.isArray(result.content)
    )
      return
    const text = result.content
      .map((part: unknown) =>
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
          ? part.text
          : "",
      )
      .join("\n")
      .replaceAll(this.location.directory, ".")
    // Input/details are screened together; do not strip nested credentials to save a summary.
    this.coordinator.enqueue({
      providerId: this.providerId,
      host: "pi",
      context: memoryContext(this.location, sessionId),
      messageId: id,
      turnId: call.turnId,
      role: "tool",
      origin: "host-observed",
      kind: "tool-result",
      occurredAt: new Date().toISOString(),
      payload: {
        text,
        metadata: {
          tool,
          status: isError ? "error" : "completed",
          input: call.input,
          ...("details" in result && result.details !== undefined
            ? { result: result.details }
            : {}),
        },
      },
    })
  }
  dispose(): void {
    this.pendingUser = undefined
    this.calls.clear()
  }
}

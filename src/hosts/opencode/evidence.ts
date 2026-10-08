import type { EvidenceCaptureCoordinator } from "../../evidence-capture.js"
import type { EvidencePayload } from "../../observation-admission.js"
import { memoryContext, type HostLocation } from "./shared.js"

interface PromptEvent {
  readonly sessionID: string
  readonly messageID: string
  prompt: { text: string }
  metadata?: Record<string, unknown>
}

interface ToolEvent {
  readonly sessionID: string
  readonly messageID: string
  readonly id: string
  readonly tool: string
  readonly input: unknown
  readonly status: "completed" | "error"
  result?: {
    readonly content?: string | readonly { readonly type: string; readonly text?: string }[]
    readonly metadata?: Record<string, unknown>
  }
  error?: { readonly message: string }
}

/** Only SDK callbacks with stable identities are mapped. Context dispatch
 * is deliberately absent: its transcript includes retrieved/synthetic data
 * and it fires repeatedly during a tool loop. */
export class V2EvidenceAdapter {
  constructor(
    private readonly coordinator: EvidenceCaptureCoordinator,
    private readonly providerId: string,
    private readonly location: HostLocation,
  ) {}

  prompt(event: PromptEvent): void {
    this.coordinator.enqueue({
      providerId: this.providerId,
      host: "opencode-v2",
      context: memoryContext(this.location, event.sessionID),
      messageId: event.messageID,
      role: "user",
      // Never reinterpret explicitly generated/retrieved input as a human
      // assertion. Metadata-bearing prompts have no supported provenance
      // contract in this SDK, so conservatively exclude them.
      origin: event.metadata ? "unknown" : "direct-user",
      kind: "turn-completed",
      occurredAt: new Date().toISOString(),
      payload: { text: event.prompt.text },
    })
  }

  tool(event: ToolEvent): void {
    // ReMem's own tool results are retrieved/derived memory. Recording them
    // again would create a feedback loop and falsely independent evidence.
    if (event.tool.startsWith("memory_")) return
    const content = event.result?.content
    const rawText =
      event.status === "error"
        ? event.error?.message
        : typeof content === "string"
          ? content
          : content
              ?.filter((part) => part.type === "text" && typeof part.text === "string")
              .map((part) => part.text)
              .join("\n")
    // Native read results include the absolute workspace path in their
    // wrapper. Store a workspace-relative spelling rather than repeatedly
    // storing machine-specific paths or mistaking the joined path for an
    // opaque credential. The workspace identity itself is screened by
    // admission, so this cannot hide a credential-bearing workspace.
    const relative = (text: string) => text.replaceAll(this.location.directory, ".")
    const text = rawText === undefined ? undefined : relative(rawText)
    const input =
      event.input &&
      typeof event.input === "object" &&
      "path" in event.input &&
      typeof event.input.path === "string"
        ? { ...event.input, path: relative(event.input.path) }
        : event.input
    const resultMetadata = event.result?.metadata
      ? Object.fromEntries(
          Object.entries(event.result.metadata).map(([key, value]) => [
            key,
            typeof value === "string" && ["path", "filepath", "title"].includes(key)
              ? relative(value)
              : value,
          ]),
        )
      : undefined
    // Payload metadata stays bounded by admission's depth/value/byte limits;
    // no arbitrary SDK event, attachments, exception stack, or result.output
    // is serialized. Inputs and result metadata are screened together so a
    // nested credential rejects this whole event before any content is saved.
    const payload: EvidencePayload = {
      ...(text === undefined ? {} : { text }),
      metadata: {
        tool: event.tool,
        status: event.status,
        input,
        ...(resultMetadata ? { result: resultMetadata } : {}),
      },
    }
    this.coordinator.enqueue({
      providerId: this.providerId,
      host: "opencode-v2",
      context: memoryContext(this.location, event.sessionID),
      turnId: event.messageID,
      // One assistant message can contain several calls: the call ID, not
      // the assistant message ID alone, identifies a completed tool result.
      messageId: event.id,
      role: "tool",
      origin: "host-observed",
      kind: "tool-result",
      occurredAt: new Date().toISOString(),
      payload,
    })
  }
}

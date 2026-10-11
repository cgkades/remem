import {
  admitEvidence,
  DEFAULT_EVIDENCE_ADMISSION_CONFIG,
  type EvidenceEnvelope,
} from "../../../src/observation-admission.js"
export const piContext = {
  directory: "/repo",
  worktree: "/repo",
  projectId: "pi-files",
  sessionId: "pi-session",
}
export function piEvidence(providerId = "pi-loop"): EvidenceEnvelope[] {
  const inputs = [
    {
      messageId: "user",
      role: "user" as const,
      origin: "direct-user" as const,
      kind: "turn-completed" as const,
      payload: { text: "Investigate the missing Aurora checkpoint file." },
    },
    ...[
      [
        "read",
        "error",
        { path: "aurora-checkpoint.txt" },
        "ENOENT: no such file or directory, open './aurora-checkpoint.txt'",
      ],
      [
        "write",
        "completed",
        { path: "aurora-checkpoint.txt", content: "checkpoint ready\n" },
        "Successfully wrote to aurora-checkpoint.txt",
      ],
      ["read", "completed", { path: "aurora-checkpoint.txt" }, "checkpoint ready\n"],
    ].map(([tool, status, input, text], i) => ({
      messageId: `tool-${i}`,
      turnId: String(i + 1),
      role: "tool" as const,
      origin: "host-observed" as const,
      kind: "tool-result" as const,
      payload: { text: typeof text === "string" ? text : "", metadata: { tool, status, input } },
    })),
  ]
  return inputs.map((source, i) => {
    const result = admitEvidence(
      {
        ...source,
        providerId,
        host: "pi",
        context: piContext,
        occurredAt: new Date(Date.now() - 10_000 + i * 1000).toISOString(),
      },
      { providerId, host: "pi", projectId: piContext.projectId },
      { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
    )
    if (result.outcome !== "admitted") throw new Error("invalid Pi fixture")
    return result.envelope
  })
}

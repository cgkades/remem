import {
  admitEvidence,
  DEFAULT_EVIDENCE_ADMISSION_CONFIG,
  type EvidenceEnvelope,
} from "../../../src/observation-admission.js"

export const procedureContext = {
  directory: "/repo",
  worktree: "/repo",
  projectId: "phoenix-procedure",
  sessionId: "procedure-session",
}
export const procedureCheck = "test -f phoenix-checkpoint.txt"
export const procedureAction = "printf 'checkpoint ready\\n' > phoenix-checkpoint.txt"

export function procedureEvidence(providerId = "host-loop"): EvidenceEnvelope[] {
  const raw = [
    {
      messageId: "problem",
      role: "user" as const,
      origin: "direct-user" as const,
      kind: "turn-completed" as const,
      payload: { text: "Investigate the missing Phoenix checkpoint file." },
    },
    ...[
      [procedureCheck, 1, "Phoenix checkpoint missing"],
      [procedureAction, 0, "checkpoint created"],
      [procedureCheck, 0, "Phoenix checkpoint exists"],
    ].map(([command, exit, text], index) => ({
      messageId: `shell-${index}`,
      turnId: `assistant-${index}`,
      role: "tool" as const,
      origin: "host-observed" as const,
      kind: "tool-result" as const,
      payload: {
        text: String(text),
        metadata: { tool: "shell", status: "completed", input: { command }, result: { exit } },
      },
    })),
  ]
  return raw.map((source, index) => {
    const result = admitEvidence(
      {
        ...source,
        providerId,
        host: "opencode-v2",
        context: procedureContext,
        occurredAt: new Date(Date.UTC(2026, 9, 9, 10, 0, index)).toISOString(),
      },
      { providerId, host: "opencode-v2", projectId: procedureContext.projectId },
      { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
    )
    if (result.outcome !== "admitted") throw new Error("invalid recovery fixture")
    return result.envelope
  })
}

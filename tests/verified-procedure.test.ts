import { describe, expect, it, vi } from "vitest"
import { CaptureCoordinator } from "../src/capture.js"
import { parseConfig } from "../src/config.js"
import {
  admitEvidence,
  DEFAULT_EVIDENCE_ADMISSION_CONFIG,
  type EvidenceEnvelope,
} from "../src/observation-admission.js"
import { observationFromResolvedTask } from "../src/procedure.js"
import { verifiedProcedureFromEvidence, SHELL_RECOVERY_RULE } from "../src/verified-procedure.js"
import {
  procedureAction,
  procedureCheck,
  procedureContext,
  procedureEvidence,
} from "./fixtures/learning/shell-recovery.js"

function replace(
  evidence: EvidenceEnvelope[],
  index: number,
  update: (source: EvidenceEnvelope) => void,
) {
  const source = evidence[index]!
  update(source)
  const admitted = admitEvidence(
    source,
    { providerId: source.providerId, host: source.host, projectId: source.context.projectId },
    { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
  )
  if (admitted.outcome !== "admitted") throw new Error("negative fixture must be admitted")
  evidence[index] = admitted.envelope
}

describe("stored native check recovery", () => {
  it("derives deterministic bounded evidence-backed recovery without inventing a root cause", () => {
    const evidence = procedureEvidence()
    const episode = verifiedProcedureFromEvidence(evidence, procedureContext)
    expect(episode?.verification).toEqual({
      rule: SHELL_RECOVERY_RULE,
      evidenceRefs: evidence.map((source) => ({
        providerId: source.providerId,
        eventId: source.id,
      })),
    })
    const observation = episode && observationFromResolvedTask(episode)
    expect(observation?.payload.text).toContain(procedureAction)
    expect(observation?.payload.text).toContain(procedureCheck)
    expect(observation?.payload.text).not.toContain("root cause")
    expect(observation).toEqual(
      observationFromResolvedTask(verifiedProcedureFromEvidence(evidence, procedureContext)!),
    )
  })

  it.each([
    [
      "generic completed status",
      (e: EvidenceEnvelope[]) =>
        replace(e, 3, (s) => {
          s.payload.metadata!.result = {}
        }),
    ],
    [
      "model success boolean",
      (e: EvidenceEnvelope[]) =>
        replace(e, 3, (s) => {
          s.payload.metadata!.result = { succeeded: true }
          s.payload.text = "Fixed; verified=true"
        }),
    ],
    [
      "failed final check",
      (e: EvidenceEnvelope[]) =>
        replace(e, 3, (s) => {
          s.payload.metadata!.result = { exit: 1 }
        }),
    ],
    [
      "abandoned/cancelled final check",
      (e: EvidenceEnvelope[]) =>
        replace(e, 3, (s) => {
          s.payload.metadata!.status = "error"
        }),
    ],
    [
      "timeout",
      (e: EvidenceEnvelope[]) =>
        replace(e, 3, (s) => {
          s.payload.metadata!.result = { exit: 0, timeout: true }
        }),
    ],
    [
      "background command",
      (e: EvidenceEnvelope[]) =>
        replace(e, 3, (s) => {
          s.payload.metadata!.input = { command: procedureCheck, background: true }
        }),
    ],
    [
      "truncated outcome",
      (e: EvidenceEnvelope[]) =>
        replace(e, 3, (s) => {
          s.payload.metadata!.result = { exit: 0, truncated: true }
        }),
    ],
    [
      "different successful check",
      (e: EvidenceEnvelope[]) =>
        replace(e, 3, (s) => {
          s.payload.metadata!.input = { command: "echo fixed" }
        }),
    ],
    [
      "changed execution directory",
      (e: EvidenceEnvelope[]) =>
        replace(e, 3, (s) => {
          s.payload.metadata!.input = { command: procedureCheck, workdir: "other" }
        }),
    ],
    [
      "unsuccessful action",
      (e: EvidenceEnvelope[]) =>
        replace(e, 2, (s) => {
          s.payload.metadata!.result = { exit: 2 }
        }),
    ],
    [
      "already successful initial check",
      (e: EvidenceEnvelope[]) =>
        replace(e, 1, (s) => {
          s.payload.metadata!.result = { exit: 0 }
        }),
    ],
    [
      "missing failure signature",
      (e: EvidenceEnvelope[]) =>
        replace(e, 1, (s) => {
          s.payload.text = ""
        }),
    ],
    [
      "parallel same-message tool calls",
      (e: EvidenceEnvelope[]) =>
        replace(e, 2, (s) => {
          s.turnId = e[1]!.turnId!
        }),
    ],
    [
      "foreign project",
      (e: EvidenceEnvelope[]) =>
        replace(e, 2, (s) => {
          s.context.projectId = "foreign"
        }),
    ],
    [
      "foreign session",
      (e: EvidenceEnvelope[]) =>
        replace(e, 2, (s) => {
          s.context.sessionId = "foreign"
        }),
    ],
    [
      "foreign provider",
      (e: EvidenceEnvelope[]) =>
        replace(e, 2, (s) => {
          s.providerId = "foreign"
        }),
    ],
    [
      "unsupported host",
      (e: EvidenceEnvelope[]) =>
        replace(e, 2, (s) => {
          s.host = "pi"
        }),
    ],
    [
      "new user task interrupts sequence",
      (e: EvidenceEnvelope[]) => {
        e.splice(2, 0, structuredClone(e[0]!))
      },
    ],
    [
      "duplicate evidence",
      (e: EvidenceEnvelope[]) => {
        e[2] = e[1]!
      },
    ],
    [
      "corrupt hash",
      (e: EvidenceEnvelope[]) => {
        e[2]!.contentHash = "a".repeat(64)
      },
    ],
    [
      "secret output",
      (e: EvidenceEnvelope[]) => {
        e[2]!.payload.text = "password=fixture-secret"
      },
    ],
    [
      "no original prompt",
      (e: EvidenceEnvelope[]) => {
        e.shift()
      },
    ],
    [
      "window overflow",
      (e: EvidenceEnvelope[]) => {
        e.unshift(...procedureEvidence(), ...procedureEvidence())
      },
    ],
  ] as const)("refuses %s", (_name, update) => {
    const evidence = procedureEvidence()
    update(evidence)
    expect(verifiedProcedureFromEvidence(evidence, procedureContext)).toBeUndefined()
  })

  it("retains new host procedures pending even with legacy auto-promotion enabled", async () => {
    const persistCandidate = vi.fn(() => Promise.resolve())
    const promote = vi.fn(() => Promise.resolve())
    const coordinator = new CaptureCoordinator(
      { persistCandidate, candidateStatus: vi.fn() },
      parseConfig({ capture: { enabled: true, autoPromote: true } }).config.capture,
      { log: vi.fn() },
      promote,
    )
    coordinator.enqueueResolvedTask(
      verifiedProcedureFromEvidence(procedureEvidence(), procedureContext)!,
    )
    await coordinator.dispose()
    expect(persistCandidate).toHaveBeenCalledExactlyOnceWith(
      expect.any(Object),
      expect.objectContaining({ status: "pending" }),
      expect.objectContaining({ autoApprove: false }),
    )
    expect(promote).not.toHaveBeenCalled()
  })
})

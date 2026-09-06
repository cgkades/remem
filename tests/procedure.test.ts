import { describe, expect, it } from "vitest"
import { CaptureCoordinator } from "../src/capture.js"
import type { CaptureConfig } from "../src/config.js"
import {
  extractProcedureCandidate,
  observationFromResolvedTask,
  type ResolvedTaskEpisode,
} from "../src/procedure.js"
import type { CandidateMemory, ObservationStore, SessionObservation } from "../src/observation.js"
import type { RememLogger } from "../src/types.js"

const config: CaptureConfig = {
  enabled: true,
  autoPromote: false,
  queueLimit: 4,
  maxInputCharacters: 2_000,
  maxCandidateCharacters: 1_500,
  timeoutMs: 100,
}

const logger: RememLogger = { log: () => undefined }

class RecordingStore implements ObservationStore {
  readonly persisted: Array<{ observation: SessionObservation; candidate: CandidateMemory }> = []

  persistCandidate(observed: SessionObservation, candidate: CandidateMemory): Promise<void> {
    this.persisted.push({ observation: observed, candidate })
    return Promise.resolve()
  }

  candidateStatus() {
    return Promise.resolve({
      pending: 0,
      approved: 0,
      consolidating: 0,
      rejected: 0,
      promoted: 0,
      expired: 0,
    })
  }
}

function episode(overrides: Partial<ResolvedTaskEpisode> = {}): ResolvedTaskEpisode {
  return {
    host: "opencode-v2",
    context: {
      directory: "/project",
      worktree: "/project",
      projectId: "phoenix",
      sessionId: "session",
    },
    sessionId: "session",
    messageId: "message-1",
    goal: "Find the compose file for local PostgreSQL",
    outcome: "succeeded",
    steps: [
      { kind: "search", summary: "search compose.yaml", path: "compose.yaml" },
      { kind: "read", summary: "read compose.yaml", path: "compose.yaml" },
    ],
    ...overrides,
  }
}

describe("resolved-task procedure extraction", () => {
  it("extracts a bounded procedure after a successful file investigation", () => {
    const observation = observationFromResolvedTask(episode())
    expect(observation?.kind).toBe("task-resolved")
    const candidate = observation ? extractProcedureCandidate(observation, config) : undefined
    expect(candidate?.memory.type).toBe("procedure")
    expect(candidate?.memory.scope).toEqual({ kind: "project", id: "phoenix" })
    expect(candidate?.memory.provenance?.[0]?.source.kind).toBe("session")
    expect(candidate?.memory.provenance?.[0]?.note).toContain("agent-derived")
    expect(candidate?.memory.content).toContain("compose.yaml")
    expect(candidate?.memory.content).not.toContain("tool-result")
  })

  it("extracts a procedure after a verified error fix", () => {
    const observation = observationFromResolvedTask(
      episode({
        goal: "Fix the migration checksum error",
        steps: [
          {
            kind: "command",
            summary: "ran migrate",
            command: "npm run migrate",
            errorSignature: "checksum mismatch",
          },
          {
            kind: "command",
            summary: "recomputed checksums",
            command: "npm run migrate -- --repair",
          },
        ],
      }),
    )
    const candidate = observation ? extractProcedureCandidate(observation, config) : undefined
    expect(candidate?.reasons).toEqual(["verified successful investigation"])
    expect(candidate?.memory.content).toContain("checksum mismatch")
    expect(candidate?.memory.content).toContain("npm run migrate")
  })

  it("does not extract failed, abandoned, or unverified investigations", () => {
    expect(observationFromResolvedTask(episode({ outcome: "failed" }))).toBeUndefined()
    expect(observationFromResolvedTask(episode({ outcome: "abandoned" }))).toBeUndefined()
    expect(
      observationFromResolvedTask(
        episode({
          steps: [{ kind: "search", summary: "looked around" }],
        }),
      ),
    ).toBeUndefined()
  })

  it("excludes credentials and non-workspace paths", () => {
    expect(
      observationFromResolvedTask(
        episode({ goal: "Remember API_KEY=super-secret-value for compose" }),
      ),
    ).toBeUndefined()
    expect(
      observationFromResolvedTask(
        episode({
          steps: [{ kind: "read", summary: "absolute path", path: "/etc/passwd" }],
        }),
      ),
    ).toBeUndefined()
    expect(
      observationFromResolvedTask(
        episode({
          steps: [{ kind: "read", summary: "unc path", path: "\\\\server\\share\\file" }],
        }),
      ),
    ).toBeUndefined()
  })

  it("ignores extra steps beyond the scan cap", () => {
    const extra = Array.from({ length: 20 }, (_, index) => ({
      kind: "other" as const,
      summary: `noise ${index}`,
      ...(index === 19 ? { command: "API_KEY=super-secret-value" } : {}),
    }))
    const observation = observationFromResolvedTask(
      episode({
        steps: [{ kind: "read", summary: "read compose.yaml", path: "compose.yaml" }, ...extra],
      }),
    )
    expect(observation?.payload.text).toContain("compose.yaml")
    expect(String(observation?.payload.text)).not.toContain("noise 19")
  })
})

describe("CaptureCoordinator resolved tasks", () => {
  it("persists a pending procedure candidate for a verified success", async () => {
    const store = new RecordingStore()
    const coordinator = new CaptureCoordinator(store, config, logger)
    coordinator.enqueueResolvedTask(episode())
    await coordinator.idle()
    expect(store.persisted).toHaveLength(1)
    expect(store.persisted[0]?.candidate.memory.type).toBe("procedure")
    expect(coordinator.explain("session")).toMatchObject({
      outcome: "pending",
      kind: "task-resolved",
    })
  })

  it("excludes unverified investigations without throwing", async () => {
    const store = new RecordingStore()
    const coordinator = new CaptureCoordinator(store, config, logger)
    expect(() => coordinator.enqueueResolvedTask(episode({ outcome: "failed" }))).not.toThrow()
    await coordinator.idle()
    expect(store.persisted).toHaveLength(0)
    expect(coordinator.explain("session")).toMatchObject({
      outcome: "excluded",
      reason: "investigation was not a verified success",
    })
  })
})

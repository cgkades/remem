import type { Context } from "@opencode-ai/plugin/promise/plugin"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { RememPlugin } from "../src/hosts/opencode/v2.js"
import { PostgresMemoryProvider } from "../src/providers/postgres.js"
import {
  candidateFromRow,
  DeterministicConsolidationPipeline,
  type CandidateRow,
} from "../src/consolidation.js"
import { runMigrations } from "../src/storage/migrations.js"
import { observationFromResolvedTask, extractProcedureCandidate } from "../src/procedure.js"
import { parseConfig } from "../src/config.js"
import { verifiedProcedureFromEvidence } from "../src/verified-procedure.js"
import {
  procedureAction,
  procedureCheck,
  procedureContext,
  procedureEvidence,
} from "./fixtures/learning/shell-recovery.js"

const databaseUrl = process.env.REMEM_TEST_DATABASE_URL
const integration = databaseUrl ? describe.sequential : describe.skip
const providerId = "procedure-loop"
const config = {
  type: "postgres" as const,
  id: providerId,
  connectionString: databaseUrl ?? "",
  primary: true,
  maxConnections: 4,
  catalogLimit: 100,
}

function host() {
  const hooks = new Map<string, ((event: unknown) => unknown)[]>()
  const hook = (name: string, callback: (event: unknown) => unknown) => {
    hooks.set(name, [...(hooks.get(name) ?? []), callback])
    return Promise.resolve({ dispose: () => Promise.resolve() })
  }
  return {
    context: {
      options: {
        providers: [config],
        embedding: { backend: "hash" },
        planner: { semantic: false },
        capture: { enabled: true, autoPromote: true },
        evidenceAdmission: { enabled: true },
        providerTimeoutMs: 5000,
        budgets: { catalogTokens: 2000, recallTokens: 5000, perProviderTokens: 4500 },
      },
      location: {
        directory: "/repo",
        project: { directory: "/repo", id: procedureContext.projectId },
      },
      session: { hook },
      tool: {
        hook: (name: string, callback: (event: unknown) => unknown) =>
          hook(`tool.${name}`, callback),
        transform: () => Promise.resolve({ dispose: () => Promise.resolve() }),
      },
    } as unknown as Context,
    async emit(name: string, event: unknown) {
      for (const callback of hooks.get(name) ?? []) await callback(event)
    },
  }
}

function tool(index: number, sessionID: string) {
  return {
    sessionID,
    messageID: `assistant-${index}`,
    id: `call-${index}`,
    tool: "shell",
    status: "completed" as const,
    input: { command: index === 1 ? procedureAction : procedureCheck },
    result: {
      content: index === 0 ? "Phoenix checkpoint missing" : "Phoenix checkpoint exists",
      metadata: { exit: index === 0 ? 1 : 0 },
    },
  }
}

integration("host verified procedure learning", () => {
  const pool = new Pool({ connectionString: databaseUrl })
  const store = new PostgresMemoryProvider(config, { pool })
  beforeAll(async () => {
    await pool.query("DROP SCHEMA IF EXISTS remem CASCADE")
    await runMigrations(pool)
  })
  afterAll(async () => {
    await pool.end()
  })

  async function start(sessionID: string) {
    const instance = host()
    const dispose = await RememPlugin.setup(instance.context)
    await instance.emit("prompt", {
      sessionID,
      messageID: "problem",
      prompt: { text: "Investigate the missing Phoenix checkpoint file." },
    })
    return { ...instance, dispose }
  }

  it("recovers stored investigation evidence after restart, captures once and recalls only after review", async () => {
    const session = "restart-procedure"
    const first = await start(session)
    await first.emit("tool.execute.after", tool(0, session))
    await first.emit("tool.execute.after", tool(1, session))
    await first.dispose?.()
    const second = host()
    const dispose = await RememPlugin.setup(second.context)
    await second.emit("tool.execute.after", tool(2, session))
    await second.emit("tool.execute.after", tool(2, session))
    await dispose?.()
    const rows = await pool.query<CandidateRow>(
      "SELECT * FROM remem.candidate_memories WHERE type='procedure' AND session_event_id IN (SELECT id FROM remem.session_events WHERE session_id=$1)",
      [session],
    )
    expect(rows.rows).toHaveLength(1)
    const row = rows.rows[0]!
    expect(row.status).toBe("pending")
    const lineage = await store.candidateLineage(row.id, {
      ...procedureContext,
      sessionId: session,
    })
    expect(lineage?.observationIds).toHaveLength(4)
    expect(lineage?.availableObservationIds).toEqual(lineage?.observationIds)
    expect(lineage?.revision).toBe(0)
    expect(
      (
        await pool.query(
          "SELECT id FROM remem.session_events WHERE session_id=$1 AND evidence_id IS NULL",
          [session],
        )
      ).rowCount,
    ).toBe(0)
    expect(
      (await pool.query("SELECT id FROM remem.memories WHERE type='procedure'")).rowCount,
    ).toBe(0)

    // The pending-review boundary is intentional Phase 5 behavior, not the
    // future Phase 6 ordinary low-risk automatic-promotion acceptance gate.
    await store.reviewCandidate(row.id, "approved", 0)
    const result = await new DeterministicConsolidationPipeline(store).consolidate([
      { ...candidateFromRow(row), status: "approved" },
    ])
    expect(result[0]?.status).toBe("promoted")
    const fresh = host()
    const disposeFresh = await RememPlugin.setup(fresh.context)
    try {
      const event = {
        sessionID: "fresh-procedure",
        system: [],
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Let's continue the Phoenix checkpoint work." }],
          },
        ],
      }
      const started = performance.now()
      await fresh.emit("context", event)
      const callbackMs = performance.now() - started
      const injected = event.messages
        .slice(1)
        .flatMap((message) => message.content.map((part) => part.text))
        .join("\n")
      expect(injected).toContain(procedureAction.replaceAll(">", "&gt;"))
      expect(injected).toContain("same check subsequently")
      const refs = candidateFromRow(row).memory.provenance?.[0]?.source.metadata?.evidenceRefs
      expect(refs).toHaveLength(4)
      for (const ref of refs as { eventId: string }[]) expect(injected).toContain(ref.eventId)
      expect(injected).not.toContain("root cause")
      expect(injected).not.toContain("fixture-secret")
      console.info(
        JSON.stringify({
          gate: "reviewed-procedure-recall",
          procedureFixtureAccurate: true,
          provenanceSources: 4,
          unsupportedRootCause: false,
          callbackMs,
          contextBytes: Buffer.byteLength(injected, "utf8"),
          contextMeasurement: "conservative UTF-8 bytes, not model tokenizer tokens",
          modelQuality: "not evaluated; deterministic fixture",
        }),
      )
    } finally {
      await disposeFresh?.()
    }
  })

  it.each(["failed", "unknown", "secret", "abandoned", "parallel", "new-task"])(
    "does not create a procedure for %s",
    async (kind) => {
      const session = `negative-${kind}`
      const instance = await start(session)
      await instance.emit("tool.execute.after", tool(0, session))
      await instance.emit("tool.execute.after", tool(1, session))
      if (kind === "new-task")
        await instance.emit("prompt", {
          sessionID: session,
          messageID: "other-problem",
          prompt: { text: "Investigate unrelated work now." },
        })
      const final = tool(2, session)
      if (kind === "failed") final.result.metadata.exit = 1
      if (kind === "unknown") final.result.metadata = {} as { exit: number }
      if (kind === "secret") final.result.content = "password=fixture-secret"
      if (kind === "parallel") final.messageID = "assistant-1"
      if (kind !== "abandoned") await instance.emit("tool.execute.after", final)
      await instance.dispose?.()
      expect(
        (
          await pool.query(
            "SELECT id FROM remem.candidate_memories WHERE type='procedure' AND session_event_id IN (SELECT id FROM remem.session_events WHERE session_id=$1)",
            [session],
          )
        ).rowCount,
      ).toBe(0)
    },
  )

  it("fails open on outcome-read outage and shuts down without authorizing a candidate", async () => {
    const read = vi
      .spyOn(PostgresMemoryProvider.prototype, "readProcedureEvidenceWindow")
      .mockRejectedValue(new Error("fixture outage"))
    const instance = await start("outage-procedure")
    try {
      for (let index = 0; index < 3; index++)
        await expect(
          instance.emit("tool.execute.after", tool(index, "outage-procedure")),
        ).resolves.toBeUndefined()
      await expect(instance.dispose?.()).resolves.toBeUndefined()
    } finally {
      read.mockRestore()
    }
    expect(
      (
        await pool.query(
          "SELECT id FROM remem.candidate_memories WHERE type='procedure' AND session_event_id IN (SELECT id FROM remem.session_events WHERE session_id='outage-procedure')",
        )
      ).rowCount,
    ).toBe(0)
  })

  it("independently verifies stored native evidence and refuses forged bodies, rules and auto-approval", async () => {
    const evidence = procedureEvidence(providerId)
    for (const envelope of evidence) await store.appendEvidence(envelope)
    const episode = verifiedProcedureFromEvidence(evidence, procedureContext)!
    const observation = observationFromResolvedTask(episode)!
    const candidate = extractProcedureCandidate(observation, parseConfig({}).config.capture)!
    await expect(
      store.persistCandidate(observation, candidate, { autoApprove: true }),
    ).rejects.toThrow("require review")
    const changed = structuredClone(candidate)
    changed.memory.content = "Unsupported root cause: network outage."
    await expect(store.persistCandidate(observation, changed)).rejects.toThrow("does not verify")
    await expect(
      store.persistCandidate(
        { ...observation, payload: { ...observation.payload, verificationRule: "model-verified" } },
        candidate,
      ),
    ).rejects.toThrow("does not verify")
    await expect(store.persistCandidate(observation, candidate)).resolves.toBeUndefined()
    expect((await store.candidateLineage(candidate.id, procedureContext))?.state).toBe("pending")
  })
})
